"""
Вычисление выгодных лотов (сигналов) для watchlist-записи.

Единая точка истины: коллектор вызывает compute_signals_for_entry после сбора
свежего снапшота, результат пишется в Redis. Бот и API-endpoint читают
из этого же ключа — рассинхрон невозможен.

Redis-ключ: signals:{user_id}:{item_id}:{region}:{quality_filter}:{enchant_filter}
TTL: SIGNALS_TTL секунд (чуть дольше интервала коллектора).
"""

import statistics as _statistics
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.services.analytics.pricing import (
    classify_risk, compute_reference, make_sell_options, evaluate_lot_profit,
    STALE_SECONDS, _is_artefact, _lot_quality_enchant, _is_liquid,
)

SIGNALS_TTL = 300       # секунд — TTL ключа сигналов (запас на случай задержки цикла)
NOTIF_DEDUP_TTL = 48 * 3600  # 48ч — один лот нотифицируется один раз

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}


def signals_key(user_id: int, item_id: str, region: str, quality_filter, enchant_filter) -> str:
    return f"signals:{user_id}:{item_id}:{region}:{quality_filter}:{enchant_filter}"


def _filtered_median_now(raw_lots: list, master, entry, is_art: bool, now: datetime) -> Optional[float]:
    """Медиана текущих цен лотов снэпшота, совпадающих по quality/enchant фильтрам entry."""
    prices = []
    for lot in raw_lots:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0:
            continue
        if not _is_liquid(lot, now):
            continue
        qlt_val, enchant = _lot_quality_enchant(lot, master, is_art)
        if entry.quality_filter is not None and qlt_val != entry.quality_filter:
            continue
        if entry.enchant_filter is not None and enchant != entry.enchant_filter:
            continue
        prices.append(buyout // amount)
    return float(_statistics.median(prices)) if prices else None


async def compute_signals_for_entry(
    db, entry, master, stats, snap,
    min_profit_margin_pct: float = 0.0,
    exclude_less_than_amount: int = 1,
) -> Optional[dict]:
    """
    Вычисляет выгодные лоты для одной watchlist-записи.

    Возвращает dict {lots, sell_options, volume_7d, volatility_7d, ref, ref_source,
    trend, risk, total_profitable_amount, saturation_ratio, computed_at}
    или None если данных недостаточно или снэпшот устарел (> STALE_SECONDS).

    ref берётся из pricing.compute_reference(): приоритет — median_price_7d из
    market_statistics (стабильный исторический ориентир, независимый от текущего
    скана лотов — иначе профит математически невозможен, см. pricing.py).
    Медиана текущего снэпшота используется только как trend-guard.
    """
    from app.models.models import SalesHistory
    from sqlalchemy import select, or_

    if snap is None or not snap.raw_lots:
        return None

    now = datetime.now(timezone.utc)

    collect_time = snap.collect_time
    if collect_time is not None:
        if collect_time.tzinfo is None:
            collect_time = collect_time.replace(tzinfo=timezone.utc)
        if (now - collect_time).total_seconds() > STALE_SECONDS:
            return None

    is_art = _is_artefact(master.category)

    volume_7d    = (stats.sales_volume_7d or 0) if stats else 0
    msg_volume   = stats.sales_volume_7d if stats else None
    msg_volatility = (
        float(stats.price_volatility_7d) if stats and stats.price_volatility_7d else None
    )

    current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit

    if entry.quality_filter is None and entry.enchant_filter is None:
        median_hist = float(stats.median_price_7d) if stats and stats.median_price_7d else None
        median_now  = float(snap.median_price_per_unit) if snap.median_price_per_unit else None
        ref_info = compute_reference(median_hist, median_now, current_min)
        vol_for_opts = volume_7d
    else:
        # С фильтрами: медиана реальных продаж с нужным quality/enchant
        cutoff_7d = now - timedelta(days=7)
        q = select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id   == entry.item_id,
            SalesHistory.region    == entry.region,
            SalesHistory.sale_time >= cutoff_7d,
        )
        if entry.quality_filter is not None:
            if entry.quality_filter == 0:
                q = q.where(or_(
                    SalesHistory.additional_info["qlt"].astext.is_(None),
                    SalesHistory.additional_info["qlt"].astext == "0",
                ))
            else:
                q = q.where(
                    SalesHistory.additional_info["qlt"].astext == str(entry.quality_filter)
                )
        if entry.enchant_filter is not None:
            if entry.enchant_filter == 0:
                q = q.where(or_(
                    SalesHistory.additional_info["ptn"].astext.is_(None),
                    SalesHistory.additional_info["ptn"].astext == "0",
                ))
            else:
                q = q.where(
                    SalesHistory.additional_info["ptn"].astext == str(entry.enchant_filter)
                )

        prices = (await db.execute(q)).scalars().all()

        if prices:
            median_hist = float(_statistics.median(prices))
            vol = len(prices)
            msg_volume = vol
            if vol >= 5:
                avg7 = _statistics.mean(prices)
                msg_volatility = round(_statistics.stdev(prices) / avg7 * 100, 2) if avg7 > 0 else None
            else:
                msg_volatility = None
            median_now = _filtered_median_now(snap.raw_lots, master, entry, is_art, now)
            ref_info = compute_reference(median_hist, median_now, current_min)
        else:
            median_hist = float(stats.median_price_7d) if stats and stats.median_price_7d else None
            ref_info = compute_reference(median_hist, None, current_min)
            vol = volume_7d
        vol_for_opts = vol if prices else None

    if ref_info is None:
        return None

    ref        = ref_info["ref"]
    ref_source = ref_info["source"]
    trend      = ref_info["trend"]
    risk       = classify_risk(msg_volatility)

    sell_options = make_sell_options(ref, vol_for_opts) if vol_for_opts is not None else None
    batch_stats  = stats.batch_stats if stats else None

    profitable: list[dict] = []

    for lot in snap.raw_lots:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0:
            continue
        if amount < exclude_less_than_amount:
            continue
        if not _is_liquid(lot, now):
            continue

        qlt_val, enchant = _lot_quality_enchant(lot, master, is_art)

        if entry.quality_filter is not None and qlt_val != entry.quality_filter:
            continue
        if entry.enchant_filter is not None and enchant != entry.enchant_filter:
            continue

        buyout_per_unit = buyout // amount

        evaluated = evaluate_lot_profit(
            buyout_per_unit, amount, sell_options, risk, min_profit_margin_pct, batch_stats,
        )
        if evaluated is None:
            continue

        quality_name = _QLT_NAMES.get(qlt_val) if qlt_val is not None else None

        profitable.append({
            "start_time":      lot.get("startTime", ""),
            "buyout_price":    buyout,
            "buyout_per_unit": buyout_per_unit,
            "amount":          amount,
            "quality_name":    quality_name,
            "enchant":         enchant,
            **evaluated,
        })

    profitable.sort(key=lambda l: l["profit_per_hour"] or 0, reverse=True)

    total_profitable_amount = sum(l["amount"] for l in profitable)
    saturation_ratio = (
        round(total_profitable_amount / (volume_7d / 7), 2) if volume_7d else None
    )

    return {
        "lots":            profitable,
        "sell_options":    sell_options,
        "volume_7d":       msg_volume,
        "volatility_7d":   msg_volatility,
        "ref":             ref,
        "ref_source":      ref_source,
        "trend":           trend,
        "risk":            risk,
        "total_profitable_amount": total_profitable_amount,
        "saturation_ratio": saturation_ratio,
        "computed_at":     now.isoformat(),
    }
