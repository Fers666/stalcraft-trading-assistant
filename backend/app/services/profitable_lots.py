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

from app.services.analytics.market_stats import (
    COVERAGE_MEDIUM, extract_time_price_pairs, _calculate_batch_stats,
)
from app.services.analytics.pricing import (
    classify_risk, compute_reference, make_sell_options, evaluate_lot_profit,
    expected_value, weighted_reference, _build_sales_filter, matching_lot_prices,
    COMMISSION, MIN_BATCH_SAMPLES, STALE_SECONDS, TIER_ORDER,
    resolve_variant_key,
    _is_artefact, _lot_quality_enchant, _is_liquid,
)

SIGNALS_TTL = 300       # секунд — TTL ключа сигналов (запас на случай задержки цикла)
NOTIF_DEDUP_TTL = 48 * 3600  # 48ч — один лот нотифицируется один раз

# Тиры, по которым будим пользователя (Telegram и web push). Сигнал в Redis и
# карточка остаются полными — асимметрия намеренная и та же, что в ленте
# (_load_observed_yield учитывает fast + NORMAL_RATIO): premium это цена с 49 %
# вероятностью продажи за 6 часов, основанием для уведомления она не является.
# Без этого гейта допуск по трём тирам на умолчании min_profit_margin_percent=0
# сдвигает порог с «дешевле ref * 0.893» на «дешевле ref * 1.007» и объём
# сообщений вырастает кратно (ТЗ profitability-criteria-unification §1.4).
NOTIFY_TIERS: tuple[str, ...] = ("fast", "normal")

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}


def notifiable_lots(lots: list[dict]) -> list[dict]:
    """Лоты сигнала, по которым публикуется событие уведомления (см. NOTIFY_TIERS)."""
    return [l for l in lots if l.get("tier_used") in NOTIFY_TIERS]


def variant_signal_key(qlt: Optional[int], ptn: Optional[int]) -> str:
    """Ключ варианта в карте signal["variants"]: "{qlt}:{ptn}"."""
    return f"{qlt or 0}:{ptn or 0}"


def compute_variant_ref(
    sales_variant: list, now: datetime, survival, item_class: str,
) -> Optional[dict]:
    """
    Опора и цены продажи ОДНОГО варианта (qlt, ptn) по его собственным продажам.

    None означает «своей опоры у варианта нет» — сделок не было вовсе либо их
    эффективный вес ниже MIN_REF_WEIGHT. Тогда лот считается по ПРЕДМЕТНОЙ
    опоре, а вариант помечается ref_scope="item" (см. compute_signals_for_entry).
    Молча потерять сигнал там, где он есть сегодня, нельзя: пользователь сам
    добавил предмет в Избранное и ждёт ответа, а не тишины.

    Цепочка та же, что у ленты (variant_stats.compute_variant) и у ветки с
    фильтрами: weighted_reference -> compute_reference -> make_sell_options.
    Второй формулы не заводится. Дополнительных запросов к БД и к Stalcraft API
    не делает — считает по строкам, которые вызывающий уже загрузил.
    """
    cutoff_7d  = now - timedelta(days=7)
    cutoff_24h = now - timedelta(hours=24)

    rows_7d   = [r for r in sales_variant if r.sale_time >= cutoff_7d]
    prices_7d = [r.price_per_unit for r in rows_7d]
    if not prices_7d:
        return None

    prices_24h = [r.price_per_unit for r in rows_7d if r.sale_time >= cutoff_24h]

    wr = weighted_reference([(r.sale_time, r.price_per_unit) for r in rows_7d], now)
    ref_info = compute_reference(
        weighted_hist=wr["ref"] if wr else None,
        median_hist=float(_statistics.median(prices_7d)),
        sample_count=len(prices_7d),
        median_24h=float(_statistics.median(prices_24h)) if prices_24h else None,
        sample_count_24h=len(prices_24h),
        weight=wr["weight"] if wr else 0.0,
    )
    if ref_info is None or ref_info["below_floor"]:
        return None

    volatility = None
    if len(prices_7d) >= 5:
        avg7 = _statistics.mean(prices_7d)
        volatility = round(_statistics.stdev(prices_7d) / avg7 * 100, 2) if avg7 > 0 else None

    # Пары «часы на рынке -> цена» по продажам ЭТОГО варианта, с тем же
    # правилом покрытия: прогноз времени продажи обязан считаться на той же
    # выборке, что и опора, иначе ₽/час расходится с Лентой.
    pairs = extract_time_price_pairs(sales_variant)
    coverage = len(pairs) / len(sales_variant) if sales_variant else 0.0
    pairs_for_options = (
        pairs if (coverage >= COVERAGE_MEDIUM and len(pairs) >= MIN_BATCH_SAMPLES) else None
    )

    return {
        "ref":            ref_info["ref"],
        "ref_source":     ref_info["source"],
        "ref_confidence": ref_info["confidence"],
        "ref_samples":    ref_info["samples"],
        "ref_scope":      "variant",
        "trend":          ref_info["trend"],
        "trend_pct":      ref_info["trend_pct"],
        "volume_7d":      len(prices_7d),
        "volatility_7d":  volatility,
        "risk":           classify_risk(volatility),
        "sell_options":   make_sell_options(
            ref_info["ref"], len(prices_7d), pairs_for_options, survival, item_class,
        ),
        # Статистика пачек ЭТОГО варианта. Обязана быть вариантной: поправка на
        # размер пачки считается как медиана_пачки / normal_price, и если
        # числитель предметный, а знаменатель вариантный — это отношение величин
        # из разных выборок.
        "batch_stats":    _calculate_batch_stats(sales_variant),
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
    survival=None,
) -> Optional[dict]:
    """
    Вычисляет выгодные лоты для одной watchlist-записи.

    Возвращает dict {lots, sell_options, volume_7d, volatility_7d, ref, ref_source,
    ref_confidence, ref_samples, trend, trend_pct, median_7d, risk,
    total_profitable_amount, saturation_ratio, computed_at}
    или None если данных недостаточно или снэпшот устарел (> STALE_SECONDS).

    Лот допускается по ЛЮБОМУ из трёх тиров продажи и помечается самым быстрым
    подошедшим (tier_used), а список ранжируется по ev_profit — ожидаемым
    рублям, а не по прибыли «если продастся». Тот же принцип, что в ленте.

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
        # Эффективное число сделок за опорой считаем по живым строкам, а не
        # берём stats.reference_weight: строки за 30д уже загружены выше
        # (лишнего запроса нет), они свежее часового среза, и — главное — сразу
        # после миграции колонка ещё NULL, а этой ветке below_floor закрывает
        # сигнал: watchlist остался бы без сигналов до первого пересчёта.
        wr_all = weighted_reference(
            [(r.sale_time, r.price_per_unit) for r in sales_30d if r.sale_time >= cutoff_7d], now,
        )
        ref_info = compute_reference(
            weighted_hist=float(stats.reference_price) if stats and stats.reference_price else None,
            median_hist=float(stats.median_price_7d) if stats and stats.median_price_7d else None,
            sample_count=volume_7d,
            median_24h=float(stats.median_price_24h) if stats and stats.median_price_24h else None,
            sample_count_24h=(stats.sales_volume_24h or 0) if stats else 0,
            median_now=float(snap.median_price_per_unit) if snap.median_price_per_unit else None,
            current_min=current_min,
            weight=wr_all["weight"] if wr_all else 0.0,
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
                weight=wr["weight"] if wr else 0.0,
            )
        else:
            ref_info = compute_reference(
                median_hist=float(stats.median_price_7d) if stats and stats.median_price_7d else None,
                sample_count=volume_7d,
                current_min=current_min,
            )
            vol = volume_7d
        vol_for_opts = vol if prices else None

    # Опора ниже пола по данным (меньше MIN_REF_WEIGHT эффективных сделок и
    # усадить не к чему) — сигнала нет: прибыль по такой опоре фиктивна.
    if ref_info is None or ref_info["below_floor"]:
        return None

    ref        = ref_info["ref"]
    ref_source = ref_info["source"]
    trend      = ref_info["trend"]
    risk       = classify_risk(msg_volatility)

    # Класс предмета — измерение кривой дожития (§3.3 feed-gear-expansion.md):
    # у снаряжения своя кривая, артефактную ему подставлять нельзя. master здесь
    # уже под рукой, поэтому сигналы читают страту своего класса.
    from app.services.feed.scope import feed_item_class

    item_class = feed_item_class(master.category)

    sell_options = (
        make_sell_options(
            ref, vol_for_opts, pairs_for_options, survival, item_class,
        )
        if vol_for_opts is not None else None
    )
    batch_stats  = stats.batch_stats if stats else None

    # ── Опора по ВАРИАНТУ (qlt, ptn), а не по предмету целиком ──────────────
    # «Предмет целиком» смешивает разные товары: у Магмы глобальный минимум
    # 145 тыс. против 9.5 млн для «Особый», и лот дешёвого качества выглядит
    # сверхвыгодным против общей опоры, а дорогого — убыточным. Ключ варианта
    # считается ОДНИМ резолвером с обеих сторон (продажи и лоты): разойдись
    # они, продажи ветеранского ствола легли бы в вариант (0, 0), а лот искал
    # бы (3, 0) — сигналов не осталось бы без единой ошибки в логах.
    #
    # Ветка с фильтрами — частный случай: sales_30d уже отфильтрован, и в карте
    # окажется ровно один вариант.
    variant_sales: dict[tuple[int, int], list] = {}
    for row in sales_30d:
        variant_sales.setdefault(
            resolve_variant_key(row.additional_info, master), [],
        ).append(row)

    # Предметная опора как фоллбек-запись варианта: покрытие qlt/ptn в
    # additional_info неполное, поэтому у многих вариантов своей опоры не будет.
    item_scope_entry = {
        "ref":            ref,
        "ref_source":     ref_source,
        "ref_confidence": ref_info["confidence"],
        "ref_samples":    ref_info["samples"],
        "ref_scope":      "item",
        "trend":          trend,
        "trend_pct":      ref_info["trend_pct"],
        "volume_7d":      msg_volume,
        "volatility_7d":  msg_volatility,
        "risk":           risk,
        "sell_options":   sell_options,
        "batch_stats":    batch_stats,
    }

    variants: dict[str, dict] = {}

    def variant_for(key: tuple[int, int]) -> dict:
        """Запись варианта из карты; считается лениво — только для живых лотов."""
        vk = variant_signal_key(*key)
        entry_v = variants.get(vk)
        if entry_v is None:
            entry_v = compute_variant_ref(
                variant_sales.get(key) or [], now, survival, item_class,
            ) or item_scope_entry
            variants[vk] = entry_v
        return entry_v

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

        # Опора и цены продажи — варианта ЭТОГО лота (ТЗ §2). Риск берётся
        # оттуда же: он умножает требуемую маржу, и предметная волатильность,
        # посчитанная по смеси качеств, завышала бы порог одним вариантам и
        # занижала другим.
        variant_key = resolve_variant_key(lot.get("additional"), master)
        variant = variant_for(variant_key)
        variant_opts = variant["sell_options"]
        if not variant_opts:
            continue

        # Все три тира, от быстрого к долгому: лот берётся, если выгоден хотя
        # бы по одному, и помечается ПЕРВЫМ подошедшим — тот же допуск, что в
        # ленте (ТЗ profitability-criteria-unification §1.1). Персональный порог
        # min_profit_margin_pct не ослабляется: он проверяется ВНУТРИ каждого
        # тира, меняется только множество цен, против которых он проверяется.
        evaluated = evaluate_lot_profit(
            buyout_per_unit, amount, variant_opts,
            variant["risk"] or risk, min_profit_margin_pct,
            variant.get("batch_stats"),
            tiers=TIER_ORDER,
        )
        if evaluated is None:
            continue

        quality_name = _QLT_NAMES.get(qlt_val) if qlt_val is not None else None

        # Сценарии продажи: купленный лот можно выставить по цене ЛЮБОГО тира,
        # поэтому в ожидаемую прибыль идут все три, а не только выбранный.
        # У выбранного берём его собственную прибыль — в sell_price_used учтена
        # поправка на размер пачки, и подмена ценой тира разошлась бы с полем
        # profit, которое из неё же и посчитано. Цена остальных — из их опции:
        # sell_options собраны из того же ref, то есть это ровно tier_prices(ref).
        scenarios: dict[str, tuple[int, Optional[float]]] = {}
        p_sold_6h: Optional[float] = None
        for option in variant_opts:
            label = option["label"]
            if label == evaluated["tier_used"]:
                value = evaluated["profit"] * amount
                p_sold_6h = option.get("p_sold_6h")
            else:
                value = int(option["price_per_unit"] * amount * (1 - COMMISSION)) - buyout
            scenarios[label] = (value, option.get("p_sold_6h"))

        profitable.append({
            "start_time":      lot.get("startTime", ""),
            "buyout_price":    buyout,
            "buyout_per_unit": buyout_per_unit,
            "amount":          amount,
            "quality_name":    quality_name,
            "enchant":         enchant,
            **evaluated,
            # Ссылка на запись в signal["variants"]: по ней потребитель берёт
            # опору и цены, от которых посчитан ЭТОТ лот.
            "variant_key":     variant_signal_key(*variant_key),
            # Ожидаемые рубли всего лота и вероятность тира, которым лот прошёл
            # (без неё ev_profit в UI нечем объяснить).
            "ev_profit":       expected_value(scenarios),
            "p_sold_6h":       p_sold_6h,
        })

    # Ранжирование по ожидаемым рублям, а не по «сколько дадут, если продастся»:
    # цена тира — это ещё и вероятность продажи (fast 81.3 % / normal 74.5 % /
    # premium 49.0 %), поэтому profit_per_hour строк разных тиров несравним.
    # Лот без измеренной вероятности уходит в конец (то же правило и в ленте,
    # ev_profit nulls_last), внутри хвоста держится прежний порядок.
    profitable.sort(key=lambda l: (
        l["ev_profit"] is None,
        -(l["ev_profit"] or 0),
        -(l["profit_per_hour"] or 0),
    ))

    total_profitable_amount = sum(l["amount"] for l in profitable)
    saturation_ratio = (
        round(total_profitable_amount / (volume_7d / 7), 2) if volume_7d else None
    )

    # Карта считается лениво по КАЖДОМУ просмотренному лоту, а в сигнал попадают
    # только выгодные, — без обрезки в payload уезжают варианты, на которые никто
    # не ссылается (у «Ветки Калины» 29 записей на 9 лотов, 44 КБ на ключ).
    referenced = {l["variant_key"] for l in profitable}
    variants = {k: v for k, v in variants.items() if k in referenced}

    return {
        "lots":            profitable,
        # Верхний уровень остаётся ПРЕДМЕТНЫМ: его читают графики и «Динамика
        # цен», где предметный смысл верен. Потребителю, которому нужен товар
        # конкретного лота, — variants[lot["variant_key"]].
        "variants":        variants,
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
