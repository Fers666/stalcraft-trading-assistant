"""
Сбор данных «Ленты артефактов» (ТЗ: docs/tasks/artifact-feed.md, Фаза 1).

Конвейер идёт ПАРАЛЛЕЛЬНО watchlist-сбору и не пересекается с ним по записи,
но переиспользует все точки истины: StalcraftClient (в нём же rate limiter),
services/analytics/pricing (все формулы), api_cache (общий кэш лотов).

  collect_artifact_lots    — полная пагинация /lots по всему набору ленты,
                             скоринг и запись выгодных лотов в feed_lots;
  collect_artifact_history — часовая дельта /history по тому же набору
                             в sales_history с user_id = NULL;

Набор ленты задаётся ОДНИМ источником — services/feed/scope.feed_scope_clause
(артефакты, снаряжение высоких рангов, части предметов, премиум, сезонные
пропуска). Имена задач остались историческими: их знает beat-расписание.
  resolve_lot_observations — закрывает наблюдения за исчезнувшими лотами
                             (sold / expired / withdrawn), к API не ходит.

Почему нужна ПОЛНАЯ пагинация: /lots не сортирует по цене (сортировка в
collectors._collect_lots_for_item происходит уже ПОСЛЕ получения), поэтому
первая страница API — произвольные 200 лотов, а не самые дешёвые. Предмет
берётся целиком или не берётся вовсе.

Операционное состояние — в Redis (потеря безвредна, обход начнётся сначала):
  feed:scan:lock         — лок цикла (NX EX), защита от наложения прогонов;
  feed:scan:last:{item}  — ISO-время последнего успешного обхода, TTL 24 ч;
  feed:scan:fail:{item}  — счётчик подряд идущих отказов предмета (TTL 1 ч):
                           после потолка предмет паркуется и не блокирует очередь;
  feed:scan:cycle        — счётчик прогонов (определяет темп холодных);
  feed:scan:sweep        — "{цикл}:{unix_ts}" начала текущего полного круга
                           (нужен только для лога калибровки «feed sweep»).
"""
import asyncio
import logging
import math
import random
import time
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.tasks.celery_app import celery_app
from app.tasks.collectors import run_async

logger = logging.getLogger(__name__)

# ─── Бюджет и темп ───────────────────────────────────────────────────────────
# Единица бюджета = запрос в терминах Token Bucket (/lots = 2). 200 ед/мин =
# 100 вызовов API в минуту. Ожидаемая суммарная нагрузка: 54.5 (текущая) +
# до 100 (лента) + 3.4 (история артефактов) ≈ 158 запросов/мин ≈ 39.5% лимита.
FEED_BUDGET_UNITS_PER_MIN = 200     # жёсткий потолок расхода за один прогон (50% лимита)
FEED_RATE_GUARD_UNITS     = 340     # 85% от 400: суммарный расход системы выше -> цикл прерывается
FEED_LOTS_PAGE_LIMIT      = 200     # максимум, который принимает /lots
FEED_LOTS_REQUEST_COST    = 2       # = TokenCost.LOTS
FEED_MAX_PAGES_PER_ITEM   = 10      # потолок 2000 лотов на предмет (=20 ед, заведомо < бюджета)
FEED_REQUEST_DELAY        = 0.3     # секунд между страницами
FEED_COLD_EVERY_N_CYCLES  = 5       # холодные артефакты обходим каждый N-й цикл
FEED_HOT_SALES_PER_DAY    = 1.0     # горячий, если max(sales_per_day) по вариантам >= порога
FEED_HOT_MIN_LOTS_TOTAL   = 200     # ...или master_items.lots_total >= порога
# Окно, за которое считается, приносил ли предмет ВЫГОДНЫЕ лоты.
# Сутки, а не часы: короткое окно понизило бы добротные предметы на любом
# затишье — на посттехработном провале 2026-08-19 лоты за 3 ч дали лишь 68
# артефактов из 103, и по трёхчасовому окну треть из них уехала бы в холодные.
FEED_YIELD_WINDOW_HOURS   = 24
FEED_MAX_PROFIT_PCT       = 1000.0  # выше -> глитч, лот не сохраняем (см. «+1671089 %»)
FEED_LOCK_KEY             = "feed:scan:lock"
FEED_LOCK_TTL             = 300
FEED_STALE_ROW_HOURS      = 1       # уборка осиротевших строк feed_lots

# Джиттер старта цикла. Beat поднимает периодические задачи в одну и ту же
# секунду (а при рестарте контейнеров — вообще все разом), и запросы ленты
# ложатся ровно на тик watchlist-сборщика: средний расход остаётся ~42% лимита,
# но форма всплеска даёт реальные 429 (замер QA: 43 отказа за минуту рестарта).
# Случайное смещение старта разводит прогоны по секундам внутри минуты.
# Сон идёт ДО взятия лока: припозднившийся прогон не должен держать лок впустую.
FEED_CYCLE_JITTER_SEC   = 10
FEED_HISTORY_JITTER_SEC = 30

# ─── Уступка окну collect_all_history (:00–:11) ──────────────────────────────
# Джиттера в 10 с хватает, чтобы развести две задачи внутри минуты, но не
# одиннадцатиминутный всплеск watchlist-истории: collect_all_history идёт
# crontab(minute="0") шестью параллельными воркерами без пауз и занимает окно
# :00–:11 (celery_app.py). Замер QA: 20:00 — 34 отказа «429 received despite
# token bucket», 12:00–12:01 — 10, при счётчике лимитера 261/400.
#
# Почему 429 при формально свободном лимите: наш Token Bucket считает расход в
# ФИКСИРОВАННОМ окне по unix_minute, а API — в своём, со своим смещением.
# Всплеск на стыке минут (условно 250 ед в конце нашей минуты N и 250 в начале
# N+1) укладывается в оба наших окна, но даёт >400 в скользящем окне API.
# Лечится не учётом, а формой расхода: в чужом окне лента снижает свой.
#
# Полный пропуск цикла отвергнут: 11 из ~60 прогонов в час — заметная потеря,
# выгодный лот живёт минуты. Вместо этого лента работает с урезанным бюджетом
# (60 ед/мин = 30 вызовов вместо 100) и пониженным порогом уже существующего
# предохранителя по фактическому расходу (recent_consumption).
# Расчёт порогов: пиковая минута QA — 261 ед при ленте на полном бюджете, т.е.
# не-лента даёт ~61 ед/мин. С 60 ед у ленты пик окна ≈ 121 ед/мин: даже если
# скользящее окно API удвоит форму всплеска, это ≈ 240 < 400. Ровно на этой
# отметке стоит и предохранитель окна — всё, что выше, обрывает цикл.
FEED_HISTORY_WINDOW_END_MIN      = 12    # окно collect_all_history — минуты :00–:11
FEED_WINDOW_BUDGET_UNITS_PER_MIN = 60    # бюджет прогона внутри окна (вне окна — FEED_BUDGET_UNITS_PER_MIN)
FEED_WINDOW_RATE_GUARD_UNITS     = 240   # 60% от 400: порог предохранителя внутри окна

# Ретраи транзиентных ошибок — на уровне предмета (образец: tasks/audit.py).
FEED_ITEM_RETRIES  = 2
FEED_RETRY_BACKOFF = (2, 5)

# Отказ предмета: счётчик подряд идущих неудач и «парковка» после потолка.
# Предмет без обновлённого feed:scan:last встаёт ПЕРВЫМ в очереди следующего
# цикла (order_queue), поэтому один стабильно падающий предмет иначе повторяет
# свой отказ каждые 60 с и бесконечно жжёт лимит API — ровно то, что случилось
# с CardinalityViolationError.
FEED_ITEM_FAIL_PREFIX = "feed:scan:fail:"
FEED_ITEM_FAIL_TTL    = 3600
FEED_ITEM_FAIL_MAX    = 3
FEED_ITEM_PARK_TTL    = 900         # «короткий» feed:scan:last припаркованного предмета

# История артефактов: часовой дельты хватает с запасом, идём до первой уже
# известной продажи либо до потолка страниц.
HISTORY_PAGE_LIMIT      = 200
HISTORY_REQUEST_COST    = 2         # = TokenCost.HISTORY
HISTORY_BACKSTOP_PAGES  = 3
SALES_RETENTION_DAYS    = 120       # will_be_deleted_at = sale_time + этого
# Пауза МЕЖДУ ПРЕДМЕТАМИ истории (внутри предмета страницы идут по
# FEED_REQUEST_DELAY). При 0.3 с все 103 артефакта укладывались примерно в
# минуту: 206 ед разом поверх 200 ед ленты и 54.5 ед watchlist — тот самый
# всплеск, который упирался в лимит. С 2 с обход растягивается на ~4 минуты
# (~52 ед/мин), при том же часовом объёме. Часовой дельте спешить некуда.
HISTORY_ITEM_DELAY      = 2.0

# ─── Наблюдения за лотами (docs/tasks/lot-observations.md, P1-4 фаза A) ──────
# Сырьё для кривой дожития: пишутся ВСЕ просканированные лоты, а не только
# выгодные. Выборка обязана быть несмещённой — по одним лишь строкам feed_lots
# кривая описывала бы исключительно дешёвые лоты и завышала вероятность продажи.
# Бюджет API не затрагивается: данные уже в руках сборщика.
LOT_OBS_UPSERT_CHUNK = 500          # как UPSERT_CHUNK в variant_stats.py
# Резолвер: не раньше 2 часов после последнего наблюдения. collect_artifact_history
# идёт раз в час (:15), поэтому продажа попадает в sales_history с задержкой до
# часа; резолвить раньше — массово метить проданные лоты как withdrawn.
LOT_OBS_RESOLVE_DELAY_HOURS = 2

# Рынок считается погасшим, если ни один лот не наблюдался дольше этого срока.
# Признак надёжен потому, что набор ленты — сотни предметов: одновременно
# опустеть они не могут, а вот аукцион целиком — может.
#
# Повод (2026-08-19): на время техработ в игре API отвечал 200 OK, но с
# total=0 по всем предметам. Лоты «исчезли», и резолвер добросовестно закрыл
# 16 238 наблюдений как withdrawn — против нормы в три-четыре сотни за час.
# Эти строки попали бы в знаменатель кривой как «не продались» и просадили бы
# все страты на две недели, пока не вышли бы из окна. Восстанавливать пришлось
# вручную; повторять — нет.
MARKET_DARK_MINUTES = 15

# Исход «пропал вместе со всем рынком»: лот перестал наблюдаться ровно перед
# тем, как аукцион замолчал целиком. Такое исчезновение НЕЛЬЗЯ отнести к
# поведению рынка, поэтому наблюдение не классифицируется, а исключается из
# кривой (см. survival._AGG_SQL). Отдельное значение, а не удаление строки:
# факт наблюдения был, и терять его незачем.
#
# Первая версия защиты (MARKET_DARK_MINUTES) лишь запрещала резолв ВО ВРЕМЯ
# темноты — и этого оказалось мало: 2026-08-19 после возвращения аукциона те же
# 14 463 лота были закрыты как withdrawn, потому что на рынок они уже не
# вернулись. Отсрочка на семь часов, а не решение.
LOT_OBS_OUTCOME_BLACKOUT = "blackout"

# Полный круг обхода: 383 предмета по 30-100 за проход, проход раз в минуту.
# Лот, виденный в любой момент этого круга перед тишиной, мог просто не попасть
# в следующий проход — его отсутствие НЕ доказывает исчезновения. Поэтому окно
# неопределённости отсчитывается назад от момента, когда рынок замолчал.
FEED_FULL_CYCLE_MINUTES = 15
LOT_OBS_RESOLVE_BATCH       = 5000  # строк за один прогон резолвера
# Допуск «дожил до конца аукциона»: последний раз лот видели за один обход до
# end_time. Полный круг ~5 мин, холодные предметы — раз в FEED_COLD_EVERY_N_CYCLES
# циклов, т.е. до ~25 мин; 30 мин покрывает и их. При 48-часовой жизни лота это
# 1% срока: цена ошибки заметно ниже, чем у систематической путаницы
# expired (полное наблюдение) с withdrawn (цензурированное).
LOT_OBS_EXPIRE_TOLERANCE_MINUTES = 30
LOT_OBS_RETENTION_DAYS = 30         # удаление resolved-строк в delete_old_data
# Происхождение наблюдения (lot_observations.source). Живой сборщик пишет
# только LIVE и работает только с LIVE: строки SNAPSHOT восстановлены задним
# числом (app/scripts/reconstruct_lot_history.py), их исходы посчитаны там же,
# а оставшийся NULL в outcome — намеренное цензурирование, а не «ещё не
# закрыто». Резолверу их трогать нельзя, иначе цензурирование превратится в
# withdrawn, а сделки уйдут исторической выборке в обход живой.
LOT_OBS_SOURCE_LIVE     = "live"
LOT_OBS_SOURCE_SNAPSHOT = "snapshot"

FEED_SCAN_LAST_PREFIX = "feed:scan:last:"
FEED_SCAN_LAST_TTL    = 24 * 3600
FEED_CYCLE_KEY        = "feed:scan:cycle"
FEED_SWEEP_KEY        = "feed:scan:sweep"


# ─── Чистые функции планировщика (тестируются без БД и сети) ─────────────────

@dataclass
class ItemPlan:
    """Предмет в очереди обхода с ожидаемой стоимостью в страницах."""
    item_id: str
    pages: int                      # ожидаемое число страниц (по последнему lots_total)
    hot: bool
    last_scan: datetime | None      # None = ещё ни разу не обходился


def pages_for_total(lots_total: int | None) -> int:
    """
    Ожидаемое число страниц /lots по последнему известному total.

    Неизвестный/нулевой total (первый прогон, lots_total = NULL) — оценка
    «1 страница»: фактическое число уточняется из total первой страницы.
    Потолок FEED_MAX_PAGES_PER_ITEM.
    """
    if not lots_total or lots_total <= 0:
        return 1
    pages = math.ceil(lots_total / FEED_LOTS_PAGE_LIMIT)
    return max(1, min(pages, FEED_MAX_PAGES_PER_ITEM))


def is_hot(
    lots_total: int | None,
    max_sales_per_day: float | None,
    observed_bargains: int | None = None,
) -> bool:
    """
    Горячий предмет: max(sales_per_day) по вариантам >= FEED_HOT_SALES_PER_DAY
    ИЛИ lots_total >= FEED_HOT_MIN_LOTS_TOTAL. Холодные обходим реже — это
    механизм, который удерживает цикл в целевых ~2 минутах.

    observed_bargains — сколько ВЫГОДНЫХ лотов сборщик реально видел у предмета
    за последние FEED_YIELD_WINDOW_HOURS. Ноль означает, что предмет обходился
    сутки и не дал ни одной возможности: такой предмет холодный, что бы ни
    говорили продажи и каталог.

    Зачем это понадобилось (замер 2026-08-19): после расширения набора со 103
    предметов до 383 снаряжение заняло 73 % набора и попало в горячие 143
    предметами — порог по продажам у него срабатывает. Но выгоду дают почти
    только артефакты: за сутки 1 312 выгодных лотов против 71 у снаряжения,
    то есть 95 % против 5 %, и вчетверо реже в пересчёте на лот (4.3 % против
    1.5 %). Больше половины каждого прогона уходило на предметы, где искать
    почти нечего.

    Признак именно «не даёт ВЫГОДЫ», а не «мало лотов»: снаряжение с выгодой
    существует (24 предмета), и терять его нельзя. На глубокой книге всё это
    было незаметно — выгодные лоты висели долго и неспешный обход их ловил. На
    тонком рынке, где привлекательное разбирают за минуты, задержка обхода
    прямо определяет, сколько выгодных лотов мы увидим.

    None (ещё ни разу не обходился) НЕ понижает: иначе новый предмет застрял бы
    в холодных, так и не будучи проверенным. Понижение не окончательно —
    холодные опрашиваются каждый FEED_COLD_EVERY_N_CYCLES-й цикл, и первая же
    появившаяся выгода возвращает предмет в горячие.
    """
    if observed_bargains == 0:
        return False
    if max_sales_per_day is not None and max_sales_per_day >= FEED_HOT_SALES_PER_DAY:
        return True
    return bool(lots_total is not None and lots_total >= FEED_HOT_MIN_LOTS_TOTAL)


def observed_yield(
    item_id: str,
    bargains: dict[str, int],
    last_scan: datetime | None,
    window_start: datetime,
) -> int | None:
    """
    Сколько выгодных лотов видели у предмета: число, 0 или None (неизвестно).

    Отличить «обходили и выгоды не было» от «ни разу не обходили» по одним
    наблюдениям нельзя — в обоих случаях строк просто нет. Поэтому ноль
    засчитывается только тем, у кого есть отметка об обходе внутри окна
    (feed:scan:last). Без этого новый предмет получил бы 0, ушёл в холодные и
    остался бы там, ни разу не будучи проверенным.
    """
    if item_id in bargains:
        return bargains[item_id]
    if last_scan is not None and last_scan >= window_start:
        return 0
    return None


def order_queue(items: list[ItemPlan]) -> list[ItemPlan]:
    """
    Порядок обхода: last_scan ASC, NULL первыми — самые устаревшие идут
    первыми (та же логика, что last_successful_check у watchlist).
    """
    return sorted(
        items,
        key=lambda p: (1, p.last_scan.timestamp()) if p.last_scan is not None else (0, 0.0),
    )


def select_by_tempo(items: list[ItemPlan], cycle: int) -> list[ItemPlan]:
    """Холодные артефакты попадают в очередь только на каждом N-м цикле."""
    if cycle % FEED_COLD_EVERY_N_CYCLES == 0:
        return list(items)
    return [p for p in items if p.hot]


def in_history_window(now: datetime) -> bool:
    """
    Идёт ли сейчас окно collect_all_history (минуты :00–:11).

    Минута часа одинакова в UTC и в МСК (смещение кратно часу), поэтому
    рассогласования с crontab-расписанием beat (timezone="Europe/Moscow") нет.
    """
    return now.minute < FEED_HISTORY_WINDOW_END_MIN


def budget_units_for(now: datetime) -> int:
    """Бюджет прогона: урезанный внутри окна истории, полный вне его."""
    return FEED_WINDOW_BUDGET_UNITS_PER_MIN if in_history_window(now) else FEED_BUDGET_UNITS_PER_MIN


def rate_guard_for(now: datetime) -> int:
    """Порог предохранителя по фактическому расходу: строже внутри окна истории."""
    return FEED_WINDOW_RATE_GUARD_UNITS if in_history_window(now) else FEED_RATE_GUARD_UNITS


def plan_run(items: list[ItemPlan], budget_units: int) -> tuple[list[ItemPlan], int]:
    """
    Отбирает предметы, укладывающиеся в бюджет прогона.

    Предмет берётся ЦЕЛИКОМ или не берётся вовсе: частичная пагинация даёт
    неполный срез и воспроизводит ловушку «первая страница /lots — не самые
    дешёвые лоты».

    Возвращает (выбранные предметы, оценка расхода в единицах).
    """
    selected: list[ItemPlan] = []
    spent = 0
    for plan in items:
        cost = plan.pages * FEED_LOTS_REQUEST_COST
        if spent + cost > budget_units:
            continue    # не влез — доберётся следующим циклом (deferred)
        selected.append(plan)
        spent += cost
    return selected, spent


def lot_price_per_unit(lot: dict) -> int:
    """Цена за штуку — та же трактовка, что в collectors._collect_lots_for_item."""
    price  = lot.get("buyoutPrice", 0) or lot.get("startPrice", 0)
    amount = lot.get("amount", 1)
    return price // amount if amount > 0 else price


def lot_identity_key(lot: dict, master=None) -> str:
    """
    lot_key строки feed_lots — идентичность лота в пределах (item_id, region).

    startTime сам по себе НЕ идентификатор лота: точность API — секунды, и у
    одного предмета регулярно висят РАЗНЫЕ лоты с одинаковым startTime
    (подтверждённый пример: wg53, 2026-08-03T13:33:08Z — 649999 ₽ qlt=1 ptn=5
    и 550000 ₽ qlt=1 ptn=4). Два таких лота в одном батче апсерта роняли весь
    INSERT и вместе с ним весь цикл сбора (CardinalityViolationError:
    «ON CONFLICT DO UPDATE command cannot affect row a second time»).

    Ключ собирается из всего, что API отдаёт про лот и что различает два
    одновременно выставленных лота: startTime | qlt | ptn | buyoutPrice |
    amount. Без startTime ключа нет (пустая строка) — такой лот не сохраняем.
    """
    from app.services.analytics.pricing import resolve_variant_key

    start = lot.get("startTime") or ""
    if not start:
        return ""
    # master нужен только не-артефактам: у снаряжения качества в lot["additional"]
    # нет, оно берётся из каталога (§3.2 ТЗ feed-gear-expansion.md).
    qlt, ptn = resolve_variant_key(lot.get("additional"), master)
    return f"{start}|{qlt}|{ptn}|{lot.get('buyoutPrice') or 0}|{lot.get('amount') or 0}"


def dedupe_rows(rows: list[dict]) -> list[dict]:
    """
    Схлопывает строки с одинаковым (item_id, region, lot_key) — побеждает последняя.

    Страховка второго уровня, независимая от схемы ключа: pg_insert(...)
    .on_conflict_do_update падает целиком, если один ключ встретился в батче
    дважды, и роняет ВЕСЬ цикл, а не одну строку. Составной lot_identity_key
    делает коллизию маловероятной, но не невозможной — два полностью
    неразличимых по данным API лота (одна секунда, одно качество, заточка,
    цена и количество) остаются возможными.
    """
    unique: dict[tuple[str, str, str], dict] = {}
    for row in rows:
        unique[(row["item_id"], row["region"], row["lot_key"])] = row
    return list(unique.values())


def sale_values(item_id: str, region: str, record: dict) -> dict | None:
    """
    Строка sales_history из записи ответа /history.

    user_id = NULL — глобально собранная продажа (вне чьего-либо watchlist).
    additional_info берём напрямую из record["additional"] — authoritative
    источник qlt/ptn (docs/tasks/sales-history-qlt-ptn-coverage.md).
    Снэпшот-матчинг lot_start здесь не делаем: collected_data по артефактам
    вне watchlist пуст.
    """
    sold_at_str = record.get("time")
    if not sold_at_str:
        return None
    try:
        sold_at = datetime.fromisoformat(sold_at_str.replace("Z", "+00:00"))
    except ValueError:
        return None

    total_price = record.get("price", 0) or 0
    amount      = record.get("amount", 1) or 0
    if total_price <= 0 or amount <= 0:
        return None

    additional = record.get("additional") or {}
    return {
        "user_id":            None,
        "item_id":            item_id,
        "region":             region,
        "sale_time":          sold_at,
        "price_per_unit":     total_price // amount,
        "amount":             amount,
        "total_price":        total_price,
        "additional_info":    additional or None,
        "will_be_deleted_at": sold_at + timedelta(days=SALES_RETENTION_DAYS),
    }


def supply_coverage_days(total_amount: int, sales_per_day: float | None) -> float | None:
    """
    За сколько дней рынок переварит нынешнее предложение варианта.

    Σ amount всех лотов варианта в срезе / продаж в день. Без продаж делить
    не на что — None (а не «бесконечность»): ответ «не продастся» даёт риск,
    а не эта метрика.
    """
    if not sales_per_day or sales_per_day <= 0:
        return None
    return round(total_amount / sales_per_day, 2)


def score_item_lots(
    item_id: str,
    region: str,
    lots: list[dict],
    variants: dict[tuple[int, int], object],
    cycle_started_at: datetime,
    now: datetime | None = None,
    survival=None,
    master=None,
) -> list[dict]:
    """
    Скоринг лотов предмета -> строки feed_lots (ТОЛЬКО выгодные).

    variants — карта (qlt, ptn) -> строка artifact_variant_stats предмета.
    Вариант без ref_price/sell_options пропускается целиком: без реальных
    сделок нет честной опоры, а считать выгодность от цен выставленных лотов —
    ровно та ошибка, на которой фича умерла дважды (docs/CHANGELOG.md).

    master — строка master_items предмета. Обязательна для не-артефактов: у
    снаряжения качество является свойством ПРЕДМЕТА, и без неё ключ варианта
    разошёлся бы с ключом продаж — лента по снаряжению вернула бы ноль строк
    без единой ошибки в логах (§3.2 ТЗ). master=None означает «артефакт».

    Формулы не форкаются: evaluate_lot_profit вызывается с min_margin_pct=0.0
    (порог видимости персональный и применяется при чтении), поэтому None
    возвращается только для убыточных лотов.
    """
    from app.services.analytics.pricing import (
        COMMISSION, RISK_MARGIN_MULT, _is_liquid, resolve_variant_key,
        evaluate_lot_profit, tier_prices,
    )
    from app.services.feed.scope import CLASS_ARTEFACT, feed_item_class

    now = now or cycle_started_at
    rows: list[dict] = []
    # Класс предмета — измерение кривой дожития: снаряжению артефактная кривая
    # чужая, и подставлять её нельзя (§3.3 ТЗ).
    item_class = feed_item_class(master.category) if master is not None else CLASS_ARTEFACT

    # Лестница цен стакана — для страты по позиции ПЛАНОВОЙ цены продажи.
    # В ленте берётся позиционная страта, а не ценовая, потому что стакан у
    # сборщика в руках и позиция есть даже у вариантов без опоры; по силе
    # признаки сопоставимы (docs/tasks/sale-survival-curve.md §2.3).
    ladders = variant_ladders(lots, now, master) if survival else {}

    # Предложение варианта — по ВСЕМ лотам среза (в т.ч. неликвидным по сроку:
    # они всё равно висят на рынке), поэтому считается отдельным проходом.
    supply: dict[tuple[int, int], int] = {}
    for lot in lots:
        amount = lot.get("amount", 1)
        if amount and amount > 0:
            variant = resolve_variant_key(lot.get("additional"), master)
            supply[variant] = supply.get(variant, 0) + amount

    for lot in lots:
        buyout = lot.get("buyoutPrice", 0) or 0
        amount = lot.get("amount", 1) or 0
        lot_key = lot_identity_key(lot, master)
        if buyout <= 0 or amount <= 0 or not lot_key:
            continue
        if not _is_liquid(lot, now):
            continue

        qlt, ptn = resolve_variant_key(lot.get("additional"), master)
        variant = variants.get((qlt, ptn))
        if variant is None or not variant.ref_price or not variant.sell_options:
            continue

        risk = variant.risk or "medium"
        buyout_per_unit = buyout // amount
        evaluated = evaluate_lot_profit(
            buyout_per_unit, amount, variant.sell_options, risk,
            min_margin_pct=0.0, batch_stats=variant.batch_stats,
        )
        if evaluated is None:
            continue

        profit_pct = float(evaluated["profit_pct"])
        if profit_pct > FEED_MAX_PROFIT_PCT:
            logger.warning(
                "feed: лот %s %s (qlt=%s ptn=%s) с прибылью %.1f%% отброшен как глитч",
                item_id, lot_key, qlt, ptn, profit_pct,
            )
            continue

        risk_mult = RISK_MARGIN_MULT.get(risk, 1.0)
        sales_per_day = float(variant.sales_per_day) if variant.sales_per_day else None
        fast = next((o for o in variant.sell_options if o["label"] == "fast"), None)

        # ₽/час: в таблице показывается прибыль ВСЕГО лота за час
        # (profit_total / est_sell_hours), а evaluate_lot_profit считает
        # profit_per_hour НА ЕДИНИЦУ. Для amount > 1 это разные величины ровно
        # в amount раз, и сортировка по колонке «на единицу» инвертировала
        # выдачу относительно показанного числа. Показываемую величину
        # материализуем здесь — той же формулой, что печатает UI.
        hours = (fast or {}).get("estimated_hours")
        profit_total = evaluated["profit"] * amount

        # Срок и вероятность по позиции ПЛАНОВОЙ цены продажи в стакане
        # (P1-4 фаза B). Считаем от цены, по которой СОБИРАЕМСЯ продать, а не
        # от цены покупки: вопрос «за сколько уйдёт то, что я куплю».
        #
        # Сценариев два, и это главное, что видит пользователь:
        #   быстро  — цена тира fast (та, по которой считается profit_total);
        #   дороже  — цена тира premium, если готов подождать.
        # Замер на проде: верхняя цена даёт в среднем +451 % прибыли, потому
        # что прибыль — это РАЗНОСТЬ «продажа минус закупка», и при тонкой
        # марже +12.8 % к цене умножают её в разы. Платится ~17 п.п.
        # вероятности. До этого лента показывала только нижний сценарий.
        ladder = ladders.get((qlt, ptn)) if survival else None

        def _scenario(sell_price: int):
            """(часы, P(продан <= 6 ч), доля продавшихся) для цены продажи."""
            if not survival or not ladder or not sell_price:
                return None, None, None
            from app.services.analytics.survival import FEATURE_POS, pos_bucket
            rank, book = rank_for_price(ladder, sell_price)
            bucket = pos_bucket(rank, book)
            summary = survival.summary(item_class, FEATURE_POS, bucket)
            if summary is None:
                return None, None, None
            h6 = survival.get(item_class, FEATURE_POS, bucket, 6)
            return (
                summary.median_hours,
                h6.p_sold_lo if h6 else None,
                summary.pct_sold_ever,
            )

        fast_hours, p_sold_6h, pct_sold_ever = _scenario(evaluated["sell_price_used"])
        if fast_hours is not None:
            hours = fast_hours

        # Сценарий ожидания. Цену берём из того же tier_prices, что и везде:
        # вторая копия множителей уже расходилась с первой.
        slow_price = tier_prices(int(variant.ref_price))["premium"]
        profit_total_slow = int(slow_price * amount * (1 - COMMISSION)) - buyout
        slow_hours, p_sold_6h_slow, _ = _scenario(slow_price)

        # Ожидаемая прибыль — максимум по сценариям: рациональный игрок выбирает
        # лучшую стратегию для каждого лота, а не одну на всю ленту. Без
        # измеренной вероятности величины не существует (подставлять p = 1
        # значило бы вернуть допущение «продастся обязательно»).
        candidates = [
            int(p / 100.0 * v)
            for p, v in ((p_sold_6h, profit_total), (p_sold_6h_slow, profit_total_slow))
            if p is not None and v > 0
        ]
        ev_profit = max(candidates) if candidates else None

        rows.append({
            "item_id":            item_id,
            "region":             region,
            "lot_key":            lot_key,
            "qlt":                qlt,
            "ptn":                ptn,
            "amount":             amount,
            "buyout_price":       buyout,
            "buyout_per_unit":    buyout_per_unit,
            "start_time":         _parse_lot_time(lot.get("startTime")),
            "end_time":           _parse_lot_time(lot.get("endTime")),
            "ref_price":          int(variant.ref_price),
            "sell_price_used":    evaluated["sell_price_used"],
            "breakeven_per_unit": evaluated["breakeven_per_unit"],
            "profit_per_unit":    evaluated["profit"],
            "profit_total":       profit_total,
            "profit_pct":         profit_pct,
            "margin_adj_pct":     round(profit_pct / risk_mult, 2),
            "profit_per_hour":    evaluated["profit_per_hour"],
            "profit_per_hour_total": round(profit_total / hours, 2) if hours else None,
            "ev_profit":          ev_profit,
            "est_sell_hours":     hours,
            "p_sold_6h":          p_sold_6h,
            "pct_sold_ever":      pct_sold_ever,
            "profit_total_slow":   profit_total_slow,
            "est_sell_hours_slow": slow_hours,
            "p_sold_6h_slow":      p_sold_6h_slow,
            "risk":               risk,
            "risk_mult":          risk_mult,
            "volatility_7d":      float(variant.volatility_7d) if variant.volatility_7d is not None else None,
            "trend_24h":          variant.trend_24h,
            "trend_24h_pct":      float(variant.trend_24h_pct) if variant.trend_24h_pct is not None else None,
            "trend_7d_pct":       float(variant.trend_7d_pct) if variant.trend_7d_pct is not None else None,
            "sales_per_day":      sales_per_day,
            "supply_coverage_days": supply_coverage_days(supply.get((qlt, ptn), 0), sales_per_day),
            "stats_confidence":   variant.ref_confidence,
            "stats_samples":      variant.ref_samples,
            "first_seen_at":      cycle_started_at,
            "seen_at":            cycle_started_at,
        })

    return rows


def _live_by_variant(
    lots: list[dict], now: datetime, master=None,
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """
    Живые лоты среза по вариантам: (qlt, ptn) -> [(цена за единицу, количество)].

    Общий примитив для variant_queues (позиция наблюдаемого лота) и
    variant_ladders (позиция ПЛАНОВОЙ цены продажи). Правило «живой» —
    ликвидный по _is_liquid, >= 2 ч до конца аукциона — обязано быть одним:
    две копии этого фильтра означали бы, что позиция в стакане при записи
    наблюдения и при прогнозе срока считается по разным книгам.
    """
    from app.services.analytics.pricing import _is_liquid, resolve_variant_key

    live: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for lot in lots:
        amount = lot.get("amount", 1) or 0
        buyout = lot.get("buyoutPrice", 0) or 0
        if buyout <= 0 or amount <= 0 or not _is_liquid(lot, now):
            continue
        variant = resolve_variant_key(lot.get("additional"), master)
        live.setdefault(variant, []).append((buyout // amount, amount))
    return live


def variant_ladders(
    lots: list[dict], now: datetime, master=None,
) -> dict[tuple[int, int], list[int]]:
    """
    Отсортированные цены живых лотов по вариантам — «лестница» стакана.

    Нужна, чтобы ответить на вопрос прогноза: если я выставлю по цене P, каким
    по счёту я встану. variant_queues отвечает на другой вопрос — где стоит
    УЖЕ выставленный лот, — и её карта цен содержит только существующие цены.
    """
    return {
        variant: sorted(price for price, _ in entries)
        for variant, entries in _live_by_variant(lots, now, master).items()
    }


def rank_for_price(ladder: list[int], price: int) -> tuple[int, int]:
    """
    (ранг, размер книги) для произвольной цены. Ранг = 1 + число лотов строго
    дешевле — то же определение, что в variant_queues, иначе страта при
    прогнозе не совпала бы со стратой, по которой кривая построена.
    """
    return bisect_left(ladder, price) + 1, len(ladder)


def variant_queues(
    lots: list[dict], now: datetime, master=None,
) -> dict[tuple[int, int], tuple[dict[int, tuple[int, int]], int]]:
    """
    Очередь по цене внутри каждого варианта: (qlt, ptn) -> (карта цены, живых лотов).

    Карта цены: buyout_per_unit -> (queue_rank, cheaper_units), где rank = 1 +
    число живых лотов СТРОГО дешевле, а cheaper_units = Σ amount тех же строго
    дешёвых лотов. Ранг «соревновательный»: у лотов с одинаковой ценой он один
    и тот же — иначе порядок внутри группы пришлось бы доопределять чем-то
    произвольным, и одно и то же состояние рынка давало бы разные числа.

    Очередь считается ПО ВАРИАНТУ (item_id, qlt, ptn), не по предмету: качество
    и заточка — главный ценообразующий признак, и агрегат по предмету смешивает
    разные товары.

    Живой = ликвидный по общему критерию (_is_liquid, >= 2 ч до конца): лот в
    последние два часа аукциона очередь покупателю не создаёт.
    """
    live = _live_by_variant(lots, now, master)

    queues: dict[tuple[int, int], tuple[dict[int, tuple[int, int]], int]] = {}
    for variant, entries in live.items():
        entries.sort()
        ranks: dict[int, tuple[int, int]] = {}
        cheaper_lots = cheaper_units = 0
        for price, amount in entries:
            # Первая встреча цены — все просмотренные лоты строго дешевле неё.
            if price not in ranks:
                ranks[price] = (cheaper_lots + 1, cheaper_units)
            cheaper_lots += 1
            cheaper_units += amount
        queues[variant] = (ranks, len(entries))
    return queues


def observation_rows(
    item_id: str,
    region: str,
    lots: list[dict],
    variants: dict[tuple[int, int], object],
    seen_at: datetime,
    master=None,
) -> list[dict]:
    """
    Строки lot_observations по срезу предмета — для ВСЕХ лотов, а не выгодных.

    Отличие от score_item_lots принципиальное и намеренное: там отбор по
    прибыльности (это и есть назначение feed_lots), здесь — вся популяция
    рынка. Кривая дожития, построенная только по прибыльным (то есть дешёвым)
    лотам, систематически завысит вероятность продажи.

    Не фильтруем и по ликвидности (_is_liquid): лот в последние 2 часа
    аукциона — как раз тот случай, ради которого различаются expired и
    withdrawn.

    ref_price_at_seen берётся из уже загруженных variants и пишется СРАЗУ:
    artifact_variant_stats перезаписывается каждый час, и через неделю опору
    на момент наблюдения не восстановить. Отсутствие опоры (нет сделок либо
    ниже пола по данным, P0-2) — это NULL, а не повод пропустить лот.

    Позиция в очереди по цене (queue_rank / cheaper_units / variant_live_lots)
    пишется здесь по той же причине, что и опора: восстановить её задним числом
    нельзя — нужен весь срез варианта на тот момент, — а сборщик держит стакан
    в руках в этом же проходе. Заполняется ТОЛЬКО при вставке (первое
    наблюдение); при повторной встрече лота не трогается, см.
    observation_update_columns. Времязависимые версии этих признаков (как
    позиция менялась за жизнь лота) — сознательно фаза B.

    Пропускаются только лоты, по которым нечего наблюдать: без buyoutPrice
    (продаются лишь ставками, сделку с ними не сматчить), без amount и без
    startTime (нет ключа идентичности — см. lot_identity_key).
    """
    from app.services.analytics.pricing import _is_liquid, resolve_variant_key

    queues = variant_queues(lots, seen_at, master)

    rows: list[dict] = []
    for lot in lots:
        buyout  = lot.get("buyoutPrice", 0) or 0
        amount  = lot.get("amount", 1) or 0
        lot_key = lot_identity_key(lot, master)
        start   = _parse_lot_time(lot.get("startTime"))
        if buyout <= 0 or amount <= 0 or not lot_key or start is None:
            continue

        qlt, ptn = resolve_variant_key(lot.get("additional"), master)
        variant  = variants.get((qlt, ptn))
        ref      = getattr(variant, "ref_price", None)

        # Неликвидный лот в очереди не стоит: у него все три поля NULL, а не
        # ноль — «не участвовал» и «первый в очереди» не должны слипнуться.
        ranks, live_lots = queues.get((qlt, ptn), ({}, 0))
        place = ranks.get(buyout // amount) if _is_liquid(lot, seen_at) else None

        rows.append({
            "source":            LOT_OBS_SOURCE_LIVE,
            "item_id":           item_id,
            "region":            region,
            "qlt":               qlt,
            "ptn":               ptn,
            "lot_key":           lot_key,
            "start_time":        start,
            "end_time":          _parse_lot_time(lot.get("endTime")),
            "amount":            amount,
            "buyout_price":      buyout,
            "buyout_per_unit":   buyout // amount,
            "ref_price_at_seen": int(ref) if ref else None,
            "queue_rank":        place[0] if place else None,
            "cheaper_units":     place[1] if place else None,
            "variant_live_lots": live_lots if place else None,
            "first_seen_at":     seen_at,
            "last_seen_at":      seen_at,
        })

    return rows


def observation_update_columns() -> set[str]:
    """
    Колонки, обновляемые апсертом наблюдения при повторной встрече лота.

    Обновляется по сути только last_seen_at. Не обновляются: ключ
    идентичности, first_seen_at (иначе теряется момент появления — основа
    времени дожития), ref_price_at_seen (опора нужна НА МОМЕНТ ПЕРВОГО
    наблюдения, иначе через сутки в строке окажется свежая опора и связь
    «цена vs вероятность продажи» рассыплется), состояние стакана
    (queue_rank / cheaper_units / variant_live_lots — по той же причине: это
    снимок условий, в которых лот был ВЫСТАВЛЕН) и поля исхода, которые ставит
    резолвер.

    Уже закрытую строку апсерт не переоткрывает: если предмет надолго выпал из
    обхода (парковка после отказов) и резолвер успел закрыть его живые лоты,
    вернувшийся лот обновит last_seen_at при сохранённом исходе. Такие строки
    видны в фазе B по last_seen_at > resolved_at и отбраковываются там.
    """
    from app.models.models import LotObservation

    frozen = {
        "id", "source", "item_id", "region", "lot_key", "qlt", "ptn",
        "start_time", "end_time", "amount", "buyout_price", "buyout_per_unit",
        "ref_price_at_seen", "queue_rank", "cheaper_units", "variant_live_lots",
        "first_seen_at", "outcome", "resolved_at", "matched_sale_id",
    }
    return {col.name for col in LotObservation.__table__.columns} - frozen


def sale_matches(obs, sale_time: datetime, total_price: int, amount: int) -> bool:
    """
    Та же сделка, что наблюдаемый лот: цена всего лота, количество и окно времени.

    Матч тот же, что у collectors.find_lot_info (восстановление lot_start), но с
    другой стороны: там от сделки ищут лот в снэпшоте, здесь от лота — сделку.
    Верхняя граница окна — last_seen_at + RESOLVE_DELAY: между последним
    наблюдением и продажей лежит интервал обхода, а сама продажа могла
    случиться уже после того, как лот пропал из скана.
    """
    return (
        total_price == obs.buyout_price
        and amount == obs.amount
        and obs.first_seen_at <= sale_time
        <= obs.last_seen_at + timedelta(hours=LOT_OBS_RESOLVE_DELAY_HOURS)
    )


def resolve_cutoff(now: datetime) -> datetime:
    """
    Граница выборки резолвера: строки с last_seen_at ПОЗЖЕ неё не трогаем.

    Отставание не техническая осторожность, а свойство данных: продажи
    артефактов приезжают часовой дельтой (collect_artifact_history, :15), и
    сразу после исчезновения лота его сделки в sales_history ещё нет.
    """
    return now - timedelta(hours=LOT_OBS_RESOLVE_DELAY_HOURS)


def classify_outcome(
    obs,
    sales: list[tuple[datetime, int, int, int]],
    used_sale_ids: set[int] | frozenset[int] = frozenset(),
) -> tuple[str, int | None]:
    """
    Исход наблюдения: (sold|expired|withdrawn, id закрывшей сделки или None).

    obs — строка lot_observations (нужны buyout_price, amount, first_seen_at,
    last_seen_at, end_time), sales — сделки ТОГО ЖЕ предмета и варианта,
    кортежи (sale_time, sale_id, total_price, amount), упорядоченные по времени.

    Сделка РАСХОДУЕТСЯ: берётся самая ранняя подходящая из ещё не занятых
    (used_sale_ids — занятые в этом прогоне и в прошлых, по matched_sale_id).
    Раньше искалась любая подходящая, и одна продажа помечала sold все
    неразличимые наблюдения — тот же предмет, вариант, цена лота и количество.
    Замер на проде: 47.5% строк sold сидели в таких группах (худшая — 42
    наблюдения на одну возможную сделку), то есть доля продаж была не оценкой,
    а завышенной верхней границей. Если свободной сделки нет, наблюдение идёт
    по обычным правилам в expired / withdrawn.

    expired — лот дожил до конца аукциона и не был куплен: для survival-анализа
    это ПОЛНОЕ наблюдение «не продался». withdrawn — пропал раньше end_time:
    ЦЕНЗУРИРОВАННОЕ наблюдение (продавец снял либо матч не нашёл сделку).
    Смешать их — значит систематически исказить кривую, поэтому исходов три,
    а не флаг «продан / не продан».
    """
    for sale_time, sale_id, total_price, amount in sales:
        if sale_id in used_sale_ids:
            continue
        if sale_matches(obs, sale_time, total_price, amount):
            return "sold", sale_id

    tolerance = timedelta(minutes=LOT_OBS_EXPIRE_TOLERANCE_MINUTES)
    if obs.end_time is not None and obs.end_time <= obs.last_seen_at + tolerance:
        return "expired", None

    return "withdrawn", None


def resolve_batch(
    rows,
    sales_by_variant: dict[tuple[str, str, int, int], list[tuple[datetime, int, int, int]]],
    used_sale_ids: set[int] | frozenset[int] = frozenset(),
) -> dict[int, tuple[str, int | None]]:
    """
    Исходы порции наблюдений: id наблюдения -> (исход, id закрывшей сделки).

    Раздача сделок ДЕТЕРМИНИРОВАНА и не зависит от плана запроса: наблюдения
    перебираются от самого старого (first_seen_at, затем id), сделки внутри
    варианта — от самой ранней (sale_time, затем id). Одна сделка достаётся
    ровно одному наблюдению: занятая уходит в used_sale_ids и дальше
    пропускается. Без фиксированного порядка тот же набор строк давал бы разные
    исходы от прогона к прогону.

    used_sale_ids на входе — сделки, уже израсходованные ПРОШЛЫМИ прогонами
    (lot_observations.matched_sale_id): резолвер идёт порциями и обязан помнить,
    что раздал раньше.
    """
    used = set(used_sale_ids)
    ordered_sales = {key: sorted(sales) for key, sales in sales_by_variant.items()}

    outcomes: dict[int, tuple[str, int | None]] = {}
    for obs in sorted(rows, key=lambda r: (r.first_seen_at, r.id)):
        outcome, sale_id = classify_outcome(
            obs, ordered_sales.get((obs.item_id, obs.region, obs.qlt, obs.ptn), []), used,
        )
        if sale_id is not None:
            used.add(sale_id)
        outcomes[obs.id] = (outcome, sale_id)
    return outcomes


def _parse_lot_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ─── Redis: лок, курсор, предохранитель по расходу ───────────────────────────

async def acquire_lock(redis_client) -> bool:
    """
    SET feed:scan:lock NX EX — защита от наложения прогонов: beat каждые 60 с
    при цикле в ~2 мин иначе запустит параллельные обходы и удвоит расход API.
    """
    return bool(await redis_client.set(
        FEED_LOCK_KEY, str(int(time.time())), nx=True, ex=FEED_LOCK_TTL,
    ))


async def release_lock(redis_client) -> None:
    await redis_client.delete(FEED_LOCK_KEY)


async def recent_consumption(redis_client) -> int:
    """
    Фактический расход лимитера: max(текущая неполная минута, предыдущая полная).

    rate_limiter.get_consumption_stats() отдаёт счётчик ТЕКУЩЕЙ минуты — в её
    первые секунды он около нуля и как одиночный сигнал бесполезен. Ключ
    предыдущей минуты жив (EXPIRE 120), поэтому читаем оба. Ядро
    rate_limiter.py при этом не трогаем.
    """
    from app.core.rate_limiter import rate_limiter

    minute = int(time.time() // 60)
    prefix = rate_limiter.REQUESTS_MINUTE_KEY_PREFIX
    try:
        values = await redis_client.mget([f"{prefix}{minute}", f"{prefix}{minute - 1}"])
    except Exception as e:
        logger.warning(f"feed: не удалось прочитать расход лимитера: {e}")
        return 0
    return max((int(v) if v else 0) for v in values)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


async def _load_last_scan(redis_client, item_ids: list[str]) -> dict[str, datetime | None]:
    if not item_ids:
        return {}
    keys = [FEED_SCAN_LAST_PREFIX + item_id for item_id in item_ids]
    try:
        values = await redis_client.mget(keys)
    except Exception as e:
        logger.warning(f"feed: не удалось прочитать курсор обхода: {e}")
        return {item_id: None for item_id in item_ids}
    return {item_id: _parse_iso(raw) for item_id, raw in zip(item_ids, values)}


# ─── Выгрузка и запись ───────────────────────────────────────────────────────

async def fetch_all_lots(
    client, item_id: str, region: str, redis_client=None, delay: float = FEED_REQUEST_DELAY,
) -> tuple[list[dict], int, int]:
    """
    Полная пагинация /lots по data["total"] с потолком FEED_MAX_PAGES_PER_ITEM.

    Возвращает (лоты, total из ответа, число сделанных запросов).
    """
    lots: list[dict] = []
    offset = 0
    total = 0
    requests = 0

    while True:
        data = await client.get_auction_lots(
            item_id, region, offset=offset, limit=FEED_LOTS_PAGE_LIMIT,
            redis_client=redis_client,
        )
        requests += 1
        page = data.get("lots") or []
        lots.extend(page)
        total = int(data.get("total") or 0)

        offset += FEED_LOTS_PAGE_LIMIT
        if (
            not page
            or offset >= total
            or offset >= FEED_MAX_PAGES_PER_ITEM * FEED_LOTS_PAGE_LIMIT
        ):
            break
        await asyncio.sleep(delay)

    return lots, total, requests


async def upsert_feed_rows(db, rows: list[dict]) -> None:
    """
    Апсерт строк feed_lots по (item_id, region, lot_key).

    Батч предварительно схлопывается по ключу (dedupe_rows): повтор ключа
    внутри одного INSERT ... ON CONFLICT DO UPDATE — ошибка уровня всей
    транзакции, а не одной строки.

    first_seen_at ставится только при вставке — в DO UPDATE не входит.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.models import FeedLot

    if not rows:
        return

    values = dedupe_rows(rows)
    if len(values) < len(rows):
        logger.info(
            "feed: схлопнуто неразличимых по данным API лотов в батче: %s",
            len(rows) - len(values),
        )

    stmt = pg_insert(FeedLot).values(values)
    updatable = {
        col.name: stmt.excluded[col.name]
        for col in FeedLot.__table__.columns
        if col.name not in ("id", "item_id", "region", "lot_key", "first_seen_at")
    }
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_id", "region", "lot_key"], set_=updatable,
    )

    await db.execute(stmt)


async def delete_stale_rows(db, item_id: str, region: str, cycle_started_at: datetime) -> int:
    """Лот исчез из среза = выкуплен, истёк или перестал быть выгодным."""
    from sqlalchemy import delete
    from app.models.models import FeedLot

    result = await db.execute(
        delete(FeedLot).where(
            FeedLot.item_id == item_id,
            FeedLot.region == region,
            FeedLot.seen_at < cycle_started_at,
        )
    )
    return result.rowcount or 0


async def upsert_lot_observations(db, rows: list[dict]) -> tuple[int, int]:
    """
    Апсерт строк lot_observations по (item_id, region, lot_key).

    Возвращает (вставлено, обновлено) — объём таблицы ТЗ требует измерить, а не
    угадать (docs/tasks/lot-observations.md §6). Различить вставку и обновление
    в одном INSERT ... ON CONFLICT позволяет системная колонка xmax: у строки,
    вставленной этим же оператором, она нулевая.

    Батчами по LOT_OBS_UPSERT_CHUNK: за полный круг это до 2000 лотов на
    предмет, один гигантский INSERT незачем. Предварительное схлопывание по
    ключу — то же и по той же причине, что в upsert_feed_rows: повтор ключа
    внутри батча роняет весь оператор.
    """
    from sqlalchemy import literal_column
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.models import LotObservation

    if not rows:
        return 0, 0

    values = dedupe_rows(rows)
    updatable = observation_update_columns()

    inserted = updated = 0
    for start in range(0, len(values), LOT_OBS_UPSERT_CHUNK):
        chunk = values[start:start + LOT_OBS_UPSERT_CHUNK]
        stmt = pg_insert(LotObservation).values(chunk)
        stmt = stmt.on_conflict_do_update(
            # source в ключе: восстановленные строки того же лота живут
            # отдельной записью и апсертом ленты не затираются (§2.3 ТЗ).
            index_elements=["source", "item_id", "region", "lot_key"],
            set_={name: stmt.excluded[name] for name in updatable},
        ).returning(literal_column("(xmax = 0)").label("is_insert"))

        for row in (await db.execute(stmt)).all():
            if row.is_insert:
                inserted += 1
            else:
                updated += 1

    return inserted, updated


@dataclass
class ItemScanResult:
    """Итог обработки одного предмета: сколько строк отскорено, убрано, наблюдено."""
    rows_scored: int
    rows_deleted: int
    obs_inserted: int = 0
    obs_updated: int = 0


async def scan_item(
    db, item_id: str, region: str, lots: list[dict], cycle_started_at: datetime,
) -> ItemScanResult:
    """Обработка одного предмета: скоринг -> апсерт -> наблюдения -> уборка -> commit."""
    variants = await _load_variants(db, item_id, region)
    # Предмет каталога нужен целиком: у не-артефактов из него берутся качество
    # (color) и класс кривой дожития (category). Одна строка по уникальному
    # индексу — цена, которую можно платить раз на предмет за цикл.
    master = await _load_master(db, item_id)
    from app.services.analytics.survival import load_survival
    survival = await load_survival(db)
    rows = score_item_lots(
        item_id, region, lots, variants, cycle_started_at,
        survival=survival, master=master,
    )
    await upsert_feed_rows(db, rows)
    obs_inserted, obs_updated = await upsert_lot_observations(
        db, observation_rows(item_id, region, lots, variants, cycle_started_at, master),
    )
    deleted = await delete_stale_rows(db, item_id, region, cycle_started_at)
    await db.commit()

    return ItemScanResult(
        rows_scored=len(rows), rows_deleted=deleted,
        obs_inserted=obs_inserted, obs_updated=obs_updated,
    )


async def note_item_failure(redis_client, item_id: str, cycle_started_at: datetime) -> int:
    """
    Считает подряд идущие отказы предмета и «паркует» его после потолка.

    Парковка = feed:scan:last на FEED_ITEM_PARK_TTL: предмет уходит в конец
    очереди обхода вместо того, чтобы возглавлять её каждый цикл. Сама функция
    исключений не выпускает — недоступный Redis не должен ронять цикл поверх
    уже случившейся ошибки.

    В ключ пишется БУДУЩАЯ метка (cycle_started_at + FEED_ITEM_PARK_TTL), а не
    текущее время: order_queue сортирует по last_scan ASC, и метка «как у
    успешного обхода» отставляла предмет всего на один оборот очереди — QA
    замерил повторный опрос через 3 минуты вместо 900 с, TTL не доживал до
    истечения. Метка из будущего держит предмет в хвосте очереди ровно до
    момента, на который он припаркован.
    """
    try:
        key = FEED_ITEM_FAIL_PREFIX + item_id
        fails = int(await redis_client.incr(key))
        await redis_client.expire(key, FEED_ITEM_FAIL_TTL)
        if fails >= FEED_ITEM_FAIL_MAX:
            await redis_client.setex(
                FEED_SCAN_LAST_PREFIX + item_id, FEED_ITEM_PARK_TTL,
                (cycle_started_at + timedelta(seconds=FEED_ITEM_PARK_TTL)).isoformat(),
            )
            logger.error(
                "feed: %s припаркован на %sс после %s отказов подряд — очередь не блокируется",
                item_id, FEED_ITEM_PARK_TTL, fails,
            )
        return fails
    except Exception as e:
        logger.warning("feed: не удалось учесть отказ %s: %s", item_id, e)
        return 0


async def clear_item_failures(redis_client, item_id: str) -> None:
    """Успешный обход обнуляет счётчик отказов (он про ПОДРЯД идущие неудачи)."""
    try:
        await redis_client.delete(FEED_ITEM_FAIL_PREFIX + item_id)
    except Exception as e:
        logger.warning("feed: не удалось сбросить счётчик отказов %s: %s", item_id, e)


async def safe_scan_item(
    db, redis_client, item_id: str, region: str, lots: list[dict], cycle_started_at: datetime,
) -> ItemScanResult | None:
    """
    scan_item с изоляцией отказа: ошибка на одном предмете не роняет цикл.

    Без этого любое исключение записи (пример из практики —
    CardinalityViolationError на дубле ключа в батче) убивает задачу целиком,
    feed:scan:last предмета не обновляется, и он снова идёт первым в следующем
    цикле: падение каждые 60 с и бесконечная трата лимита API. Причину того
    случая устранил составной lot_identity_key, механизм закрывает эта функция.
    """
    try:
        result = await scan_item(db, item_id, region, lots, cycle_started_at)
    except Exception as e:
        logger.error("feed: обработка %s не удалась: %s", item_id, e, exc_info=True)
        try:
            await db.rollback()
        except Exception as rollback_error:
            logger.error("feed: откат транзакции %s не удался: %s", item_id, rollback_error)
        await note_item_failure(redis_client, item_id, cycle_started_at)
        return None

    await clear_item_failures(redis_client, item_id)
    return result


async def _load_variants(db, item_id: str, region: str) -> dict[tuple[int, int], object]:
    """Карта (qlt, ptn) -> строка artifact_variant_stats предмета — опора скоринга."""
    from sqlalchemy import select
    from app.models.models import ArtifactVariantStats

    rows = (await db.execute(
        select(ArtifactVariantStats).where(
            ArtifactVariantStats.item_id == item_id,
            ArtifactVariantStats.region == region,
        )
    )).scalars().all()
    return {(row.qlt, row.ptn): row for row in rows}


async def _load_master(db, item_id: str):
    """Строка master_items предмета — источник качества и класса не-артефактов."""
    from sqlalchemy import select
    from app.models.models import MasterItem

    return (await db.execute(
        select(MasterItem).where(MasterItem.item_id == item_id)
    )).scalar_one_or_none()


async def _load_observed_yield(db, region: str, now: datetime) -> dict[str, int]:
    """
    Сколько ВЫГОДНЫХ лотов сборщик видел у каждого предмета за
    FEED_YIELD_WINDOW_HOURS.

    Один агрегатный запрос на цикл по уже собираемым наблюдениям — к внешнему
    API не обращается и бюджет не расходует. Соединение с artifact_variant_stats
    не нужно: опора варианта записана в саму строку наблюдения
    (ref_price_at_seen) именно для таких вопросов.

    Порог тот же, что у нижнего тира скоринга (FAST_RATIO с поправкой на
    комиссию): вторая копия правила разошлась бы с первой, и планировщик стал
    бы считать выгодным не то, что показывает лента.

    В словаре только предметы, у которых выгода БЫЛА; отсутствие трактуется в
    observed_yield.
    """
    from sqlalchemy import func, select
    from app.models.models import LotObservation
    from app.services.analytics.pricing import COMMISSION, FAST_RATIO

    rows = (await db.execute(
        select(LotObservation.item_id, func.count())
        .where(
            LotObservation.source == LOT_OBS_SOURCE_LIVE,
            LotObservation.region == region,
            LotObservation.last_seen_at >= now - timedelta(hours=FEED_YIELD_WINDOW_HOURS),
            LotObservation.ref_price_at_seen > 0,
            LotObservation.buyout_per_unit
                < LotObservation.ref_price_at_seen * FAST_RATIO * (1 - COMMISSION),
        )
        .group_by(LotObservation.item_id)
    )).all()
    return {item_id: count for item_id, count in rows}


async def _feed_items(db) -> list[tuple[str, int | None]]:
    """
    Набор ленты: артефакты, снаряжение высоких рангов, части предметов, премиум
    и сезонные пропуска — ровно то, что описывает feed_scope_clause (§3.1 ТЗ
    feed-gear-expansion.md). Возвращает пары (item_id, lots_total).

    Торгуемость строгая (on_auction IS TRUE): предмет с FALSE/NULL не даст ни
    одной строки, а бюджет API на его опрос потратится.
    """
    from sqlalchemy import select
    from app.models.models import MasterItem
    from app.services.feed.scope import feed_scope_clause

    rows = (await db.execute(
        select(MasterItem.item_id, MasterItem.lots_total)
        .where(feed_scope_clause())
        .order_by(MasterItem.item_id)
    )).all()
    return [(row.item_id, row.lots_total) for row in rows]


# ─── Celery-задачи ───────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.feed_collector.collect_artifact_lots", bind=True, max_retries=0)
def collect_artifact_lots(self):
    """
    Обход артефактов рынка с полной пагинацией /lots и записью выгодных лотов.

    Beat каждые 60 с; задача сама решает, какие предметы «созрели» (как
    collect_all_active_lots). Расход одного прогона ограничен
    FEED_BUDGET_UNITS_PER_MIN, дополнительно — предохранитель по фактическому
    расходу лимитера (FEED_RATE_GUARD_UNITS). В окне collect_all_history
    (:00–:11) действуют урезанные FEED_WINDOW_* — цикл не пропускается, но
    уступает всплеску watchlist-истории. Коммит после каждого предмета —
    прогресс не теряется при рестарте воркера/деплое.

    bind=True, max_retries=0: ретраи внутренние (на уровне одного предмета),
    падение на одном предмете не рестартует весь прогон. Ошибка ЛЮБОЙ стадии
    предмета (выгрузка, кэш, запись в БД) изолируется: транзакция откатывается,
    предмет учитывается в счётчике отказов, цикл идёт дальше.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import ArtifactVariantStats
        from app.services.cache.api_cache import api_cache
        from app.services.collector.client import stalcraft_client
        from app.core.config import settings
        from sqlalchemy import func, select
        import redis.asyncio as aioredis

        # Джиттер до всего остального: разводит запросы ленты и watchlist-тик,
        # которые beat выпускает в одну секунду (см. FEED_CYCLE_JITTER_SEC).
        await asyncio.sleep(random.uniform(0, FEED_CYCLE_JITTER_SEC))

        region = settings.stalcraft_region
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

        try:
            if not await acquire_lock(redis_client):
                logger.info("feed: предыдущий цикл ещё идёт, пропуск")
                return

            try:
                cycle = int(await redis_client.incr(FEED_CYCLE_KEY))
                started = time.monotonic()
                cycle_started_at = datetime.now(timezone.utc)

                async with get_db_session() as db:
                    # Опора скоринга — artifact_variant_stats. Пока ни у одного
                    # варианта нет ref_price (Фаза 2 / бэкфилл истории), выгодных
                    # лотов быть не может по построению, а обход стоил бы до
                    # 200 ед/мин лимита впустую.
                    refs_ready = (await db.execute(
                        select(func.count()).select_from(ArtifactVariantStats)
                        .where(
                            ArtifactVariantStats.region == region,
                            ArtifactVariantStats.ref_price.is_not(None),
                        )
                    )).scalar_one()
                    if not refs_ready:
                        logger.warning(
                            "feed cycle #%s: нет ни одного варианта с ref_price "
                            "(artifact_variant_stats пуста) — обход пропущен, "
                            "лимит API не расходуется", cycle,
                        )
                        return

                    items = await _feed_items(db)
                    if not items:
                        logger.warning("feed cycle #%s: набор ленты пуст", cycle)
                        return

                    sales_map = dict((await db.execute(
                        select(
                            ArtifactVariantStats.item_id,
                            func.max(ArtifactVariantStats.sales_per_day),
                        )
                        .where(ArtifactVariantStats.region == region)
                        .group_by(ArtifactVariantStats.item_id)
                    )).all())

                    item_ids = [item_id for item_id, _ in items]
                    last_scan = await _load_last_scan(redis_client, item_ids)
                    # Фактическая отдача: сколько ВЫГОДНЫХ лотов у предмета
                    # видели за сутки. Предмет, который обходился и не дал ни
                    # одного, уходит в холодные — см. is_hot.
                    yield_map = await _load_observed_yield(db, region, cycle_started_at)
                    window_start = cycle_started_at - timedelta(hours=FEED_YIELD_WINDOW_HOURS)

                    plans = [
                        ItemPlan(
                            item_id=item_id,
                            pages=pages_for_total(lots_total),
                            hot=is_hot(
                                lots_total,
                                float(sales_map[item_id]) if sales_map.get(item_id) is not None else None,
                                observed_yield(
                                    item_id, yield_map, last_scan.get(item_id), window_start,
                                ),
                            ),
                            last_scan=last_scan.get(item_id),
                        )
                        for item_id, lots_total in items
                    ]
                    queue = select_by_tempo(order_queue(plans), cycle)
                    # В окне collect_all_history (:00–:11) лента уступает: бюджет
                    # урезан, порог предохранителя ниже (см. FEED_WINDOW_*).
                    budget = budget_units_for(cycle_started_at)
                    selected, estimated = plan_run(queue, budget)
                    deferred = len(queue) - len(selected)

                    units = pages = done = guard_trips = item_errors = 0
                    rows_upserted = rows_deleted = 0
                    obs_inserted = obs_updated = 0
                    scanned_now: set[str] = set()

                    for idx, plan in enumerate(selected):
                        # Порог берётся по ТЕКУЩЕМУ времени, а не по старту цикла:
                        # прогон, начатый на :59 с полным бюджетом, заезжает в окно
                        # истории и должен подчиниться его строгому порогу.
                        guard = rate_guard_for(datetime.now(timezone.utc))
                        consumed = await recent_consumption(redis_client)
                        if consumed > guard:
                            guard_trips += 1
                            logger.warning(
                                "feed: расход системы %s ед/мин > %s — цикл прерван, "
                                "остаток предметов доберётся следующим",
                                consumed, guard,
                            )
                            break

                        result = None
                        for attempt in range(FEED_ITEM_RETRIES + 1):
                            try:
                                result = await fetch_all_lots(
                                    stalcraft_client, plan.item_id, region,
                                    redis_client=redis_client,
                                )
                                break
                            except Exception as e:
                                if attempt < FEED_ITEM_RETRIES:
                                    backoff = FEED_RETRY_BACKOFF[min(attempt, len(FEED_RETRY_BACKOFF) - 1)]
                                    logger.warning(
                                        "feed: транзиентная ошибка %s (попытка %s/%s): %s; retry через %ss",
                                        plan.item_id, attempt + 1, FEED_ITEM_RETRIES + 1, e, backoff,
                                    )
                                    await asyncio.sleep(backoff)
                                else:
                                    logger.error(
                                        "feed: %s пропущен после %s попыток: %s",
                                        plan.item_id, FEED_ITEM_RETRIES + 1, e,
                                    )

                        if result is None:
                            # feed:scan:last не обновляем — предмет пойдёт первым
                            # в очереди следующего цикла; после FEED_ITEM_FAIL_MAX
                            # подряд его паркует note_item_failure.
                            item_errors += 1
                            await note_item_failure(redis_client, plan.item_id, cycle_started_at)
                            continue

                        lots, total, requests = result
                        units += requests * FEED_LOTS_REQUEST_COST
                        pages += requests

                        # Общий кэш: GET /lots/{item_id} по артефакту не порождает
                        # собственный запрос к API. Кладём 200 САМЫХ ДЕШЁВЫХ лотов —
                        # строго лучше первой страницы API, которую кладёт
                        # watchlist-коллектор. Сбой записи в кэш — не повод терять
                        # уже оплаченный лимитом срез.
                        try:
                            await api_cache.set_lots(
                                region, plan.item_id,
                                {"total": total, "lots": sorted(lots, key=lot_price_per_unit)[:200]},
                                redis_client=redis_client,
                            )
                        except Exception as e:
                            logger.warning("feed: кэш лотов %s не обновлён: %s", plan.item_id, e)

                        scan = await safe_scan_item(
                            db, redis_client, plan.item_id, region, lots, cycle_started_at,
                        )
                        if scan is None:
                            item_errors += 1
                            continue

                        rows_upserted += scan.rows_scored
                        rows_deleted += scan.rows_deleted
                        obs_inserted += scan.obs_inserted
                        obs_updated += scan.obs_updated

                        await redis_client.setex(
                            FEED_SCAN_LAST_PREFIX + plan.item_id, FEED_SCAN_LAST_TTL,
                            cycle_started_at.isoformat(),
                        )
                        scanned_now.add(plan.item_id)
                        done += 1

                        if units >= budget:
                            break
                        if idx < len(selected) - 1:
                            await asyncio.sleep(FEED_REQUEST_DELAY)

                    logger.info(
                        "feed cycle #%s: items_planned=%s items_done=%s items_failed=%s pages=%s "
                        "units=%s budget=%s%s elapsed=%.1fs deferred=%s guard_trips=%s "
                        "rows_upserted=%s rows_deleted=%s obs_inserted=%s obs_updated=%s "
                        "(оценка расхода при планировании: %s ед)",
                        cycle, len(selected), done, item_errors, pages, units, budget,
                        " (окно истории)" if in_history_window(cycle_started_at) else "",
                        time.monotonic() - started, deferred, guard_trips,
                        rows_upserted, rows_deleted, obs_inserted, obs_updated, estimated,
                    )

                    await _finish_sweep_if_complete(
                        db, redis_client, cycle, plans, scanned_now, cycle_started_at,
                    )
            finally:
                await release_lock(redis_client)
        finally:
            await redis_client.aclose()
            await redis_client.connection_pool.disconnect(inuse_connections=True)

    return run_async(_run())


async def _finish_sweep_if_complete(
    db, redis_client, cycle: int, plans: list[ItemPlan],
    scanned_now: set[str], cycle_started_at: datetime,
) -> None:
    """
    Полный круг = каждый предмет набора обойдён с момента старта круга.

    Логирует длительность круга (метрика калибровки) и убирает осиротевшие
    строки feed_lots — предметов, выпавших из набора (сняты с торгов, удалены
    из каталога).

    Здесь же снимается объём lot_observations: ТЗ требует измерить прирост, а
    не угадать его (docs/tasks/lot-observations.md §6). Раз в круг (~5 мин)
    один COUNT по таблице до ~200 тыс. строк — цена, которую можно платить.
    """
    from sqlalchemy import delete, func, select
    from app.models.models import FeedLot, LotObservation

    raw = await redis_client.get(FEED_SWEEP_KEY)
    sweep_cycle, sweep_started = None, None
    if raw and ":" in raw:
        try:
            sweep_cycle, sweep_ts = raw.split(":", 1)
            sweep_cycle = int(sweep_cycle)
            sweep_started = datetime.fromtimestamp(float(sweep_ts), tz=timezone.utc)
        except ValueError:
            sweep_cycle, sweep_started = None, None

    if sweep_started is None:
        await redis_client.set(FEED_SWEEP_KEY, f"{cycle}:{cycle_started_at.timestamp()}")
        return

    covered = all(
        plan.item_id in scanned_now
        or (plan.last_scan is not None and plan.last_scan >= sweep_started)
        for plan in plans
    )
    if not covered:
        return

    now = datetime.now(timezone.utc)
    logger.info(
        "feed sweep: полный круг за %.0fс (циклов: %s)",
        (now - sweep_started).total_seconds(), cycle - (sweep_cycle or cycle) + 1,
    )
    result = await db.execute(
        delete(FeedLot).where(
            FeedLot.seen_at < now - timedelta(hours=FEED_STALE_ROW_HOURS)
        )
    )
    await db.commit()
    if result.rowcount:
        logger.info("feed sweep: убрано осиротевших строк feed_lots: %s", result.rowcount)

    volume = (await db.execute(
        select(
            func.count(),
            func.count().filter(LotObservation.outcome.is_(None)),
            func.count().filter(LotObservation.ref_price_at_seen.is_not(None)),
        ).select_from(LotObservation)
    )).one()
    logger.info(
        "feed sweep: lot_observations всего=%s открытых=%s с опорой=%s",
        volume[0], volume[1], volume[2],
    )

    await redis_client.set(FEED_SWEEP_KEY, f"{cycle + 1}:{now.timestamp()}")


@celery_app.task(
    name="app.tasks.feed_collector.calculate_artifact_variant_stats", bind=True, max_retries=0,
)
def calculate_artifact_variant_stats(self):
    """
    Пересчёт artifact_variant_stats — опоры скоринга ленты.

    Beat :14,:24,:34,:44,:54 — вне окна collect_all_history (:00–:11) и вне
    слотов calculate_market_stats_batch (:12–:57 шагом 5), чтобы не
    воспроизвести docs/tasks/cpu-spikes-recurring-2026-07-06.md.
    К Stalcraft API не обращается: читает только sales_history.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.core.config import settings
        from app.services.analytics.variant_stats import (
            calculate_artifact_variant_stats as _calculate,
        )

        async with get_db_session() as db:
            return await _calculate(db, settings.stalcraft_region)

    return run_async(_run())


@celery_app.task(name="app.tasks.feed_collector.collect_artifact_history", bind=True, max_retries=0)
def collect_artifact_history(self):
    """
    Часовая дельта /history по всем артефактам -> sales_history (user_id=NULL).

    Без реальных сделок у ленты нет опорной цены, а выгодность считалась бы от
    цен выставленных лотов — ровно та ошибка, на которой фича умерла дважды
    (docs/CHANGELOG.md). Стоимость: ~103 × 2 = 206 ед/час ≈ 3.4 ед/мин В СРЕДНЕМ,
    но тратились они за одну минуту — поэтому обход растянут HISTORY_ITEM_DELAY
    и смещён джиттером (см. P2-5 ревизии QA).
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.core.config import settings
        import redis.asyncio as aioredis

        await asyncio.sleep(random.uniform(0, FEED_HISTORY_JITTER_SEC))

        region = settings.stalcraft_region
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

        stats = {"items": 0, "requests": 0, "inserted": 0, "errors": 0}
        try:
            async with get_db_session() as db:
                items = await _feed_items(db)
                logger.info(
                    "collect_artifact_history: старт region=%s предметов=%s", region, len(items),
                )

                for idx, (item_id, _) in enumerate(items):
                    consumed = await recent_consumption(redis_client)
                    if consumed > FEED_RATE_GUARD_UNITS:
                        logger.warning(
                            "feed history: расход системы %s ед/мин > %s — сбор прерван "
                            "на %s/%s", consumed, FEED_RATE_GUARD_UNITS, idx, len(items),
                        )
                        break

                    try:
                        requests, inserted = await _collect_history_for_artifact(db, item_id, region)
                    except Exception as e:
                        logger.error("feed history: %s пропущен: %s", item_id, e)
                        stats["errors"] += 1
                        continue

                    stats["items"] += 1
                    stats["requests"] += requests
                    stats["inserted"] += inserted

                    if idx < len(items) - 1:
                        await asyncio.sleep(HISTORY_ITEM_DELAY)

                logger.info(
                    "collect_artifact_history: завершено items=%s requests=%s "
                    "(~%s ед лимита) inserted=%s errors=%s",
                    stats["items"], stats["requests"],
                    stats["requests"] * HISTORY_REQUEST_COST, stats["inserted"], stats["errors"],
                )
        finally:
            await redis_client.aclose()
            await redis_client.connection_pool.disconnect(inuse_connections=True)

        return stats

    return run_async(_run())


async def _collect_history_for_artifact(db, item_id: str, region: str) -> tuple[int, int]:
    """
    Дельта /history по предмету: постранично до первой уже известной продажи
    (совпадение по (sale_time, total_price, amount)) либо до
    HISTORY_BACKSTOP_PAGES страниц — часовой дельты хватает с запасом.

    Дедуп — на существующем уникальном индексе uq_sales_history_sale.
    Возвращает (запросов к API, вставлено строк).
    """
    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.models import SalesHistory
    from app.services.collector.client import stalcraft_client

    known_rows = (await db.execute(
        select(SalesHistory.sale_time, SalesHistory.total_price, SalesHistory.amount)
        .where(SalesHistory.item_id == item_id, SalesHistory.region == region)
        .order_by(SalesHistory.sale_time.desc())
        .limit(HISTORY_BACKSTOP_PAGES * HISTORY_PAGE_LIMIT)
    )).all()
    known = {
        (int(row.sale_time.timestamp()), row.total_price, row.amount)
        for row in known_rows
    }

    added: set[tuple[int, int, int]] = set()
    requests = 0
    inserted = 0
    for page in range(HISTORY_BACKSTOP_PAGES):
        data = await stalcraft_client.get_auction_history(
            item_id, region, offset=page * HISTORY_PAGE_LIMIT, limit=HISTORY_PAGE_LIMIT,
        )
        requests += 1
        records = data.get("prices") or []
        if not records:
            break

        hit_known = False
        values: list[dict] = []
        for record in records:
            row = sale_values(item_id, region, record)
            if row is None:
                continue
            key = (int(row["sale_time"].timestamp()), row["total_price"], row["amount"])
            if key in known:
                # Продажа уже в базе — дальше по страницам только более старые.
                hit_known = True
                continue
            if key in added:
                continue  # /history вернул одну продажу дважды в пределах прохода
            added.add(key)
            values.append(row)

        if values:
            result = await db.execute(
                pg_insert(SalesHistory).values(values).on_conflict_do_nothing(
                    index_elements=["item_id", "region", "sale_time", "total_price", "amount"]
                )
            )
            inserted += result.rowcount or 0
            await db.commit()

        if hit_known or len(records) < HISTORY_PAGE_LIMIT:
            break
        await asyncio.sleep(FEED_REQUEST_DELAY)

    return requests, inserted


# ─── Резолвер исходов наблюдений (P1-4 фаза A, §5 ТЗ) ────────────────────────

@celery_app.task(
    name="app.tasks.feed_collector.resolve_lot_observations", bind=True, max_retries=0,
)
def resolve_lot_observations(self):
    """
    Закрывает наблюдения за исчезнувшими лотами: sold / expired / withdrawn.

    Раз в 15 минут, к Stalcraft API не обращается — читает только
    lot_observations и sales_history. Строка берётся не раньше чем через
    LOT_OBS_RESOLVE_DELAY_HOURS после последнего наблюдения: история артефактов
    приходит раз в час, и на свежих строках продажи в sales_history ещё нет —
    резолвер пометил бы их withdrawn.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session

        async with get_db_session() as db:
            now = datetime.now(timezone.utc)
            dark_for = await market_dark_for(db, now)
            if dark_for is not None:
                # Закрывать наблюдения, когда погас весь аукцион, значит
                # записать «лот сняли с продажи» про каждый лот на рынке.
                logger.warning(
                    "резолв пропущен: ни одного лота не видно %.0f мин — "
                    "похоже, аукцион недоступен, а не рынок опустел",
                    dark_for,
                )
                return {"skipped": "market_dark", "dark_minutes": round(dark_for)}
            return await _resolve_observations(db, now)

    return run_async(_run())


async def blackout_orphans(db, ids: list[int], now: datetime) -> set[int]:
    """
    Из переданных наблюдений — те, что пропали вместе со всем рынком.

    Признак не требует хранить интервалы недоступности: если после последнего
    показа лота НИ ОДИН лот не наблюдался ещё MARKET_DARK_MINUTES, значит
    замолчал аукцион целиком, а не исчез конкретный лот. Набор ленты — сотни
    предметов, одновременно опустеть они не могут.
    """
    from sqlalchemy import text

    if not ids:
        return set()

    result = await db.execute(
        text("""
            WITH act AS (
                -- Активность рынка по минутам. Округление обязательно: строки
                -- ОДНОГО прохода различаются секундами и без него ссылались бы
                -- друг на друга («лот в 06:22:10 видит активность в 06:22:50»),
                -- из-за чего осиротевшим не признавался никто.
                SELECT DISTINCT date_trunc('minute', last_seen_at) AS m
                FROM lot_observations
                WHERE source = :live
                  AND last_seen_at >= CAST(:since AS timestamptz)
            ), silence AS (
                -- Минуты, после которых рынок молчал MARKET_DARK_MINUTES.
                -- Хвост исключён: у самой свежей минуты «ничего после» всегда,
                -- и без этого условия живой рынок считался бы погасшим.
                SELECT a.m AS quiet_from
                FROM act a
                WHERE a.m < CAST(:now AS timestamptz)
                            - make_interval(mins => CAST(:dark AS int))
                  AND NOT EXISTS (
                      SELECT 1 FROM act b
                      WHERE b.m >  a.m
                        AND b.m <= a.m + make_interval(mins => CAST(:dark AS int))
                  )
            )
            SELECT o.id
            FROM lot_observations o
            WHERE o.id = ANY(:ids)
              AND EXISTS (
                  SELECT 1 FROM silence s
                  WHERE o.last_seen_at <= s.quiet_from + interval '1 minute'
                    AND o.last_seen_at >= s.quiet_from
                                          - make_interval(mins => CAST(:cycle AS int))
              )
        """),
        {
            "ids": ids,
            "live": LOT_OBS_SOURCE_LIVE,
            "dark": MARKET_DARK_MINUTES,
            "cycle": FEED_FULL_CYCLE_MINUTES,
            "now": now,
            "since": now - timedelta(days=LOT_OBS_RETENTION_DAYS),
        },
    )
    return {row.id for row in result}


async def market_dark_for(db, now: datetime) -> float | None:
    """
    Сколько минут не видно ни одного лота, если рынок погас. Иначе None.

    Момент последнего наблюдения ЛЮБОГО лота — и есть последний момент, когда
    аукцион отвечал. Отдельное состояние для этого заводить не нужно.
    """
    from sqlalchemy import func, select
    from app.models.models import LotObservation

    last_seen = (await db.execute(
        select(func.max(LotObservation.last_seen_at))
        .where(LotObservation.source == LOT_OBS_SOURCE_LIVE)
    )).scalar()
    if last_seen is None:
        return None                      # наблюдений ещё нет — не наш случай
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)

    minutes = (now - last_seen).total_seconds() / 60
    return minutes if minutes > MARKET_DARK_MINUTES else None


async def _resolve_observations(db, now: datetime) -> dict[str, int]:
    """
    Одна порция резолва. Возвращает распределение исходов (метрика §6 ТЗ).

    Сделки грузятся ОДНИМ запросом на всю порцию и раскладываются по варианту:
    построчный поиск дал бы до LOT_OBS_RESOLVE_BATCH запросов за прогон.

    Уже израсходованные сделки (matched_sale_id прошлых прогонов) поднимаются
    диапазоном id — по частичному уникальному индексу uq_lot_obs_matched_sale,
    без раздувания списка параметров. Сам индекс — последний рубеж: если два
    прогона резолвера всё же наложатся, коммит второго упадёт на уникальности,
    а не тихо припишет одну сделку двум наблюдениям.
    """
    from sqlalchemy import select, update
    from app.models.models import LotObservation, MasterItem, SalesHistory
    from app.services.analytics.variant_stats import variant_key

    cutoff = resolve_cutoff(now)
    rows = (await db.execute(
        select(LotObservation)
        .where(
            # Только живые наблюдения: у восстановленных из снапшотов исход уже
            # проставлен скриптом, а оставшийся NULL — намеренное
            # цензурирование (дыра в сборе либо конец окна). Резолвер записал бы
            # их withdrawn и заодно израсходовал бы на них сделки.
            LotObservation.source == LOT_OBS_SOURCE_LIVE,
            LotObservation.outcome.is_(None),
            LotObservation.last_seen_at < cutoff,
        )
        .order_by(LotObservation.last_seen_at)
        .limit(LOT_OBS_RESOLVE_BATCH)
    )).scalars().all()

    stats = {"sold": 0, "expired": 0, "withdrawn": 0, LOT_OBS_OUTCOME_BLACKOUT: 0}
    if not rows:
        logger.info("lot_obs resolve: закрывать нечего")
        return stats

    # Лоты, пропавшие вместе со всем рынком, отделяем ДО классификации: их
    # исчезновение вызвано недоступностью аукциона, а не поведением рынка, и
    # любая метка (withdrawn/expired) была бы враньём.
    orphans = await blackout_orphans(db, [row.id for row in rows], now)
    if orphans:
        await db.execute(
            update(LotObservation)
            .where(LotObservation.id.in_(orphans))
            .values(outcome=LOT_OBS_OUTCOME_BLACKOUT, resolved_at=now)
        )
        stats[LOT_OBS_OUTCOME_BLACKOUT] = len(orphans)
        logger.warning(
            "lot_obs resolve: %s наблюдений исключено как пропавшие вместе с рынком",
            len(orphans),
        )
        rows = [row for row in rows if row.id not in orphans]
        if not rows:
            await db.commit()
            return stats

    item_ids = {row.item_id for row in rows}
    regions  = {row.region for row in rows}
    sales = (await db.execute(
        select(
            SalesHistory.id, SalesHistory.item_id, SalesHistory.region, SalesHistory.sale_time,
            SalesHistory.total_price, SalesHistory.amount, SalesHistory.additional_info,
        ).where(
            SalesHistory.item_id.in_(item_ids),
            SalesHistory.region.in_(regions),
            SalesHistory.sale_time >= min(row.first_seen_at for row in rows),
            SalesHistory.sale_time <= max(row.last_seen_at for row in rows)
            + timedelta(hours=LOT_OBS_RESOLVE_DELAY_HOURS),
        )
    )).all()

    # Предметы каталога — для ключа варианта не-артефактов: у снаряжения в
    # additional продажи нет ни qlt, ни ptn, и без master сделка легла бы в
    # вариант (0, 0), а наблюдение искало бы (3, 0) — ни один лот снаряжения
    # не получил бы исход sold (§3.2 ТЗ).
    masters = {
        row.item_id: row
        for row in (await db.execute(
            select(MasterItem).where(MasterItem.item_id.in_(item_ids))
        )).scalars().all()
    }

    by_variant: dict[tuple[str, str, int, int], list[tuple[datetime, int, int, int]]] = {}
    for sale in sales:
        qlt, ptn = variant_key(sale.additional_info, masters.get(sale.item_id))
        by_variant.setdefault((sale.item_id, sale.region, qlt, ptn), []).append(
            (sale.sale_time, sale.id, sale.total_price, sale.amount)
        )

    used_sale_ids: set[int] = set()
    if sales:
        sale_ids = {sale.id for sale in sales}
        taken = (await db.execute(
            select(LotObservation.matched_sale_id).where(
                # Счёт сделок ведётся ВНУТРИ источника: восстановленные строки
                # претендуют на те же сделки того же лота, но живую выборку
                # обеднять не должны (индекс uq_lot_obs_matched_sale — по паре
                # с source, см. миграцию 0042).
                LotObservation.source == LOT_OBS_SOURCE_LIVE,
                LotObservation.matched_sale_id.between(min(sale_ids), max(sale_ids)),
            )
        )).scalars().all()
        # Диапазон id захватывает и чужие сделки — оставляем только те, что
        # реально в этой порции, чтобы счётчик в логе не врал.
        used_sale_ids = set(taken) & sale_ids

    outcomes = resolve_batch(rows, by_variant, used_sale_ids)

    sold = [(obs_id, sale_id) for obs_id, (out, sale_id) in outcomes.items() if out == "sold"]
    if sold:
        # Каждой строке своя сделка -> ORM bulk UPDATE по первичному ключу, а
        # не один UPDATE ... IN (...): matched_sale_id у строк разный.
        # synchronize_session=None: строки этой порции уже загружены в сессию,
        # синхронизировать их незачем — дальше они не используются.
        await db.execute(
            update(LotObservation).execution_options(synchronize_session=None),
            [
                {"id": obs_id, "outcome": "sold", "resolved_at": now, "matched_sale_id": sale_id}
                for obs_id, sale_id in sold
            ],
        )
        stats["sold"] = len(sold)

    for outcome in ("expired", "withdrawn"):
        ids = [obs_id for obs_id, (out, _) in outcomes.items() if out == outcome]
        if not ids:
            continue
        await db.execute(
            update(LotObservation)
            .where(LotObservation.id.in_(ids))
            .values(outcome=outcome, resolved_at=now)
        )
        stats[outcome] = len(ids)
    await db.commit()

    total = sum(stats.values())
    logger.info(
        "lot_obs resolve: закрыто=%s sold=%s (%.0f%%) expired=%s withdrawn=%s (%.0f%%) "
        "сделок в окне=%s (из них уже израсходовано ранее=%s)",
        total, stats["sold"], 100 * stats["sold"] / total, stats["expired"],
        stats["withdrawn"], 100 * stats["withdrawn"] / total, len(sales), len(used_sale_ids),
    )
    return stats
