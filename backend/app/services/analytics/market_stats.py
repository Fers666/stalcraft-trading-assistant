"""
Сервис расчёта рыночной статистики и прогноза времени продажи.

Для каждого товара рассчитывает:
- Ценовую статистику за 24ч и 7 дней
- Волатильность
- Лучшее время продажи (час/день недели)
- 3 ценовых варианта с прогнозом времени продажи

Алгоритм sell_options:
  1. Если есть данные о выкупах (buyout_detection) — используем реальное
     время_на_рынке = sale_time - lot_start
  2. Если данных мало — используем позицию цены относительно рынка как прокси
"""

import logging
import statistics
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    CollectedData, SalesHistory, MarketStatistics, UserWatchlist,
)

logger = logging.getLogger(__name__)

# Минимум продаж для достоверного расчёта
MIN_SALES_FOR_STATS = 3
MIN_BUYOUTS_FOR_TIME_MODEL = 5


async def calculate_market_stats(
    db: AsyncSession,
    item_id: str,
    region: str,
    user_id: int | None = None,
) -> MarketStatistics | None:
    """
    Пересчитывает market_statistics для пары (item_id, region).

    user_id=None → глобальная статистика (читается всеми пользователями).
    user_id=<id> → оставлено для совместимости, не используется в основном потоке.
    """
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d  = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    # ── 1. История продаж (глобальная — user_id не фильтруем) ────────────────
    sales_30d = (await db.execute(
        select(SalesHistory).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region  == region,
            SalesHistory.sale_time >= cutoff_30d,
        ).order_by(SalesHistory.sale_time.desc())
    )).scalars().all()

    if not sales_30d:
        return None

    prices_24h = [s.price_per_unit for s in sales_30d if s.sale_time >= cutoff_24h]
    prices_7d  = [s.price_per_unit for s in sales_30d if s.sale_time >= cutoff_7d]

    # ── 2. Ценовая статистика ─────────────────────────────────────────────────
    def safe_stats(prices: list) -> dict:
        if not prices:
            return {}
        return {
            "avg":    round(statistics.mean(prices), 2),
            "median": round(statistics.median(prices), 2),
            "min":    min(prices),
            "max":    max(prices),
            "count":  len(prices),
        }

    s24 = safe_stats(prices_24h)
    s7d = safe_stats(prices_7d)

    volatility_7d = None
    if len(prices_7d) >= 2:
        avg = statistics.mean(prices_7d)
        stdev = statistics.stdev(prices_7d)
        volatility_7d = round(stdev / avg * 100, 2) if avg > 0 else None

    # ── 3. Лучшее время продажи (час и день недели) ───────────────────────────
    best_sell_hour = None
    best_sell_day = None
    weekend_bonus = None

    if len(sales_30d) >= MIN_SALES_FOR_STATS:
        by_hour: dict[int, list] = {}
        by_day:  dict[str, list] = {}

        for s in sales_30d:
            sale_local = s.sale_time.astimezone(timezone(timedelta(hours=3)))
            h = sale_local.hour
            d = sale_local.strftime("%A")
            by_hour.setdefault(h, []).append(s.price_per_unit)
            by_day.setdefault(d, []).append(s.price_per_unit)

        # Час с наибольшим объёмом продаж
        best_sell_hour = max(by_hour, key=lambda h: len(by_hour[h]))

        # День с наибольшим объёмом
        best_sell_day = max(by_day, key=lambda d: len(by_day[d]))

        # Бонус выходного дня
        weekday_sales = [
            p for d, ps in by_day.items()
            if d not in ("Saturday", "Sunday") for p in ps
        ]
        weekend_sales = [
            p for d, ps in by_day.items()
            if d in ("Saturday", "Sunday") for p in ps
        ]
        if weekday_sales and weekend_sales:
            avg_wd = statistics.mean(weekday_sales)
            avg_we = statistics.mean(weekend_sales)
            weekend_bonus = round((avg_we / avg_wd - 1) * 100, 2) if avg_wd > 0 else None

    # ── 4. Прогноз времени продажи (sell_options) ─────────────────────────────
    sell_options = await _calculate_sell_options(
        db=db,
        item_id=item_id,
        region=region,
        sales_30d=sales_30d,
        prices_7d=prices_7d,
        s7d=s7d,
        now=now,
        cutoff_30d=cutoff_30d,
    )

    # ── 5. Среднее время продажи из выкупов ──────────────────────────────────
    avg_sell_time = _avg_sell_time_from_buyouts(sales_30d)

    # ── 6. Upsert в market_statistics (глобальная запись, user_id=None) ────────
    existing = (await db.execute(
        select(MarketStatistics).where(
            MarketStatistics.item_id == item_id,
            MarketStatistics.region  == region,
        )
    )).scalar_one_or_none()

    if existing is None:
        existing = MarketStatistics(
            user_id=None, item_id=item_id, region=region,
        )
        db.add(existing)

    existing.avg_price_24h       = s24.get("avg")
    existing.min_price_24h       = s24.get("min")
    existing.max_price_24h       = s24.get("max")
    existing.sales_volume_24h    = s24.get("count", 0)
    existing.avg_price_7d        = s7d.get("avg")
    existing.median_price_7d     = s7d.get("median")
    existing.min_price_7d        = s7d.get("min")
    existing.max_price_7d        = s7d.get("max")
    existing.sales_volume_7d     = s7d.get("count", 0)
    existing.price_volatility_7d = volatility_7d
    existing.best_sell_hour      = best_sell_hour
    existing.best_sell_day       = best_sell_day
    existing.weekend_bonus_percent = weekend_bonus
    existing.avg_sell_time_hours = avg_sell_time
    existing.sell_options        = sell_options
    existing.calculated_at       = now

    await db.commit()
    await db.refresh(existing)
    return existing


def _avg_sell_time_from_buyouts(sales: list) -> float | None:
    """Среднее время продажи в часах из детектированных выкупов."""
    times = []
    for s in sales:
        info = s.additional_info or {}
        if info.get("source") != "buyout_detection":
            continue
        lot_start_str = info.get("lot_start")
        if not lot_start_str:
            continue
        try:
            lot_start = datetime.fromisoformat(lot_start_str.replace("Z", "+00:00"))
            hours = (s.sale_time - lot_start).total_seconds() / 3600
            if 0 < hours < 48 * 7:  # исключаем аномалии
                times.append(hours)
        except Exception:
            continue
    return round(statistics.mean(times), 2) if times else None


async def _calculate_sell_options(
    db: AsyncSession,
    item_id: str,
    region: str,
    sales_30d: list,
    prices_7d: list,
    s7d: dict,
    now: datetime,
    cutoff_30d: datetime,
) -> list[dict]:
    """
    Возвращает 3 варианта цены продажи с прогнозом времени.

    Каждый вариант:
    {
        "label": "fast" | "normal" | "premium",
        "label_ru": "Быстро" | "Нормально" | "Выгодно",
        "price_per_unit": int,
        "estimated_hours": float,
        "estimated_hours_display": "~2ч" | "~12ч" | "~2-3 дня",
        "confidence": "high" | "medium" | "low",
        "data_points": int,
    }
    """
    # Собираем данные о времени продажи из выкупов
    time_price_pairs: list[tuple[float, int]] = []
    for s in sales_30d:
        info = s.additional_info or {}
        if info.get("source") != "buyout_detection":
            continue
        lot_start_str = info.get("lot_start")
        if not lot_start_str:
            continue
        try:
            lot_start = datetime.fromisoformat(lot_start_str.replace("Z", "+00:00"))
            hours = (s.sale_time - lot_start).total_seconds() / 3600
            if 0 < hours < 48 * 7:
                time_price_pairs.append((hours, s.price_per_unit))
        except Exception:
            continue

    # Берём последний глобальный снэпшот (user_id=None)
    last_snapshot = (await db.execute(
        select(CollectedData).where(
            CollectedData.user_id == None,
            CollectedData.item_id == item_id,
            CollectedData.region  == region,
        ).order_by(CollectedData.collect_time.desc()).limit(1)
    )).scalar_one_or_none()

    current_min_liquid = (
        last_snapshot.best_liquid_price_per_unit or last_snapshot.best_price_per_unit
    ) if last_snapshot else None

    median_7d = s7d.get("median")
    avg_7d    = s7d.get("avg")

    if not median_7d and not current_min_liquid:
        return []

    # Базовые ценовые точки
    base = int(median_7d or current_min_liquid)
    fast_price    = int((current_min_liquid or base) * 0.99)   # чуть ниже текущего минимума
    normal_price  = int(base * 0.97)                            # около медианы с запасом
    premium_price = int(base * 1.03)                            # выше медианы

    confidence = "high" if len(time_price_pairs) >= MIN_BUYOUTS_FOR_TIME_MODEL else \
                 "medium" if len(time_price_pairs) >= 2 else "low"

    # Рассчитываем время для каждой ценовой точки
    fast_hours    = _estimate_hours(fast_price,    time_price_pairs, "fast")
    normal_hours  = _estimate_hours(normal_price,  time_price_pairs, "normal")
    premium_hours = _estimate_hours(premium_price, time_price_pairs, "premium")

    return [
        {
            "label":    "fast",
            "label_ru": "Быстро",
            "price_per_unit": fast_price,
            "estimated_hours": fast_hours,
            "estimated_hours_display": _format_hours(fast_hours),
            "confidence": confidence,
            "data_points": len(time_price_pairs),
        },
        {
            "label":    "normal",
            "label_ru": "Нормально",
            "price_per_unit": normal_price,
            "estimated_hours": normal_hours,
            "estimated_hours_display": _format_hours(normal_hours),
            "confidence": confidence,
            "data_points": len(time_price_pairs),
        },
        {
            "label":    "premium",
            "label_ru": "Выгодно",
            "price_per_unit": premium_price,
            "estimated_hours": premium_hours,
            "estimated_hours_display": _format_hours(premium_hours),
            "confidence": confidence,
            "data_points": len(time_price_pairs),
        },
    ]


def _estimate_hours(
    price: int,
    time_price_pairs: list[tuple[float, int]],
    tier: str,
) -> float:
    """
    Оценивает время продажи в часах для заданной цены.

    Если данных достаточно — интерполирует по реальным продажам.
    Иначе — использует эвристику по позиции цены.
    """
    # Эвристика по умолчанию
    defaults = {"fast": 3.0, "normal": 18.0, "premium": 60.0}

    if len(time_price_pairs) >= MIN_BUYOUTS_FOR_TIME_MODEL:
        # Сортируем по цене
        pairs = sorted(time_price_pairs, key=lambda x: x[1])
        prices = [p[1] for p in pairs]
        times  = [p[0] for p in pairs]

        # Находим ближайшие по цене
        nearest = sorted(pairs, key=lambda x: abs(x[1] - price))[:5]
        if nearest:
            return round(statistics.mean(t for t, _ in nearest), 1)

    if len(time_price_pairs) >= 2:
        # Небольшая выборка — берём среднее и масштабируем
        avg_time = statistics.mean(t for t, _ in time_price_pairs)
        multipliers = {"fast": 0.4, "normal": 1.0, "premium": 2.5}
        return round(avg_time * multipliers[tier], 1)

    return defaults[tier]


def _format_hours(hours: float) -> str:
    if hours < 2:
        return "< 2 ч"
    if hours < 24:
        return f"~{round(hours)} ч"
    days = hours / 24
    if days < 2:
        return "~1-2 дня"
    return f"~{round(days)} дня" if days < 5 else f"~{round(days)} дней"
