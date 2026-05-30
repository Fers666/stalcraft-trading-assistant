from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime

from app.db.session import get_db
from app.models.models import User, MarketStatistics
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/monitoring", tags=["Monitoring"])


class MonitoringItemResponse(BaseModel):
    item_id: str
    region: str
    avg_price_7d: float | None
    median_price_7d: float | None
    min_price_7d: int | None
    max_price_7d: int | None
    sales_volume_7d: int | None
    price_volatility_7d: float | None
    best_sell_hour: int | None
    best_sell_day: str | None
    weekend_bonus_percent: float | None
    avg_sell_time_hours: float | None
    sell_options: list | None
    calculated_at: datetime | None

    class Config:
        from_attributes = True


@router.get("/item/{item_id}", response_model=MonitoringItemResponse)
async def get_item_stats(
    item_id: str,
    region: str = Query(default="RU"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stats = (await db.execute(
        select(MarketStatistics).where(
            MarketStatistics.user_id == current_user.id,
            MarketStatistics.item_id == item_id,
            MarketStatistics.region == region.upper(),
        )
    )).scalar_one_or_none()

    if stats is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="No stats yet for this item")

    return stats
