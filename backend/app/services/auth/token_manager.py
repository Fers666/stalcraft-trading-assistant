"""
OAuth2 Client Credentials token manager для Stalcraft API.

Flow:
  POST https://exbo.net/oauth/token
  → access_token (временный, обычно 3600s)

Токен кешируется в Redis. За 60 секунд до истечения — обновляется автоматически.
"""

import logging
import time

import httpx
import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

OAUTH_URL = "https://exbo.net/oauth/token"
REDIS_KEY = "stalcraft:access_token"
REFRESH_BEFORE_EXPIRY = 60  # секунд до истечения — обновить заранее


class TokenManager:
    def __init__(self):
        self._redis: aioredis.Redis | None = None

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is not None:
            try:
                await self._redis.ping()
                return self._redis
            except Exception:
                self._redis = None
        self._redis = await aioredis.from_url(
            settings.redis_url, encoding="utf-8", decode_responses=True
        )
        return self._redis

    async def _fetch_new_token(self) -> tuple[str, int]:
        """Запрашивает новый access_token через OAuth. Возвращает (token, expires_in)."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                OAUTH_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": settings.stalcraft_client_id,
                    "client_secret": settings.stalcraft_client_secret,
                    "scope": "",
                },
            )
            response.raise_for_status()
            data = response.json()

        token = data["access_token"]
        expires_in = int(data.get("expires_in", 3600))
        logger.info(f"Fetched new Stalcraft access token, expires in {expires_in}s")
        return token, expires_in

    async def get_token(self) -> str:
        """
        Возвращает валидный access_token.
        Берёт из Redis если есть, иначе запрашивает новый.
        """
        r = await self._get_redis()
        token = await r.get(REDIS_KEY)

        if token:
            return token

        token, expires_in = await self._fetch_new_token()
        ttl = max(expires_in - REFRESH_BEFORE_EXPIRY, 60)
        await r.setex(REDIS_KEY, ttl, token)
        return token

    async def invalidate(self):
        """Сбрасывает кеш — следующий вызов get_token() запросит новый токен."""
        r = await self._get_redis()
        await r.delete(REDIS_KEY)


token_manager = TokenManager()
