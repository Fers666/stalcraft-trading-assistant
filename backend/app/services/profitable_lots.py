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

from app.services.analytics.market_stats import COVERAGE_MEDIUM, extract_time_price_pairs
from app.services.analytics.pricing import (
    classify_risk, compute_reference, make_sell_options, evaluate_lot_profit,
    weighted_reference, _build_sales_filter, matching_lot_prices,
    MIN_BATCH_SAMPLES, STALE_SECONDS, _is_artefact, _lot_quality_enchant, _is_liquid,
)

SIGNALS_TTL = 300       # секунд — TTL ключа сигналов (запас на случай задержки цикла)
NOTIF_DEDUP_TTL = 48 * 3600  # 48ч — один лот нотифицируется один раз

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}


def signals_key(user_id: int, item_id: str, region: str, quality_filter, enchant_filter) -> str:
    return f"signals:{user_id}:{item_id}:{region}:{quality_filter}:{enchant_filter}"


def buymin_key(user_id: int, item_id: str, region: str, quality_filter, enchant_filter) -> str:
    """Ключ «самого дешёвого подходящего лота» для Buy Sniper (см. cheapest_matching_lot)."""
    return f"buymin:{user_id}:{item_id}:{region}:{quality_filter}:{enchant_filter}"


def _filtered_median_now(raw_lots: list, master, entry, is_art: bool, now: datetime) -> Optional[float]:
    """Медиана текущих цен лотов снэпшота, совпадающих по quality/enchant фильтрам entry."""
    prices = matching_lot_prices(
        raw_lots, master, entry.quality_filter, entry.enchant_filter, now,
    )
    return float(_statistics.median(prices)) if prices else None


def cheapest_matching_lot(entry, master, snap) -> Optional[dict]:
    """
    Самый дешёвый ликвидный лот снапшота, подходящий под quality_filter/
    enchant_filter записи watchlist. Для триггера закупки (Buy Sniper):
    срабатывает на ЛЮБОЙ лот ≤ порога, независимо от прибыльности перепродажи,
    поэтому НЕ зависит от исторических данных / ref (в отличие от
    compute_signals_for_entry, который возвращает None без ref).

    Возвращает {start_time, price_per_unit, amount, quality_name, enchant}
    или None если подходящих ликвидных лотов нет.
    """
    if snap is None or not snap.raw_lots:
        return None

    now = datetime.now(timezone.utc)
    is_art = _is_artefact(master.category)

    best: Optional[dict] = None
    best_ppu: Optional[int] = None

    for lot in snap.raw_lots:
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

        ppu = buyout // amount
        if best_ppu is None or ppu < best_ppu:
            best_ppu = ppu
            best = {
                "start_time":     lot.get("startTime", ""),
                "price_per_unit": ppu,
                "amount":         amount,
                "quality_name":   _QLT_NAMES.get(qlt_val) if qlt_val is not None else None,
                "enchant":        enchant,
            }

    return best


async def compute_signals_for_entry(
    db, entry, master, stats, snap,
    min_profit_margin_pct: float = 0.0,
    exclude_less_than_amount: int = 1,
) -> Optional[dict]:
    """
    Вычисляет выгодные лоты для одной watchlist-записи.

    Возвращает dict {lots, sell_options, volume_7d, volatility_7d, ref, ref_source,
    ref_confidence, ref_samples, trend, trend_pct, median_7d, risk,
    total_profitable_amount, saturation_ratio, computed_at}
    или None если данных недостаточно или снэпшот устарел (> STALE_SECONDS).

    ref берётся из pricing.compute_reference(): приоритет — взвешенная по
    свежести медиана реальных продаж за 7д (плоская медиана 7д остаётся
    фоллбеком, текущий минимум лотов — только при полном отсутствии истории,
    иначе профит математически невозможен, см. pricing.py).
    Медиана активных лотов снэпшота — только фоллбек-метка тренда.

    sell_options считаются по реальным парам «часы на рынке → цена» за 30 дней
    (extract_time_price_pairs + правило покрытия COVERAGE_MEDIUM) — так же, как
    в market_stats и в статистике вариантов Ленты. Эвристика по объёму продаж
    остаётся только фоллбеком при недостаточном покрытии.
    """
    from app.models.models import SalesHistory
    from sqlalchemy import select

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

    cutoff_7d  = now - timedelta(days=7)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_30d = now - timedelta(days=30)

    # Продажи за 30 дней ПОД ФИЛЬТРАМИ качества/заточки записи (без фильтров —
    # все продажи предмета). Одна выборка на двух потребителей: 7-дневное
    # подмножество даёт опорную цену ветки с фильтрами, полные 30 дней — пары
    # «часы на рынке → цена» для прогноза времени продажи.
    #
    # Пары обязательны: без них make_sell_options падал на грубую эвристику по
    # объёму продаж, и одно и то же ₽/час расходилось с Лентой (которая пары
    # передаёт) в разы — вплоть до 4х на одном лоте. Окно, правило покрытия и
    # сама функция извлечения пар — те же, что в market_stats и variant_stats.
    sales_30d = (await db.execute(
        select(
            SalesHistory.sale_time,
            SalesHistory.price_per_unit,
            SalesHistory.additional_info,
        ).where(
            SalesHistory.item_id   == entry.item_id,
            SalesHistory.region    == entry.region,
            SalesHistory.sale_time >= cutoff_30d,
            *_build_sales_filter(entry.quality_filter, entry.enchant_filter),
        )
    )).all()

    pairs = extract_time_price_pairs(sales_30d)
    coverage = len(pairs) / len(sales_30d) if sales_30d else 0.0
    pairs_for_options = (
        pairs if (coverage >= COVERAGE_MEDIUM and len(pairs) >= MIN_BATCH_SAMPLES) else None
    )

    if entry.quality_filter is None and entry.enchant_filter is None:
        ref_info = compute_reference(
            weighted_hist=float(stats.reference_price) if stats and stats.reference_price else None,
            median_hist=float(stats.median_price_7d) if stats and stats.median_price_7d else None,
            sample_count=volume_7d,
            median_24h=float(stats.median_price_24h) if stats and stats.median_price_24h else None,
            sample_count_24h=(stats.sales_volume_24h or 0) if stats else 0,
            median_now=float(snap.median_price_per_unit) if snap.median_price_per_unit else None,
            current_min=current_min,
        )
        vol_for_opts = volume_7d
    else:
        # Фоллбек-минимум под тем же фильтром: глобальный минимум по предмету
        # относится к другому товару (у Магмы это 145 тыс. против 9.5 млн для
        # «Особый») и как опора дал бы бессмысленный ref.
        filtered_lot_prices = matching_lot_prices(
            snap.raw_lots, master, entry.quality_filter, entry.enchant_filter, now,
        )
        current_min = min(filtered_lot_prices) if filtered_lot_prices else None
        # С фильтрами: опорная цена по реальным продажам с нужным quality/enchant.
        # sale_time нужен для взвешивания по свежести — без него ref вырождается
        # в плоскую медиану 7д и на падающем рынке завышает прибыль.
        rows = [r for r in sales_30d if r.sale_time >= cutoff_7d]

        prices = [r.price_per_unit for r in rows]

        if prices:
            median_hist = float(_statistics.median(prices))
            vol = len(prices)
            msg_volume = vol
            if vol >= 5:
                avg7 = _statistics.mean(prices)
                msg_volatility = round(_statistics.stdev(prices) / avg7 * 100, 2) if avg7 > 0 else None
            else:
                msg_volatility = None

            prices_24h = [r.price_per_unit for r in rows if r.sale_time >= cutoff_24h]
            wr = weighted_reference([(r.sale_time, r.price_per_unit) for r in rows], now)
            ref_info = compute_reference(
                weighted_hist=wr["ref"] if wr else None,
                median_hist=median_hist,
                sample_count=vol,
                median_24h=float(_statistics.median(prices_24h)) if prices_24h else None,
                sample_count_24h=len(prices_24h),
                median_now=_filtered_median_now(snap.raw_lots, master, entry, is_art, now),
                current_min=current_min,
            )
        else:
            ref_info = compute_reference(
                median_hist=float(stats.median_price_7d) if stats and stats.median_price_7d else None,
                sample_count=volume_7d,
                current_min=current_min,
            )
            vol = volume_7d
        vol_for_opts = vol if prices else None

    if ref_info is None:
        return None

    ref        = ref_info["ref"]
    ref_source = ref_info["source"]
    trend      = ref_info["trend"]
    risk       = classify_risk(msg_volatility)

    sell_options = (
        make_sell_options(ref, vol_for_opts, pairs_for_options)
        if vol_for_opts is not None else None
    )
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
        "ref_confidence":  ref_info["confidence"],
        "ref_samples":     ref_info["samples"],
        "trend":           trend,
        "trend_pct":       ref_info["trend_pct"],
        "median_7d":       ref_info["median_7d"],
        "risk":            risk,
        "total_profitable_amount": total_profitable_amount,
        "saturation_ratio": saturation_ratio,
        "computed_at":     now.isoformat(),
    }
