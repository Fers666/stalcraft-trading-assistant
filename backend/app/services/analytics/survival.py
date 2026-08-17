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
from sqlalchemy.ext.asyncio import AsyncSession


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
    """
    if not queue_rank or not variant_live_lots or variant_live_lots <= 0:
        return None
    if variant_live_lots <= 3:
        return "thin"
    relpos = queue_rank / variant_live_lots
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

    Границы не круглые: они взяты по замеру §2.4 ТЗ так, чтобы разделить
    участки разной крутизны кривой и чтобы каждый тировый множитель
    (0.94 / 1.00 / 1.06) попал в свой бакет, а не делил его с соседом.
    """
    if not price_per_unit or not ref_price or ref_price <= 0:
        return None
    r = price_per_unit / ref_price
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
    """

    def __init__(self, rows: Optional[dict[tuple[str, str, int], Stratum]] = None):
        self._rows = rows or {}

    def __bool__(self) -> bool:
        return bool(self._rows)

    def get(self, feature: str, bucket: Optional[str], horizon_h: int) -> Optional[Stratum]:
        if not bucket:
            return None
        return self._rows.get((feature, bucket, horizon_h))

    def summary(self, feature: str, bucket: Optional[str]) -> Optional[Stratum]:
        """
        Сводка страты (median_hours, pct_sold_ever) — они не зависят от
        горизонта. Берём с первого доступного горизонта.
        """
        if not bucket:
            return None
        for h in HORIZONS_H:
            row = self._rows.get((feature, bucket, h))
            if row is not None:
                return row
        return None


# ─── Пересчёт ────────────────────────────────────────────────────────────────

# CASE-выражения страт живут рядом с pos_bucket/ratio_bucket и обязаны им
# соответствовать: расхождение означало бы, что таблица считается по одним
# границам, а читается по другим. Проверяется тестом test_sql_buckets_match.
_POS_CASE = """
    CASE WHEN variant_live_lots <= 3 THEN 'thin'
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
_AGG_SQL = """
WITH inc AS (
    SELECT {bucket_case} AS bucket,
           EXTRACT(epoch FROM end_time   - start_time) / 3600 AS planned_h,
           EXTRACT(epoch FROM last_seen_at - start_time) / 3600 AS life_h,
           outcome
    FROM lot_observations
    WHERE source = 'live'
      AND outcome IS NOT NULL
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND first_seen_at - start_time <= make_interval(mins => :max_delay)
      AND first_seen_at >= :since
      AND {availability}
), h AS (
    SELECT unnest(CAST(:horizons AS int[])) AS horizon_h
)
SELECT inc.bucket,
       h.horizon_h,
       count(*) FILTER (WHERE planned_h >= h.horizon_h) AS n_at_risk,
       count(*) FILTER (WHERE planned_h >= h.horizon_h
                          AND outcome = 'sold' AND life_h <= h.horizon_h) AS n_sold,
       count(*) FILTER (WHERE planned_h >= h.horizon_h
                          AND outcome = 'withdrawn' AND life_h <= h.horizon_h) AS n_withdrawn,
       count(*) AS n_total,
       count(*) FILTER (WHERE outcome = 'sold') AS n_sold_ever,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY life_h)
           FILTER (WHERE outcome = 'sold') AS median_hours
FROM inc CROSS JOIN h
GROUP BY inc.bucket, h.horizon_h
"""


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
        "feature":       feature,
        "bucket":        row.bucket,
        "horizon_h":     int(row.horizon_h),
        "n_at_risk":     n_at_risk,
        "n_sold":        n_sold,
        "p_sold_lo":     round(100.0 * n_sold / n_at_risk, 2),
        "p_sold_hi":     round(100.0 * n_sold / denom_hi, 2) if denom_hi > 0 else 100.0,
        "pct_withdrawn": round(100.0 * n_withdrawn / n_at_risk, 2),
        "pct_sold_ever": (
            round(100.0 * (row.n_sold_ever or 0) / row.n_total, 2) if row.n_total else None
        ),
        "median_hours": round(float(row.median_hours), 2) if row.median_hours is not None else None,
        "computed_at":  now,
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

    result = await db.execute(text(
        "SELECT feature, bucket, horizon_h, n_at_risk, p_sold_lo, p_sold_hi, "
        "       pct_withdrawn, pct_sold_ever, median_hours FROM sale_survival"
    ))
    rows: dict[tuple[str, str, int], Stratum] = {}
    for r in result:
        rows[(r.feature, r.bucket, int(r.horizon_h))] = Stratum(
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
