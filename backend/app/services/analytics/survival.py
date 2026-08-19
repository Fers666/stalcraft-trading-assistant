"""
Кривая дожития лота: «с какой вероятностью продастся за H часов».

P1-4 фаза B, ТЗ docs/tasks/sale-survival-curve.md.

Здесь три вещи:
- разбиение наблюдений на страты (чистые функции, тестируются без БД);
- пересчёт таблицы sale_survival из lot_observations (раз в сутки);
- чтение таблицы потребителями (make_sell_options, лента).

Почему это вообще понадобилось: до фазы B срок продажи брался из множителей
0.4 / 1.0 / 2.5 к среднему времени и лестницы 2/8/24 ... 72/168/336 часов
(pricing.make_sell_options). Ни одно из тех двенадцати чисел не измерялось.
lot_observations — единственный источник в системе, который видит и лоты,
которые НЕ продались, поэтому только по нему кривую и можно построить.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.feed.scope import CLASS_ARTEFACT, CLASS_GEAR, class_case_sql


# Горизонты прогноза. Мельче часа не строим: шаг обхода ленты 5-25 минут, и
# момент события известен только с этой точностью. Крупнее 24 ч нет смысла:
# 42% лотов выставляются на 12 ч или меньше и до такого горизонта физически
# не доживают (замер §2.1 ТЗ).
HORIZONS_H: tuple[int, ...] = (1, 3, 6, 12, 24)

# Окно выборки. Сверху ограничено LOT_OBS_RETENTION_DAYS = 30, но брать всё
# окно не нужно: рынок дрейфует, а две недели уже дают тысячи наблюдений
# на страту.
SURVIVAL_WINDOW_DAYS = 14

# Инцидентная когорта: лот должен быть замечен вскоре после выставления.
# Замер §2.2 ТЗ: лот нельзя купить первые ~10 минут после start_time (0.0%
# сделок в этом окне по независимому источнику sales_history), а сборщик
# впервые видит его на 7-13-й минуте. То есть мы застаём лот ровно тогда,
# когда он становится доступен, и поправка на левое усечение не нужна —
# нужен только отсев тех, кто висел на рынке ДО начала сбора.
INCIDENT_MAX_DELAY_MINUTES = 30

# Страта с меньшим числом наблюдений не публикуется, потребитель откатывается
# на прежнее поведение. Не «на глаз»: при n=200 и p~0.8 половина ширины 95%-
# интервала ~5.5 п.п., что меньше наименьшего разрыва между соседними стратами
# в замере (§2.5 ТЗ). Публиковать страту, чью погрешность не отличить от
# разницы с соседом, значит показывать пользователю шум.
MIN_STRATUM_N = 200

FEATURE_POS   = "pos"
FEATURE_RATIO = "ratio"

# Кэш таблицы в процессе: она пересчитывается раз в сутки и весит ~60 строк,
# поэтому ходить за ней в БД на каждый лот ленты бессмысленно.
SURVIVAL_CACHE_TTL_SECONDS = 600


def pos_bucket(queue_rank: Optional[int], variant_live_lots: Optional[int]) -> Optional[str]:
    """
    Страта по НОРМИРОВАННОЙ позиции лота в стакане своего варианта.

    Нормировка обязательна. Сырой ранг и сырая глубина немонотонны: замер
    §2.3 ТЗ дал «100+ единиц дешевле» лучшей стратой (81.3% продаж за 6 ч)
    просто потому, что такие книги бывают только у оборотистых вариантов —
    признак смешан с ликвидностью. Доля же монотонна: 89.4% в верхних 10%
    книги против 34.2% в нижней половине.

    Книга из <= 3 лотов — отдельная страта, а не доля: 1 из 2 и 1 из 200 это
    разные рынки, и делить одно на другое здесь нечего.

    Верх книги разбит дробно (2 / 5 / 10 %), потому что там и происходит всё
    интересное. Прежние четыре полосы схлопывали внутри одного «top10» разброс
    в 24 п.п. — от 89.8 % у самых дешёвых до 65.8 % на границе, — и из-за этого
    сценарий «продать дороже» в двух третях строк ленты показывал НУЛЕВУЮ цену
    ожидания: +12.8 % к цене не перепрыгивали такую широкую границу.

    Границы круглые, а не подогнанные под квантили одного среза: квантили,
    снятые с неполных суток, уехали бы. Устойчивость проверена посуточно —
    порядок страт воспроизвёлся день в день без единого пересечения (уровни при
    этом плавают на 3-9 п.п., но это лечится объёмом данных, а не границами).
    """
    if not queue_rank or not variant_live_lots or variant_live_lots <= 0:
        return None
    if variant_live_lots <= 3:
        return "thin"
    relpos = queue_rank / variant_live_lots
    if relpos <= 0.02:
        return "top2"
    if relpos <= 0.05:
        return "top5"
    if relpos <= 0.10:
        return "top10"
    if relpos <= 0.25:
        return "top25"
    if relpos <= 0.50:
        return "mid"
    return "bottom"


def ratio_bucket(price_per_unit: Optional[int], ref_price: Optional[int]) -> Optional[str]:
    """
    Страта по отношению цены к опоре варианта.

    Для ТИРА бери ratio_bucket_value(множитель) напрямую: цена тира усечена
    (int(ref * 0.94)), и при ref, не кратном 50, отношение выходит 0.9399992 —
    тир падает в соседний бакет. Округлить цену недостаточно: отношение всё
    равно пересчитывается из целого числа.
    """
    if not price_per_unit or not ref_price or ref_price <= 0:
        return None
    return ratio_bucket_value(price_per_unit / ref_price)


def ratio_bucket_value(r: Optional[float]) -> Optional[str]:
    """
    Страта по готовому отношению цена/опора.

    Границы не круглые: они взяты по замеру §2.4 ТЗ так, чтобы разделить
    участки разной крутизны кривой и чтобы каждый тировый множитель
    (0.94 / 1.00 / 1.06) попал в свой бакет, а не делил его с соседом.
    """
    if r is None or r <= 0:
        return None
    if r < 0.90:
        return "lt90"
    if r < 0.94:
        return "r90_94"
    if r < 0.98:
        return "r94_98"
    if r < 1.03:
        return "r98_103"
    if r < 1.10:
        return "r103_110"
    if r < 1.30:
        return "r110_130"
    return "ge130"


@dataclass(frozen=True)
class Stratum:
    """Одна страта на одном горизонте — то, что читает потребитель."""
    n_at_risk: int
    p_sold_lo: float      # withdrawn считается непроданным (консервативно)
    p_sold_hi: float      # withdrawn исключён из знаменателя
    pct_withdrawn: float
    pct_sold_ever: Optional[float]
    median_hours: Optional[float]


class SurvivalTable:
    """
    Прочитанная sale_survival. Пустая таблица — рабочее состояние: первый
    пересчёт идёт через сутки после деплоя, и до него все потребители обязаны
    вести себя как раньше.

    Ключ строки включает КЛАСС предмета (artefact / gear): у снаряжения своя
    механика рынка, и заимствовать артефактную кривую ему нельзя. Пока
    gear-страты не набрали MIN_STRATUM_N, get() по ним возвращает None —
    ровно та же деградация, что у артефактов до первого пересчёта, второй
    выкатки не нужно (§3.3 ТЗ feed-gear-expansion.md).
    """

    def __init__(self, rows: Optional[dict[tuple[str, str, str, int], Stratum]] = None):
        self._rows = rows or {}

    def __bool__(self) -> bool:
        return bool(self._rows)

    def get(
        self, item_class: str, feature: str, bucket: Optional[str], horizon_h: int,
    ) -> Optional[Stratum]:
        if not bucket:
            return None
        return self._rows.get((item_class, feature, bucket, horizon_h))

    def summary(self, item_class: str, feature: str, bucket: Optional[str]) -> Optional[Stratum]:
        """
        Сводка страты: median_hours не зависит от горизонта, pct_sold_ever
        зависит (знаменатель — дожившие до горизонта, см. _stratum_row).
        Берём с первого доступного, то есть с самого широкого — там популяция
        ближе всего ко «всем лотам страты».
        """
        if not bucket:
            return None
        for h in HORIZONS_H:
            row = self._rows.get((item_class, feature, bucket, h))
            if row is not None:
                return row
        return None


# ─── Пересчёт ────────────────────────────────────────────────────────────────

# CASE-выражения страт живут рядом с pos_bucket/ratio_bucket и обязаны им
# соответствовать: расхождение означало бы, что таблица считается по одним
# границам, а читается по другим. Проверяется тестом test_sql_buckets_match.
_POS_CASE = """
    CASE WHEN variant_live_lots <= 3 THEN 'thin'
         WHEN queue_rank::numeric / variant_live_lots <= 0.02 THEN 'top2'
         WHEN queue_rank::numeric / variant_live_lots <= 0.05 THEN 'top5'
         WHEN queue_rank::numeric / variant_live_lots <= 0.10 THEN 'top10'
         WHEN queue_rank::numeric / variant_live_lots <= 0.25 THEN 'top25'
         WHEN queue_rank::numeric / variant_live_lots <= 0.50 THEN 'mid'
         ELSE 'bottom' END
"""
_RATIO_CASE = """
    CASE WHEN buyout_per_unit::numeric / ref_price_at_seen < 0.90 THEN 'lt90'
         WHEN buyout_per_unit::numeric / ref_price_at_seen < 0.94 THEN 'r90_94'
         WHEN buyout_per_unit::numeric / ref_price_at_seen < 0.98 THEN 'r94_98'
         WHEN buyout_per_unit::numeric / ref_price_at_seen < 1.03 THEN 'r98_103'
         WHEN buyout_per_unit::numeric / ref_price_at_seen < 1.10 THEN 'r103_110'
         WHEN buyout_per_unit::numeric / ref_price_at_seen < 1.30 THEN 'r110_130'
         ELSE 'ge130' END
"""

_FEATURE_SQL = {
    FEATURE_POS:   (_POS_CASE,   "queue_rank IS NOT NULL AND variant_live_lots > 0"),
    FEATURE_RATIO: (_RATIO_CASE, "ref_price_at_seen IS NOT NULL AND ref_price_at_seen > 0"),
}

# Одним запросом на признак: страты x горизонты. CROSS JOIN по горизонтам, а
# не пять запросов — тогда наблюдение читается один раз.
#
# planned_h >= horizon_h — административное цензурирование, и оно здесь
# главное. Длительность аукциона переменная (48 ч у 47% лотов, 12 ч у 39%,
# 24 ч у 11%, 6 ч у 3%), поэтому лот с 12-часовым аукционом НЕ является
# наблюдением «не продан за 24 ч»: он до этого горизонта не дожил. Без этого
# фильтра дальние горизонты занижались бы механически.
#
# source = 'live' — не косметика: восстановленные из снапшотов наблюдения
# измеряют позицию в книге верно (corr = 0.992 с живым на общих лотах), но их
# популяция смещена обрезкой снапшота до 200 дешёвых лотов предмета, и на
# одних и тех же предметах они дают вероятность продажи ниже на 8-16 п.п.
#
# ЕЩЁ ЖИВЫЕ ЛОТЫ ВХОДЯТ В ЗНАМЕНАТЕЛЬ. Лот, который всё ещё висит на рынке и
# прожил дольше горизонта, — это полноценное наблюдение «за H часов не
# продался», и выбрасывать его нельзя. Первая версия брала только закрытые
# (outcome IS NOT NULL), а лот закрывается лишь через LOT_OBS_RESOLVE_DELAY_HOURS
# после последнего наблюдения: среди недавних успевают закрыться в основном
# быстро проданные. Замер на проде дал завышение на 12.5-15.7 п.п. по горизонтам
# и до 21.4 п.п. по отдельным стратам — ровно та ошибка «метрика по выжившим»,
# ради которой вся эта таблица и заводилась.
#
# Условие «исход известен к горизонту H»: outcome IS NOT NULL (лот ушёл с рынка,
# судьба ясна) ЛИБО life_h >= H (лот пережил горизонт у нас на глазах, значит по
# H он точно не продан). Лот моложе H и ещё живой не даёт информации о H и в
# выборку не идёт.
_KNOWN_AT_H = "(outcome IS NOT NULL OR life_h >= h.horizon_h)"

# Класс предмета (artefact / gear) — полноценное измерение страты, а не метка:
# у снаряжения качество является свойством предмета, тиры получают апгрейдом, а
# не покупкой, и артефактная кривая для него — чужая. Берётся из каталога
# (JOIN master_items), потому что в наблюдении класса нет и денормализовать его
# в 200-тысячную таблицу ради одного JOIN незачем.
_AGG_SQL = """
WITH inc AS (
    SELECT {class_case} AS item_class,
           {bucket_case} AS bucket,
           EXTRACT(epoch FROM end_time   - start_time) / 3600 AS planned_h,
           EXTRACT(epoch FROM last_seen_at - start_time) / 3600 AS life_h,
           outcome
    FROM lot_observations o
    JOIN master_items mi ON mi.item_id = o.item_id
    WHERE source = 'live'
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND first_seen_at - start_time <= make_interval(mins => :max_delay)
      -- Наблюдения, пропавшие вместе со всем рынком, из популяции ВЫБРАСЫВАЮТСЯ.
      -- Оставить их нельзя ни в каком виде: outcome не NULL, поэтому строка
      -- попала бы в знаменатель и никогда в числитель, то есть тихо просаживала
      -- бы вероятность. Ровно это и случилось 2026-08-19 на техработах, когда
      -- 14 463 живых лота были помечены withdrawn.
      AND (outcome IS NULL OR outcome <> 'blackout')
      AND first_seen_at >= :since
      AND {availability}
), h AS (
    SELECT unnest(CAST(:horizons AS int[])) AS horizon_h
)
SELECT inc.item_class,
       inc.bucket,
       h.horizon_h,
       count(*) FILTER (WHERE planned_h >= h.horizon_h AND {known}) AS n_at_risk,
       count(*) FILTER (WHERE planned_h >= h.horizon_h AND {known}
                          AND outcome = 'sold' AND life_h <= h.horizon_h) AS n_sold,
       count(*) FILTER (WHERE planned_h >= h.horizon_h AND {known}
                          AND outcome = 'withdrawn' AND life_h <= h.horizon_h) AS n_withdrawn,
       count(*) FILTER (WHERE planned_h >= h.horizon_h AND {known}) AS n_total,
       count(*) FILTER (WHERE planned_h >= h.horizon_h AND {known}
                          AND outcome = 'sold') AS n_sold_ever,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY life_h)
           FILTER (WHERE outcome = 'sold') AS median_hours
FROM inc CROSS JOIN h
GROUP BY inc.item_class, inc.bucket, h.horizon_h
""".replace("{known}", _KNOWN_AT_H).replace("{class_case}", class_case_sql("mi"))


def _stratum_row(feature: str, row, now: datetime) -> Optional[dict]:
    """Одна строка sale_survival из агрегата. None — страта не публикуется."""
    n_at_risk = row.n_at_risk or 0
    if n_at_risk < MIN_STRATUM_N:
        return None

    n_sold = row.n_sold or 0
    n_withdrawn = row.n_withdrawn or 0
    # Верхняя граница: снятый лот трактуется как цензурированный, то есть
    # выкидывается из знаменателя. Трактовка щедрая — в замере она даёт
    # 92-99% во всех стратах и различия стирает, поэтому в UI идёт lo.
    denom_hi = n_at_risk - n_withdrawn
    return {
        # Ключ словаря — ИМЯ КОЛОНКИ ("class"): строки уходят в Core-INSERT по
        # SaleSurvival.__table__. Атрибут модели называется item_class, потому
        # что class — ключевое слово Python; в агрегате поле тоже под
        # псевдонимом item_class (row.class не написать).
        "class":         row.item_class,
        "feature":       feature,
        "bucket":        row.bucket,
        "horizon_h":     int(row.horizon_h),
        "n_at_risk":     n_at_risk,
        "n_sold":        n_sold,
        "p_sold_lo":     round(100.0 * n_sold / n_at_risk, 2),
        "p_sold_hi":     round(100.0 * n_sold / denom_hi, 2) if denom_hi > 0 else 100.0,
        "pct_withdrawn": round(100.0 * n_withdrawn / n_at_risk, 2),
        # Знаменатель ТОТ ЖЕ, что у p_sold_* (дожившие до горизонта и с
        # известным к нему исходом). Считать «продались когда-либо» по всей
        # страте нельзя: 6- и 12-часовые аукционы продаются реже, и на общей
        # популяции pct_sold_ever выходил МЕНЬШЕ p_sold_24h во всех стратах —
        # в UI «за сутки 89.93 %» соседствовало с «не продаётся 13 %».
        #
        # Это НИЖНЯЯ граница: ещё живые лоты попадают в знаменатель, а
        # продаться могут позже. То есть «не продаётся N %» — оценка сверху.
        # Направление выбрано намеренно: покупателю осторожная оценка
        # безопасна, оптимистичная — нет.
        "pct_sold_ever": (
            round(100.0 * (row.n_sold_ever or 0) / row.n_total, 2) if row.n_total else None
        ),
        "median_hours": round(float(row.median_hours), 2) if row.median_hours is not None else None,
        "computed_at":  now,
    }


# ─── Калибровка: сверка опубликованного с фактом ─────────────────────────────

# Наблюдение годится для проверки горизонта H, только если к моменту сверки его
# судьба на этом горизонте ОПРЕДЕЛЕНА. Иначе выборка наполняется одними
# быстрыми: лот, проданный за час, закрывается через LOT_OBS_RESOLVE_DELAY_HOURS
# и попадает в выборку, а его сосед, всё ещё висящий вторые сутки, — нет.
# Ровно та же ошибка «метрика по выжившим», что уже стоила знаменателя кривой.
CALIBRATION_MATURITY_HOURS = 2  # запас на задержку резолвера

# Минимум наблюдений на страту в проверочном окне. Ниже — строка не пишется:
# ошибка в 10 п.п. на выборке в полсотни лотов неотличима от случайности
# (полуширина 95%-интервала там ~14 п.п.).
MIN_CALIBRATION_N = 150

# Окно короче суток сверять НЕЛЬЗЯ: продажи имеют выраженный суточный ход
# (замер 2026-08-19: 36-40 % в 2-5 утра против 54-57 % в 7-11 по Москве), и
# короткое окно измеряет время суток, а не качество кривой. Проверено на себе:
# ручной прогон через 5.5 ч после ночного пересчёта дал среднюю ошибку
# -16.25 п.п., тогда как на полных сутках она -8.2 — разница целиком от того,
# что окно пришлось на ночной провал.
MIN_CALIBRATION_WINDOW_HOURS = 20

_CALIB_SQL = """
WITH inc AS (
    SELECT {class_case} AS item_class,
           {bucket_case} AS bucket,
           EXTRACT(epoch FROM end_time   - start_time) / 3600 AS planned_h,
           EXTRACT(epoch FROM last_seen_at - start_time) / 3600 AS life_h,
           first_seen_at,
           outcome
    FROM lot_observations o
    JOIN master_items mi ON mi.item_id = o.item_id
    WHERE source = 'live'
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND first_seen_at - start_time <= make_interval(mins => :max_delay)
      -- Наблюдения, пропавшие вместе со всем рынком, из популяции ВЫБРАСЫВАЮТСЯ.
      -- Оставить их нельзя ни в каком виде: outcome не NULL, поэтому строка
      -- попала бы в знаменатель и никогда в числитель, то есть тихо просаживала
      -- бы вероятность. Ровно это и случилось 2026-08-19 на техработах, когда
      -- 14 463 живых лота были помечены withdrawn.
      AND (outcome IS NULL OR outcome <> 'blackout')
      AND first_seen_at >= :window_from
      AND {availability}
), h AS (
    SELECT unnest(CAST(:horizons AS int[])) AS horizon_h
)
SELECT inc.item_class,
       inc.bucket,
       h.horizon_h,
       count(*) FILTER (WHERE {evaluable}) AS n,
       count(*) FILTER (WHERE {evaluable}
                          AND outcome = 'sold' AND life_h <= h.horizon_h) AS n_sold
FROM inc CROSS JOIN h
GROUP BY inc.item_class, inc.bucket, h.horizon_h
"""

# Судьба на горизонте определена: лот дожил у нас на глазах до H либо ушёл с
# рынка, И при этом прошло достаточно времени, чтобы это стало известно.
_EVALUABLE = (
    "planned_h >= h.horizon_h "
    "AND (outcome IS NOT NULL OR life_h >= h.horizon_h) "
    # CAST обязателен: без него asyncpg не выводит тип параметра в выражении
    # «:now - make_interval(...)» и валится с «timestamp with time zone <=
    # interval». Текстовыми тестами это не ловится, только исполнением.
    "AND first_seen_at <= CAST(:now AS timestamptz) - make_interval("
    "hours => h.horizon_h + CAST(:maturity AS int))"
)

_CALIB_SQL = (
    _CALIB_SQL
    .replace("{evaluable}", _EVALUABLE)
    .replace("{class_case}", class_case_sql("mi"))
)


async def evaluate_calibration(db: AsyncSession, now: Optional[datetime] = None) -> dict:
    """
    Сверяет ОПУБЛИКОВАННЫЕ вероятности с тем, что случилось на самом деле.

    Проверочное окно начинается там, где закончилось обучение: берётся
    computed_at действующей sale_survival, и в сверку идут только лоты,
    впервые увиденные ПОСЛЕ него. Пересечения периодов быть не должно — иначе
    таблица проверяет сама себя.

    Пишет по строке на страту. Отрицательный error_pp означает, что обещали
    больше, чем вышло, то есть ошибка в опасную для пользователя сторону.
    """
    from app.models.models import SaleSurvival, SurvivalCalibration

    now = now or datetime.now(timezone.utc)

    published = (await db.execute(
        text("""
            SELECT class AS item_class, feature, bucket, horizon_h,
                   p_sold_lo, computed_at
            FROM sale_survival
        """)
    )).all()
    if not published:
        return {"rows": 0, "reason": "sale_survival пуста — сверять нечего"}

    # Окно проверки открывается моментом обучения. Если таблицу пересчитали
    # несколько раз, берём САМЫЙ ПОЗДНИЙ: сверять надо то, что показывается.
    window_from = max(r.computed_at for r in published)
    if window_from.tzinfo is None:
        window_from = window_from.replace(tzinfo=timezone.utc)

    window_hours = (now - window_from).total_seconds() / 3600
    if window_hours < MIN_CALIBRATION_WINDOW_HOURS:
        return {
            "rows": 0,
            "window_hours": round(window_hours, 1),
            "reason": (
                f"окно короче {MIN_CALIBRATION_WINDOW_HOURS} ч — сверка измерила бы "
                f"время суток, а не кривую"
            ),
        }

    predicted = {
        (r.item_class, r.feature, r.bucket, r.horizon_h): float(r.p_sold_lo)
        for r in published
    }

    rows: list[dict] = []
    for feature, (bucket_case, availability) in _FEATURE_SQL.items():
        sql = _CALIB_SQL.format(bucket_case=bucket_case, availability=availability)
        result = await db.execute(
            text(sql),
            {
                "max_delay": INCIDENT_MAX_DELAY_MINUTES,
                "window_from": window_from,
                "now": now,
                "maturity": CALIBRATION_MATURITY_HOURS,
                "horizons": list(HORIZONS_H),
            },
        )
        for agg in result:
            n = agg.n or 0
            if n < MIN_CALIBRATION_N:
                continue
            key = (agg.item_class, feature, agg.bucket, agg.horizon_h)
            if key not in predicted:
                continue          # страта появилась после обучения — сверять не с чем
            realized = round(100.0 * (agg.n_sold or 0) / n, 2)
            rows.append({
                "class":       agg.item_class,
                "feature":     feature,
                "bucket":      agg.bucket,
                "horizon_h":   agg.horizon_h,
                "window_from": window_from,
                "window_to":   now,
                "n":           n,
                "predicted":   round(predicted[key], 2),
                "realized":    realized,
                "error_pp":    round(realized - predicted[key], 2),
                "computed_at": now,
            })

    if rows:
        stmt = pg_insert(SurvivalCalibration).values(rows)
        await db.execute(stmt.on_conflict_do_update(
            index_elements=["class", "feature", "bucket", "horizon_h", "window_from"],
            set_={
                "window_to":   stmt.excluded.window_to,
                "n":           stmt.excluded.n,
                "predicted":   stmt.excluded.predicted,
                "realized":    stmt.excluded.realized,
                "error_pp":    stmt.excluded.error_pp,
                "computed_at": stmt.excluded.computed_at,
            },
        ))
    await db.commit()

    errors = [abs(float(r["error_pp"])) for r in rows]
    return {
        "rows": len(rows),
        "window_from": window_from.isoformat(),
        "window_hours": round(window_hours, 1),
        "mean_abs_error_pp": round(sum(errors) / len(errors), 2) if errors else None,
        "max_abs_error_pp": round(max(errors), 2) if errors else None,
        # Систематический перекос важнее средней ошибки: если все страты врут в
        # одну сторону, это смещение, а не шум.
        "mean_error_pp": (
            round(sum(float(r["error_pp"]) for r in rows) / len(rows), 2) if rows else None
        ),
    }


async def recalculate_survival(db: AsyncSession, now: Optional[datetime] = None) -> dict:
    """
    Пересчитывает sale_survival целиком: DELETE + INSERT в одной транзакции.

    Таблица производная и крошечная (~60 строк), инкрементальность здесь была
    бы сложностью без выигрыша. Целиком — ещё и потому, что страта, переставшая
    набирать MIN_STRATUM_N, обязана ИСЧЕЗНУТЬ: устаревшая строка хуже
    отсутствующей, потребитель умеет деградировать.
    """
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=SURVIVAL_WINDOW_DAYS)

    rows: list[dict] = []
    skipped: dict[str, int] = {}
    # Класс приходит из агрегата отдельным полем: страты обоих классов
    # считаются одним проходом, но НЕ смешиваются — группировка идёт по
    # (класс, страта, горизонт).
    for feature, (bucket_case, availability) in _FEATURE_SQL.items():
        sql = _AGG_SQL.format(bucket_case=bucket_case, availability=availability)
        result = await db.execute(
            text(sql),
            {
                "max_delay": INCIDENT_MAX_DELAY_MINUTES,
                "since": since,
                "horizons": list(HORIZONS_H),
            },
        )
        for agg in result:
            built = _stratum_row(feature, agg, now)
            if built is None:
                skipped[feature] = skipped.get(feature, 0) + 1
                continue
            rows.append(built)

    from app.models.models import SaleSurvival

    await db.execute(text("DELETE FROM sale_survival"))
    if rows:
        await db.execute(SaleSurvival.__table__.insert(), rows)
    await db.commit()

    return {
        "rows": len(rows),
        "pos": sum(1 for r in rows if r["feature"] == FEATURE_POS),
        "ratio": sum(1 for r in rows if r["feature"] == FEATURE_RATIO),
        "artefact": sum(1 for r in rows if r["class"] == CLASS_ARTEFACT),
        "gear": sum(1 for r in rows if r["class"] == CLASS_GEAR),
        "skipped_thin_strata": sum(skipped.values()),
        "window_days": SURVIVAL_WINDOW_DAYS,
    }


# ─── Чтение ──────────────────────────────────────────────────────────────────

_cache: tuple[datetime, SurvivalTable] | None = None


async def load_survival(db: AsyncSession, now: Optional[datetime] = None) -> SurvivalTable:
    """
    Читает sale_survival с кэшем на SURVIVAL_CACHE_TTL_SECONDS.

    Кэш в процессе, а не в Redis: таблица пересчитывается раз в сутки, весит
    ~60 строк и одинакова для всех пользователей — согласовывать между
    воркерами тут нечего.
    """
    global _cache
    now = now or datetime.now(timezone.utc)
    if _cache is not None:
        loaded_at, table = _cache
        if (now - loaded_at).total_seconds() < SURVIVAL_CACHE_TTL_SECONDS:
            return table

    # "class" в кавычках и под псевдонимом: это ключевое слово Python, атрибутом
    # строки результата оно быть не может.
    result = await db.execute(text(
        'SELECT "class" AS item_class, feature, bucket, horizon_h, n_at_risk, '
        "       p_sold_lo, p_sold_hi, pct_withdrawn, pct_sold_ever, median_hours "
        "FROM sale_survival"
    ))
    rows: dict[tuple[str, str, str, int], Stratum] = {}
    for r in result:
        rows[(r.item_class, r.feature, r.bucket, int(r.horizon_h))] = Stratum(
            n_at_risk=r.n_at_risk,
            p_sold_lo=float(r.p_sold_lo),
            p_sold_hi=float(r.p_sold_hi),
            pct_withdrawn=float(r.pct_withdrawn),
            pct_sold_ever=float(r.pct_sold_ever) if r.pct_sold_ever is not None else None,
            median_hours=float(r.median_hours) if r.median_hours is not None else None,
        )
    table = SurvivalTable(rows)
    _cache = (now, table)
    return table


def reset_cache() -> None:
    """Сброс кэша — для тестов и для ручного прогона после пересчёта."""
    global _cache
    _cache = None
