"""
Redis-кэш для ответов Stalcraft API.

Назначение: несколько пользователей запрашивают один и тот же товар →
только один реальный запрос к API, остальные получают данные из кэша.

TTL:
  - Активные лоты (/lots):    5 минут  (совпадает с интервалом сбора)
  - История продаж (/history): 60 минут (совпадает с интервалом сбора истории)

Ключи Redis:
  stalcraft:cache:{region}:{item_id}:lots
  stalcraft:cache:{region}:{item_id}:history
"""

import json
import logging

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

TTL_LOTS    = 5 * 60   # секунд
TTL_HISTORY = 60 * 60  # секунд

# Версия кэша — bump при изменении структуры данных (старые ключи умрут по TTL)
CACHE_VERSION = "v2"


class ApiCache:
    def __init__(self):
        self._redis: aioredis.Redis | None = None

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = await aioredis.from_url(
                settings.redis_url, encoding="utf-8", decode_responses=True
            )
        return self._redis

    def _lots_key(self, region: str, item_id: str) -> str:
        return f"stalcraft:cache:{CACHE_VERSION}:{region}:{item_id}:lots"

    def _history_key(self, region: str, item_id: str) -> str:
        return f"stalcraft:cache:{CACHE_VERSION}:{region}:{item_id}:history"

    async def get_lots(self, region: str, item_id: str) -> dict | None:
        """Возвращает закэшированные лоты или None если кэш пуст."""
        try:
            r = await self._get_redis()
            raw = await r.get(self._lots_key(region, item_id))
            if raw:
                logger.debug(f"Cache HIT: lots {region}/{item_id}")
                return json.loads(raw)
        except Exception as e:
            logger.warning(f"Cache read error: {e}")
        return None

    async def set_lots(self, region: str, item_id: str, data: dict) -> None:
        """Сохраняет лоты в кэш на 5 минут."""
        try:
            r = await self._get_redis()
            await r.setex(self._lots_key(region, item_id), TTL_LOTS, json.dumps(data))
            logger.debug(f"Cache SET: lots {region}/{item_id}")
        except Exception as e:
            logger.warning(f"Cache write error: {e}")

    async def get_history(self, region: str, item_id: str) -> dict | None:
        """Возвращает закэшированную историю или None."""
        try:
            r = await self._get_redis()
            raw = await r.get(self._history_key(region, item_id))
            if raw:
                logger.debug(f"Cache HIT: history {region}/{item_id}")
                return json.loads(raw)
        except Exception as e:
            logger.warning(f"Cache read error: {e}")
        return None

    async def set_history(self, region: str, item_id: str, data: dict) -> None:
        """Сохраняет историю в кэш на 60 минут."""
        try:
            r = await self._get_redis()
            await r.setex(self._history_key(region, item_id), TTL_HISTORY, json.dumps(data))
            logger.debug(f"Cache SET: history {region}/{item_id}")
        except Exception as e:
            logger.warning(f"Cache write error: {e}")

    async def get_or_fetch_lots(self, region: str, item_id: str) -> dict:
        """
        Главный метод для API endpoint-ов:
        1. Проверяет кэш
        2. Если кэш пуст — делает запрос к Stalcraft API и кэширует результат
        """
        cached = await self.get_lots(region, item_id)
        if cached is not None:
            cached["_from_cache"] = True
            return cached

        from app.services.collector.client import stalcraft_client
        original_region = stalcraft_client.region
        stalcraft_client.region = region
        try:
            data = await stalcraft_client.get_auction_lots(item_id)
        finally:
            stalcraft_client.region = original_region

        await self.set_lots(region, item_id, data)
        data["_from_cache"] = False
        return data

    async def invalidate_lots(self, region: str, item_id: str) -> None:
        """Сбрасывает кэш лотов (вызывается после сбора новых данных воркером)."""
        try:
            r = await self._get_redis()
            await r.delete(self._lots_key(region, item_id))
        except Exception as e:
            logger.warning(f"Cache invalidate error: {e}")


api_cache = ApiCache()
