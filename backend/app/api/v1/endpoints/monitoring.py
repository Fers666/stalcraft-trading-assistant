import json

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import statistics as _statistics

from app.db.session import get_db
from app.models.models import User, MarketStatistics, CollectedData, SalesHistory, MasterItem
from app.core.dependencies import get_current_user
from app.core.tiers import get_tier_limits, max_stats_hours
from app.services.profitable_lots import signals_key
from app.services.analytics.pricing import (
    make_sell_options, classify_risk, compute_reference, weighted_reference,
    matching_lot_prices, _build_sales_filter,
)
from app.services.analytics.market_stats import (
    derive_sell_timing, derive_buy_timing,
    _calculate_batch_stats, _avg_sell_time_from_buyouts,
)

router = APIRouter(prefix="/monitoring", tags=["Monitoring"])


class MonitoringItemResponse(BaseModel):
    item_id: str
    region: str
    avg_price_24h: float | None = None
    median_price_24h: float | None = None
    min_price_24h: int | None = None
    max_price_24h: int | None = None
    sales_volume_24h: int | None = None
    avg_price_48h: float | None = None
    min_price_48h: int | None = None
    max_price_48h: int | None = None
    sales_volume_48h: int | None = None
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
    # Цены продажи от ТЕКУЩЕГО минимума лотов — режим «Сейчас» в карточке.
    # sell_options считаются от опорной цены (взвешенная медиана продаж за 7д).
    sell_options_now: list | None = None
    current_min_price: int | None = None
    # Опорная цена и тренд — см. pricing.compute_reference.
    # reference_price НЕ равна median_price_7d: та остаётся описательной статистикой.
    reference_price: int | None = None
    reference_source: str | None = None
    reference_confidence: str | None = None
    reference_samples: int | None = None
    trend: str | None = None
    trend_pct: float | None = None
    batch_stats: dict | None = None
    demand_signals: dict | None = None
    risk_level: str | None = None
    calculated_at: datetime | None

    class Config:
        from_attributes = True


def _make_sell_options(median: float, volume_7d: int) -> list[dict]:
    """Тонкая обёртка над pricing.make_sell_options (confidence=low, без time_price_pairs)."""
    return make_sell_options(int(median), volume_7d)


def _mask_stats_windows(response: "MonitoringItemResponse", allowed_windows: tuple[str, ...]) -> "MonitoringItemResponse":
    """Обнуляет поля окон статистики, не разрешённых тарифом пользователя.
    Маскировка на уровне Pydantic-ответа — статистика глобальная и общая для
    всех, фильтрация по тарифу не дублирует логику расчёта на уровне SQL."""
    if "48h" not in allowed_windows:
        response.avg_price_48h = None
        response.min_price_48h = None
        response.max_price_48h = None
        response.sales_volume_48h = None
    if "7d" not in allowed_windows:
        response.avg_price_7d = None
        response.median_price_7d = None
        response.min_price_7d = None
        response.max_price_7d = None
        response.sales_volume_7d = None
        response.price_volatility_7d = None
        response.sell_options = None
        response.risk_level = None
        # Всё производное от 7-дневного окна: опорная цена и тренд считаются
        # относительно медианы 7д, поэтому маскируются вместе с ней.
        response.sell_options_now = None
        response.reference_price = None
        response.reference_source = None
        response.reference_confidence = None
        response.reference_samples = None
        response.trend = None
        response.trend_pct = None
    if "30d" not in allowed_windows:
        response.sales_volume_30d = None
        response.price_volatility_30d = None
    return response


@router.get("/item/{item_id}", response_model=MonitoringItemResponse)
async def get_item_stats(
    item_id: str,
    region: str = Query(default="RU"),
    quality_filter: int | None = Query(default=None),
    enchant_filter: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    limits = get_tier_limits(current_user)

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

        response = MonitoringItemResponse(
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
            # Цены здесь и так от текущего снапшота — «Сейчас» обязан их видеть,
            # иначе UI печатает «нет свежего снапшота» ровно при его наличии
            sell_options_now=fresh_sell_options,
            current_min_price=int(current_min) if current_min else None,
            reference_price=int(current_min) if current_min else None,
            reference_source="current_fallback" if current_min else None,
            reference_confidence="low" if current_min else None,
            reference_samples=0,
            batch_stats=None,
            demand_signals=None,
            risk_level=None,
            calculated_at=latest_snap.collect_time,
        )
        return _mask_stats_windows(response, limits.stats_windows)

    # Снапшот нужен обеим веткам: даёт текущий минимум лотов (режим «Сейчас»)
    # и фоллбек-опору, когда истории продаж по фильтру нет.
    latest_snap = (await db.execute(
        select(CollectedData).where(
            CollectedData.user_id == None,
            CollectedData.item_id == item_id,
            CollectedData.region  == region.upper(),
        ).order_by(CollectedData.collect_time.desc()).limit(1)
    )).scalar_one_or_none()

    if quality_filter is None and enchant_filter is None:
        current_min = (
            latest_snap.best_liquid_price_per_unit or latest_snap.best_price_per_unit
        ) if latest_snap else None

        # reference_price считается часовой задачей по всем продажам за 7д.
        # Не пересчитываем здесь: при полураспаде веса в 48ч отсутствие последнего
        # часа несущественно, а запрос всей истории на каждый поллинг (30с) — дорог.
        ref_info = compute_reference(
            weighted_hist=float(stats.reference_price) if stats.reference_price else None,
            median_hist=float(stats.median_price_7d) if stats.median_price_7d else None,
            sample_count=stats.sales_volume_7d or 0,
            median_24h=float(stats.median_price_24h) if stats.median_price_24h else None,
            sample_count_24h=stats.sales_volume_24h or 0,
            median_now=float(latest_snap.median_price_per_unit) if latest_snap and latest_snap.median_price_per_unit else None,
            current_min=float(current_min) if current_min else None,
            # Эффективное число сделок за опорой считает та же часовая задача,
            # что и саму опору (живьём это вся история за 7д на каждый поллинг).
            # NULL — строка ещё не пересчитана после появления колонки: вес 0
            # даёт confidence="low", то есть честное «данных мало» вместо
            # завышенной уверенности по сырому count. Гейт below_floor карточка
            # не применяет, поэтому опора остаётся видна.
            weight=float(stats.reference_weight or 0),
        )

        fresh_sell_options = (
            _make_sell_options(ref_info["ref"], stats.sales_volume_7d or 0)
            if ref_info else stats.sell_options
        )
        sell_options_now = (
            _make_sell_options(float(current_min), stats.sales_volume_7d or 0)
            if current_min else None
        )

        response = MonitoringItemResponse(
            item_id=stats.item_id,
            region=stats.region,
            avg_price_24h=float(stats.avg_price_24h) if stats.avg_price_24h else None,
            min_price_24h=int(stats.min_price_24h) if stats.min_price_24h else None,
            max_price_24h=int(stats.max_price_24h) if stats.max_price_24h else None,
            sales_volume_24h=stats.sales_volume_24h,
            avg_price_48h=float(stats.avg_price_48h) if stats.avg_price_48h else None,
            min_price_48h=int(stats.min_price_48h) if stats.min_price_48h else None,
            max_price_48h=int(stats.max_price_48h) if stats.max_price_48h else None,
            sales_volume_48h=stats.sales_volume_48h,
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
            sell_options_now=sell_options_now,
            current_min_price=int(current_min) if current_min else None,
            median_price_24h=float(stats.median_price_24h) if stats.median_price_24h else None,
            reference_price=ref_info["ref"] if ref_info else None,
            reference_source=ref_info["source"] if ref_info else None,
            reference_confidence=ref_info["confidence"] if ref_info else None,
            reference_samples=ref_info["samples"] if ref_info else None,
            trend=ref_info["trend"] if ref_info else None,
            trend_pct=ref_info["trend_pct"] if ref_info else None,
            batch_stats=stats.batch_stats,
            demand_signals=stats.demand_signals,
            risk_level=classify_risk(float(stats.price_volatility_7d) if stats.price_volatility_7d else None),
            calculated_at=stats.calculated_at,
        )
        return _mask_stats_windows(response, limits.stats_windows)

    # С фильтрами — пробуем SalesHistory (на случай если когда-нибудь API начнёт
    # возвращать qlt/ptn в истории), затем фолбэк на raw_lots снэпшотов.
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d  = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    # Один фетч строк за 30д (sale_time/price/amount/additional_info) вместо двух
    # scalar-запросов: те же колонки покрывают и ценовые окна, и группу A
    # (время продажи/пачки/ср. время). Row даёт атрибутный доступ, совместимый
    # с чистыми хелперами market_stats — ORM-сущность целиком не грузим.
    extra_conds = _build_sales_filter(quality_filter, enchant_filter)
    rows = (await db.execute(
        select(
            SalesHistory.sale_time,
            SalesHistory.price_per_unit,
            SalesHistory.amount,
            SalesHistory.additional_info,
        ).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region.upper(),
            SalesHistory.sale_time >= cutoff_30d,
            *extra_conds,
        ).order_by(SalesHistory.sale_time.desc())
    )).all()

    rows_7d    = [r for r in rows if r.sale_time >= cutoff_7d]
    prices_30d = [r.price_per_unit for r in rows]
    prices_7d  = [r.price_per_unit for r in rows_7d]

    # Статистика строится только на реальных продажах (SalesHistory с qlt/ptn).
    # qlt/ptn попадает в additional_info при матчинге продажи с лотом из снэпшота.
    # Чем дольше работает коллектор, тем больше покрытие.
    filtered_median          = None
    filtered_median_24h      = None
    filtered_volume          = 0
    filtered_sales_30d       = 0
    filtered_opts            = []
    filtered_volatility_7d   = None
    filtered_volatility_30d  = None

    # Текущий минимум лотов под тем же фильтром качества/заточки: режим «Сейчас»
    # и фоллбек-опора, если продаж по фильтру ещё нет.
    filtered_current_min = None
    if latest_snap and latest_snap.raw_lots:
        master = (await db.execute(
            select(MasterItem).where(MasterItem.item_id == item_id)
        )).scalar_one_or_none()
        if master:
            lot_prices = matching_lot_prices(
                latest_snap.raw_lots, master, quality_filter, enchant_filter, now,
            )
            filtered_current_min = min(lot_prices) if lot_prices else None

    prices_24h = [r.price_per_unit for r in rows if r.sale_time >= cutoff_24h]

    if prices_7d:
        filtered_median = _statistics.median(prices_7d)
        filtered_volume = len(prices_7d)
        if prices_24h:
            filtered_median_24h = _statistics.median(prices_24h)

    # Опорная цена — как и в ветке без фильтров, через единый compute_reference.
    # Раньше здесь стояла голая медиана 7д без всякой поправки на свежесть:
    # на падающем рынке она обещала прибыль, которой уже нет.
    wr = weighted_reference([(r.sale_time, r.price_per_unit) for r in rows_7d], now)
    ref_info = compute_reference(
        weighted_hist=wr["ref"] if wr else None,
        median_hist=float(filtered_median) if filtered_median else None,
        sample_count=filtered_volume,
        median_24h=float(filtered_median_24h) if filtered_median_24h else None,
        sample_count_24h=len(prices_24h),
        current_min=float(filtered_current_min) if filtered_current_min else None,
        weight=wr["weight"] if wr else 0.0,
    )
    if ref_info:
        filtered_opts = _make_sell_options(ref_info["ref"], filtered_volume)

    filtered_opts_now = (
        _make_sell_options(float(filtered_current_min), filtered_volume)
        if filtered_current_min else None
    )

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

    # Группа A (время продажи / пачки / ср. время продажи) + buy-side (B1) —
    # пересчёт per-request из отфильтрованного набора вместо агрегата по всему предмету.
    # Пустая выборка → хелперы вернут None/{}, карточка честно покажет «нет данных».
    sell_timing            = derive_sell_timing(rows)
    buy_timing             = derive_buy_timing(rows)
    filtered_batch         = _calculate_batch_stats(rows)
    filtered_avg_sell_time = _avg_sell_time_from_buyouts(rows)

    response = MonitoringItemResponse(
        item_id=stats.item_id,
        region=stats.region,
        avg_price_24h=float(stats.avg_price_24h) if stats.avg_price_24h else None,
        min_price_24h=int(stats.min_price_24h) if stats.min_price_24h else None,
        max_price_24h=int(stats.max_price_24h) if stats.max_price_24h else None,
        # Объём 24ч — по отфильтрованной выборке: UI гейтит по нему линию «24ч»
        # и метку тренда, агрегат по всему предмету дал бы ложный «объём есть»
        sales_volume_24h=len(prices_24h),
        avg_price_48h=float(stats.avg_price_48h) if stats.avg_price_48h else None,
        min_price_48h=int(stats.min_price_48h) if stats.min_price_48h else None,
        max_price_48h=int(stats.max_price_48h) if stats.max_price_48h else None,
        sales_volume_48h=stats.sales_volume_48h,
        avg_price_7d=float(stats.avg_price_7d) if stats.avg_price_7d else None,
        median_price_7d=filtered_median,
        min_price_7d=int(stats.min_price_7d) if stats.min_price_7d else None,
        max_price_7d=int(stats.max_price_7d) if stats.max_price_7d else None,
        sales_volume_7d=filtered_volume,
        sales_volume_30d=filtered_sales_30d,
        price_volatility_7d=filtered_volatility_7d,
        price_volatility_30d=filtered_volatility_30d,
        best_sell_hour=sell_timing["best_sell_hour"],
        best_sell_day=sell_timing["best_sell_day"],
        best_buy_hour=buy_timing["best_buy_hour"],
        best_buy_day=buy_timing["best_buy_day"],
        sell_hours_by_day=sell_timing["sell_hours_by_day"] or None,
        buy_hours_by_day=buy_timing["buy_hours_by_day"] or None,
        weekend_bonus_percent=sell_timing["weekend_bonus_percent"],
        avg_sell_time_hours=filtered_avg_sell_time,
        sell_options=filtered_opts or None,
        sell_options_now=filtered_opts_now,
        current_min_price=int(filtered_current_min) if filtered_current_min else None,
        median_price_24h=float(filtered_median_24h) if filtered_median_24h else None,
        reference_price=ref_info["ref"] if ref_info else None,
        reference_source=ref_info["source"] if ref_info else None,
        reference_confidence=ref_info["confidence"] if ref_info else None,
        reference_samples=ref_info["samples"] if ref_info else None,
        trend=ref_info["trend"] if ref_info else None,
        trend_pct=ref_info["trend_pct"] if ref_info else None,
        batch_stats=filtered_batch,
        demand_signals=stats.demand_signals,
        risk_level=classify_risk(filtered_volatility_7d),
        calculated_at=stats.calculated_at,
    )
    return _mask_stats_windows(response, limits.stats_windows)


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
    current_user: User = Depends(get_current_user),
):
    """История цен из снэпшотов за последние N часов (по умолчанию 48ч)."""
    from datetime import timezone, timedelta

    if hours > max_stats_hours(get_tier_limits(current_user)):
        return []

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
    # Медиана цен сделок ЗА ЭТО ОКНО. Карточка рисует линию-ориентир и крупное
    # число шапки от неё, а не от median_price_7d: у редко торгуемого варианта
    # в 7д попадает одна сделка, и «медиана» превращалась в её цену (она же
    # максимум месяца). В daily-режиме окно отдаётся агрегатами по дням, из
    # которых настоящую медиану сделок не восстановить — поэтому считаем в SQL.
    median: int | None = None


@router.get("/sales-chart/{item_id}", response_model=SalesChartResponse)
async def get_sales_chart(
    item_id: str,
    region: str = Query(default="RU"),
    hours: int = Query(default=24, ge=1, le=720),
    quality_filter: int | None = Query(default=None),
    enchant_filter: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """История продаж только из SalesHistory (реальные сделки).
    qlt/ptn попадает в additional_info при матчинге продажи с лотом из снэпшота."""
    if hours > max_stats_hours(get_tier_limits(current_user)):
        return SalesChartResponse(mode="scatter", sales=[], days=[], total_count=0)

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
        # Строки уже в памяти — доп. запрос ради медианы не нужен.
        median = int(_statistics.median([r.price_per_unit for r in rows])) if rows else None
        return SalesChartResponse(
            mode="scatter", sales=sales, total_count=len(sales), median=median,
        )

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
        # Медиана считается по САМИМ сделкам окна, а не по дневным средним:
        # день с десятью сделками иначе весил бы столько же, сколько день с одной.
        median_row = (await db.execute(
            select(func.percentile_cont(0.5).within_group(SalesHistory.price_per_unit.asc()))
            .where(
                SalesHistory.item_id == item_id,
                SalesHistory.region  == region.upper(),
                SalesHistory.sale_time >= cutoff,
                *extra_conds,
            )
        )).scalar()
        return SalesChartResponse(
            mode="daily",
            days=days,
            total_count=sum(d.count for d in days),
            median=int(median_row) if median_row is not None else None,
        )


class SignalLot(BaseModel):
    start_time: str
    buyout_price: int
    buyout_per_unit: int
    amount: int
    quality_name: str | None = None
    enchant: int | None = None
    profit: int | None = None
    profit_pct: float | None = None
    profit_per_hour: float | None = None
    tier_used: str | None = None
    sell_price_used: int | None = None
    # Цена продажи, при которой прибыль после комиссии = 0 (pricing.evaluate_lot_profit)
    breakeven_per_unit: int | None = None
    ref_used: int | None = None


class SignalsResponse(BaseModel):
    lots: list[SignalLot]
    sell_options: list | None
    volume_7d: int | None
    volatility_7d: float | None
    ref: int | None
    ref_source: str | None = None
    ref_confidence: str | None = None
    ref_samples: int | None = None
    trend: str | None = None
    trend_pct: float | None = None
    median_7d: int | None = None
    risk: str | None = None
    total_profitable_amount: int | None = None
    saturation_ratio: float | None = None
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

    Производные 7-дневного окна маскируются по тарифу так же, как в
    /monitoring/item: иначе закрытая там статистика утекала бы через сигналы.
    """
    import redis.asyncio as aioredis
    from app.core.config import settings

    allows_7d = "7d" in get_tier_limits(current_user).stats_windows

    key = signals_key(
        current_user.id, item_id, region.upper(), quality_filter, enchant_filter
    )
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        raw = await r.get(key)
        if raw:
            data = json.loads(raw)
            masked = (lambda v: v if allows_7d else None)
            return SignalsResponse(
                lots         = data.get("lots", []),
                sell_options = masked(data.get("sell_options")),
                volume_7d    = masked(data.get("volume_7d")),
                volatility_7d= masked(data.get("volatility_7d")),
                ref          = masked(data.get("ref")),
                ref_source   = masked(data.get("ref_source")),
                ref_confidence = masked(data.get("ref_confidence")),
                ref_samples  = masked(data.get("ref_samples")),
                trend        = masked(data.get("trend")),
                trend_pct    = masked(data.get("trend_pct")),
                median_7d    = masked(data.get("median_7d")),
                risk         = masked(data.get("risk")),
                total_profitable_amount = data.get("total_profitable_amount"),
                saturation_ratio        = data.get("saturation_ratio"),
                computed_at  = data.get("computed_at"),
            )
    finally:
        await r.aclose()

    return SignalsResponse(
        lots=[], sell_options=None, volume_7d=None,
        volatility_7d=None, ref=None, computed_at=None,
    )
