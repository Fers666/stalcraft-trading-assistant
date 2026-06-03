from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from pydantic import BaseModel
from datetime import datetime
import statistics as _statistics

from app.db.session import get_db
from app.models.models import User, MarketStatistics, CollectedData, GlobalItemScan, MasterItem, SalesHistory
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
    price_volatility_30d: float | None
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


def _build_sales_filter(quality_filter: int | None, enchant_filter: int | None) -> list:
    """Возвращает список SQL-условий для фильтрации SalesHistory по качеству/заточке."""
    conds = []
    if quality_filter is not None:
        if quality_filter == 0:
            # qlt=0: поле qlt отсутствует или явно равно 0
            conds.append(or_(
                SalesHistory.additional_info['qlt'].astext.is_(None),
                SalesHistory.additional_info['qlt'].astext == '0',
            ))
        else:
            conds.append(SalesHistory.additional_info['qlt'].astext == str(quality_filter))
    if enchant_filter is not None:
        # ptn — прямое целое 1-15 (0 = не зачарован, в watchlist enchant_filter всегда 1-15)
        conds.append(SalesHistory.additional_info['ptn'].astext == str(enchant_filter))
    return conds


def _make_sell_options(median: float, volume_7d: int) -> list[dict]:
    """Быстрый расчёт sell_options от отфильтрованной медианы (confidence=low)."""
    from app.services.analytics.market_stats import _format_hours
    ref = int(median)
    fast_price    = int(ref * 0.97)
    normal_price  = int(ref * 1.00)
    premium_price = int(ref * 1.05)
    COMMISSION    = 0.05

    sales_per_day = volume_7d / 7.0
    if sales_per_day >= 5:
        fh, nh, ph = 2.0, 8.0, 24.0
    elif sales_per_day >= 1:
        fh, nh, ph = 8.0, 24.0, 72.0
    elif sales_per_day >= 0.14:
        fh, nh, ph = 24.0, 72.0, 168.0
    else:
        fh, nh, ph = 72.0, 168.0, 336.0

    def opt(label, label_ru, price, hours):
        return {
            "label": label, "label_ru": label_ru,
            "price_per_unit": price,
            "net_price_per_unit": int(price * (1 - COMMISSION)),
            "estimated_hours": hours,
            "estimated_hours_display": _format_hours(hours),
            "confidence": "low",
            "data_points": volume_7d,
        }

    return [
        opt("fast",    "Быстро",    fast_price,    fh),
        opt("normal",  "Нормально", normal_price,  nh),
        opt("premium", "Выгодно",   premium_price, ph),
    ]


@router.get("/item/{item_id}", response_model=MonitoringItemResponse)
async def get_item_stats(
    item_id: str,
    region: str = Query(default="RU"),
    quality_filter: int | None = Query(default=None),
    enchant_filter: int | None = Query(default=None),
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

    # Без фильтров — возвращаем глобальную статистику напрямую
    if quality_filter is None and enchant_filter is None:
        return stats

    # С фильтрами — пересчитываем median/volume/volatility/sell_options от отфильтрованных продаж
    from datetime import timezone, timedelta
    now = datetime.now(timezone.utc)
    cutoff_7d  = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    extra_conds = _build_sales_filter(quality_filter, enchant_filter)
    prices_30d = (await db.execute(
        select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region.upper(),
            SalesHistory.sale_time >= cutoff_30d,
            *extra_conds,
        )
    )).scalars().all()

    prices_7d = (await db.execute(
        select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region.upper(),
            SalesHistory.sale_time >= cutoff_7d,
            *extra_conds,
        )
    )).scalars().all()

    if prices_7d:
        filtered_median = _statistics.median(prices_7d)
        filtered_volume = len(prices_7d)
        filtered_opts   = _make_sell_options(filtered_median, filtered_volume)
    else:
        filtered_median = None
        filtered_volume = 0
        filtered_opts   = []

    filtered_volatility_30d = None
    if len(prices_30d) >= 5:
        avg30 = _statistics.mean(prices_30d)
        stdev30 = _statistics.stdev(prices_30d)
        filtered_volatility_30d = round(stdev30 / avg30 * 100, 2) if avg30 > 0 else None

    return MonitoringItemResponse(
        item_id=stats.item_id,
        region=stats.region,
        avg_price_7d=float(stats.avg_price_7d) if stats.avg_price_7d else None,
        median_price_7d=filtered_median,
        min_price_7d=int(stats.min_price_7d) if stats.min_price_7d else None,
        max_price_7d=int(stats.max_price_7d) if stats.max_price_7d else None,
        sales_volume_7d=filtered_volume,
        price_volatility_7d=float(stats.price_volatility_7d) if stats.price_volatility_7d else None,
        price_volatility_30d=filtered_volatility_30d,
        best_sell_hour=stats.best_sell_hour,
        best_sell_day=stats.best_sell_day,
        best_buy_hour=stats.best_buy_hour,
        best_buy_day=stats.best_buy_day,
        sell_hours_by_day=stats.sell_hours_by_day,
        buy_hours_by_day=stats.buy_hours_by_day,
        weekend_bonus_percent=float(stats.weekend_bonus_percent) if stats.weekend_bonus_percent else None,
        avg_sell_time_hours=float(stats.avg_sell_time_hours) if stats.avg_sell_time_hours else None,
        sell_options=filtered_opts or None,
        calculated_at=stats.calculated_at,
    )


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


class SaleRecord(BaseModel):
    sale_time: str
    price_per_unit: int
    amount: int


class DayPoint(BaseModel):
    period_iso: str
    min_price: int | None
    avg_price: float | None
    max_price: int | None
    count: int


class SalesChartResponse(BaseModel):
    mode: str                    # "scatter" | "daily"
    sales: list[SaleRecord] = []
    days: list[DayPoint] = []
    total_count: int


@router.get("/sales-chart/{item_id}", response_model=SalesChartResponse)
async def get_sales_chart(
    item_id: str,
    region: str = Query(default="RU"),
    hours: int = Query(default=24, ge=1, le=720),
    quality_filter: int | None = Query(default=None),
    enchant_filter: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Продажи из sales_history: scatter (≤48ч) или min/avg/max по дням (7д)."""
    from datetime import timezone, timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    extra_conds = _build_sales_filter(quality_filter, enchant_filter)

    if hours < 168:
        rows = (await db.execute(
            select(SalesHistory.sale_time, SalesHistory.price_per_unit, SalesHistory.amount)
            .where(
                SalesHistory.item_id == item_id,
                SalesHistory.region == region.upper(),
                SalesHistory.sale_time >= cutoff,
                *extra_conds,
            )
            .order_by(SalesHistory.sale_time)
        )).all()

        sales = [
            SaleRecord(
                sale_time=r.sale_time.isoformat(),
                price_per_unit=r.price_per_unit,
                amount=r.amount,
            )
            for r in rows
        ]
        return SalesChartResponse(mode="scatter", sales=sales, total_count=len(sales))

    else:
        trunc_expr = func.date_trunc('day', SalesHistory.sale_time)
        rows = (await db.execute(
            select(
                trunc_expr.label('period'),
                func.min(SalesHistory.price_per_unit).label('min_price'),
                func.avg(SalesHistory.price_per_unit).label('avg_price'),
                func.max(SalesHistory.price_per_unit).label('max_price'),
                func.count().label('cnt'),
            )
            .where(
                SalesHistory.item_id == item_id,
                SalesHistory.region == region.upper(),
                SalesHistory.sale_time >= cutoff,
                *extra_conds,
            )
            .group_by(trunc_expr)
            .order_by(trunc_expr)
        )).all()

        days = [
            DayPoint(
                period_iso=r.period.isoformat() if hasattr(r.period, 'isoformat') else str(r.period),
                min_price=r.min_price,
                avg_price=float(r.avg_price) if r.avg_price else None,
                max_price=r.max_price,
                count=r.cnt,
            )
            for r in rows
        ]
        return SalesChartResponse(mode="daily", days=days, total_count=sum(d.count for d in days))


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
