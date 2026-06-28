"""
«Радар рынка» — кросс-юзерная агрегация watchlist. Доступ: аддон
User.has_market_radar_addon или is_admin (см. get_market_radar_access).
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import User
from app.core.dependencies import get_market_radar_access
from app.services.analytics.market_radar import get_market_radar_aggregate

router = APIRouter(prefix="/market-radar", tags=["Market Radar"])


class MarketRadarItem(BaseModel):
    item_id: str
    quality_filter: int | None = None
    enchant_filter: int | None = None
    name_ru: str | None = None
    name_en: str | None = None
    icon_path: str | None = None
    watchers_count: int
    new_watchers_24h: int
    avg_price_24h: float | None = None
    sales_volume_24h: int | None = None
    bulk_spike: bool | None = None
    price_window: str
    profitable_offers_count: int | None = None


class MarketRadarResponse(BaseModel):
    top_items: list[MarketRadarItem]
    total_active_watchers: int
    unique_items_tracked: int
    calculated_at: str


@router.get("/", response_model=MarketRadarResponse)
async def get_market_radar(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_market_radar_access),
):
    aggregate = await get_market_radar_aggregate(db)
    return MarketRadarResponse(**aggregate)
