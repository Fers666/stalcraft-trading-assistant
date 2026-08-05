"""
Тесты планировщика бюджета «Ленты артефактов» (Фаза 1 ТЗ artifact-feed.md).

Главный риск фичи — расход лимита Stalcraft API, поэтому планировщик, очередь
обхода и предохранители вынесены из тела Celery-задачи в чистые функции и
проверяются здесь без БД и сети.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.tasks.feed_collector import (
    FEED_BUDGET_UNITS_PER_MIN,
    FEED_COLD_EVERY_N_CYCLES,
    FEED_HISTORY_WINDOW_END_MIN,
    FEED_HOT_MIN_LOTS_TOTAL,
    FEED_HOT_SALES_PER_DAY,
    FEED_ITEM_FAIL_MAX,
    FEED_ITEM_FAIL_PREFIX,
    FEED_ITEM_PARK_TTL,
    FEED_LOCK_KEY,
    FEED_LOTS_PAGE_LIMIT,
    FEED_LOTS_REQUEST_COST,
    FEED_MAX_PAGES_PER_ITEM,
    FEED_RATE_GUARD_UNITS,
    FEED_SCAN_LAST_PREFIX,
    FEED_WINDOW_BUDGET_UNITS_PER_MIN,
    FEED_WINDOW_RATE_GUARD_UNITS,
    ItemPlan,
    acquire_lock,
    budget_units_for,
    fetch_all_lots,
    in_history_window,
    is_hot,
    order_queue,
    pages_for_total,
    plan_run,
    rate_guard_for,
    recent_consumption,
    safe_scan_item,
    sale_values,
    select_by_tempo,
)

NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)


def _plan(item_id: str, pages: int = 1, hot: bool = True, last_scan=None) -> ItemPlan:
    return ItemPlan(item_id=item_id, pages=pages, hot=hot, last_scan=last_scan)


# ─── Число страниц из total ───────────────────────────────────────────────────

@pytest.mark.parametrize("total,expected", [
    (None, 1),   # первый прогон, lots_total ещё не замерялся
    (0, 1),
    (1, 1),
    (200, 1),
    (201, 2),
    (2000, 10),
    (5000, FEED_MAX_PAGES_PER_ITEM),  # упор в потолок
])
def test_pages_for_total(total, expected):
    assert pages_for_total(total) == expected


# ─── plan_run ─────────────────────────────────────────────────────────────────

def test_plan_run_takes_item_wholly_or_not_at_all():
    """
    Частичной пагинации не бывает: предмет на 10 страниц либо влезает целиком,
    либо откладывается — иначе срез неполный и лучшие лоты теряются.
    """
    items = [_plan("a", pages=10), _plan("b", pages=10)]
    selected, spent = plan_run(items, budget_units=20)
    assert [p.item_id for p in selected] == ["a"]
    assert spent == 20


def test_plan_run_estimate_never_exceeds_budget():
    items = [_plan(str(i), pages=3) for i in range(50)]
    selected, spent = plan_run(items, FEED_BUDGET_UNITS_PER_MIN)
    assert spent <= FEED_BUDGET_UNITS_PER_MIN
    assert spent == len(selected) * 3 * FEED_LOTS_REQUEST_COST


def test_plan_run_deferred_rest():
    """Что не влезло в бюджет — deferred, доберётся следующим циклом."""
    items = [_plan("a", pages=5), _plan("b", pages=5), _plan("c", pages=5)]
    selected, _ = plan_run(items, budget_units=20)
    deferred = len(items) - len(selected)
    assert len(selected) == 2 and deferred == 1


def test_plan_run_empty_budget():
    assert plan_run([_plan("a")], budget_units=0) == ([], 0)


# ─── Порядок обхода ───────────────────────────────────────────────────────────

def test_order_queue_nulls_first_then_ascending():
    items = [
        _plan("fresh", last_scan=NOW),
        _plan("never", last_scan=None),
        _plan("old", last_scan=NOW - timedelta(minutes=10)),
        _plan("never2", last_scan=None),
    ]
    ordered = [p.item_id for p in order_queue(items)]
    assert set(ordered[:2]) == {"never", "never2"}
    assert ordered[2:] == ["old", "fresh"]


# ─── Горячие / холодные ───────────────────────────────────────────────────────

@pytest.mark.parametrize("lots_total,sales_per_day,expected", [
    (None, None, False),
    (10, 0.1, False),
    (10, FEED_HOT_SALES_PER_DAY, True),
    (FEED_HOT_MIN_LOTS_TOTAL, None, True),
    (FEED_HOT_MIN_LOTS_TOTAL - 1, 0.5, False),
])
def test_is_hot(lots_total, sales_per_day, expected):
    assert is_hot(lots_total, sales_per_day) is expected


def test_select_by_tempo_cold_only_every_nth_cycle():
    items = [_plan("hot", hot=True), _plan("cold", hot=False)]

    for cycle in range(1, FEED_COLD_EVERY_N_CYCLES):
        assert [p.item_id for p in select_by_tempo(items, cycle)] == ["hot"]

    nth = select_by_tempo(items, FEED_COLD_EVERY_N_CYCLES)
    assert [p.item_id for p in nth] == ["hot", "cold"]


# ─── Лок цикла ────────────────────────────────────────────────────────────────

class FakeRedis:
    """Минимальный дубль redis.asyncio для лока и минутных счётчиков."""

    def __init__(self, values: dict | None = None):
        self.values = dict(values or {})

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = value
        return True

    async def delete(self, key):
        self.values.pop(key, None)

    async def mget(self, keys):
        return [self.values.get(k) for k in keys]

    async def incr(self, key):
        self.values[key] = str(int(self.values.get(key, 0)) + 1)
        return int(self.values[key])

    async def expire(self, key, ttl):
        return True

    async def setex(self, key, ttl, value):
        self.values[key] = value
        return True


def test_lock_blocks_second_run():
    """Beat каждые 60 с при цикле ~2 мин иначе даст наложение и двойной расход."""
    r = FakeRedis()
    assert asyncio.run(acquire_lock(r)) is True
    assert asyncio.run(acquire_lock(r)) is False
    assert FEED_LOCK_KEY in r.values


# ─── Предохранитель по фактическому расходу ───────────────────────────────────

def _consumption_with(current: int | None, previous: int | None) -> int:
    from app.core.rate_limiter import rate_limiter
    import time as _time

    minute = int(_time.time() // 60)
    prefix = rate_limiter.REQUESTS_MINUTE_KEY_PREFIX
    values = {}
    if current is not None:
        values[f"{prefix}{minute}"] = str(current)
    if previous is not None:
        values[f"{prefix}{minute - 1}"] = str(previous)
    return asyncio.run(recent_consumption(FakeRedis(values)))


def test_recent_consumption_uses_previous_minute():
    """
    В первые секунды минуты счётчик текущей минуты около нуля и как одиночный
    сигнал бесполезен — берём максимум с предыдущей полной минутой.
    """
    assert _consumption_with(current=3, previous=350) == 350


def test_recent_consumption_uses_current_minute_when_higher():
    assert _consumption_with(current=380, previous=100) == 380


def test_recent_consumption_empty_keys():
    assert _consumption_with(current=None, previous=None) == 0


# ─── Уступка окну collect_all_history (:00–:11) ───────────────────────────────
# Джиттера в 10 с хватало, чтобы развести ленту с watchlist-тиком внутри минуты,
# но не с одиннадцатиминутным всплеском collect_all_history: замер QA — 34 отказа
# 429 в 20:00 и 10 в 12:00–12:01. В окне лента не пропускает цикл, а урезает
# бюджет и порог предохранителя.

def _at_minute(minute: int) -> datetime:
    return NOW.replace(minute=minute)


@pytest.mark.parametrize("minute,expected", [
    (0, True),                                # начало окна collect_all_history
    (FEED_HISTORY_WINDOW_END_MIN - 1, True),  # :11 — последняя минута окна
    (FEED_HISTORY_WINDOW_END_MIN, False),     # :12 — окно закончилось
    (15, False),                              # collect_artifact_history
    (59, False),
])
def test_in_history_window(minute, expected):
    assert in_history_window(_at_minute(minute)) is expected


def test_budget_is_cut_inside_history_window():
    """В окне бюджет урезан — но цикл всё равно идёт (полный пропуск отвергнут)."""
    assert budget_units_for(_at_minute(0)) == FEED_WINDOW_BUDGET_UNITS_PER_MIN
    assert FEED_WINDOW_BUDGET_UNITS_PER_MIN > 0


def test_budget_is_full_outside_history_window():
    assert budget_units_for(_at_minute(30)) == FEED_BUDGET_UNITS_PER_MIN


def test_rate_guard_is_stricter_inside_history_window():
    assert rate_guard_for(_at_minute(5)) == FEED_WINDOW_RATE_GUARD_UNITS
    assert rate_guard_for(_at_minute(30)) == FEED_RATE_GUARD_UNITS
    assert FEED_WINDOW_RATE_GUARD_UNITS < FEED_RATE_GUARD_UNITS


def test_window_budget_keeps_hot_items_flowing():
    """
    Урезанный бюджет — не пропуск: одностраничные предметы (типовой артефакт)
    продолжают обходиться каждую минуту, просто их меньше за прогон.
    """
    items = [_plan(str(i), pages=1) for i in range(50)]
    selected, spent = plan_run(items, budget_units=budget_units_for(_at_minute(0)))
    assert len(selected) == FEED_WINDOW_BUDGET_UNITS_PER_MIN // FEED_LOTS_REQUEST_COST
    assert spent <= FEED_WINDOW_BUDGET_UNITS_PER_MIN


def test_window_peak_stays_below_api_limit():
    """
    Смета окна: пиковая минута QA — 261 ед при ленте на полном бюджете, значит
    не-лента даёт ~61 ед/мин. С урезанным бюджетом пик ≈ 121 ед/мин, и даже
    удвоение формы всплеска в скользящем окне API не доходит до 400.
    """
    non_feed_peak = 261 - FEED_BUDGET_UNITS_PER_MIN
    window_peak = non_feed_peak + FEED_WINDOW_BUDGET_UNITS_PER_MIN
    assert window_peak * 2 <= 400
    # предохранитель окна ловит всё, что выше расчётного пика
    assert FEED_WINDOW_RATE_GUARD_UNITS >= window_peak


# ─── Полная пагинация /lots ───────────────────────────────────────────────────

class FakeLotsClient:
    """Отдаёт `total` лотов страницами по FEED_LOTS_PAGE_LIMIT."""

    def __init__(self, total: int):
        self.total = total
        self.calls: list[int] = []

    async def get_auction_lots(self, item_id, region, offset=0, limit=200, redis_client=None):
        self.calls.append(offset)
        page = [
            {"buyoutPrice": 100 + i, "amount": 1, "startTime": f"lot-{offset + i}"}
            for i in range(max(0, min(limit, self.total - offset)))
        ]
        return {"total": self.total, "lots": page}


@pytest.mark.parametrize("total,expected_requests", [
    (0, 1),
    (200, 1),
    (201, 2),
    (1000, 5),
])
def test_fetch_all_lots_walks_every_page(total, expected_requests):
    """
    /lots не сортирует по цене: первая страница — произвольные 200 лотов.
    Предмет должен выгружаться целиком, иначе лучшие предложения теряются.
    """
    client = FakeLotsClient(total)
    lots, reported_total, requests = asyncio.run(
        fetch_all_lots(client, "art1", "RU", delay=0)
    )
    assert requests == expected_requests
    assert reported_total == total
    assert len(lots) == total
    assert client.calls == [i * FEED_LOTS_PAGE_LIMIT for i in range(expected_requests)]


def test_fetch_all_lots_respects_page_cap():
    """Потолок FEED_MAX_PAGES_PER_ITEM — защита от сверхмассовых предметов."""
    client = FakeLotsClient(FEED_LOTS_PAGE_LIMIT * (FEED_MAX_PAGES_PER_ITEM + 5))
    lots, _, requests = asyncio.run(fetch_all_lots(client, "art1", "RU", delay=0))
    assert requests == FEED_MAX_PAGES_PER_ITEM
    assert len(lots) == FEED_LOTS_PAGE_LIMIT * FEED_MAX_PAGES_PER_ITEM


# ─── Строка sales_history из записи /history ─────────────────────────────────

def test_sale_values_is_global_row():
    """Глобально собранная продажа пишется с user_id = NULL."""
    row = sale_values("art1", "RU", {
        "time": "2026-08-03T10:00:00Z",
        "price": 300_000,
        "amount": 3,
        "additional": {"qlt": 4, "ptn": 15},
    })
    assert row["user_id"] is None
    assert row["price_per_unit"] == 100_000
    assert row["additional_info"] == {"qlt": 4, "ptn": 15}
    assert row["sale_time"] == datetime(2026, 8, 3, 10, 0, tzinfo=timezone.utc)
    assert row["will_be_deleted_at"] == row["sale_time"] + timedelta(days=120)


def test_sale_values_without_additional():
    row = sale_values("art1", "RU", {"time": "2026-08-03T10:00:00Z", "price": 100, "amount": 1})
    assert row["additional_info"] is None


# ─── Изоляция отказа предмета (M3) ────────────────────────────────────────────

class FakeDB:
    """Сессия, падающая на commit: сценарий CardinalityViolationError."""

    def __init__(self, fail: bool = True):
        self.fail = fail
        self.rolled_back = False
        self.committed = False

    async def execute(self, query):
        return SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: []),
            rowcount=0,
            __iter__=lambda self_: iter([]),
        )

    async def commit(self):
        if self.fail:
            raise RuntimeError("ON CONFLICT DO UPDATE command cannot affect row a second time")
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


def _safe_scan(db, redis_client, item_id="art1"):
    return asyncio.run(safe_scan_item(db, redis_client, item_id, "RU", [], NOW))


def test_failed_item_does_not_break_the_cycle():
    """
    Ошибка записи одного предмета не должна ронять задачу: иначе feed:scan:last
    не обновляется, предмет снова идёт первым (order_queue) и цикл падает
    каждые 60 с, впустую тратя лимит API — тот самый сценарий
    CardinalityViolationError.
    """
    db, redis_client = FakeDB(fail=True), FakeRedis()
    assert _safe_scan(db, redis_client) is None
    assert db.rolled_back is True
    assert redis_client.values[FEED_ITEM_FAIL_PREFIX + "art1"] == "1"


def test_repeated_failures_park_the_item():
    """После потолка отказов предмет получает feed:scan:last и уходит в конец очереди."""
    db, redis_client = FakeDB(fail=True), FakeRedis()
    for _ in range(FEED_ITEM_FAIL_MAX):
        assert _safe_scan(db, redis_client) is None

    assert redis_client.values[FEED_ITEM_FAIL_PREFIX + "art1"] == str(FEED_ITEM_FAIL_MAX)
    assert FEED_SCAN_LAST_PREFIX + "art1" in redis_client.values


def test_parking_stamp_is_in_the_future():
    """
    В feed:scan:last пишется момент ОКОНЧАНИЯ парковки, а не время цикла.
    С меткой «как у успешного обхода» order_queue отставлял предмет всего на
    один оборот очереди: QA замерил повторный опрос через 3 минуты вместо 900 с,
    TTL до истечения не доживал.
    """
    db, redis_client = FakeDB(fail=True), FakeRedis()
    for _ in range(FEED_ITEM_FAIL_MAX):
        _safe_scan(db, redis_client)

    parked_until = datetime.fromisoformat(redis_client.values[FEED_SCAN_LAST_PREFIX + "art1"])
    assert parked_until == NOW + timedelta(seconds=FEED_ITEM_PARK_TTL)


def test_parked_item_stays_behind_freshly_scanned_ones():
    """
    Смысл парковки: припаркованный предмет не должен обгонять предметы,
    обойдённые в этом же цикле, — иначе он снова возглавит очередь и продолжит
    жечь лимит API своим отказом.
    """
    db, redis_client = FakeDB(fail=True), FakeRedis()
    for _ in range(FEED_ITEM_FAIL_MAX):
        _safe_scan(db, redis_client)

    parked = datetime.fromisoformat(redis_client.values[FEED_SCAN_LAST_PREFIX + "art1"])
    queue = order_queue([
        _plan("art1", last_scan=parked),
        _plan("scanned-now", last_scan=NOW),
        _plan("scanned-earlier", last_scan=NOW - timedelta(minutes=5)),
    ])
    assert [p.item_id for p in queue][-1] == "art1"


def test_successful_scan_clears_failure_counter():
    """Счётчик — про ПОДРЯД идущие отказы: успешный обход его обнуляет."""
    db, redis_client = FakeDB(fail=True), FakeRedis()
    _safe_scan(db, redis_client)
    assert FEED_ITEM_FAIL_PREFIX + "art1" in redis_client.values

    result = _safe_scan(FakeDB(fail=False), redis_client)
    assert result is not None and result.rows_scored == 0
    assert FEED_ITEM_FAIL_PREFIX + "art1" not in redis_client.values


def test_broken_redis_does_not_break_failure_handling():
    """Отказ Redis поверх уже случившейся ошибки не должен ронять цикл."""
    class BrokenRedis:
        async def incr(self, key):
            raise RuntimeError("redis down")

    assert _safe_scan(FakeDB(fail=True), BrokenRedis()) is None


@pytest.mark.parametrize("record", [
    {"price": 100, "amount": 1},                              # нет времени
    {"time": "2026-08-03T10:00:00Z", "price": 0, "amount": 1},   # нулевая цена
    {"time": "2026-08-03T10:00:00Z", "price": 100, "amount": 0},  # нулевое количество
    {"time": "не дата", "price": 100, "amount": 1},
])
def test_sale_values_rejects_broken_records(record):
    assert sale_values("art1", "RU", record) is None
