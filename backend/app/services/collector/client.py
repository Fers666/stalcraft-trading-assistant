import asyncio
import logging

import httpx

from app.core.config import settings
from app.core.rate_limiter import rate_limiter, TokenCost
from app.services.auth.token_manager import token_manager

logger = logging.getLogger(__name__)


class StalcraftClient:
    """HTTP клиент Stalcraft API. Токен получается через OAuth, запросы через Token Bucket."""

    def __init__(self):
        self.base_url = settings.stalcraft_base_url
        self.region = settings.stalcraft_region

    async def _request(self, method: str, path: str, cost: int, **kwargs) -> dict:
        await rate_limiter.acquire(cost=cost)

        token = await token_manager.get_token()
        headers = {"Authorization": f"Bearer {token}"}

        logger.debug(f"→ {method} {self.base_url}{path}")

        async with httpx.AsyncClient(base_url=self.base_url, timeout=30.0) as client:
            response = await client.request(method, path, headers=headers, **kwargs)

        logger.debug(f"← {response.status_code}")

        if response.status_code == 401:
            # Токен протух — сбрасываем кеш и повторяем один раз
            logger.warning("401 received — refreshing token and retrying")
            await token_manager.invalidate()
            token = await token_manager.get_token()
            async with httpx.AsyncClient(base_url=self.base_url, timeout=30.0) as client:
                response = await client.request(
                    method, path,
                    headers={"Authorization": f"Bearer {token}"},
                    **kwargs,
                )

        if response.status_code == 429:
            logger.error("429 received despite token bucket — backing off 60s")
            await asyncio.sleep(60)
            raise RuntimeError("Rate limit exceeded (429)")

        response.raise_for_status()
        return response.json() if response.content else {}

    async def get_auction_lots(self, item_id: str, region: str, offset: int = 0, limit: int = 200) -> dict:
        return await self._request(
            "GET", f"/{region}/auction/{item_id}/lots",
            cost=TokenCost.LOTS,
            params={"offset": offset, "limit": min(limit, 200), "additional": "true"},
        )

    async def get_auction_history(self, item_id: str, region: str, offset: int = 0, limit: int = 200) -> dict:
        return await self._request(
            "GET", f"/{region}/auction/{item_id}/history",
            cost=TokenCost.HISTORY,
            params={"offset": offset, "limit": min(limit, 200), "additional": "true"},
        )

    async def get_emission(self, region: str | None = None) -> dict:
        r = region or self.region
        return await self._request("GET", f"/{r}/emission", cost=TokenCost.EMISSION)

    async def close(self):
        if self._client:
            await self._client.aclose()


stalcraft_client = StalcraftClient()
