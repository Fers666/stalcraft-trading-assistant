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
import time
from enum import IntEnum

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Стоимость каждого типа запроса
class TokenCost(IntEnum):
    LOTS     = 2
    HISTORY  = 2
    EMISSION = 1


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
    redis.call('EXPIRE', minute_key, 120)
    return 1
else
    local wait = (needed - tokens) / rate
    return -math.ceil(wait)
end
"""


class TokenBucketRateLimiter:
    """
    Глобальный rate limiter для Stalcraft API.
    Bucket state хранится в Redis — корректно при нескольких воркерах Celery.
    Соединение не кешируется: создаётся свежее на каждый acquire().
    """

    CAPACITY    = 400          # запросов в корзине (проверено экспериментально)
    REFILL_RATE = 400 / 60.0  # запросов в секунду
    BUCKET_KEY  = "stalcraft:rate_limit"
    REQUESTS_MINUTE_KEY_PREFIX = "stalcraft:requests:minute:"  # + unix_minute, EXPIRE 120

    def __init__(self):
        self._fallback_lock         = asyncio.Lock()
        self._fallback_tokens       = float(self.CAPACITY)
        self._fallback_last_refill  = time.monotonic()

    async def acquire(self, cost: int = TokenCost.LOTS, max_wait: float = 60.0):
        """
        Запрашивает `cost` токенов. Ждёт если недостаточно (но не дольше max_wait).
        Raises: TimeoutError если ждать дольше max_wait секунд.
        """
        waited = 0.0
        while True:
            now = time.time()
            minute_key = f"{self.REQUESTS_MINUTE_KEY_PREFIX}{int(now // 60)}"
            r = aioredis.from_url(settings.redis_url, decode_responses=True)
            try:
                result = int(await r.eval(
                    _LUA_ACQUIRE, 2,
                    self.BUCKET_KEY, minute_key, int(cost), self.CAPACITY, now, self.REFILL_RATE,
                ))
            except (aioredis.RedisError, ConnectionError, OSError) as e:
                logger.warning(f"Rate limiter Redis error, using in-memory fallback: {e}")
                await r.aclose()
                await self._acquire_fallback(cost, max_wait)
                return
            finally:
                await r.aclose()

            if result == 1:
                logger.debug(f"Token acquired (cost={cost})")
                return

            wait_sec = abs(result)
            if waited + wait_sec > max_wait:
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


# Глобальный экземпляр
rate_limiter = TokenBucketRateLimiter()
