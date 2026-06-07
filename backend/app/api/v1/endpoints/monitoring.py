import json

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import statistics as _statistics

from app.db.session import get_db
from app.models.models import User, MarketStatistics, CollectedData, GlobalItemScan, MasterItem, SalesHistory, UserFeedExclusion
from app.core.dependencies import get_current_user
from app.services.profitable_lots import signals_key

router = APIRouter(prefix="/monitoring", tags=["Monitoring"])


class MonitoringItemResponse(BaseModel):
    item_id: str
    region: str
    avg_price_7d: float | None
    median_price_7d: float | None
    min_price_7d: int | None
    max_price_7d: int | None
    sales_volume_7d: int | None
    sales_volume_30d: int | None
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
    batch_stats: dict | None = None
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
        if enchant_filter == 0:
            # 0 = "Не точёный" артефакт: ptn отсутствует или явно равен 0
            conds.append(or_(
                SalesHistory.additional_info['ptn'].astext.is_(None),
                SalesHistory.additional_info['ptn'].astext == '0',
            ))
        else:
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
        # MarketStatistics ещё нет (история продаж не накоплена),
        # но CollectedData может уже быть — генерируем минимальный ответ из снапшота.
        latest_snap = (await db.execute(
            select(CollectedData).where(
                CollectedData.user_id == None,
                CollectedData.item_id == item_id,
                CollectedData.region  == region.upper(),
            ).order_by(CollectedData.collect_time.desc()).limit(1)
        )).scalar_one_or_none()

        if latest_snap is None:
            raise HTTPException(status_code=404, detail="No stats yet for this item")

        current_min = (
            latest_snap.best_liquid_price_per_unit or latest_snap.best_price_per_unit
        )
        fresh_sell_options = _make_sell_options(float(current_min), 0) if current_min else None

        return MonitoringItemResponse(
            item_id=item_id,
            region=region.upper(),
            avg_price_7d=None,
            median_price_7d=None,
            min_price_7d=None,
            max_price_7d=None,
            sales_volume_7d=None,
            sales_volume_30d=None,
            price_volatility_7d=None,
            price_volatility_30d=None,
            best_sell_hour=None,
            best_sell_day=None,
            best_buy_hour=None,
            best_buy_day=None,
            sell_hours_by_day=None,
            buy_hours_by_day=None,
            weekend_bonus_percent=None,
            avg_sell_time_hours=None,
            sell_options=fresh_sell_options,
            batch_stats=None,
            calculated_at=latest_snap.collect_time,
        )

    # Без фильтров — возвращаем статистику со свежими sell_options из последнего снапшота.
    # sell_options в MarketStatistics пересчитываются раз в час — при быстром падении рынка
    # они устаревают и дают ложные "выгодные лоты". Перегенерируем здесь каждый запрос.
    if quality_filter is None and enchant_filter is None:
        latest_snap = (await db.execute(
            select(CollectedData).where(
                CollectedData.user_id == None,
                CollectedData.item_id == item_id,
                CollectedData.region  == region.upper(),
            ).order_by(CollectedData.collect_time.desc()).limit(1)
        )).scalar_one_or_none()

        fresh_sell_options = stats.sell_options  # fallback: сохранённые
        if latest_snap:
            current_min = (
                latest_snap.best_liquid_price_per_unit or latest_snap.best_price_per_unit
            )
            if current_min:
                fresh_sell_options = _make_sell_options(
                    float(current_min), stats.sales_volume_7d or 0
                )

        return MonitoringItemResponse(
            item_id=stats.item_id,
            region=stats.region,
            avg_price_7d=float(stats.avg_price_7d) if stats.avg_price_7d else None,
            median_price_7d=float(stats.median_price_7d) if stats.median_price_7d else None,
            min_price_7d=int(stats.min_price_7d) if stats.min_price_7d else None,
            max_price_7d=int(stats.max_price_7d) if stats.max_price_7d else None,
            sales_volume_7d=stats.sales_volume_7d,
            sales_volume_30d=stats.sales_volume_30d,
            price_volatility_7d=float(stats.price_volatility_7d) if stats.price_volatility_7d else None,
            price_volatility_30d=float(stats.price_volatility_30d) if stats.price_volatility_30d else None,
            best_sell_hour=stats.best_sell_hour,
            best_sell_day=stats.best_sell_day,
            best_buy_hour=stats.best_buy_hour,
            best_buy_day=stats.best_buy_day,
            sell_hours_by_day=stats.sell_hours_by_day,
            buy_hours_by_day=stats.buy_hours_by_day,
            weekend_bonus_percent=float(stats.weekend_bonus_percent) if stats.weekend_bonus_percent else None,
            avg_sell_time_hours=float(stats.avg_sell_time_hours) if stats.avg_sell_time_hours else None,
            sell_options=fresh_sell_options,
            batch_stats=stats.batch_stats,
            calculated_at=stats.calculated_at,
        )

    # С фильтрами — пробуем SalesHistory (на случай если когда-нибудь API начнёт
    # возвращать qlt/ptn в истории), затем фолбэк на raw_lots снэпшотов.
    now = datetime.now(timezone.utc)
    cutoff_7d  = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    extra_conds = _build_sales_filter(quality_filter, enchant_filter)
    prices_7d = (await db.execute(
        select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region.upper(),
            SalesHistory.sale_time >= cutoff_7d,
            *extra_conds,
        )
    )).scalars().all()

    prices_30d = (await db.execute(
        select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region.upper(),
            SalesHistory.sale_time >= cutoff_30d,
            *extra_conds,
        )
    )).scalars().all()

    # Статистика строится только на реальных продажах (SalesHistory с qlt/ptn).
    # qlt/ptn попадает в additional_info при матчинге продажи с лотом из снэпшота.
    # Чем дольше работает коллектор, тем больше покрытие.
    filtered_median          = None
    filtered_volume          = 0
    filtered_sales_30d       = 0
    filtered_opts            = []
    filtered_volatility_7d   = None
    filtered_volatility_30d  = None

    if prices_7d:
        filtered_median  = _statistics.median(prices_7d)
        filtered_volume  = len(prices_7d)
        filtered_opts    = _make_sell_options(filtered_median, filtered_volume)

    if prices_30d:
        filtered_sales_30d = len(prices_30d)
        if len(prices_30d) >= 5:
            avg30 = _statistics.mean(prices_30d)
            if avg30 > 0:
                filtered_volatility_30d = round(_statistics.stdev(prices_30d) / avg30 * 100, 2)

    if len(prices_7d) >= 5:
        avg7 = _statistics.mean(prices_7d)
        if avg7 > 0:
            filtered_volatility_7d = round(_statistics.stdev(prices_7d) / avg7 * 100, 2)

    return MonitoringItemResponse(
        item_id=stats.item_id,
        region=stats.region,
        avg_price_7d=float(stats.avg_price_7d) if stats.avg_price_7d else None,
        median_price_7d=filtered_median,
        min_price_7d=int(stats.min_price_7d) if stats.min_price_7d else None,
        max_price_7d=int(stats.max_price_7d) if stats.max_price_7d else None,
        sales_volume_7d=filtered_volume,
        sales_volume_30d=filtered_sales_30d,
        price_volatility_7d=filtered_volatility_7d,
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
        batch_stats=stats.batch_stats,
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
    """История продаж только из SalesHistory (реальные сделки).
    qlt/ptn попадает в additional_info при матчинге продажи с лотом из снэпшота."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    extra_conds = _build_sales_filter(quality_filter, enchant_filter)

    if hours < 168:
        rows = (await db.execute(
            select(SalesHistory.sale_time, SalesHistory.price_per_unit, SalesHistory.amount)
            .where(
                SalesHistory.item_id == item_id,
                SalesHistory.region  == region.upper(),
                SalesHistory.sale_time >= cutoff,
                *extra_conds,
            )
            .order_by(SalesHistory.sale_time)
        )).all()
        sales = [
            SaleRecord(sale_time=r.sale_time.isoformat(), price_per_unit=r.price_per_unit, amount=r.amount)
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
                SalesHistory.region  == region.upper(),
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


class SignalLot(BaseModel):
    start_time: str
    buyout_price: int
    buyout_per_unit: int
    amount: int
    quality_name: str | None = None
    enchant: int | None = None


class SignalsResponse(BaseModel):
    lots: list[SignalLot]
    sell_options: list | None
    volume_7d: int | None
    volatility_7d: float | None
    ref: int | None
    computed_at: str | None


@router.get("/signals/{item_id}", response_model=SignalsResponse)
async def get_signals(
    item_id: str,
    region: str = Query(default="RU"),
    quality_filter: int | None = Query(default=None),
    enchant_filter: int | None = Query(default=None),
    current_user: User = Depends(get_current_user),
):
    """
    Предвычисленные выгодные лоты для watchlist-записи из Redis.

    Обновляется коллектором после каждого успешного сбора снапшота (~каждые 1-2 мин).
    Та же логика что и Telegram-уведомления — рассинхрон невозможен.
    """
    import redis.asyncio as aioredis
    from app.core.config import settings

    key = signals_key(
        current_user.id, item_id, region.upper(), quality_filter, enchant_filter
    )
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        raw = await r.get(key)
        if raw:
            data = json.loads(raw)
            return SignalsResponse(
                lots         = data.get("lots", []),
                sell_options = data.get("sell_options"),
                volume_7d    = data.get("volume_7d"),
                volatility_7d= data.get("volatility_7d"),
                ref          = data.get("ref"),
                computed_at  = data.get("computed_at"),
            )
    finally:
        await r.aclose()

    return SignalsResponse(
        lots=[], sell_options=None, volume_7d=None,
        volatility_7d=None, ref=None, computed_at=None,
    )


MIN_LIQUID_LOTS_FOR_FEED = 2  # отсекаем неликвид — товар, который потом сложно перепродать
FEED_COMMISSION = 0.05        # комиссия аукциона при продаже — выгодность считаем "на руки"

_FEED_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран", 4: "Мастер", 5: "Легендарный",
}


def _variant_label(category: str | None, quality: int | None, enchant: int | None) -> str | None:
    """Человекочитаемое название варианта (заточка/качество) для карточки ленты.
    None — для базового варианта (quality=0, enchant=0), его в названии не нужно."""
    is_artefact = bool(category and "artefact" in category.lower())
    parts = []
    if is_artefact and quality:
        parts.append(_FEED_QLT_NAMES.get(quality, f"Кач. {quality}"))
    if enchant:
        parts.append(f"+{enchant}")
    return " ".join(parts) if parts else None


class OpportunityItem(BaseModel):
    item_id: str
    name_ru: str | None
    name_en: str | None
    category: str | None
    icon_path: str | None
    region: str
    quality: int | None
    enchant: int | None
    variant_label: str | None
    current_price: int | None
    avg_price_24h: float | None
    min_price_24h: int | None
    est_profit_pct: float | None
    est_profit_per_unit: int | None
    lot_count: int | None
    scanned_at: datetime | None
    min_price_at: datetime | None
    hours_since_min: float | None


@router.get("/feed", response_model=list[OpportunityItem])
async def get_feed(
    region: str = Query(default="RU"),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Топ возможностей сейчас: предметы всего аукциона (вне watchlist),
    которые прямо сейчас выгодно купить и перепродать позже по средней цене.

    est_profit_pct = (avg_price_24h * (1 - FEED_COMMISSION) - current_price) / current_price * 100
    То есть: купил сейчас по current_price → выставил по средней цене 24ч →
    после вычета комиссии аукциона (5%) получил на руки est_profit_per_unit
    с каждой единицы, что в процентах от цены покупки даёт est_profit_pct.
    Сортировка по нему — самые выгодные сделки сверху.

    Каждый вариант предмета (качество × заточка) — отдельная "единица" со
    своей ценой, своей карточкой и своим местом в рейтинге: точёный +10 и
    обычный +0 — разные товары, сравнивать их цены напрямую бессмысленно
    (см. global_item_scan.quality/enchant и global_scanner._scan_single_item).

    Отсекаем:
      - товары с liquid_lot_count < MIN_LIQUID_LOTS_FOR_FEED (потом некому перепродать)
      - товары, скрытые пользователем из ленты (UserFeedExclusion)
    """
    region_u = region.upper()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    excluded_subq = (
        select(UserFeedExclusion.item_id)
        .where(
            UserFeedExclusion.user_id == user.id,
            UserFeedExclusion.region == region_u,
        )
    )

    # COALESCE(..., 0): старые строки скана (до миграции 0020) не знают о вариантах
    # и хранят quality/enchant=NULL — приравниваем их к базовому варианту (0, 0).
    # Без этого NULL = NULL даёт NULL в условии JOIN, и вся такая история выпадает из ленты.
    qlt_expr = func.coalesce(GlobalItemScan.quality, 0)
    ptn_expr = func.coalesce(GlobalItemScan.enchant, 0)

    agg_subq = (
        select(
            GlobalItemScan.item_id.label("item_id"),
            qlt_expr.label("quality"),
            ptn_expr.label("enchant"),
            func.min(GlobalItemScan.best_price).label("min_price"),
            func.avg(GlobalItemScan.avg_price).label("avg_price"),
            func.count().label("scan_count"),
        )
        .where(
            GlobalItemScan.region == region_u,
            GlobalItemScan.scanned_at >= cutoff,
            GlobalItemScan.item_id.notin_(excluded_subq),
        )
        .group_by(GlobalItemScan.item_id, qlt_expr, ptn_expr)
        .having(func.count() >= 2)
        .subquery()
    )

    # Последний скан по каждому варианту предмета — текущая цена и ликвидность прямо сейчас
    latest_subq = (
        select(
            GlobalItemScan.item_id.label("item_id"),
            qlt_expr.label("quality"),
            ptn_expr.label("enchant"),
            GlobalItemScan.best_price.label("current_price"),
            GlobalItemScan.lot_count.label("lot_count"),
            GlobalItemScan.liquid_lot_count.label("liquid_lot_count"),
            GlobalItemScan.scanned_at.label("scanned_at"),
        )
        .distinct(GlobalItemScan.item_id, qlt_expr, ptn_expr)
        .where(
            GlobalItemScan.region == region_u,
            GlobalItemScan.scanned_at >= cutoff,
        )
        .order_by(
            GlobalItemScan.item_id, qlt_expr, ptn_expr,
            GlobalItemScan.scanned_at.desc(),
        )
        .subquery()
    )

    net_revenue_expr = agg_subq.c.avg_price * (1 - FEED_COMMISSION)
    profit_per_unit_expr = net_revenue_expr - latest_subq.c.current_price
    profit_pct_expr = profit_per_unit_expr / latest_subq.c.current_price * 100

    join_cond = (
        (latest_subq.c.item_id == agg_subq.c.item_id)
        & (latest_subq.c.quality == agg_subq.c.quality)
        & (latest_subq.c.enchant == agg_subq.c.enchant)
    )

    rows = (await db.execute(
        select(
            agg_subq.c.item_id,
            agg_subq.c.quality,
            agg_subq.c.enchant,
            agg_subq.c.min_price,
            agg_subq.c.avg_price,
            latest_subq.c.current_price,
            latest_subq.c.lot_count,
            latest_subq.c.scanned_at,
            profit_pct_expr.label("profit_pct"),
            profit_per_unit_expr.label("profit_per_unit"),
        )
        .select_from(agg_subq.join(latest_subq, join_cond))
        .where(
            agg_subq.c.avg_price > 0,
            latest_subq.c.current_price > 0,
            profit_per_unit_expr > 0,
            latest_subq.c.liquid_lot_count >= MIN_LIQUID_LOTS_FOR_FEED,
        )
        .order_by(profit_pct_expr.desc())
        .limit(limit)
    )).all()

    if not rows:
        return []

    top_ids = list({row.item_id for row in rows})
    min_by_variant = {
        (row.item_id, row.quality, row.enchant): int(row.min_price) for row in rows
    }

    # Момент лучшей цены за 24ч по каждому варианту — отдельным запросом
    # (нужен для "была N часов назад")
    detail_rows = (await db.execute(
        select(
            GlobalItemScan.item_id,
            GlobalItemScan.quality,
            GlobalItemScan.enchant,
            GlobalItemScan.best_price,
            GlobalItemScan.scanned_at,
        )
        .where(
            GlobalItemScan.item_id.in_(top_ids),
            GlobalItemScan.region == region_u,
            GlobalItemScan.scanned_at >= cutoff,
        )
        .order_by(GlobalItemScan.scanned_at.asc())
    )).all()

    min_at: dict[tuple[str, int | None, int | None], datetime] = {}
    for row in detail_rows:
        key = (row.item_id, row.quality, row.enchant)
        if key in min_by_variant and row.best_price == min_by_variant[key]:
            min_at[key] = row.scanned_at  # самое недавнее вхождение минимума

    meta_rows = (await db.execute(
        select(MasterItem.item_id, MasterItem.name_ru, MasterItem.name_en,
               MasterItem.category, MasterItem.icon_path)
        .where(MasterItem.item_id.in_(top_ids))
    )).all()
    meta_by_id = {row.item_id: row for row in meta_rows}

    now = datetime.now(timezone.utc)
    result = []
    for row in rows:
        meta = meta_by_id.get(row.item_id)
        key = (row.item_id, row.quality, row.enchant)
        min_dt = min_at.get(key)
        result.append(OpportunityItem(
            item_id=row.item_id,
            name_ru=meta.name_ru if meta else None,
            name_en=meta.name_en if meta else None,
            category=meta.category if meta else None,
            icon_path=meta.icon_path if meta else None,
            region=region_u,
            quality=row.quality,
            enchant=row.enchant,
            variant_label=_variant_label(meta.category if meta else None, row.quality, row.enchant),
            current_price=int(row.current_price) if row.current_price is not None else None,
            avg_price_24h=round(float(row.avg_price), 2),
            min_price_24h=int(row.min_price),
            est_profit_pct=round(float(row.profit_pct), 2),
            est_profit_per_unit=int(row.profit_per_unit),
            lot_count=row.lot_count,
            scanned_at=row.scanned_at,
            min_price_at=min_dt,
            hours_since_min=round((now - min_dt).total_seconds() / 3600, 1) if min_dt else None,
        ))

    return result


class FeedExclusionRequest(BaseModel):
    item_id: str
    region: str = "RU"


class ExcludedItem(BaseModel):
    item_id: str
    name_ru: str | None
    name_en: str | None
    category: str | None
    icon_path: str | None
    region: str
    excluded_at: datetime | None


@router.post("/feed/exclude", status_code=201)
async def exclude_from_feed(
    payload: FeedExclusionRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Скрыть предмет из "Ленты возможностей" — не интересен пользователю."""
    region_u = payload.region.upper()

    existing = (await db.execute(
        select(UserFeedExclusion).where(
            UserFeedExclusion.user_id == user.id,
            UserFeedExclusion.item_id == payload.item_id,
            UserFeedExclusion.region == region_u,
        )
    )).scalar_one_or_none()
    if existing:
        return {"status": "already_excluded"}

    db.add(UserFeedExclusion(user_id=user.id, item_id=payload.item_id, region=region_u))
    await db.commit()
    return {"status": "excluded"}


@router.delete("/feed/exclude/{item_id}", status_code=204)
async def restore_to_feed(
    item_id: str,
    region: str = Query(default="RU"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Вернуть ранее скрытый предмет обратно в ленту."""
    region_u = region.upper()

    existing = (await db.execute(
        select(UserFeedExclusion).where(
            UserFeedExclusion.user_id == user.id,
            UserFeedExclusion.item_id == item_id,
            UserFeedExclusion.region == region_u,
        )
    )).scalar_one_or_none()
    if not existing:
        raise HTTPException(status_code=404, detail="Item is not excluded")

    await db.delete(existing)
    await db.commit()


@router.get("/feed/excluded", response_model=list[ExcludedItem])
async def get_excluded_from_feed(
    region: str = Query(default="RU"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Список предметов, скрытых пользователем из ленты — для управления (вернуть обратно)."""
    region_u = region.upper()

    rows = (await db.execute(
        select(UserFeedExclusion, MasterItem)
        .join(MasterItem, MasterItem.item_id == UserFeedExclusion.item_id)
        .where(
            UserFeedExclusion.user_id == user.id,
            UserFeedExclusion.region == region_u,
        )
        .order_by(UserFeedExclusion.created_at.desc())
    )).all()

    return [
        ExcludedItem(
            item_id=item.item_id,
            name_ru=item.name_ru,
            name_en=item.name_en,
            category=item.category,
            icon_path=item.icon_path,
            region=region_u,
            excluded_at=exclusion.created_at,
        )
        for exclusion, item in rows
    ]
