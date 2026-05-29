"""
Алгоритмы аналитики из документа архитектуры (раздел 5).
"""
from dataclasses import dataclass
from typing import Optional


SELL_COMMISSION = 0.05  # 5% комиссия при продаже


@dataclass
class LotData:
    price_per_unit: int
    amount: int


@dataclass
class MarketStats:
    avg_sell_price_7d: float
    sales_volume_7d: int
    price_volatility_7d: float   # процент
    best_sell_hour: Optional[int] = None
    best_sell_day: Optional[str] = None


@dataclass
class ProfitabilityResult:
    is_profitable: bool
    profit_percent: float
    score: float                 # profit_percent * confidence
    expected_sell_price: int     # после комиссии
    expected_profit_per_unit: int
    recommend_sell_hour: Optional[int]
    recommend_sell_day: Optional[str]
    risk_level: str              # low | medium | high
    confidence: float


def calculate_profitability(
    lot: LotData,
    market_stats: MarketStats,
    min_margin_percent: float = 10.0,
) -> ProfitabilityResult:
    """
    Рассчитывает выгодность покупки лота для перепродажи.

    Формула:
      expected_revenue = avg_sell_price_7d * (1 - 0.05)   # минус 5% комиссии
      profit_per_unit  = expected_revenue - lot.price_per_unit
      profit_percent   = profit_per_unit / lot.price_per_unit * 100
      confidence       = min(1.0, sales_volume_7d / 100)
      score            = profit_percent * confidence
    """
    # Ожидаемая выручка с учётом комиссии продажи
    expected_revenue = market_stats.avg_sell_price_7d * (1 - SELL_COMMISSION)

    profit_per_unit = expected_revenue - lot.price_per_unit
    profit_percent = (profit_per_unit / lot.price_per_unit * 100) if lot.price_per_unit > 0 else 0.0

    # Уверенность на основе объёма продаж
    confidence = min(1.0, market_stats.sales_volume_7d / 100.0)

    score = profit_percent * confidence

    # Риск на основе волатильности
    vol = market_stats.price_volatility_7d
    if vol > 30:
        risk = "high"
    elif vol > 15:
        risk = "medium"
    else:
        risk = "low"

    return ProfitabilityResult(
        is_profitable=profit_percent >= min_margin_percent,
        profit_percent=round(profit_percent, 1),
        score=round(score, 1),
        expected_sell_price=int(expected_revenue),
        expected_profit_per_unit=int(profit_per_unit),
        recommend_sell_hour=market_stats.best_sell_hour,
        recommend_sell_day=market_stats.best_sell_day,
        risk_level=risk,
        confidence=round(confidence, 2),
    )


def predict_best_sell_time(sales: list[dict]) -> dict:
    """
    Анализирует историю продаж и возвращает лучшее время для продажи.

    sales: список словарей с полями sale_time (datetime), price_per_unit
    """
    if not sales:
        return {"best_hour": None, "best_day": None, "weekend_bonus_percent": 0.0}

    hourly: dict[int, list] = {}
    weekly: dict[str, list] = {}

    for sale in sales:
        hour = sale["sale_time"].hour
        day = sale["sale_time"].strftime("%A")
        price = sale["price_per_unit"]

        hourly.setdefault(hour, []).append(price)
        weekly.setdefault(day, []).append(price)

    best_hour = max(hourly, key=lambda h: sum(hourly[h]) / len(hourly[h]))
    best_day = max(weekly, key=lambda d: sum(weekly[d]) / len(weekly[d]))

    weekends = ["Saturday", "Sunday"]
    weekend_prices = [p for d in weekends for p in weekly.get(d, [])]
    weekday_prices = [p for d, ps in weekly.items() if d not in weekends for p in ps]

    weekend_avg = sum(weekend_prices) / len(weekend_prices) if weekend_prices else 0
    weekday_avg = sum(weekday_prices) / len(weekday_prices) if weekday_prices else 0

    bonus = ((weekend_avg - weekday_avg) / weekday_avg * 100) if weekday_avg > 0 else 0.0

    return {
        "best_hour": best_hour,
        "best_day": best_day,
        "weekend_bonus_percent": round(bonus, 1),
    }


def find_best_batch_combination(target_quantity: int, lots: list[dict]) -> Optional[dict]:
    """
    Жадный алгоритм: подбирает минимальную по стоимости комбинацию лотов
    для набора target_quantity штук.

    lots: список {'amount': int, 'price_per_unit': int}
    Возвращает None если нельзя набрать нужное количество.
    """
    sorted_lots = sorted(lots, key=lambda l: l["price_per_unit"])
    remaining = target_quantity
    selected = []
    total_cost = 0

    for lot in sorted_lots:
        if remaining <= 0:
            break
        take = min(lot["amount"], remaining)
        cost = take * lot["price_per_unit"]
        selected.append({"amount": take, "price_per_unit": lot["price_per_unit"], "total_price": cost})
        total_cost += cost
        remaining -= take

    if remaining > 0:
        return None

    return {
        "lots": selected,
        "total_quantity": target_quantity,
        "total_cost": total_cost,
        "avg_price_per_unit": round(total_cost / target_quantity, 2),
    }
