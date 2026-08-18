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
from typing import TYPE_CHECKING, Optional

from sqlalchemy import or_

from app.models.models import SalesHistory
from app.services.feed.scope import CLASS_ARTEFACT

if TYPE_CHECKING:                       # только аннотация: pricing остаётся
    from app.services.analytics.survival import SurvivalTable   # без доступа к БД


COMMISSION       = 0.05   # комиссия аукциона при продаже
GLITCH_RATIO     = 0.05   # current_min < hist_median * GLITCH_RATIO -> игнорируем current_min (глитч-цена)
TREND_DROP_RATIO = 0.75   # median_now(аски) < median_hist * этого -> рынок "просел" (фоллбек-метка тренда)
STALE_SECONDS    = 90     # снэпшот старше этого -> сигналу не доверяем

# Опорная цена (ref) — взвешенная по свежести медиана продаж за 7д.
# Плоская медиана за 7 дней на трендовом рынке отражает цену ~3.5-дневной
# давности: на падающем рынке она обещает прибыль, которой уже нет.
REF_HALF_LIFE_HOURS = 48.0  # период полураспада веса сделки
MIN_REF_SAMPLES     = 3     # меньше -> метка тренда не публикуется (см. compute_reference)
TREND_SOFT_RATIO    = 0.95  # median_24h / median_7d ниже этого -> тренд "falling"

# Пол по данным: за опорой должно стоять достаточное ЭФФЕКТИВНОЕ число сделок
# (сумма весов 0.5 ** (age/48), а не сырой count). Три сделки трёхдневной
# давности — это ~1 эффективная сделка, а не 3.
MIN_REF_WEIGHT       = 5.0   # ниже — below_floor, торгового сигнала нет
REF_CONF_HIGH_WEIGHT = 10.0  # эффективных сделок для confidence="high"
TRIM_RATIO           = 3.0   # цена вне [med / K, med * K] -> выброс

# Ценовые тиры — множители к ref, откалиброванные по факту исполнения.
# Замер (docs/tasks/quantile-sell-tiers.md §2): для каждого варианта берётся
# взвешенная медиана сделок за 7д до среза, затем квантили цен реальных сделок
# этого же варианта в следующие сутки; медиана по вариантам, 6 срезов за 3 недели.
# Усреднение по ВАРИАНТАМ, а не по сделкам: оборот сосредоточен в нескольких
# ликвидных вариантах, а тир применяется к варианту независимо от его оборота.
# Отсюда q25 = 0.937 (а не 0.889, как в первой редакции разбора), q50 = 0.997,
# q75 = 1.058. Разброс между срезами ±2 %, тренда нет.
FAST_RATIO    = 0.94   # ~75 % сделок варианта проходят по этой цене или выше
NORMAL_RATIO  = 1.00   # ~50 %
PREMIUM_RATIO = 1.06   # ~25 %

# Доля сделок варианта, проходящих по цене тира или выше, в процентах.
# Это и есть смысл тира: не «скидка N %», а обещание с измеренной вероятностью.
FILL_PROBABILITY: dict[str, int] = {"fast": 75, "normal": 50, "premium": 25}

# Множитель тира по его имени. Нужен, чтобы страта кривой дожития определялась
# по МНОЖИТЕЛЮ, а не по цене: tier_prices усекает (int(ref * 0.94)), и при ref,
# не кратном 50, отношение выходит 0.9399992 вместо 0.94 — тир уезжает в
# соседний бакет. На проде так уезжали 30% вариантов, причём всегда в сторону
# более оптимистичных цифр (+5.35 п.п. вероятности).
TIER_RATIOS: dict[str, float] = {
    "fast": FAST_RATIO, "normal": NORMAL_RATIO, "premium": PREMIUM_RATIO,
}

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


def _as_int(value) -> Optional[int]:
    """int или None: API отдаёт числа, но строка/мусор не должны ронять разбор."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resolve_quality(
    additional: Optional[dict], master=None, is_art: Optional[bool] = None,
) -> Optional[int]:
    """
    Качество товара по данным лота/продажи и предмету каталога.

    ЕДИНЫЙ резолвер (docs/tasks/feed-gear-expansion.md §3.2). У артефактов
    качество — свойство ЛОТА (`additional.qlt`, отсутствие = 0 «Обычный»); у
    снаряжения его в лоте нет вовсе, качество является свойством ПРЕДМЕТА
    (`master_items.color`, см. _COLOR_TO_QLT).

    Почему одна функция, а не две ветки в разных модулях: ключ варианта
    считается с двух сторон — из продажи (variant_stats.variant_key) и из лота
    (сборщик ленты). Разойдись они, лента по снаряжению вернула бы НОЛЬ строк
    без единой ошибки в логах: все продажи ветеранского ствола легли бы в
    вариант (0, 0), а сборщик искал бы (3, 0).

    master=None и is_art=None означают «артефакт» — так вызывают места, где
    набор гарантированно артефактный.

    None возвращается только для не-артефакта с неизвестным цветом: «качество
    неизвестно» и «качество 0» — разные вещи для фильтров карточки.
    """
    qlt = _as_int((additional or {}).get("qlt"))
    if qlt is not None:
        return qlt

    if is_art is None:
        is_art = _is_artefact(getattr(master, "category", None)) if master is not None else True
    if is_art:
        return 0
    return _COLOR_TO_QLT.get((getattr(master, "color", None) or "").lower())


def resolve_variant_key(
    additional: Optional[dict], master=None, is_art: Optional[bool] = None,
) -> tuple[int, int]:
    """
    (qlt, ptn) варианта — единица расчёта ленты и ключ artifact_variant_stats.

    Отличие от resolve_quality: здесь величины ВСЕГДА целые. Неизвестное
    качество и отсутствующая заточка схлопываются в 0 — иначе продажи одного и
    того же товара разъехались бы по двум вариантам, а колонки qlt/ptn в
    feed_lots / lot_observations NOT NULL.
    """
    return (
        resolve_quality(additional, master, is_art) or 0,
        _as_int((additional or {}).get("ptn")) or 0,
    )


def _lot_quality_enchant(lot: dict, master, is_art: bool) -> tuple[Optional[int], Optional[int]]:
    """
    (качество, заточка) лота для фильтров карточки/Радара/сигналов.

    Качество считает общий резолвер (resolve_quality) — та же величина, что у
    ключа варианта. Заточка трактуется по-разному намеренно: у артефакта её
    отсутствие означает «не точёный» (0, полноценное значение фильтра), у
    снаряжения — «признака нет» (None).
    """
    additional = lot.get("additional") or {}
    ptn = additional.get("ptn")

    qlt_val = resolve_quality(additional, master, is_art)
    if is_art:
        enchant = 0 if ptn is None else int(ptn)
    else:
        enchant = int(ptn) if ptn is not None and int(ptn) > 0 else None

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


def matching_lot_prices(
    raw_lots: list,
    master,
    quality_filter: Optional[int],
    enchant_filter: Optional[int],
    now: datetime,
) -> list[int]:
    """
    Цены за штуку ликвидных лотов снэпшота, подходящих под фильтры качества/заточки.

    Общая основа для «текущего минимума» и «медианы текущих цен» под фильтром —
    иначе каждый вызывающий заводит свою копию перебора raw_lots.
    """
    is_art = _is_artefact(master.category)
    prices: list[int] = []

    for lot in raw_lots or []:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0 or not _is_liquid(lot, now):
            continue
        qlt_val, enchant = _lot_quality_enchant(lot, master, is_art)
        if quality_filter is not None and qlt_val != quality_filter:
            continue
        if enchant_filter is not None and enchant != enchant_filter:
            continue
        prices.append(buyout // amount)

    return prices


def classify_risk(volatility_pct: Optional[float]) -> str:
    """low/medium/high по волатильности цены за 7д (в процентах)."""
    if volatility_pct is None:
        return "medium"
    if volatility_pct > HIGH_VOLATILITY:
        return "high"
    if volatility_pct > MED_VOLATILITY:
        return "medium"
    return "low"


def format_hours(hours: float, precise: bool = False) -> str:
    """
    precise=True — величина ИЗМЕРЕНА (медиана срока по наблюдениям, фаза B), и
    её можно печатать как есть. Без флага всё, что меньше двух часов,
    схлопывается в «< 2 ч»: прежние сроки берутся из эвристики, и десятичная
    доля у выдуманного числа изобразила бы точность, которой нет.

    Порог был откалиброван под лестницу 2...336 ч, где значения ниже двух часов
    были краем. После фазы B туда попали ВСЕ измеренные медианы (0.46-1.99 ч),
    и строка «срок» стала одинаковой у всех трёх тиров — то есть результат
    работы перестал быть виден ровно там, ради чего делался.
    """
    if precise and hours < 1:
        return f"~{round(hours * 60)} мин"
    if precise and hours < 2:
        return f"~{hours:.1f} ч".replace(".", ",")
    if hours < 2:
        return "< 2 ч"
    if hours < 24:
        return f"~{round(hours)} ч"
    days = hours / 24
    if days < 2:
        return "~1-2 дня"
    return f"~{round(days)} дня" if days < 5 else f"~{round(days)} дней"


def weighted_median(pairs: list[tuple[float, float]]) -> Optional[float]:
    """
    Медиана значений с весами: точка, где накопленный вес достигает половины.

    При точном равенстве половине — среднее с соседом, иначе результат
    прыгает на чётных выборках и перестаёт совпадать с обычной медианой
    при одинаковых весах.
    """
    usable = [(v, w) for v, w in pairs if w > 0]
    if not usable:
        return None

    usable.sort(key=lambda p: p[0])
    half = sum(w for _, w in usable) / 2

    cum = 0.0
    for i, (value, weight) in enumerate(usable):
        cum += weight
        if cum > half:
            return value
        if cum == half:
            return (value + usable[i + 1][0]) / 2 if i + 1 < len(usable) else value

    return usable[-1][0]


def _trim_outliers(pairs: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """
    Убирает цены вне диапазона [med / TRIM_RATIO, med * TRIM_RATIO],
    где med — ВЗВЕШЕННАЯ медиана.

    Отсечка по кратности, а не по MAD: MAD зависит от плотности цен и на
    круглых ценах схлопывается. Живой `wgwz` (qlt 3, ptn 0) — 18 сделок из 39
    по ровно 999 999 → MAD = 1 111, полоса ±3 888, то есть 0.4 % от цены, и
    фильтр съедал 19 сделок вместе со всем свежим проливом на 899 999-900 000.
    Кратность свободна от масштаба и от плотности: 3× — ровно та величина, на
    которой измерены реальные выбросы (docs/tasks/profit-algo-review.md §1.7:
    0.38 % сделок выше 3× медианы, 0.60 % ниже трети).

    Предохранители по размеру выборки не нужны: на двух сделках `a` и `5a`
    медиана 3a, границы a…9a — не срезается ничего.

    Центр — взвешенная медиана: с плоской фильтр душит тренд. На «Юле»
    (5 дней рынок стоял на 6.8-7.0 млн, последние 2 дня просел до 6.0-6.6)
    плоский центр 6.85 млн отправляет всю просадку в нижнюю треть диапазона.
    """
    med = weighted_median(pairs)
    if med is None:
        return pairs

    return [(v, w) for v, w in pairs if med / TRIM_RATIO <= v <= med * TRIM_RATIO]


def weighted_reference(
    samples: list[tuple[datetime, float]],
    now: datetime,
    half_life_hours: float = REF_HALF_LIFE_HOURS,
) -> Optional[dict]:
    """
    Опорная цена по продажам с экспоненциальным затуханием веса по возрасту:
    вес = 0.5 ** (age_hours / half_life_hours).

    samples — пары (sale_time, price_per_unit) за окно ref (обычно 7д).

    Реагирует на тренд плавно и без порогов, а на малой выборке деградирует
    мягко: 2-3 случайные свежие сделки не уводят ориентир целиком, потому что
    в расчёте участвует всё окно — просто с меньшим весом.

    Перед расчётом отбрасываются выбросы по кратности медиане (см.
    _trim_outliers), поэтому samples/weight описывают то, на чём опора
    реально построена.

    Возвращает {"ref": float, "samples": int, "weight": float,
    "confidence": "high"|"low"} или None если продаж нет.
    """
    pairs: list[tuple[float, float]] = []
    for sale_time, price in samples:
        if not price or price <= 0:
            continue
        age_hours = max(0.0, (now - sale_time).total_seconds() / 3600)
        pairs.append((float(price), 0.5 ** (age_hours / half_life_hours)))

    pairs = _trim_outliers(pairs)

    ref = weighted_median(pairs)
    if ref is None:
        return None

    return {
        "ref": ref,
        "samples": len(pairs),
        "weight": sum(w for _, w in pairs),
        "confidence": "high" if len(pairs) >= MIN_REF_SAMPLES else "low",
    }


def compute_reference(
    *,
    weighted_hist: Optional[float] = None,
    median_hist:   Optional[float] = None,
    sample_count:  int = 0,
    median_24h:    Optional[float] = None,
    sample_count_24h: int = 0,
    median_now:    Optional[float] = None,
    current_min:   Optional[float] = None,
    weight:        float = 0.0,
) -> Optional[dict]:
    """
    Единая опорная цена (ref) для sell_options — один источник формулы
    для карточки предмета, сигналов, часовой статистики и Радара.

    weighted_hist — weighted_reference(...)["ref"], основной источник.
    median_hist   — плоская медиана продаж за 7д: фоллбек и база для тренда.
                    Как ref используется, только если взвешенной нет.
    median_24h    — медиана реальных сделок за 24ч, основной сигнал тренда.
                    Учитывается только при sample_count_24h >= MIN_REF_SAMPLES:
                    на одной-двух сделках медиана суток — это выброс, а не уровень
                    рынка, и метка тренда получалась противоположной реальности.
    median_now    — медиана АКТИВНЫХ лотов (аски). Фоллбек-сигнал тренда, когда
                    сделок за 24ч нет или их слишком мало. Систематически выше цен
                    реальных продаж, поэтому ref не двигает.
    current_min   — минимум среди лотов: фоллбек, если истории продаж нет вовсе.
    weight        — эффективное число сделок за опорой (weighted_reference["weight"]).
                    Им, а не сырым count, определяются confidence и below_floor.

    Возвращает dict с ref/source/trend/trend_pct/confidence/weight/below_floor/
    samples/samples_24h/median_7d или None, если ориентира нет вообще.
    Если результат не None — ref всегда int > 0.

    Усадки к родительскому уровню здесь нет и не должно быть: qlt/ptn —
    главный ценообразующий признак, поэтому соседнее качество это другой товар
    (у Магмы 145 тыс. против 9.5 млн), а не уточнение тонкой выборки. Замер на
    стенде: усадка спасала 3665 вариантов из 3665, и 66.3 % полученных опор
    лежали вне всего диапазона реальных сделок варианта за 30 дней.

    below_floor — признак, а не поведение: число возвращается всегда (карточка
    предмета вправе показать приблизительную оценку с подписью «мало сделок»),
    а решение «не давать торговый сигнал» принимает вызывающий.

    Тренд — только метка: опорную цену двигает взвешивание по свежести,
    а не пороговый guard (он срабатывал лишь при обвале и пропускал
    обычные просадки на 5-15%).
    """
    # Глитч-лоты (цена в разы ниже исторической) не должны становиться ориентиром
    hist = weighted_hist or median_hist
    if current_min and hist and current_min < hist * GLITCH_RATIO:
        current_min = None

    if weighted_hist:
        ref, source = float(weighted_hist), "weighted_history"
    elif median_hist:
        ref, source = float(median_hist), "history"
    elif current_min:
        ref, source = float(current_min), "current_fallback"
    else:
        return None

    trend, trend_pct = "unknown", None
    if median_hist and median_hist > 0:
        # Тонкая суточная выборка — норма для фильтрованных бакетов (одно качество
        # с заточкой): одна сделка-выброс не должна объявляться уровнем рынка.
        if median_24h and sample_count_24h >= MIN_REF_SAMPLES:
            trend_pct = round((median_24h / median_hist - 1) * 100, 2)
            ratio = median_24h / median_hist
            trend = (
                "falling" if ratio < TREND_SOFT_RATIO
                else "rising" if ratio > 1 / TREND_SOFT_RATIO
                else "stable"
            )
        elif median_now:
            # Только аски: порог грубее, процент не публикуем — это не цены сделок
            ratio = median_now / median_hist
            trend = (
                "falling" if ratio < TREND_DROP_RATIO
                else "rising" if ratio > 1 / TREND_DROP_RATIO
                else "stable"
            )

    return {
        "ref":        max(1, int(ref)),
        "source":     source,
        "trend":      trend,
        "trend_pct":  trend_pct,
        "weight":     round(weight, 2),
        "confidence": (
            "high"   if weight >= REF_CONF_HIGH_WEIGHT
            else "medium" if weight >= MIN_REF_WEIGHT
            else "low"
        ),
        "below_floor": weight < MIN_REF_WEIGHT,
        "samples":    sample_count,
        "samples_24h": sample_count_24h,
        "median_7d":  int(median_hist) if median_hist else None,
    }


def tier_prices(ref: int) -> dict[str, int]:
    """
    Цены трёх тиров от опорной цены — единственное место применения множителей.

    Существует, чтобы market_stats (ветка confidence="high" со своим прогнозом
    времени) не держал вторую копию констант: копии обязаны совпадать, а
    независимые они расходились.
    """
    return {
        "fast":    int(ref * FAST_RATIO),
        "normal":  int(ref * NORMAL_RATIO),
        "premium": int(ref * PREMIUM_RATIO),
    }


def base_option(
    label: str, label_ru: str, price: int, hours: float,
    confidence: str, data_points: int,
) -> dict:
    """
    Одна ценовая точка без данных о дожитии — общая форма для обоих путей
    сборки (make_sell_options и market_stats._calculate_sell_options).

    Существует по той же причине, что и tier_prices: у market_stats своя
    ветка confidence="high" со своим прогнозом времени, и раньше она держала
    вторую копию словаря. Копии обязаны совпадать по набору полей, а
    независимые они расходились.

    fill_probability здесь означает «доля состоявшихся сделок, прошедших по
    этой цене или выше». Величина верная и полезная — это позиция цены в
    потоке сделок. Она НЕ про то, продастся ли лот вообще: сделок, которых не
    было, в ней нет. На тот вопрос отвечает p_sold_* (см. apply_survival).
    """
    return {
        "label": label, "label_ru": label_ru,
        "price_per_unit": price,
        "net_price_per_unit": int(price * (1 - COMMISSION)),
        "estimated_hours": hours,
        "estimated_hours_display": format_hours(hours),
        "fill_probability": FILL_PROBABILITY[label],
        "confidence": confidence,
        "data_points": data_points,
        "time_source": "heuristic",
        "p_sold_6h": None,
        "p_sold_24h": None,
        "pct_sold_ever": None,
    }


def apply_survival(
    option: dict,
    ref: int,
    survival: Optional["SurvivalTable"],
    override_hours: bool,
    item_class: str = CLASS_ARTEFACT,
) -> dict:
    """
    Дописывает в ценовую точку измеренную вероятность продажи (P1-4 фаза B).

    override_hours=False — для ветки market_stats confidence="high": там срок
    интерполирован по реальным парам (часы, цена) ЭТОГО предмета, а таблица
    дожития глобальна (страты по признакам, не по варианту). Предметная оценка
    срока информативнее, и терять её из-за глобальной незачем. Вероятность
    продажи при этом добавляется в любом случае: предметная оценка видит
    только состоявшиеся сделки и о непроданных лотах сказать не может ничего.

    item_class — класс предмета кривой дожития (scope.CLASS_*). Умолчание
    "artefact" сохраняет прежнее поведение путей, которые про класс не знают
    (карточка watchlist, Радар): до этой задачи наблюдались только артефакты,
    и другой кривой в таблице не было. Пути ленты класс передают явно.
    """
    if survival is None:
        return option

    from app.services.analytics.survival import (
        FEATURE_RATIO, ratio_bucket, ratio_bucket_value,
    )

    # По множителю тира, а не по option["price_per_unit"]: цена усечена, см.
    # TIER_RATIOS. Округлять цену бесполезно — отношение всё равно
    # пересчитывается из целого. Для точек, не являющихся тиром, расчёт по цене.
    tier_ratio = TIER_RATIOS.get(option["label"])
    bucket = (
        ratio_bucket_value(tier_ratio) if tier_ratio
        else ratio_bucket(option["price_per_unit"], ref)
    )
    summary = survival.summary(item_class, FEATURE_RATIO, bucket)
    if summary is None:
        return option

    # Публикуем нижнюю границу: снятый лот считается непроданным. Верхняя
    # (withdrawn выкинут из знаменателя) даёт 92-99% во всех стратах и различия
    # между ними стирает — решение она не поддерживает.
    h6  = survival.get(item_class, FEATURE_RATIO, bucket, 6)
    h24 = survival.get(item_class, FEATURE_RATIO, bucket, 24)
    option["p_sold_6h"]     = h6.p_sold_lo if h6 else None
    option["p_sold_24h"]    = h24.p_sold_lo if h24 else None
    option["pct_sold_ever"] = summary.pct_sold_ever

    if override_hours and summary.median_hours is not None:
        option["estimated_hours"] = summary.median_hours
        option["estimated_hours_display"] = format_hours(summary.median_hours, precise=True)
        option["time_source"] = "measured"
        option["data_points"] = summary.n_at_risk
        option["confidence"] = "measured"
    elif not override_hours:
        option["time_source"] = "item_pairs"
    return option


def make_sell_options(
    ref: int,
    volume_7d: Optional[int],
    time_price_pairs: Optional[list[tuple[float, int]]] = None,
    survival: Optional["SurvivalTable"] = None,
    item_class: str = CLASS_ARTEFACT,
) -> list[dict]:
    """
    3 ценовые точки (fast/normal/premium) от ref с прогнозом времени продажи
    и вероятностью исполнения (fill_probability, см. FILL_PROBABILITY).

    survival — таблица дожития (P1-4 фаза B). Когда она есть, срок продажи и
    вероятность берутся ИЗМЕРЕННЫМИ: каждый тир попадает в свой бакет по
    отношению к опоре, и оттуда читаются медиана срока среди проданных и
    P(продан <= H). Когда её нет (первые сутки после деплоя, страта не набрала
    MIN_STRATUM_N) — работает прежняя эвристика, ниже.

    Прежняя эвристика, ради полноты картины: множители 0.4 / 1.0 / 2.5 к
    среднему времени либо лестница 2/8/24 ... 72/168/336 часов по
    sales_per_day. Ни одно из этих двенадцати чисел не измерялось; замер дал
    медианы 0.79 / 0.99 / 1.01 ч против обещанных лестницей 24 / 72 / 168 для
    той же ликвидности (docs/tasks/sale-survival-curve.md §2.4).

    time_price_pairs — реальные пары (часы_на_рынке, цена) из sales_history
    с восстановленным lot_start. При >= MIN_BATCH_SAMPLES точек даёт
    confidence="medium" (интерполяция по среднему времени), иначе
    confidence="low" (оценка по объёму продаж за 7д).
    """
    prices = tier_prices(ref)
    fast_price, normal_price, premium_price = (
        prices["fast"], prices["normal"], prices["premium"],
    )

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
        return apply_survival(
            base_option(label, label_ru, price, hours, confidence, data_points),
            ref, survival, override_hours=True, item_class=item_class,
        )

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
        # Цена продажи, при которой прибыль после комиссии равна нулю.
        # Единственное место расчёта: ключ растекается в signals -> Redis -> API -> UI.
        "breakeven_per_unit": int(buyout_per_unit / (1 - COMMISSION)),
        "ref_used":           int(normal["price_per_unit"]),
    }
