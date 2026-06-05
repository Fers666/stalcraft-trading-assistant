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

# Минимум продаж для расчёта лучшего часа/дня продажи
MIN_SALES_FOR_STATS = 3

# Минимум продаж для расчёта волатильности (меньше → число бессмысленно)
MIN_SALES_FOR_VOLATILITY = 5

# Минимум точек (lot_start) для nearest-neighbor прогноза времени продажи
MIN_BUYOUTS_FOR_TIME_MODEL = 5

# Пороги покрытия для уверенности прогноза времени продажи
COVERAGE_HIGH   = 0.30  # ≥30% продаж с lot_start + минимум 10 точек
COVERAGE_MEDIUM = 0.10  # 10–30% продаж с lot_start + минимум 3 точки


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
    if len(prices_7d) >= MIN_SALES_FOR_VOLATILITY:
        avg = statistics.mean(prices_7d)
        stdev = statistics.stdev(prices_7d)
        volatility_7d = round(stdev / avg * 100, 2) if avg > 0 else None

    prices_30d = [s.price_per_unit for s in sales_30d]
    volatility_30d = None
    if len(prices_30d) >= MIN_SALES_FOR_VOLATILITY:
        avg = statistics.mean(prices_30d)
        stdev = statistics.stdev(prices_30d)
        volatility_30d = round(stdev / avg * 100, 2) if avg > 0 else None

    # ── 3. Лучшее время продажи (час и день недели) ───────────────────────────
    # Взвешенный скор: 60% цена + 40% объём.
    # Логика: нас интересует не просто когда продаётся больше всего,
    # а когда покупатели платят БОЛЬШЕ и при этом рынок достаточно активен.
    WEIGHT_PRICE  = 0.6
    WEIGHT_VOLUME = 0.4

    best_sell_hour    = None
    best_sell_day     = None
    sell_hours_by_day = {}
    best_buy_hour     = None
    best_buy_day      = None
    buy_hours_by_day  = {}
    weekend_bonus     = None

    if len(sales_30d) >= MIN_SALES_FOR_STATS:
        by_hour: dict[int, list] = {}
        by_day:  dict[str, list] = {}

        for s in sales_30d:
            sale_local = s.sale_time.astimezone(timezone(timedelta(hours=3)))
            h = sale_local.hour
            d = sale_local.strftime("%A")
            by_hour.setdefault(h, []).append(s.price_per_unit)
            by_day.setdefault(d, []).append(s.price_per_unit)

        def weighted_score(groups: dict) -> str | int | None:
            """
            Выбирает лучший ключ по взвешенному скору:
              score = avg_price_norm × WEIGHT_PRICE + volume_norm × WEIGHT_VOLUME
            Нормализация: каждый показатель делится на свой максимум → диапазон [0, 1].
            """
            if not groups:
                return None
            max_avg = max(statistics.mean(ps) for ps in groups.values())
            max_vol = max(len(ps) for ps in groups.values())
            if max_avg == 0 or max_vol == 0:
                return max(groups, key=lambda k: len(groups[k]))

            def score(key):
                avg_price = statistics.mean(groups[key])
                volume    = len(groups[key])
                return (avg_price / max_avg) * WEIGHT_PRICE + (volume / max_vol) * WEIGHT_VOLUME

            return max(groups, key=score)

        best_sell_hour = weighted_score(by_hour)
        best_sell_day  = weighted_score(by_day)

        # Лучший час продажи для каждого дня отдельно
        # by_day_hour[day][hour] = [prices]
        by_day_hour: dict[str, dict[int, list]] = {}
        for s in sales_30d:
            sale_local = s.sale_time.astimezone(timezone(timedelta(hours=3)))
            d = sale_local.strftime("%A")
            h = sale_local.hour
            by_day_hour.setdefault(d, {}).setdefault(h, []).append(s.price_per_unit)

        sell_hours_by_day = {
            day: weighted_score(hours_map)
            for day, hours_map in by_day_hour.items()
            if len(hours_map) >= 1
        }

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

    # ── Лучшее время покупки ──────────────────────────────────────────────────
    # Источник: снэпшоты collected_data (каждые 5 мин).
    # Берём best_liquid_price_per_unit — минимальную цену ликвидных лотов.
    # Группируем по часу/дню и ищем когда средний минимум НАИМЕНЬШИЙ.
    best_buy_hour = None
    best_buy_day  = None

    snapshots_30d = (await db.execute(
        select(CollectedData).where(
            CollectedData.user_id == None,
            CollectedData.item_id == item_id,
            CollectedData.region  == region,
            CollectedData.collect_time >= cutoff_30d,
            CollectedData.best_liquid_price_per_unit.isnot(None),
        )
    )).scalars().all()

    if len(snapshots_30d) >= 6:   # минимум ~30 минут данных
        buy_by_hour: dict[int, list] = {}
        buy_by_day:  dict[str, list] = {}

        for snap in snapshots_30d:
            snap_local = snap.collect_time.astimezone(timezone(timedelta(hours=3)))
            h = snap_local.hour
            d = snap_local.strftime("%A")
            price = snap.best_liquid_price_per_unit
            buy_by_hour.setdefault(h, []).append(price)
            buy_by_day.setdefault(d, []).append(price)

        # Час/день где средняя минимальная цена наименьшая
        if buy_by_hour:
            best_buy_hour = min(buy_by_hour, key=lambda h: statistics.mean(buy_by_hour[h]))
        if buy_by_day:
            best_buy_day = min(buy_by_day, key=lambda d: statistics.mean(buy_by_day[d]))

        # Лучший час покупки для каждого дня отдельно
        buy_by_day_hour: dict[str, dict[int, list]] = {}
        for snap in snapshots_30d:
            snap_local = snap.collect_time.astimezone(timezone(timedelta(hours=3)))
            d = snap_local.strftime("%A")
            h = snap_local.hour
            buy_by_day_hour.setdefault(d, {}).setdefault(h, []).append(
                snap.best_liquid_price_per_unit
            )

        buy_hours_by_day = {
            day: min(hours_map, key=lambda h: statistics.mean(hours_map[h]))
            for day, hours_map in buy_by_day_hour.items()
            if len(hours_map) >= 1
        }

    # ── 4. Статистика пачек ───────────────────────────────────────────────────
    batch_stats = _calculate_batch_stats(sales_30d)

    # ── 5. Прогноз времени продажи (sell_options) ─────────────────────────────
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

    # ── 6. Среднее время продажи из выкупов ──────────────────────────────────
    avg_sell_time = _avg_sell_time_from_buyouts(sales_30d)

    # ── 7. Upsert в market_statistics (глобальная запись, user_id=None) ────────
    # Ищем по (item_id, region) без фильтра user_id — уникальный ключ на паре,
    # поэтому старые строки с user_id != None тоже найдутся и будут исправлены.
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
    else:
        existing.user_id = None  # исправляем legacy-записи с user_id != None

    existing.avg_price_24h       = s24.get("avg")
    existing.min_price_24h       = s24.get("min")
    existing.max_price_24h       = s24.get("max")
    existing.sales_volume_24h    = s24.get("count", 0)
    existing.avg_price_7d        = s7d.get("avg")
    existing.median_price_7d     = s7d.get("median")
    existing.min_price_7d        = s7d.get("min")
    existing.max_price_7d        = s7d.get("max")
    existing.sales_volume_7d     = s7d.get("count", 0)
    existing.sales_volume_30d    = len(prices_30d)
    existing.price_volatility_7d  = volatility_7d
    existing.price_volatility_30d = volatility_30d
    existing.best_sell_hour      = best_sell_hour
    existing.best_sell_day       = best_sell_day
    existing.best_buy_hour       = best_buy_hour
    existing.best_buy_day        = best_buy_day
    existing.sell_hours_by_day   = sell_hours_by_day or None
    existing.buy_hours_by_day    = buy_hours_by_day or None
    existing.weekend_bonus_percent = weekend_bonus
    existing.avg_sell_time_hours = avg_sell_time
    existing.batch_stats         = batch_stats
    existing.sell_options        = sell_options
    existing.calculated_at       = now

    await db.commit()
    await db.refresh(existing)
    return existing


def _calculate_batch_stats(sales: list) -> dict | None:
    """
    Анализирует структуру продаж по размерам пачек.
    Возвращает None если товар торгуется почти исключительно поштучно (<10% пачек).
    """
    if not sales:
        return None

    batch_sales = [s for s in sales if s.amount > 1]
    batch_ratio = len(batch_sales) / len(sales)
    if batch_ratio < 0.10:
        return None

    BUCKETS: list[tuple[str, str, int, int]] = [
        ("x1",       "1 шт",    1,   1),
        ("x2_5",     "2-5 шт",  2,   5),
        ("x6_10",    "6-10 шт", 6,   10),
        ("x11_25",   "11-25 шт",11,  25),
        ("x26_50",   "26-50 шт",26,  50),
        ("x51_plus", "51+ шт",  51,  10_000),
    ]

    by_size: dict = {}
    for key, label, lo, hi in BUCKETS:
        group = [s for s in sales if lo <= s.amount <= hi]
        if not group:
            continue
        prices = [s.price_per_unit for s in group]
        by_size[key] = {
            "label":               label,
            "count":               len(group),
            "share_pct":           round(len(group) / len(sales) * 100, 1),
            "avg_price_per_unit":  round(statistics.mean(prices), 2),
            "median_price_per_unit": round(statistics.median(prices), 2),
        }

    if not by_size:
        return None

    amounts = [s.amount for s in sales]
    median_amount = round(statistics.median(amounts))

    most_popular_bucket = max(by_size, key=lambda k: by_size[k]["count"])

    # Скидка оптом: одиночные продажи vs крупные пачки
    bulk_discount_pct = None
    single = by_size.get("x1")
    large  = by_size.get("x51_plus") or by_size.get("x26_50")
    if single and large:
        sp = single["avg_price_per_unit"]
        lp = large["avg_price_per_unit"]
        if sp > 0:
            bulk_discount_pct = round((sp - lp) / sp * 100, 1)

    return {
        "by_size":            by_size,
        "median_amount":      median_amount,
        "bulk_discount_pct":  bulk_discount_pct,
        "batch_ratio_pct":    round(batch_ratio * 100, 1),
        "most_popular_bucket": most_popular_bucket,
        "total_analyzed":     len(sales),
    }


def _avg_sell_time_from_buyouts(sales: list) -> float | None:
    """
    Среднее время продажи в часах.
    Использует продажи где lot_start восстановлен при матчинге снэпшот→история.
    """
    times = []
    for s in sales:
        info = s.additional_info or {}
        lot_start_str = info.get("lot_start")
        if not lot_start_str:
            continue
        try:
            lot_start = datetime.fromisoformat(lot_start_str.replace("Z", "+00:00"))
            hours = (s.sale_time - lot_start).total_seconds() / 3600
            if 0 < hours < 48 * 7:
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

    Источники прогноза времени (от лучшего к худшему):
    1. Реальные пары (price, time_on_market) из sales_history где есть lot_start
       (lot_start восстанавливается при матчинге снэпшот-лота с продажей из API /history)
    2. Объём продаж за 7 дней — косвенный показатель активности рынка
    """
    # ── 1. Реальные данные о времени продажи ─────────────────────────────────
    time_price_pairs: list[tuple[float, int]] = []
    for s in sales_30d:
        info = s.additional_info or {}
        lot_start_str = info.get("lot_start")
        if not lot_start_str:
            continue
        try:
            lot_start = datetime.fromisoformat(lot_start_str.replace("Z", "+00:00"))
            hours = (s.sale_time - lot_start).total_seconds() / 3600
            if 0 < hours < 48 * 7:  # исключаем аномалии
                time_price_pairs.append((hours, s.price_per_unit))
        except Exception:
            continue

    # ── 2. Текущий минимум ликвидных лотов ───────────────────────────────────
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

    median_7d      = s7d.get("median")
    sales_volume_7d = s7d.get("count", 0) or 0

    if not median_7d and not current_min_liquid:
        return []

    # ── 3. Три ценовые точки ──────────────────────────────────────────────────
    # Все три варианта относительно текущей минимальной ликвидной цены.
    # Это гарантирует: fast < normal < premium всегда,
    # и каждый вариант имеет понятный смысл для продавца.
    #
    # ref = текущий минимум ликвидных лотов (реальная рыночная цена прямо сейчас)
    ref = int(current_min_liquid or median_7d)

    fast_price    = int(ref * 0.97)  # -3%: твой лот дешевле всех → купят первым
    normal_price  = int(ref * 1.00)  #  ±0%: по рыночной цене
    premium_price = int(ref * 1.05)  # +5%: выше рынка → ждёшь когда чужие раскупят

    # ── 4. Прогноз времени ────────────────────────────────────────────────────
    # Уверенность определяется покрытием: какой % продаж за 30д имеет lot_start
    total_sales_30d = len(sales_30d)
    matched_count   = len(time_price_pairs)
    coverage = matched_count / total_sales_30d if total_sales_30d > 0 else 0.0

    if coverage >= 0.30 and matched_count >= 10:
        # ≥30% продаж с реальным lot_start и минимум 10 точек — высокая точность
        confidence    = "high"
        fast_hours    = _estimate_hours(fast_price,    time_price_pairs, "fast")
        normal_hours  = _estimate_hours(normal_price,  time_price_pairs, "normal")
        premium_hours = _estimate_hours(premium_price, time_price_pairs, "premium")

    elif coverage >= 0.10 and matched_count >= 3:
        # 10–30% покрытия — средняя точность, интерполируем из имеющихся данных
        confidence = "medium"
        avg_time      = statistics.mean(t for t, _ in time_price_pairs)
        fast_hours    = round(avg_time * 0.4, 1)
        normal_hours  = round(avg_time * 1.0, 1)
        premium_hours = round(avg_time * 2.5, 1)

    else:
        # <10% покрытия или нет lot_start — оценка по объёму продаж/день
        confidence    = "low"
        sales_per_day = sales_volume_7d / 7.0

        if sales_per_day >= 5:       # активный рынок ≥5 продаж/день
            fast_hours, normal_hours, premium_hours = 2.0,  8.0,   24.0
        elif sales_per_day >= 1:     # умеренный 1–5 продаж/день
            fast_hours, normal_hours, premium_hours = 8.0,  24.0,  72.0
        elif sales_per_day >= 0.14:  # редкий ~1 продажа/неделю
            fast_hours, normal_hours, premium_hours = 24.0, 72.0,  168.0
        else:                         # очень редкий <1 продажи/неделю
            fast_hours, normal_hours, premium_hours = 72.0, 168.0, 336.0

    COMMISSION = 0.05  # комиссия аукциона 5%

    def make_option(label, label_ru, price, hours):
        return {
            "label":            label,
            "label_ru":         label_ru,
            "price_per_unit":   price,                          # цена выставления
            "net_price_per_unit": int(price * (1 - COMMISSION)),# продавец получит
            "estimated_hours":  hours,
            "estimated_hours_display": _format_hours(hours),
            "confidence":       confidence,
            "data_points":      len(time_price_pairs),
        }

    return [
        make_option("fast",    "Быстро",   fast_price,    fast_hours),
        make_option("normal",  "Нормально",normal_price,  normal_hours),
        make_option("premium", "Выгодно",  premium_price, premium_hours),
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
