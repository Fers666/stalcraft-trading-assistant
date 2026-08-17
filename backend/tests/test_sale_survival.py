"""
Кривая дожития (P1-4 фаза B): страты, сборка строк, деградация потребителей.

Проверяется в первую очередь то, на чём эта задача может тихо сломаться:
- границы страт в Python и в SQL обязаны совпадать (иначе таблица считается
  по одним границам, а читается по другим);
- пустая таблица не должна менять поведение ни одного потребителя;
- нижняя и верхняя границы по withdrawn не должны путаться местами.
"""

import re
from types import SimpleNamespace

import pytest

from app.services.analytics.survival import (
    FEATURE_POS, FEATURE_RATIO, HORIZONS_H, MIN_STRATUM_N,
    Stratum, SurvivalTable, _POS_CASE, _RATIO_CASE, _stratum_row,
    pos_bucket, ratio_bucket,
)
from app.services.analytics.pricing import make_sell_options, tier_prices


# ─── Страты ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("rank, book, expected", [
    (1, 2, "thin"),          # книга <= 3 — отдельная страта, а не доля
    (1, 3, "thin"),
    (1, 100, "top10"),       # 0.01
    (10, 100, "top10"),      # ровно 0.10 — граница включающая
    (11, 100, "top25"),
    (25, 100, "top25"),
    (26, 100, "mid"),
    (50, 100, "mid"),
    (51, 100, "bottom"),
    (100, 100, "bottom"),
])
def test_pos_bucket(rank, book, expected):
    assert pos_bucket(rank, book) == expected


def test_pos_bucket_without_data():
    """Нет ранга или пустая книга — страты нет, потребитель деградирует."""
    assert pos_bucket(None, 100) is None
    assert pos_bucket(1, None) is None
    assert pos_bucket(1, 0) is None


@pytest.mark.parametrize("price, ref, expected", [
    (80, 100, "lt90"),
    (89, 100, "lt90"),
    (90, 100, "r90_94"),
    (93, 100, "r90_94"),
    (94, 100, "r94_98"),     # тир fast
    (97, 100, "r94_98"),
    (98, 100, "r98_103"),
    (100, 100, "r98_103"),   # тир normal
    (102, 100, "r98_103"),
    (103, 100, "r103_110"),
    (106, 100, "r103_110"),  # тир premium
    (109, 100, "r103_110"),
    (110, 100, "r110_130"),
    (129, 100, "r110_130"),
    (130, 100, "ge130"),
])
def test_ratio_bucket(price, ref, expected):
    assert ratio_bucket(price, ref) == expected


@pytest.mark.parametrize("ref", [
    100_000,    # делится на 50 — усечение tier_prices незаметно
    477_777,    # реальный ref с прода: int(ref*0.94) даёт 0.9399992
    45_001, 33_333, 62_000, 999_999, 7,
])
def test_each_tier_lands_in_its_own_bucket(ref):
    """
    Три тира обязаны попасть в ТРИ разных бакета: иначе «Быстро» и «Выгодно»
    получили бы одну и ту же вероятность и один и тот же срок, а выбор между
    ними перестал бы что-либо значить.

    Страта берётся по МНОЖИТЕЛЮ, а не по цене. Прежняя версия теста брала
    только ref=100_000 и пропустила дефект: tier_prices усекает, и при ref,
    не кратном 50, fast уезжал из r94_98 в r90_94 — на проде у 30% вариантов,
    всегда в сторону более оптимистичных цифр.
    """
    from app.services.analytics.pricing import TIER_RATIOS
    from app.services.analytics.survival import ratio_bucket_value

    buckets = {
        label: ratio_bucket_value(TIER_RATIOS[label]) for label in tier_prices(ref)
    }
    assert buckets == {
        "fast": "r94_98", "normal": "r98_103", "premium": "r103_110",
    }, (ref, buckets)


@pytest.mark.parametrize("ref", [477_777, 45_001, 33_333, 100_000])
def test_measured_option_bucket_survives_price_truncation(ref):
    """Тот же дефект на уровне выдачи: fast обязан получить страту r94_98."""
    rows = {}
    for h in HORIZONS_H:
        rows[(FEATURE_RATIO, "r94_98", h)] = Stratum(
            n_at_risk=1560, p_sold_lo=83.72, p_sold_hi=93.09,
            pct_withdrawn=8.0, pct_sold_ever=87.31, median_hours=0.80,
        )
    fast = next(o for o in make_sell_options(ref, 50, None, SurvivalTable(rows))
                if o["label"] == "fast")
    assert fast["p_sold_6h"] == 83.72
    assert fast["estimated_hours"] == 0.80


def test_ratio_bucket_without_reference():
    assert ratio_bucket(100, None) is None
    assert ratio_bucket(100, 0) is None
    assert ratio_bucket(None, 100) is None


def test_sql_buckets_match_python():
    """
    Границы в CASE-выражениях должны совпадать с pos_bucket/ratio_bucket.

    Тест текстовый и намеренно грубый: он ловит ровно тот класс ошибки, из-за
    которого таблица считалась бы по одним границам, а читалась по другим —
    расхождение, которое никак иначе не проявится, кроме кривых чисел в UI.
    """
    pos_numbers = re.findall(r"<= (0\.\d+)", _POS_CASE)
    assert pos_numbers == ["0.10", "0.25", "0.50"]
    assert "variant_live_lots <= 3" in _POS_CASE

    ratio_numbers = re.findall(r"< (\d\.\d+)", _RATIO_CASE)
    assert ratio_numbers == ["0.90", "0.94", "0.98", "1.03", "1.10", "1.30"]

    for bucket in ("thin", "top10", "top25", "mid", "bottom"):
        assert f"'{bucket}'" in _POS_CASE
    for bucket in ("lt90", "r90_94", "r94_98", "r98_103", "r103_110", "r110_130", "ge130"):
        assert f"'{bucket}'" in _RATIO_CASE


# ─── Сборка строки таблицы ───────────────────────────────────────────────────

class _Agg:
    """Строка агрегата, как её отдаёт _AGG_SQL."""
    def __init__(self, bucket, horizon_h, n_at_risk, n_sold, n_withdrawn,
                 n_total, n_sold_ever, median_hours):
        self.bucket = bucket
        self.horizon_h = horizon_h
        self.n_at_risk = n_at_risk
        self.n_sold = n_sold
        self.n_withdrawn = n_withdrawn
        self.n_total = n_total
        self.n_sold_ever = n_sold_ever
        self.median_hours = median_hours


def test_thin_stratum_is_not_published():
    """Страта ниже порога не пишется вовсе — потребитель откатывается назад."""
    agg = _Agg("top10", 6, MIN_STRATUM_N - 1, 100, 10, 300, 250, 1.0)
    assert _stratum_row(FEATURE_POS, agg, None) is None


def test_bounds_bracket_the_truth():
    """
    Нижняя граница считает снятый лот непроданным, верхняя выкидывает его из
    знаменателя. Перепутать их местами значит показать оптимизм вместо
    осторожности, поэтому проверяем и порядок, и сами числа.
    """
    agg = _Agg("top10", 6, n_at_risk=1000, n_sold=700, n_withdrawn=100,
               n_total=1200, n_sold_ever=900, median_hours=0.74)
    row = _stratum_row(FEATURE_POS, agg, None)

    assert row["p_sold_lo"] == 70.0            # 700 / 1000
    assert row["p_sold_hi"] == pytest.approx(77.78, abs=0.01)   # 700 / 900
    assert row["p_sold_lo"] < row["p_sold_hi"]
    assert row["pct_withdrawn"] == 10.0
    assert row["pct_sold_ever"] == 75.0        # 900 / 1200, по всей страте
    assert row["median_hours"] == 0.74


def test_all_withdrawn_does_not_divide_by_zero():
    agg = _Agg("bottom", 24, n_at_risk=500, n_sold=0, n_withdrawn=500,
               n_total=500, n_sold_ever=0, median_hours=None)
    row = _stratum_row(FEATURE_POS, agg, None)
    assert row["p_sold_lo"] == 0.0
    assert row["p_sold_hi"] == 100.0
    assert row["median_hours"] is None


# ─── Чтение и деградация ─────────────────────────────────────────────────────

def _table():
    rows = {}
    for h, p in zip(HORIZONS_H, (20.0, 50.0, 84.4, 90.0, 92.0)):
        rows[(FEATURE_RATIO, "r94_98", h)] = Stratum(
            n_at_risk=1523, p_sold_lo=p, p_sold_hi=p + 9.5,
            pct_withdrawn=8.0, pct_sold_ever=88.0, median_hours=0.79,
        )
    return SurvivalTable(rows)


def test_empty_table_keeps_old_behaviour():
    """
    Главный инвариант деплоя: первый пересчёт идёт через сутки, и до него
    выдача обязана быть в точности прежней.
    """
    without = make_sell_options(100_000, 50)
    with_empty = make_sell_options(100_000, 50, None, SurvivalTable())
    for a, b in zip(without, with_empty):
        assert a == b


def test_unknown_bucket_keeps_old_behaviour():
    """Страта есть у одного тира — остальные два не должны пострадать."""
    opts = make_sell_options(100_000, 50, None, _table())
    by_label = {o["label"]: o for o in opts}

    assert by_label["fast"]["time_source"] == "measured"
    assert by_label["normal"]["time_source"] == "heuristic"
    assert by_label["normal"]["p_sold_6h"] is None
    assert by_label["normal"]["estimated_hours"] == make_sell_options(
        100_000, 50)[1]["estimated_hours"]


def test_measured_option_replaces_heuristic_hours():
    fast = next(o for o in make_sell_options(100_000, 50, None, _table())
                if o["label"] == "fast")
    assert fast["estimated_hours"] == 0.79
    assert fast["p_sold_6h"] == 84.4
    assert fast["pct_sold_ever"] == 88.0
    assert fast["data_points"] == 1523
    assert fast["confidence"] == "measured"
    # fill_probability остаётся: это другая величина (доля состоявшихся сделок
    # по цене тира или выше), и терять измеренное незачем
    assert fast["fill_probability"] == 75


def test_option_shape_is_stable_with_and_without_survival():
    """Набор полей не должен зависеть от наличия таблицы — иначе API-схема плывёт."""
    a = make_sell_options(100_000, 50)[0]
    b = make_sell_options(100_000, 50, None, _table())[0]
    assert set(a) == set(b)


def test_summary_falls_back_across_horizons():
    """Сводка страты берётся с любого доступного горизонта, а не только с первого."""
    rows = {(FEATURE_POS, "top10", 24): Stratum(
        n_at_risk=900, p_sold_lo=92.0, p_sold_hi=99.0,
        pct_withdrawn=7.0, pct_sold_ever=77.3, median_hours=0.98,
    )}
    table = SurvivalTable(rows)
    assert table.summary(FEATURE_POS, "top10").median_hours == 0.98
    assert table.get(FEATURE_POS, "top10", 6) is None
    assert table.summary(FEATURE_POS, None) is None


# ─── Позиция плановой цены в стакане ─────────────────────────────────────────

def test_rank_for_price_matches_queue_definition():
    """
    Ранг плановой цены обязан считаться тем же правилом, что ранг наблюдаемого
    лота (1 + число строго дешевле). Иначе прогноз читал бы страту, по которой
    кривая не строилась.
    """
    from app.tasks.feed_collector import rank_for_price

    ladder = [100, 100, 200, 300]
    assert rank_for_price(ladder, 50) == (1, 4)
    assert rank_for_price(ladder, 100) == (1, 4)   # равные цены — тот же ранг
    assert rank_for_price(ladder, 150) == (3, 4)
    assert rank_for_price(ladder, 300) == (4, 4)
    assert rank_for_price(ladder, 999) == (5, 4)


def test_ladder_and_queue_share_the_same_book():
    """
    variant_ladders и variant_queues обязаны видеть один стакан: расхождение
    фильтра ликвидности означало бы, что наблюдение записано по одной книге,
    а прогноз сделан по другой.
    """
    from datetime import datetime, timedelta, timezone
    from app.tasks.feed_collector import variant_ladders, variant_queues

    now = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
    far = (now + timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    soon = (now + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lots = [
        {"buyoutPrice": 100, "amount": 1, "endTime": far,  "additional": {"qlt": 3, "ptn": 0}},
        {"buyoutPrice": 300, "amount": 1, "endTime": far,  "additional": {"qlt": 3, "ptn": 0}},
        # неликвидный: до конца < 2 ч — очередь покупателю не создаёт
        {"buyoutPrice": 50,  "amount": 1, "endTime": soon, "additional": {"qlt": 3, "ptn": 0}},
    ]
    ladders = variant_ladders(lots, now)
    queues = variant_queues(lots, now)

    assert ladders[(3, 0)] == [100, 300]
    assert len(ladders[(3, 0)]) == queues[(3, 0)][1]


# ─── Интеграция с лентой ─────────────────────────────────────────────────────

def _feed_survival(median_hours=0.98, p6=89.4, sold_ever=77.3, bucket="top10"):
    rows = {}
    for h, p in zip(HORIZONS_H, (54.4, 81.5, p6, 92.6, 94.0)):
        rows[(FEATURE_POS, bucket, h)] = Stratum(
            n_at_risk=4958, p_sold_lo=p, p_sold_hi=p + 7.0,
            pct_withdrawn=6.0, pct_sold_ever=sold_ever, median_hours=median_hours,
        )
    return SurvivalTable(rows)


def _feed_inputs():
    from datetime import datetime, timedelta, timezone
    from app.services.analytics.pricing import make_sell_options

    now = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
    end = (now + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    variant = SimpleNamespace(
        ref_price=100_000, sell_options=make_sell_options(100_000, 70), risk="low",
        batch_stats=None, volatility_7d=5.0, trend_24h="stable", trend_24h_pct=1.0,
        trend_7d_pct=-2.0, sales_per_day=3.0, ref_confidence="high", ref_samples=70,
    )
    # Дешёвый лот плюс стена дорогих: плановая цена продажи встанет в верх книги.
    lots = [{"startTime": "2026-08-17T10:00:00Z", "endTime": end,
             "buyoutPrice": 50_000, "amount": 1, "additional": {"qlt": 4, "ptn": 15}}]
    lots += [{"startTime": f"2026-08-17T10:{i:02d}:00Z", "endTime": end,
              "buyoutPrice": 300_000, "amount": 1, "additional": {"qlt": 4, "ptn": 15}}
             for i in range(20)]
    return lots, {(4, 15): variant}, now


def test_feed_row_carries_measured_probability():
    from app.tasks.feed_collector import score_item_lots

    lots, variants, now = _feed_inputs()
    rows = score_item_lots("art1", "RU", lots, variants, now, survival=_feed_survival())

    assert len(rows) == 1
    row = rows[0]
    assert row["p_sold_6h"] == 89.4
    assert row["pct_sold_ever"] == 77.3
    # Срок берётся из позиционной страты, а не из тира fast
    assert float(row["est_sell_hours"]) == 0.98
    # ₽/час пересчитан по НОВОМУ сроку: иначе колонка и её сортировка
    # разъехались бы с показанным числом часов
    assert row["profit_per_hour_total"] == pytest.approx(
        row["profit_total"] / 0.98, abs=0.5)


def test_feed_row_without_survival_is_unchanged():
    """Пустая таблица не должна менять ленту — это состояние первых суток."""
    from app.tasks.feed_collector import score_item_lots

    lots, variants, now = _feed_inputs()
    before = score_item_lots("art1", "RU", lots, variants, now)
    after = score_item_lots("art1", "RU", lots, variants, now, survival=SurvivalTable())

    assert before[0]["est_sell_hours"] == after[0]["est_sell_hours"]
    assert after[0]["p_sold_6h"] is None
    assert after[0]["pct_sold_ever"] is None
    assert before[0].keys() == after[0].keys()


def test_feed_uses_planned_sell_price_not_lot_price():
    """
    Страта считается от цены, по которой мы СОБИРАЕМСЯ продать, а не от цены
    покупки. Дешёвый лот стоит первым в книге, но продавать мы будем сильно
    дороже — и попадём в другую страту. Спутать эти два вопроса значит
    обещать срок покупателя, а не продавца.
    """
    from datetime import datetime, timedelta, timezone
    from app.tasks.feed_collector import rank_for_price, variant_ladders
    from app.services.analytics.pricing import evaluate_lot_profit, make_sell_options

    now = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
    end = (now + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def lot(price, i):
        return {"startTime": f"2026-08-17T10:{i:02d}:00Z", "endTime": end,
                "buyoutPrice": price, "amount": 1, "additional": {"qlt": 4, "ptn": 15}}

    # Один дешёвый лот (его и покупаем), плотная середина вокруг плановой цены
    # продажи и стена дорогих сверху.
    lots = [lot(50_000, 0)]
    lots += [lot(60_000 + i * 5_000, i + 1) for i in range(8)]   # 60k..95k
    lots += [lot(300_000, 20 + i) for i in range(11)]
    ladder = variant_ladders(lots, now)[(4, 15)]

    sell_options = make_sell_options(100_000, 70)
    evaluated = evaluate_lot_profit(50_000, 1, sell_options, "low")

    rank_planned, book = rank_for_price(ladder, evaluated["sell_price_used"])
    rank_bought, _ = rank_for_price(ladder, 50_000)

    assert rank_bought == 1                      # купленный лот — самый дешёвый
    assert rank_planned > rank_bought            # плановая цена продажи — выше
    assert pos_bucket(rank_bought, book) == "top10"
    assert pos_bucket(rank_planned, book) != "top10"


# ─── Отображение измеренного срока ───────────────────────────────────────────

def test_measured_hours_are_printed_not_collapsed():
    """
    format_hours схлопывал всё, что меньше двух часов, в «< 2 ч». После фазы B
    туда попали ВСЕ измеренные медианы (0.46-1.99 ч), и строка «срок» стала
    одинаковой у трёх тиров — результат работы перестал быть виден.
    """
    from app.services.analytics.pricing import format_hours

    assert format_hours(0.46, precise=True) == "~28 мин"
    assert format_hours(0.80, precise=True) == "~48 мин"
    assert format_hours(1.03, precise=True) == "~1,0 ч"
    assert format_hours(1.76, precise=True) == "~1,8 ч"
    # Без флага поведение прежнее: эвристический срок не заслуживает десятых
    assert format_hours(0.80) == "< 2 ч"
    # Выше двух часов флаг ничего не меняет
    assert format_hours(8.0, precise=True) == format_hours(8.0) == "~8 ч"


def test_tiers_with_different_medians_show_different_durations():
    """
    Ровно тот симптом, который нашёл QA: три одинаковых «< 2 ч» в карточке.

    Требовать ТРИ разные строки нельзя: измеренные медианы normal и premium —
    1.00 и 1.03 ч, то есть отличаются на 1.8 минуты, и печатать их по-разному
    значило бы показывать точность, которой в данных нет. Различаться обязаны
    те, кто различается по существу: fast (0.80 ч) против остальных.
    """
    rows = {}
    for bucket, med in (("r94_98", 0.80), ("r98_103", 1.00), ("r103_110", 1.03)):
        for h in HORIZONS_H:
            rows[(FEATURE_RATIO, bucket, h)] = Stratum(
                n_at_risk=1560, p_sold_lo=83.0, p_sold_hi=90.0,
                pct_withdrawn=8.0, pct_sold_ever=87.0, median_hours=med,
            )
    shown = {o["label"]: o["estimated_hours_display"]
             for o in make_sell_options(477_777, 50, None, SurvivalTable(rows))}
    assert shown["fast"] != shown["normal"], shown
    assert shown["fast"] == "~48 мин"
    # Ни одна строка не должна быть прежней заглушкой
    assert "< 2 ч" not in shown.values(), shown


# ─── Согласованность величин внутри страты ───────────────────────────────────

def test_sold_ever_is_not_below_horizon_probability():
    """
    pct_sold_ever считался по всей страте, а p_sold_* — по дожившим до
    горизонта. На проде это давало pct_sold_ever МЕНЬШЕ p_sold_24h во всех 59
    стратах: «за сутки продалось больше, чем продалось вообще». Знаменатель
    обязан быть общим.
    """
    agg = _Agg("top10", 24, n_at_risk=1000, n_sold=700, n_withdrawn=100,
               n_total=1000, n_sold_ever=800, median_hours=0.74)
    row = _stratum_row(FEATURE_POS, agg, None)
    assert row["pct_sold_ever"] >= row["p_sold_lo"]
    assert row["pct_sold_ever"] == 80.0


def test_agg_sql_uses_one_denominator():
    """
    Текстовая сверка запроса: n_total и n_sold_ever обязаны нести тот же
    фильтр planned_h, что и n_at_risk. Дефект жил именно в SQL, и никакой
    тест на чистых функциях его бы не поймал.
    """
    from app.services.analytics.survival import _AGG_SQL

    assert _AGG_SQL.count("planned_h >= h.horizon_h") == 5
    body = _AGG_SQL[_AGG_SQL.index("AS n_at_risk"):]
    assert "count(*) AS n_total" not in body


# ─── Знаменатель: ещё живые лоты — тоже наблюдения ───────────────────────────

def test_agg_sql_counts_still_live_lots_that_outlived_the_horizon():
    """
    Главный дефект расчёта, найденный уже после выкатки: в знаменатель шли
    только ЗАКРЫТЫЕ наблюдения. Лот закрывается через 2 ч после последнего
    появления, поэтому среди недавних успевают закрыться в основном быстро
    проданные — классическая метрика по выжившим. Замер на проде: завышение
    12.5-15.7 п.п. по горизонтам и до 21.4 п.п. по отдельным стратам.

    Лот, переживший горизонт у нас на глазах, обязан считаться как
    «за H не продался», даже если он всё ещё висит на рынке.
    """
    from app.services.analytics.survival import _AGG_SQL

    # Выборка больше не отсеивает незакрытые строки в WHERE
    where_block = _AGG_SQL[:_AGG_SQL.index("), h AS (")]
    assert "outcome IS NOT NULL" not in where_block
    # ...а каждая считалка знает, когда исход к горизонту известен
    assert _AGG_SQL.count("(outcome IS NOT NULL OR life_h >= h.horizon_h)") == 5


def test_still_live_lot_lowers_the_probability():
    """
    Смысловая проверка на числах: 100 проданных за 1 ч и 100 ещё живых,
    переваливших за 6 ч, дают 50 %, а не 100 %.
    """
    agg = _Agg("top10", 6, n_at_risk=200, n_sold=100, n_withdrawn=0,
               n_total=200, n_sold_ever=100, median_hours=1.0)
    row = _stratum_row(FEATURE_POS, agg, None)
    assert row["p_sold_lo"] == 50.0
    assert row["pct_sold_ever"] == 50.0
