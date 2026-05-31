"""
Token Bucket Rate Limiter для Stalcraft API.

Лимиты (из официального ТЗ):
  - 100 токенов / минута
  - /auction/.../lots    = 2 токена
  - /auction/.../history = 2 токена
  - /emission            = 1 токен

Реализация через Redis:
  - Ключ: stalcraft:rate_limit (глобальный для demo API)
  - Пополнение: 100 токенов каждую минуту
  - Lua-скрипт для атомарного acquire
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
    LOTS    = 2
    HISTORY = 2
    EMISSION = 1


# Lua-скрипт: атомарно проверяет и списывает токены
# KEYS[1] = bucket key
# ARGV[1] = tokens_needed
# ARGV[2] = capacity
# ARGV[3] = current_time (unix seconds, float)
# ARGV[4] = refill_rate (tokens per second = 100/60)
# Возвращает: 1 если успешно, 0 если недостаточно, -1 если нужно ждать N секунд
_LUA_ACQUIRE = """
local key        = KEYS[1]
local needed     = tonumber(ARGV[1])
local capacity   = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local rate       = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens     = tonumber(data[1]) or capacity
local last_refill = tonumber(data[2]) or now

-- пополнение пропорционально прошедшему времени
local elapsed = now - last_refill
local refilled = elapsed * rate
tokens = math.min(capacity, tokens + refilled)

if tokens >= needed then
    tokens = tokens - needed
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 120)
    return 1
else
    -- сколько секунд ждать до накопления нужного количества
    local wait = (needed - tokens) / rate
    return -math.ceil(wait)
end
"""


class TokenBucketRateLimiter:
    """
    Глобальный rate limiter для Stalcraft API.
    Использует Redis для хранения состояния (работает корректно
    при нескольких воркерах Celery).
    """

    CAPACITY    = 100          # токенов в корзине
    REFILL_RATE = 100 / 60.0  # токенов в секунду (100/мин)
    BUCKET_KEY  = "stalcraft:rate_limit"

    def __init__(self):
        self._redis: aioredis.Redis | None = None
        self._script_sha: str | None = None
        self._fallback_lock = asyncio.Lock()
        self._fallback_tokens = float(self.CAPACITY)
        self._fallback_last_refill = time.monotonic()

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is not None:
            try:
                await self._redis.ping()
                return self._redis
            except Exception:
                self._redis = None
                self._script_sha = None
        self._redis = await aioredis.from_url(
            settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        return self._redis

    async def _load_script(self, r: aioredis.Redis) -> str:
        if self._script_sha is None:
            self._script_sha = await r.script_load(_LUA_ACQUIRE)
        return self._script_sha

    async def acquire(self, cost: int = TokenCost.LOTS, max_wait: float = 60.0):
        """
        Запрашивает `cost` токенов. Ждёт если недостаточно (но не дольше max_wait).
        Raises: TimeoutError если ждать дольше max_wait секунд.
        """
        waited = 0.0
        while True:
            try:
                r = await self._get_redis()
                sha = await self._load_script(r)
                result = await r.evalsha(
                    sha, 1,
                    self.BUCKET_KEY,
                    cost,
                    self.CAPACITY,
                    time.time(),
                    self.REFILL_RATE,
                )
                result = int(result)

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

            except (aioredis.RedisError, ConnectionError) as e:
                # Fallback: in-memory bucket если Redis недоступен
                logger.warning(f"Redis unavailable, using in-memory fallback: {e}")
                await self._acquire_fallback(cost, max_wait)
                return

    async def _acquire_fallback(self, cost: int, max_wait: float):
        """In-memory fallback когда Redis недоступен."""
        waited = 0.0
        while True:
            async with self._fallback_lock:
                now = time.monotonic()
                elapsed = now - self._fallback_last_refill
                self._fallback_tokens = min(
                    self.CAPACITY,
                    self._fallback_tokens + elapsed * self.REFILL_RATE
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
        try:
            r = await self._get_redis()
            data = await r.hmget(self.BUCKET_KEY, "tokens", "last_refill")
            tokens = float(data[0]) if data[0] else float(self.CAPACITY)
            return {
                "tokens_available": round(tokens, 1),
                "capacity": self.CAPACITY,
                "refill_rate_per_min": 100,
                "source": "redis",
            }
        except Exception:
            return {
                "tokens_available": round(self._fallback_tokens, 1),
                "capacity": self.CAPACITY,
                "refill_rate_per_min": 100,
                "source": "fallback",
            }

    async def close(self):
        if self._redis:
            await self._redis.aclose()
            self._redis = None


# Глобальный экземпляр
rate_limiter = TokenBucketRateLimiter()
