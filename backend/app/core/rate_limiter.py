"""
Token Bucket Rate Limiter для Stalcraft API.

РЕАЛЬНЫЕ ЛИМИТЫ (экспериментально проверены 2026-06-07):
  - 400 запросов / минута (НЕ 100 токенов!)
  - /auction/.../lots    = 2 запроса
  - /auction/.../history = 2 запроса
  - /emission            = 1 запрос

API отслеживает через headers: x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset

Реализация через Redis:
  - Ключ: stalcraft:rate_limit (глобальный для всех воркеров)
  - Пополнение: 400 запросов каждую минуту
  - Lua-скрипт для атомарного acquire
  - Period: 60 секунд (ровно)

Архитектурное решение — без кеширования соединения:
  Celery создаёт новый asyncio.new_event_loop() для каждой задачи.
  Синглтон с кешированным Redis-соединением становится невалидным в новом loop.
  Решение: создавать свежее соединение в каждом вызове acquire() через
  aioredis.from_url() (синхронный вызов, возвращает новый объект без привязки к loop).
  Состояние bucket живёт в Redis (HMSET), а не в Python-объекте — всё корректно.
"""

import asyncio
import logging
import statistics
import time
from datetime import datetime
from enum import IntEnum
from zoneinfo import ZoneInfo

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

MSK = ZoneInfo("Europe/Moscow")

# Стоимость каждого типа запроса
class TokenCost(IntEnum):
    LOTS     = 2
    HISTORY  = 2
    EMISSION = 1


# ─── Суточный учёт расхода и отказов (ТЗ watchlist-parallel-fetch.md, Часть B) ─
# Минутный счётчик расхода живёт 25 часов, а не 120 секунд: без истории вопрос
# «подошли ли мы к потолку за сутки» неотвечаем, а именно он решает, можно ли
# ускорять сборщики. 1440 ключей по ~40 байт ≈ 60 КБ в сутки, чтение окна —
# один MGET.
MINUTE_KEY_TTL = 90_000             # 25 ч: сутки плюс запас на границу окна

# Типы событий. Это РАЗНЫЕ вещи, и складывать их в один счётчик нельзя:
#   429            — внешний отказ: лимит реально нарушен;
#   limiter_timeout — наше самоограничение: до API не дошли, данные не собраны;
#   guard_trips     — предохранитель сборщика: лимит не нарушен, но цикл оборван.
ERROR_429             = "429"
ERROR_LIMITER_TIMEOUT = "limiter_timeout"
ERROR_GUARD_TRIPS     = "guard_trips"

ERRORS_HOUR_PREFIX      = "stalcraft:errors:"        # + kind + ":hour:" + unix_hour
GUARD_TRIPS_HOUR_PREFIX = "stalcraft:guard_trips:hour:"
LAST_429_KEY            = "stalcraft:errors:429:last"


def _hour_key(kind: str, unix_hour: int) -> str:
    if kind == ERROR_GUARD_TRIPS:
        return f"{GUARD_TRIPS_HOUR_PREFIX}{unix_hour}"
    return f"{ERRORS_HOUR_PREFIX}{kind}:hour:{unix_hour}"


# Lua-скрипт: атомарно проверяет и списывает токены
# KEYS[1] = bucket key
# KEYS[2] = minute counter key (consumption stats, см. get_consumption_stats())
# ARGV[1] = tokens_needed
# ARGV[2] = capacity
# ARGV[3] = current_time (unix seconds, float)
# ARGV[4] = refill_rate (tokens per second = 400/60)
# Возвращает: 1 если успешно, -N если нужно ждать N секунд
# При успехе дополнительно атомарно инкрементирует минутный счётчик потреблённых
# токенов (для админ-статистики) — без отдельного round-trip к Redis.
_LUA_ACQUIRE = """
local key         = KEYS[1]
local minute_key  = KEYS[2]
local needed      = tonumber(ARGV[1])
local capacity    = tonumber(ARGV[2])
local now         = tonumber(ARGV[3])
local rate        = tonumber(ARGV[4])

local data        = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens      = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then tokens = capacity end
if last_refill == nil then last_refill = now end

local elapsed = now - last_refill
tokens = math.min(capacity, tokens + elapsed * rate)

if tokens >= needed then
    tokens = tokens - needed
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 120)
    redis.call('INCRBY', minute_key, needed)
    redis.call('EXPIRE', minute_key, __MINUTE_TTL__)
    return 1
else
    local wait = (needed - tokens) / rate
    return -math.ceil(wait)
end
""".replace("__MINUTE_TTL__", str(MINUTE_KEY_TTL))


class TokenBucketRateLimiter:
    """
    Глобальный rate limiter для Stalcraft API.
    Bucket state хранится в Redis — корректно при нескольких воркерах Celery.
    Соединение не кешируется: создаётся свежее на каждый acquire().
    """

    CAPACITY    = 400          # запросов в корзине (проверено экспериментально)
    REFILL_RATE = 400 / 60.0  # запросов в секунду
    BUCKET_KEY  = "stalcraft:rate_limit"
    REQUESTS_MINUTE_KEY_PREFIX = "stalcraft:requests:minute:"  # + unix_minute, TTL MINUTE_KEY_TTL

    def __init__(self):
        self._fallback_lock         = asyncio.Lock()
        self._fallback_tokens       = float(self.CAPACITY)
        self._fallback_last_refill  = time.monotonic()

    async def acquire(
        self, cost: int = TokenCost.LOTS, max_wait: float = 60.0,
        redis_client: "aioredis.Redis | None" = None,
    ):
        """
        Запрашивает `cost` токенов. Ждёт если недостаточно (но не дольше max_wait).
        redis_client: опциональное переиспользуемое Redis-соединение (например, общий
        клиент на весь батч collect_all_active_lots). Если не передано (по умолчанию) —
        поведение не меняется: создаётся и закрывается новое соединение на каждый вызов.
        Если передано — жизненным циклом соединения владеет вызывающий код, здесь оно
        не закрывается.
        Raises: TimeoutError если ждать дольше max_wait секунд.
        """
        waited = 0.0
        while True:
            now = time.time()
            minute_key = f"{self.REQUESTS_MINUTE_KEY_PREFIX}{int(now // 60)}"
            owns_client = redis_client is None
            r = redis_client if redis_client is not None else aioredis.from_url(settings.redis_url, decode_responses=True)
            try:
                result = int(await r.eval(
                    _LUA_ACQUIRE, 2,
                    self.BUCKET_KEY, minute_key, int(cost), self.CAPACITY, now, self.REFILL_RATE,
                ))
            except (aioredis.RedisError, ConnectionError, OSError) as e:
                logger.warning(f"Rate limiter Redis error, using in-memory fallback: {e}")
                if owns_client:
                    await r.aclose()
                await self._acquire_fallback(cost, max_wait)
                return
            finally:
                if owns_client:
                    await r.aclose()

            if result == 1:
                logger.debug(f"Token acquired (cost={cost})")
                return

            wait_sec = abs(result)
            if waited + wait_sec > max_wait:
                # Самоограничение, а не отказ API: до Stalcraft мы не дошли, но
                # данные не собраны. Считаем отдельно от 429 — причина другая.
                await incr_error(ERROR_LIMITER_TIMEOUT, redis_client=redis_client)
                raise TimeoutError(
                    f"Rate limit: need to wait {wait_sec:.1f}s but max_wait={max_wait}s"
                )
            logger.info(f"Rate limit: waiting {wait_sec:.1f}s for {cost} tokens")
            await asyncio.sleep(wait_sec)
            waited += wait_sec

    async def _acquire_fallback(self, cost: int, max_wait: float):
        """In-memory fallback когда Redis недоступен."""
        waited = 0.0
        while True:
            async with self._fallback_lock:
                now = time.monotonic()
                elapsed = now - self._fallback_last_refill
                self._fallback_tokens = min(
                    self.CAPACITY,
                    self._fallback_tokens + elapsed * self.REFILL_RATE,
                )
                self._fallback_last_refill = now

                if self._fallback_tokens >= cost:
                    self._fallback_tokens -= cost
                    return

                wait_sec = (cost - self._fallback_tokens) / self.REFILL_RATE

            if waited + wait_sec > max_wait:
                raise TimeoutError(f"Rate limit fallback: wait {wait_sec:.1f}s exceeds max")

            await asyncio.sleep(wait_sec)
            waited += wait_sec

    async def get_status(self) -> dict:
        """Текущее состояние корзины (для мониторинга в UI)."""
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            data = await r.hmget(self.BUCKET_KEY, "tokens", "last_refill")
            tokens = float(data[0]) if data[0] else float(self.CAPACITY)
            return {
                "tokens_available":    round(tokens, 1),
                "capacity":            self.CAPACITY,
                "refill_rate_per_min": 400,
                "source":              "redis",
            }
        except Exception:
            return {
                "tokens_available":    round(self._fallback_tokens, 1),
                "capacity":            self.CAPACITY,
                "refill_rate_per_min": 400,
                "source":              "fallback",
            }
        finally:
            await r.aclose()

    async def get_consumption_stats(self) -> dict:
        """
        Реально потреблённые токены за текущую минуту (для админ-статистики).
        Минутный счётчик инкрементируется атомарно внутри _LUA_ACQUIRE — см.
        REQUESTS_MINUTE_KEY_PREFIX. Не агрегирует историю по часам (см. ТЗ
        docs/tasks/admin-stats.md, упрощённый Вариант B — только текущая минута).
        """
        minute_key = f"{self.REQUESTS_MINUTE_KEY_PREFIX}{int(time.time() // 60)}"
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            value = await r.get(minute_key)
            requests_current_minute = int(value) if value else 0
            return {
                "requests_current_minute": requests_current_minute,
                "capacity_per_minute":     self.CAPACITY,
                "source":                  "redis",
            }
        except Exception:
            return {
                "requests_current_minute": None,
                "capacity_per_minute":     self.CAPACITY,
                "source":                  "fallback",
            }
        finally:
            await r.aclose()

    async def get_history(
        self, hours: int = 24, redis_client=None, now: float | None = None,
    ) -> dict:
        """
        Суточная картина расхода и отказов (ТЗ watchlist-parallel-fetch.md §4.3).

        Голое число 429 не отвечает на главный вопрос: пока их ноль, неясно,
        близко ли мы к потолку. Поэтому рядом идут пиковая минута (429 приходят
        на пике, а не на среднем), медиана как фон и счётчики предохранителей —
        «мы сами себя тормозим», когда лимит ещё не нарушен, а данные уже не
        собраны.

        ВАЖНО: отсутствующий минутный ключ НЕ считается нулевым расходом.
        Ключи живут MINUTE_KEY_TTL, и их отсутствие означает «данных нет»
        (Redis перезапущен, история протухла), а не «к API не ходили».
        Полнота картины отдаётся отдельно — minutes_observed.

        ОГОВОРКА: счётчик живёт в Redis того окружения, где работает воркер.
        Прод и локальный/стейдж-стек ходят под одним STALCRAFT_CLIENT_ID, но с
        разными Redis, поэтому это НИЖНЯЯ ГРАНИЦА нагрузки на ключ, а не полная.
        Признак отдаётся в shared_key_warning — UI обязан подписать это честно.
        """
        now = now if now is not None else time.time()
        current_minute = int(now // 60)
        current_hour   = int(now // 3600)
        owns_client    = redis_client is None
        r = redis_client if redis_client is not None else aioredis.from_url(
            settings.redis_url, decode_responses=True
        )
        try:
            minute_keys = [
                f"{self.REQUESTS_MINUTE_KEY_PREFIX}{current_minute - i}"
                for i in range(hours * 60)
            ]
            raw_minutes = await r.mget(minute_keys)

            hour_keys: list[str] = []
            for h in range(hours):
                unix_hour = current_hour - h
                hour_keys += [
                    _hour_key(ERROR_429, unix_hour),
                    _hour_key(ERROR_LIMITER_TIMEOUT, unix_hour),
                    _hour_key(ERROR_GUARD_TRIPS, unix_hour),
                ]
            raw_hours = await r.mget(hour_keys)
            last_429  = await r.get(LAST_429_KEY)
        except Exception as e:
            # Операционная метрика не имеет права ронять страницу админа.
            logger.warning(f"rate limit history unavailable: {e}")
            return self._empty_history(hours)
        finally:
            if owns_client:
                await r.aclose()

        per_minute = {
            current_minute - i: int(v)
            for i, v in enumerate(raw_minutes) if v is not None
        }
        observed = list(per_minute.values())

        hours_out = []
        for h in range(hours - 1, -1, -1):
            unix_hour = current_hour - h
            in_hour = [u for m, u in per_minute.items() if m // 60 == unix_hour]
            base = h * 3
            hours_out.append({
                "hour_msk":         datetime.fromtimestamp(unix_hour * 3600, MSK).strftime("%H:00"),
                "peak_units":       max(in_hour) if in_hour else 0,
                "avg_units":        round(sum(in_hour) / len(in_hour)) if in_hour else 0,
                "errors_429":       int(raw_hours[base]     or 0),
                "limiter_timeouts": int(raw_hours[base + 1] or 0),
                "guard_trips":      int(raw_hours[base + 2] or 0),
            })

        peak_minute = max(per_minute, key=per_minute.get) if per_minute else None

        return {
            "window_hours":            hours,
            "capacity_per_minute":     self.CAPACITY,
            "source":                  "redis",
            "minutes_observed":        len(observed),
            "peak_units_per_minute":   max(observed) if observed else 0,
            "peak_minute_msk": (
                datetime.fromtimestamp(peak_minute * 60, MSK).strftime("%Y-%m-%d %H:%M")
                if peak_minute is not None else None
            ),
            "median_units_per_minute": round(statistics.median(observed)) if observed else 0,
            "errors_429_total":        sum(h["errors_429"]       for h in hours_out),
            "limiter_timeouts_total":  sum(h["limiter_timeouts"] for h in hours_out),
            "guard_trips_total":       sum(h["guard_trips"]      for h in hours_out),
            "last_429_at_msk":         last_429,
            "shared_key_warning":      True,
            "hours":                   hours_out,
        }

    def _empty_history(self, hours: int) -> dict:
        return {
            "window_hours":            hours,
            "capacity_per_minute":     self.CAPACITY,
            "source":                  "fallback",
            "minutes_observed":        0,
            "peak_units_per_minute":   0,
            "peak_minute_msk":         None,
            "median_units_per_minute": 0,
            "errors_429_total":        0,
            "limiter_timeouts_total":  0,
            "guard_trips_total":       0,
            "last_429_at_msk":         None,
            "shared_key_warning":      True,
            "hours":                   [],
        }


# Глобальный экземпляр
rate_limiter = TokenBucketRateLimiter()


async def recent_consumption(redis_client) -> int:
    """
    Фактический расход лимитера: max(текущая неполная минута, предыдущая полная).

    В первые секунды минуты счётчик текущей минуты около нуля и как одиночный
    сигнал бесполезен, поэтому читаем оба ключа. Живёт здесь, а не в
    feed_collector: предохранители ленты и watchlist обязаны читать расход из
    одного источника, иначе две копии правила разойдутся при первой же правке
    префикса или TTL.
    """
    minute = int(time.time() // 60)
    prefix = rate_limiter.REQUESTS_MINUTE_KEY_PREFIX
    try:
        values = await redis_client.mget([f"{prefix}{minute}", f"{prefix}{minute - 1}"])
    except Exception as e:
        logger.warning(f"не удалось прочитать расход лимитера: {e}")
        return 0
    return max((int(v) if v else 0) for v in values)


async def incr_error(
    kind: str, redis_client=None, path: str | None = None, now: float | None = None,
) -> None:
    """
    Почасовой счётчик события `kind` (429 / limiter_timeout / guard_trips).

    Best-effort и намеренно молчаливый: учёт ошибок не имеет права ломать сбор
    данных. Падение Redis здесь означает потерю метрики, а не потерю лота.
    """
    now = now if now is not None else time.time()
    owns_client = redis_client is None
    r = redis_client if redis_client is not None else aioredis.from_url(
        settings.redis_url, decode_responses=True
    )
    try:
        key = _hour_key(kind, int(now // 3600))
        await r.incr(key)
        await r.expire(key, MINUTE_KEY_TTL)
        if kind == ERROR_429:
            # Счётчика мало: без времени и пути отказ не с чем сопоставить.
            stamp = datetime.fromtimestamp(now, MSK).strftime("%Y-%m-%d %H:%M:%S")
            await r.set(LAST_429_KEY, f"{stamp} {path or '?'}", ex=MINUTE_KEY_TTL)
    except Exception as e:
        logger.warning(f"не удалось записать счётчик {kind}: {e}")
    finally:
        if owns_client:
            try:
                await r.aclose()
            except Exception:
                pass
