from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime

from app.db.session import get_db
from app.models.models import User, MarketStatistics, CollectedData, GlobalItemScan, MasterItem
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
    best_buy_hour: int | None
    best_buy_day: str | None
    sell_hours_by_day: dict | None
    buy_hours_by_day: dict | None
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
    # Глобальная статистика хранится с user_id=None — одна запись на пару (item_id, region)
    stats = (await db.execute(
        select(MarketStatistics).where(
            MarketStatistics.user_id == None,
            MarketStatistics.item_id == item_id,
            MarketStatistics.region == region.upper(),
        )
    )).scalar_one_or_none()

    if stats is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="No stats yet for this item")

    return stats


class PricePoint(BaseModel):
    time: datetime
    best_price: int | None
    best_liquid_price: int | None
    avg_price: float | None
    total_lots: int | None
    liquid_lots: int | None


@router.get("/history/{item_id}", response_model=list[PricePoint])
async def get_price_history(
    item_id: str,
    region: str = Query(default="RU"),
    hours: int = Query(default=48, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """История цен из снэпшотов за последние N часов (по умолчанию 48ч)."""
    from datetime import timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    rows = (await db.execute(
        select(CollectedData)
        .where(
            CollectedData.user_id == None,
            CollectedData.item_id == item_id,
            CollectedData.region == region.upper(),
            CollectedData.collect_time >= cutoff,
        )
        .order_by(CollectedData.collect_time.asc())
    )).scalars().all()

    return [
        PricePoint(
            time=row.collect_time,
            best_price=row.best_price_per_unit,
            best_liquid_price=row.best_liquid_price_per_unit,
            avg_price=float(row.avg_price_per_unit) if row.avg_price_per_unit else None,
            total_lots=row.total_lots,
            liquid_lots=row.liquid_lots_count,
        )
        for row in rows
    ]


class FeedItem(BaseModel):
    item_id: str
    name_ru: str | None
    name_en: str | None
    category: str | None
    icon_path: str | None
    region: str
    lot_count: int | None
    liquid_lot_count: int | None
    best_price: int | None
    avg_price: float | None
    price_change_pct: float | None
    tradability_score: float | None
    scanned_at: datetime | None


@router.get("/feed", response_model=list[FeedItem])
async def get_feed(
    region: str = Query(default="RU"),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Топ предметов по торгуемости из глобального скана."""
    rows = (await db.execute(
        select(GlobalItemScan, MasterItem.name_ru, MasterItem.name_en,
               MasterItem.category, MasterItem.icon_path)
        .join(MasterItem, MasterItem.item_id == GlobalItemScan.item_id)
        .where(GlobalItemScan.region == region.upper())
        .order_by(GlobalItemScan.tradability_score.desc())
        .limit(limit)
    )).all()

    return [
        FeedItem(
            item_id=row.GlobalItemScan.item_id,
            name_ru=row.name_ru,
            name_en=row.name_en,
            category=row.category,
            icon_path=row.icon_path,
            region=row.GlobalItemScan.region,
            lot_count=row.GlobalItemScan.lot_count,
            liquid_lot_count=row.GlobalItemScan.liquid_lot_count,
            best_price=row.GlobalItemScan.best_price,
            avg_price=float(row.GlobalItemScan.avg_price) if row.GlobalItemScan.avg_price else None,
            price_change_pct=float(row.GlobalItemScan.price_change_pct) if row.GlobalItemScan.price_change_pct else None,
            tradability_score=float(row.GlobalItemScan.tradability_score) if row.GlobalItemScan.tradability_score else None,
            scanned_at=row.GlobalItemScan.scanned_at,
        )
        for row in rows
    ]
