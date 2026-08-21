"""
Тесты суточного учёта расхода и отказов внешнего API (Часть B ТЗ
docs/tasks/watchlist-parallel-fetch.md).

Часть B — измерительный прибор для Части A: без неё нельзя доказать, что
ускорение сборщика не вывело нас за лимит Stalcraft API. Поэтому агрегация
проверяется здесь на подложенных значениях, без Redis и сети.

Ключевое требование: отсутствующий минутный ключ НЕ равен нулевому расходу.
Ключи живут 25 часов, и их отсутствие означает «данных нет» (Redis перезапущен,
история протухла), а не «в эту минуту к API не ходили». Спутать эти два случая —
значит занизить медиану и соврать про близость к потолку.
"""

import asyncio
import time

import pytest

from app.core.rate_limiter import (
    ERROR_429,
    ERROR_LIMITER_TIMEOUT,
    GUARD_TRIPS_HOUR_PREFIX,
    LAST_429_KEY,
    MINUTE_KEY_TTL,
    _LUA_ACQUIRE,
    incr_error,
    rate_limiter,
    recent_consumption,
)

MINUTE_PREFIX = rate_limiter.REQUESTS_MINUTE_KEY_PREFIX


class FakeRedis:
    """Минимальный дубль redis.asyncio (по образцу tests/test_feed_budget.py)."""

    def __init__(self, values: dict | None = None, broken: bool = False):
        self.values = dict(values or {})
        self.broken = broken
        self.expires: dict[str, int] = {}

    async def mget(self, keys):
        if self.broken:
            raise ConnectionError("redis is down")
        return [self.values.get(k) for k in keys]

    async def get(self, key):
        if self.broken:
            raise ConnectionError("redis is down")
        return self.values.get(key)

    async def incr(self, key):
        if self.broken:
            raise ConnectionError("redis is down")
        self.values[key] = str(int(self.values.get(key, 0)) + 1)
        return int(self.values[key])

    async def expire(self, key, ttl):
        if self.broken:
            raise ConnectionError("redis is down")
        self.expires[key] = ttl
        return True

    async def set(self, key, value, nx=False, ex=None):
        if self.broken:
            raise ConnectionError("redis is down")
        self.values[key] = value
        if ex is not None:
            self.expires[key] = ex
        return True

    async def aclose(self):
        return None


# ─── B1: минутный счётчик обязан пережить сутки ───────────────────────────────
# До Части B TTL был 120 с: истории не существовало в принципе, и вопрос
# «подошли ли мы к потолку за сутки» был неотвечаем.

def test_minute_key_ttl_covers_a_day():
    assert MINUTE_KEY_TTL >= 24 * 3600, "минутный счётчик должен покрывать сутки"


def test_lua_uses_the_ttl_constant_not_a_literal():
    """
    Регрессия: TTL минутного ключа задаётся подстановкой константы в Lua.
    Литерал 120 в скрипте означал бы, что история снова живёт две минуты.
    """
    assert f"EXPIRE', minute_key, {MINUTE_KEY_TTL}" in _LUA_ACQUIRE.replace('"', "'")


# ─── B2: агрегация суточной истории ───────────────────────────────────────────

def _history(values: dict, hours: int = 24, now: float | None = None) -> dict:
    return asyncio.run(
        rate_limiter.get_history(
            hours=hours, redis_client=FakeRedis(values), now=now or time.time()
        )
    )


def _minute_values(now: float, per_minute: dict[int, int]) -> dict:
    """per_minute: {сколько минут назад: расход} → ключи Redis."""
    current = int(now // 60)
    return {f"{MINUTE_PREFIX}{current - ago}": str(units)
            for ago, units in per_minute.items()}


def test_peak_and_median_ignore_missing_minutes():
    """
    Отсутствующий ключ не должен попадать в выборку нулём: иначе медиана
    поедет вниз, и панель покажет запас там, где его нет.
    """
    now = time.time()
    values = _minute_values(now, {1: 100, 2: 178, 3: 150})

    result = _history(values, now=now)

    assert result["peak_units_per_minute"] == 178
    assert result["median_units_per_minute"] == 150
    assert result["minutes_observed"] == 3


def test_empty_history_does_not_crash():
    """Свежий Redis: данных нет — это не ошибка, это ноль наблюдений."""
    result = _history({}, now=time.time())

    assert result["minutes_observed"] == 0
    assert result["peak_units_per_minute"] == 0
    assert result["median_units_per_minute"] == 0
    assert result["source"] == "redis"


def test_window_is_limited_by_hours():
    """Минуты старше запрошенного окна в выборку не берутся."""
    now = time.time()
    values = _minute_values(now, {1: 50, 61: 400})   # 61 минуту назад — вне окна в 1 ч

    result = _history(values, hours=1, now=now)

    assert result["peak_units_per_minute"] == 50
    assert result["minutes_observed"] == 1


def test_capacity_is_reported():
    """Потолок нужен рядом с числами, иначе 178 не с чем сравнить."""
    assert _history({}, now=time.time())["capacity_per_minute"] == rate_limiter.CAPACITY


def test_hours_are_grouped_with_peak_and_errors():
    """
    Столбик часа — это пиковая минута часа, а не среднее: 429 приходят на пике.
    """
    now = time.time()
    current_hour = int(now // 3600)
    values = _minute_values(now, {1: 100, 2: 178})
    values[f"stalcraft:errors:{ERROR_429}:hour:{current_hour}"] = "2"
    values[f"{GUARD_TRIPS_HOUR_PREFIX}{current_hour}"] = "3"

    result = _history(values, now=now)
    this_hour = result["hours"][-1]

    assert len(result["hours"]) == 24
    assert this_hour["peak_units"] == 178
    assert this_hour["errors_429"] == 2
    assert this_hour["guard_trips"] == 3
    assert result["errors_429_total"] == 2
    assert result["guard_trips_total"] == 3


def test_totals_sum_across_hours():
    now = time.time()
    current_hour = int(now // 3600)
    values = {
        f"stalcraft:errors:{ERROR_429}:hour:{current_hour}": "1",
        f"stalcraft:errors:{ERROR_429}:hour:{current_hour - 5}": "4",
        f"stalcraft:errors:{ERROR_LIMITER_TIMEOUT}:hour:{current_hour - 2}": "7",
    }

    result = _history(values, now=now)

    assert result["errors_429_total"] == 5
    assert result["limiter_timeouts_total"] == 7


def test_redis_failure_degrades_to_fallback_not_500():
    """Панель админа не должна падать из-за недоступной операционной метрики."""
    result = asyncio.run(
        rate_limiter.get_history(redis_client=FakeRedis(broken=True), now=time.time())
    )

    assert result["source"] == "fallback"
    assert result["errors_429_total"] == 0
    assert result["minutes_observed"] == 0


def test_partial_coverage_is_reported_honestly():
    """
    minutes_observed — признак того, насколько картина полна. Без него
    «пик 178» из трёх наблюдений неотличим от пика за полные сутки.
    """
    now = time.time()
    result = _history(_minute_values(now, {i: 10 for i in range(1, 51)}), now=now)

    assert result["minutes_observed"] == 50
    assert result["window_hours"] == 24


# ─── B3: счётчики отказов ─────────────────────────────────────────────────────

def test_incr_error_writes_hourly_key_with_ttl():
    r = FakeRedis()
    now = time.time()
    key = f"stalcraft:errors:{ERROR_429}:hour:{int(now // 3600)}"

    asyncio.run(incr_error(ERROR_429, redis_client=r, now=now))

    assert r.values[key] == "1"
    assert r.expires[key] == MINUTE_KEY_TTL


def test_incr_error_records_last_429_path():
    """Одного счётчика мало: без времени и пути 429 не с чем сопоставить."""
    r = FakeRedis()

    asyncio.run(incr_error(
        ERROR_429, redis_client=r, path="/RU/auction/wg53/lots", now=time.time(),
    ))

    assert "wg53" in r.values[LAST_429_KEY]


def test_incr_error_never_raises_when_redis_is_broken():
    """
    Учёт ошибок не имеет права ломать сбор данных: отказ записи метрики
    молча игнорируется. Иначе падение Redis превратится в падение сборщика.
    """
    asyncio.run(incr_error(
        ERROR_LIMITER_TIMEOUT, redis_client=FakeRedis(broken=True), now=time.time(),
    ))


def test_guard_trips_use_their_own_key():
    """
    Срабатывание предохранителя — не отказ API: лимит не нарушен, но данные
    не собраны. Смешивать его с 429 в одном счётчике нельзя.
    """
    r = FakeRedis()
    now = time.time()

    asyncio.run(incr_error("guard_trips", redis_client=r, now=now))

    assert r.values[f"{GUARD_TRIPS_HOUR_PREFIX}{int(now // 3600)}"] == "1"


# ─── B2: recent_consumption переехал в лимитер ────────────────────────────────
# Предохранитель ленты читает расход отсюда же — источник правды должен быть один.

def test_recent_consumption_takes_max_of_two_minutes():
    now = time.time()
    minute = int(now // 60)
    values = {f"{MINUTE_PREFIX}{minute}": "3", f"{MINUTE_PREFIX}{minute - 1}": "350"}

    assert asyncio.run(
        recent_consumption(FakeRedis(values))
    ) == 350


def test_recent_consumption_survives_redis_failure():
    assert asyncio.run(
        recent_consumption(FakeRedis(broken=True))
    ) == 0


def test_feed_collector_reuses_the_limiter_helper():
    """
    Регрессия: у ленты был свой recent_consumption. Две копии правила разошлись
    бы при первой же правке TTL или префикса.
    """
    from app.tasks import feed_collector

    assert feed_collector.recent_consumption is recent_consumption
