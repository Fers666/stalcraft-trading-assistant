"""
Общие хелперы для расчёта выгодности лотов аукциона.

Используются:
- profitable_lots.compute_signals_for_entry — живой скан выгодных лотов
  (питает Redis-сигналы для Telegram-бота и API /monitoring/signals)
- market_stats._calculate_sell_options — прогноз цены/времени продажи
  для статистики товара
- monitoring._make_sell_options — то же для API /monitoring/item/{item_id}
- market_radar — SQL-фильтр SalesHistory по quality/enchant для бакетов
  топа с заданным фильтром (см. _build_sales_filter), фильтрация raw_lots
  снэпшота по quality/enchant бакета (см. _lot_quality_enchant) и подсчёт
  profitable_offers_count (см. _is_artefact, _is_liquid)
"""

import statistics
from datetime import datetime
from typing import Optional

from sqlalchemy import or_

from app.models.models import SalesHistory


COMMISSION       = 0.05   # комиссия аукциона при продаже
GLITCH_RATIO     = 0.05   # current_min < hist_median * GLITCH_RATIO -> игнорируем current_min (глитч-цена)
TREND_DROP_RATIO = 0.75   # median_now < median_hist * TREND_DROP_RATIO -> рынок "просел"
STALE_SECONDS    = 90     # снэпшот старше этого -> сигналу не доверяем

HIGH_VOLATILITY  = 30.0
MED_VOLATILITY   = 15.0

RISK_MARGIN_MULT = {"low": 1.0, "medium": 1.3, "high": 1.6}

MIN_BATCH_SAMPLES = 3

# Бакеты размеров пачек — поправка на объём в evaluate_lot_profit
# и статистика продаж по пачкам (market_stats._calculate_batch_stats).
BATCH_BUCKETS: list[tuple[str, int, int]] = [
    ("x1",       1,   1),
    ("x2_5",     2,   5),
    ("x6_10",    6,   10),
    ("x11_25",   11,  25),
    ("x26_50",   26,  50),
    ("x51_plus", 51,  10_000),
]


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


def _is_artefact(category: Optional[str]) -> bool:
    return bool(category and "artefact" in category.lower())


def _lot_quality_enchant(lot: dict, master, is_art: bool) -> tuple[Optional[int], Optional[int]]:
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

    return qlt_val, enchant


def _is_liquid(lot: dict, now: datetime) -> bool:
    """Лот ликвиден, если до конца аукциона >= 2ч (или endTime неизвестен)."""
    end_str = lot.get("endTime", "")
    if not end_str:
        return True
    try:
        end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
        return (end_dt - now).total_seconds() / 3600 >= 2
    except Exception:
        return True


def classify_risk(volatility_pct: Optional[float]) -> str:
    """low/medium/high по волатильности цены за 7д (в процентах)."""
    if volatility_pct is None:
        return "medium"
    if volatility_pct > HIGH_VOLATILITY:
        return "high"
    if volatility_pct > MED_VOLATILITY:
        return "medium"
    return "low"


def format_hours(hours: float) -> str:
    if hours < 2:
        return "< 2 ч"
    if hours < 24:
        return f"~{round(hours)} ч"
    days = hours / 24
    if days < 2:
        return "~1-2 дня"
    return f"~{round(days)} дня" if days < 5 else f"~{round(days)} дней"


def compute_reference(
    median_hist: Optional[float],
    median_now: Optional[float],
    current_min: Optional[float],
) -> Optional[dict]:
    """
    Опорная цена (ref) для расчёта sell_options.

    median_hist — медиана продаж за 7д (MarketStatistics.median_price_7d),
                  стабильный ориентир, независимый от текущего скана лотов.
    median_now  — медиана ТЕКУЩЕГО снэпшота (CollectedData.median_price_per_unit
                  либо аналог по тем же фильтрам качества/заточки) —
                  используется только как trend-guard, не как сам ref.
    current_min — текущий минимум среди лотов, фоллбек если истории продаж нет.

    Возвращает {"ref": int, "source": "history"|"current_fallback", "trend": ...}
    или None если нет вообще никакого ориентира.
    """
    if median_hist:
        ref = float(median_hist)
        trend = "stable"
        if median_now and median_hist > 0:
            ratio = median_now / median_hist
            if ratio < TREND_DROP_RATIO:
                trend = "falling"
                # рынок просел — не верим в полный возврат к старой медиане,
                # но и не считаем текущую просадку новой нормой целиком
                ref = max(median_now, median_hist * TREND_DROP_RATIO)
            elif ratio > 1 / TREND_DROP_RATIO:
                trend = "rising"
        return {"ref": int(ref), "source": "history", "trend": trend}

    if current_min:
        return {"ref": int(current_min), "source": "current_fallback", "trend": "unknown"}

    return None


def make_sell_options(
    ref: int,
    volume_7d: Optional[int],
    time_price_pairs: Optional[list[tuple[float, int]]] = None,
) -> list[dict]:
    """
    3 ценовые точки (fast/normal/premium) от ref с прогнозом времени продажи.

    time_price_pairs — реальные пары (часы_на_рынке, цена) из sales_history
    с восстановленным lot_start. При >= MIN_BATCH_SAMPLES точек даёт
    confidence="medium" (интерполяция по среднему времени), иначе
    confidence="low" (оценка по объёму продаж за 7д).
    """
    fast_price    = int(ref * 0.97)
    normal_price  = int(ref * 1.00)
    premium_price = int(ref * 1.05)

    pairs = time_price_pairs or []
    if len(pairs) >= MIN_BATCH_SAMPLES:
        confidence = "medium"
        avg_time = statistics.mean(t for t, _ in pairs)
        fast_hours    = round(avg_time * 0.4, 1)
        normal_hours  = round(avg_time * 1.0, 1)
        premium_hours = round(avg_time * 2.5, 1)
        data_points = len(pairs)
    else:
        confidence = "low"
        sales_per_day = (volume_7d or 0) / 7.0
        if sales_per_day >= 5:
            fast_hours, normal_hours, premium_hours = 2.0, 8.0, 24.0
        elif sales_per_day >= 1:
            fast_hours, normal_hours, premium_hours = 8.0, 24.0, 72.0
        elif sales_per_day >= 0.14:
            fast_hours, normal_hours, premium_hours = 24.0, 72.0, 168.0
        else:
            fast_hours, normal_hours, premium_hours = 72.0, 168.0, 336.0
        data_points = volume_7d or 0

    def opt(label, label_ru, price, hours):
        return {
            "label": label, "label_ru": label_ru,
            "price_per_unit": price,
            "net_price_per_unit": int(price * (1 - COMMISSION)),
            "estimated_hours": hours,
            "estimated_hours_display": format_hours(hours),
            "confidence": confidence,
            "data_points": data_points,
        }

    return [
        opt("fast",    "Быстро",    fast_price,    fast_hours),
        opt("normal",  "Нормально", normal_price,  normal_hours),
        opt("premium", "Выгодно",   premium_price, premium_hours),
    ]


def batch_bucket_for_amount(amount: int) -> Optional[str]:
    for key, lo, hi in BATCH_BUCKETS:
        if lo <= amount <= hi:
            return key
    return None


def evaluate_lot_profit(
    buyout_per_unit: int,
    amount: int,
    sell_options: Optional[list[dict]],
    risk: str,
    min_margin_pct: float = 0.0,
    batch_stats: Optional[dict] = None,
) -> Optional[dict]:
    """
    Оценивает выгодность лота. Базовый сценарий продажи — tier "fast"
    (консервативнее "normal": продать быстрее, не упираясь в рыночную медиану).

    Если для размера пачки `amount` есть статистика реальных продаж
    (batch_stats.by_size[bucket]) — корректирует ожидаемую цену продажи
    пропорционально отношению медианной цены пачки к "normal"-цене.

    required_margin = min_margin_pct * RISK_MARGIN_MULT[risk] — чем выше
    волатильность, тем больший запас прибыли требуется.

    Возвращает None если невыгодно, иначе словарь с метриками.
    """
    if not sell_options:
        return None
    fast   = next((o for o in sell_options if o["label"] == "fast"), None)
    normal = next((o for o in sell_options if o["label"] == "normal"), None)
    if not fast or not normal:
        return None

    sell_price = fast["price_per_unit"]

    if amount > 1 and batch_stats:
        bucket = batch_bucket_for_amount(amount)
        bucket_info = (batch_stats.get("by_size") or {}).get(bucket) if bucket else None
        if (
            bucket_info
            and bucket_info.get("count", 0) >= MIN_BATCH_SAMPLES
            and normal["price_per_unit"] > 0
        ):
            factor = bucket_info["median_price_per_unit"] / normal["price_per_unit"]
            sell_price = sell_price * factor

    net_price = sell_price * (1 - COMMISSION)
    profit = net_price - buyout_per_unit
    if profit <= 0:
        return None

    profit_pct = profit / buyout_per_unit * 100
    required_margin = min_margin_pct * RISK_MARGIN_MULT.get(risk, 1.0)
    if profit_pct < required_margin:
        return None

    hours = fast["estimated_hours"] or 0
    profit_per_hour = profit / hours if hours > 0 else None

    return {
        "profit":          int(profit),
        "profit_pct":      round(profit_pct, 1),
        "profit_per_hour": round(profit_per_hour, 2) if profit_per_hour is not None else None,
        "tier_used":       "fast",
        "sell_price_used": int(sell_price),
    }
