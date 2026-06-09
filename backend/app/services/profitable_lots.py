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

COMMISSION = 0.05
SIGNALS_TTL = 300       # секунд — TTL ключа сигналов (запас на случай задержки цикла)
NOTIF_DEDUP_TTL = 48 * 3600  # 48ч — один лот нотифицируется один раз

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}
_COLOR_TO_QLT: dict[str, int] = {
    "default": 0, "rank_newbie": 1, "rank_stalker": 2, "rank_veteran": 3,
    "rank_master": 4, "rank_legend": 5, "quest_item": 5,
    "gray": 0, "grey": 0, "white": 0, "green": 1, "blue": 2,
    "violet": 3, "purple": 3, "yellow": 4, "black": 4, "red": 5,
}


def signals_key(user_id: int, item_id: str, region: str, quality_filter, enchant_filter) -> str:
    return f"signals:{user_id}:{item_id}:{region}:{quality_filter}:{enchant_filter}"


def _fmt_hours(hours: float) -> str:
    if hours < 2:
        return "< 2 ч"
    if hours < 24:
        return f"~{round(hours)} ч"
    days = hours / 24
    return f"~{round(days)} дня" if days < 5 else f"~{round(days)} дней"


def make_sell_options(ref: int, volume_7d: int) -> list[dict]:
    """Генерирует 3 варианта продажи от опорной цены ref."""
    fast_price    = int(ref * 0.97)
    normal_price  = int(ref * 1.00)
    premium_price = int(ref * 1.05)

    sales_per_day = volume_7d / 7.0 if volume_7d else 0
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
            "estimated_hours_display": _fmt_hours(hours),
            "confidence": "low",
            "data_points": volume_7d,
        }

    return [
        opt("fast",    "Быстро",    fast_price,    fh),
        opt("normal",  "Нормально", normal_price,  nh),
        opt("premium", "Выгодно",   premium_price, ph),
    ]


def _is_artefact(category: Optional[str]) -> bool:
    return bool(category and "artefact" in category.lower())


async def compute_signals_for_entry(
    db, entry, master, stats, snap,
    min_profit_margin_pct: float = 0.0,
) -> Optional[dict]:
    """
    Вычисляет выгодные лоты для одной watchlist-записи.

    Возвращает dict {lots, sell_options, volume_7d, volatility_7d, ref, computed_at}
    или None если данных недостаточно.

    ref = median_price_7d из market_statistics — стабильный исторический ориентир,
    позволяет находить лоты когда рынок временно просел ниже нормального уровня.
    """
    from app.models.models import SalesHistory
    from sqlalchemy import select, or_

    if snap is None or not snap.raw_lots:
        return None

    volume_7d    = (stats.sales_volume_7d or 0) if stats else 0
    msg_volume   = stats.sales_volume_7d if stats else None
    msg_volatility = (
        float(stats.price_volatility_7d) if stats and stats.price_volatility_7d else None
    )

    if entry.quality_filter is None and entry.enchant_filter is None:
        if stats and stats.median_price_7d:
            ref = int(stats.median_price_7d)
        else:
            current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit
            if not current_min:
                return None
            ref = int(current_min)
        vol_for_opts = volume_7d
    else:
        # С фильтрами: медиана реальных продаж с нужным quality/enchant
        cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)
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
            ref = int(_statistics.median(prices))
            vol = len(prices)
            msg_volume = vol
            if vol >= 5:
                avg7 = _statistics.mean(prices)
                msg_volatility = round(_statistics.stdev(prices) / avg7 * 100, 2) if avg7 > 0 else None
            else:
                msg_volatility = None
        else:
            if stats and stats.median_price_7d:
                ref = int(stats.median_price_7d)
            else:
                current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit
                if not current_min:
                    return None
                ref = int(current_min)
            vol = volume_7d
        vol_for_opts = vol if prices else volume_7d

    sell_options = make_sell_options(ref, vol_for_opts)
    normal_opt   = next((o for o in sell_options if o["label"] == "normal"), None)
    if not normal_opt:
        return None
    normal_net = int(normal_opt["net_price_per_unit"])

    now    = datetime.now(timezone.utc)
    is_art = _is_artefact(master.category)
    profitable: list[dict] = []

    for lot in snap.raw_lots:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0:
            continue

        end_str = lot.get("endTime", "")
        if end_str:
            try:
                end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                if (end_dt - now).total_seconds() / 3600 < 2:
                    continue
            except Exception:
                pass

        additional = lot.get("additional") or {}
        qlt = additional.get("qlt")
        ptn = additional.get("ptn")

        if is_art:
            qlt_val = int(qlt) if qlt is not None else 0
            enchant = 0 if ptn is None else int(ptn)
        else:
            color_qlt = _COLOR_TO_QLT.get((master.color or "").lower())
            qlt_val   = int(qlt) if qlt is not None else color_qlt
            enchant   = int(ptn) if ptn is not None and int(ptn) > 0 else None

        if entry.quality_filter is not None and qlt_val != entry.quality_filter:
            continue
        if entry.enchant_filter is not None and enchant != entry.enchant_filter:
            continue

        buyout_per_unit = buyout // amount
        profit = normal_net - buyout_per_unit
        if profit <= 0:
            continue
        if min_profit_margin_pct > 0:
            profit_pct = profit / buyout_per_unit * 100
            if profit_pct < min_profit_margin_pct:
                continue

        quality_name = _QLT_NAMES.get(qlt_val) if qlt_val is not None else None

        profitable.append({
            "start_time":      lot.get("startTime", ""),
            "buyout_price":    buyout,
            "buyout_per_unit": buyout_per_unit,
            "amount":          amount,
            "quality_name":    quality_name,
            "enchant":         enchant,
        })

    return {
        "lots":         profitable,
        "sell_options": sell_options,
        "volume_7d":    msg_volume,
        "volatility_7d": msg_volatility,
        "ref":          ref,
        "computed_at":  datetime.now(timezone.utc).isoformat(),
    }
