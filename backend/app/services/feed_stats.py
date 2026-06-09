"""
Расчёт статистики для feed_watchlist-записи.
Читает из SalesHistory и CollectedData (уже собранных данных).
Не делает API-запросов.
"""
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import SalesHistory, CollectedData
from app.services.profitable_lots import make_sell_options


@dataclass
class FeedStats:
    sales_7d: int
    sales_24h: int
    profitable_lots_count: int
    avg_profit: float


async def compute_feed_stats(
    db: AsyncSession,
    item_id: str,
    region: str,
    quality_filter,
    enchant_filter,
    min_profit_margin_pct: float = 0.0,
) -> FeedStats:
    now = datetime.now(timezone.utc)
    cutoff_7d  = now - timedelta(days=7)
    cutoff_24h = now - timedelta(hours=24)

    # ── Продажи из истории ──────────────────────────────────────────────────
    sales_7d_row = await db.execute(
        select(func.count()).where(
            SalesHistory.item_id   == item_id,
            SalesHistory.region    == region,
            SalesHistory.sale_time >= cutoff_7d,
        )
    )
    sales_24h_row = await db.execute(
        select(func.count()).where(
            SalesHistory.item_id   == item_id,
            SalesHistory.region    == region,
            SalesHistory.sale_time >= cutoff_24h,
        )
    )
    sales_7d  = sales_7d_row.scalar() or 0
    sales_24h = sales_24h_row.scalar() or 0

    # ── Последний снэпшот лотов ─────────────────────────────────────────────
    snap_row = await db.execute(
        select(CollectedData)
        .where(
            CollectedData.item_id == item_id,
            CollectedData.region  == region,
        )
        .order_by(CollectedData.collect_time.desc())
        .limit(1)
    )
    snap = snap_row.scalar_one_or_none()

    if snap is None or not snap.raw_lots:
        return FeedStats(
            sales_7d=sales_7d, sales_24h=sales_24h,
            profitable_lots_count=0, avg_profit=0.0,
        )

    # ── Прибыльные лоты из снэпшота ────────────────────────────────────────
    ref = snap.best_liquid_price_per_unit or snap.best_price_per_unit
    if not ref:
        return FeedStats(
            sales_7d=sales_7d, sales_24h=sales_24h,
            profitable_lots_count=0, avg_profit=0.0,
        )

    sell_opts = make_sell_options(ref, sales_7d)
    normal_opt = next((o for o in sell_opts if o["label"] == "normal"), None)
    if not normal_opt:
        return FeedStats(
            sales_7d=sales_7d, sales_24h=sales_24h,
            profitable_lots_count=0, avg_profit=0.0,
        )
    normal_net = normal_opt["net_price_per_unit"]

    profitable_count = 0
    profit_sum = 0.0

    for lot in snap.raw_lots:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0:
            continue

        additional = lot.get("additional") or {}
        qlt = additional.get("qlt")
        ptn = additional.get("ptn")

        if quality_filter is not None:
            lot_qlt = int(qlt) if qlt is not None else 0
            if lot_qlt != quality_filter:
                continue
        if enchant_filter is not None:
            lot_ptn = int(ptn) if ptn is not None else 0
            if lot_ptn != enchant_filter:
                continue

        buyout_per_unit = buyout // amount
        profit = normal_net - buyout_per_unit
        if profit <= 0:
            continue
        if min_profit_margin_pct > 0:
            profit_pct = profit / buyout_per_unit * 100
            if profit_pct < min_profit_margin_pct:
                continue

        profitable_count += 1
        profit_sum += profit

    avg_profit = profit_sum / profitable_count if profitable_count else 0.0

    return FeedStats(
        sales_7d=sales_7d,
        sales_24h=sales_24h,
        profitable_lots_count=profitable_count,
        avg_profit=avg_profit,
    )
