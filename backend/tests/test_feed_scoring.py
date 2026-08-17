"""
Тесты скоринга «Ленты артефактов» (Фаза 2 ТЗ artifact-feed.md).

Проверяются чистые функции: группировка продаж по варианту, метрики варианта,
маппинг лота в строку feed_lots. К БД и сети тесты не ходят — та же планка,
что у test_pricing.py и test_feed_budget.py.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.api.v1.endpoints.feed import band_bounds, FEED_BAND_MIN_ROWS, _SORT_COLUMNS
from app.models.models import FeedLot
from app.services.analytics.pricing import RISK_MARGIN_MULT, make_sell_options
from app.services.analytics.variant_stats import (
    compute_variant, trend_7d_pct, variant_key,
)
from app.tasks.feed_collector import (
    FEED_MAX_PROFIT_PCT, dedupe_rows, lot_identity_key, score_item_lots,
    supply_coverage_days,
)

NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)


# ─── Группировка продаж по варианту ───────────────────────────────────────────

@pytest.mark.parametrize("additional,expected", [
    (None,                     (0, 0)),
    ({},                       (0, 0)),
    ({"qlt": 4},               (4, 0)),
    ({"qlt": 4, "ptn": 15},    (4, 15)),
    ({"qlt": "4", "ptn": "15"}, (4, 15)),   # API отдаёт числа, но строки не должны ломать группировку
    ({"qlt": None},            (0, 0)),
])
def test_variant_key(additional, expected):
    """
    Отсутствующее поле = 0, а не NULL: иначе продажи одного товара разъехались
    бы по двум вариантам и опора считалась бы по половине сделок.
    """
    assert variant_key(additional) == expected


# ─── Покрытие предложения ─────────────────────────────────────────────────────

def test_supply_coverage_days():
    assert supply_coverage_days(30, 3.0) == 10.0


@pytest.mark.parametrize("sales_per_day", [None, 0, 0.0])
def test_supply_coverage_days_without_sales(sales_per_day):
    """Без продаж делить не на что — None, а не «бесконечность»."""
    assert supply_coverage_days(30, sales_per_day) is None


# ─── Недельный тренд ──────────────────────────────────────────────────────────

def test_trend_7d_pct():
    assert trend_7d_pct(90.0, 100.0) == -10.0


@pytest.mark.parametrize("median_30d", [0, None])
def test_trend_7d_pct_without_base(median_30d):
    """median_30d = 0 / None не должен давать ZeroDivisionError."""
    assert trend_7d_pct(100.0, median_30d) is None


# ─── Метрики варианта ─────────────────────────────────────────────────────────

def _sale(hours_ago: float, price: int, amount: int = 1, additional=None):
    return SimpleNamespace(
        sale_time=NOW - timedelta(hours=hours_ago),
        price_per_unit=price,
        amount=amount,
        total_price=price * amount,
        additional_info=additional,
    )


def test_compute_variant_builds_reference_from_sales():
    # 10 сделок за неделю — эффективный вес 6.2, выше пола MIN_REF_WEIGHT
    hours = (1, 5, 10, 20, 30, 40, 50, 60, 80, 100)
    sales = [_sale(h, 100_000) for h in hours]
    variant = compute_variant(sales, NOW)

    assert variant["ref_price"] == 100_000
    assert variant["ref_source"] == "weighted_history"
    assert variant["sales_volume_7d"] == len(hours)
    assert variant["sales_per_day"] == round(len(hours) / 7, 2)
    assert variant["sell_options"] is not None
    assert variant["risk"] == "low"


def test_compute_variant_below_floor_gives_no_signal():
    """
    Три сделки за неделю (эффективный вес ~1.6) — торгового сигнала нет:
    ни опоры, ни цен продажи. 65% обещанной прибыли ленты стояло ровно на таких
    вариантах (docs/tasks/profit-algo-review.md §1.3).
    """
    variant = compute_variant([_sale(h, 100_000) for h in (10, 50, 100)], NOW)

    assert variant["ref_price"] is None
    assert variant["sell_options"] is None


def test_compute_variant_without_sales_in_window_has_no_reference():
    """Сделки только старше 7 дней — опоры нет, вариант в скоринге пропускается."""
    variant = compute_variant([_sale(24 * 20, 100_000)], NOW)
    assert variant["ref_price"] is None
    assert variant["sell_options"] is None
    assert variant["sales_volume_30d"] == 1


# ─── Маппинг лота в строку feed_lots ──────────────────────────────────────────

def _variant(ref: int | None = 100_000, risk: str = "low", sales_per_day: float = 3.0, **over):
    data = {
        "ref_price": ref,
        "sell_options": make_sell_options(ref, 70) if ref else None,
        "risk": risk,
        "batch_stats": None,
        "volatility_7d": 5.0,
        "trend_24h": "stable",
        "trend_24h_pct": 1.0,
        "trend_7d_pct": -2.0,
        "sales_per_day": sales_per_day,
        "ref_confidence": "high",
        "ref_samples": 70,
    }
    data.update(over)
    return SimpleNamespace(**data)


def _lot(price_per_unit: int, amount: int = 1, key: str = "2026-08-03T10:00:00Z", **extra):
    lot = {
        "startTime": key,
        "endTime": (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": price_per_unit * amount,
        "amount": amount,
        "additional": {"qlt": 4, "ptn": 15},
    }
    lot.update(extra)
    return lot


def test_score_item_lots_maps_profitable_lot():
    rows = score_item_lots(
        "art1", "RU", [_lot(50_000, amount=3)], {(4, 15): _variant()}, NOW,
    )
    assert len(rows) == 1
    row = rows[0]

    assert row["item_id"] == "art1" and row["region"] == "RU"
    assert (row["qlt"], row["ptn"]) == (4, 15)
    assert row["amount"] == 3
    assert row["buyout_price"] == 150_000 and row["buyout_per_unit"] == 50_000
    assert row["ref_price"] == 100_000
    # profit_total — прибыль со ВСЕГО лота, колонка сортировки по умолчанию
    assert row["profit_total"] == row["profit_per_unit"] * 3
    assert row["profit_per_unit"] > 0
    assert row["first_seen_at"] == NOW and row["seen_at"] == NOW
    # lot_key составной: startTime|qlt|ptn|buyoutPrice|amount
    assert row["lot_key"] == "2026-08-03T10:00:00Z|4|15|150000|3"
    # start_time берётся из startTime лота, а не парсится из ключа
    assert row["start_time"] == datetime(2026, 8, 3, 10, 0, tzinfo=timezone.utc)
    assert row["stats_confidence"] == "high"
    # Σ amount лотов варианта (3) / продаж в день (3.0)
    assert row["supply_coverage_days"] == 1.0


def test_score_item_lots_skips_unprofitable():
    """evaluate_lot_profit -> None (лот дороже опоры) ⇒ строки нет."""
    rows = score_item_lots("art1", "RU", [_lot(200_000)], {(4, 15): _variant()}, NOW)
    assert rows == []


def test_score_item_lots_skips_glitch_profit():
    """Цена в тысячу раз ниже опоры — глитч, а не сделка века."""
    rows = score_item_lots("art1", "RU", [_lot(10)], {(4, 15): _variant()}, NOW)
    assert rows == []


def test_glitch_cutoff_boundary_keeps_normal_profit():
    """Отсекается только то, что выше FEED_MAX_PROFIT_PCT — обычная прибыль остаётся."""
    rows = score_item_lots("art1", "RU", [_lot(30_000)], {(4, 15): _variant()}, NOW)
    assert len(rows) == 1
    assert rows[0]["profit_pct"] <= FEED_MAX_PROFIT_PCT


@pytest.mark.parametrize("variant_stats", [
    _variant(ref=None),
    _variant(sell_options=None),
])
def test_score_item_lots_skips_variant_without_reference(variant_stats):
    """Нет реальных сделок — нет честной опоры: лоты варианта пропускаются целиком."""
    rows = score_item_lots("art1", "RU", [_lot(50_000)], {(4, 15): variant_stats}, NOW)
    assert rows == []


def test_score_item_lots_skips_unknown_variant():
    """«Мастер +15» и «Мастер +10» — разные товары: чужой вариант не подставляется."""
    rows = score_item_lots("art1", "RU", [_lot(50_000)], {(4, 10): _variant()}, NOW)
    assert rows == []


def test_score_item_lots_skips_expiring_lot():
    """Лот, который закончится раньше чем через 2 ч, купить и перепродать нельзя."""
    ends_soon = (NOW + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    rows = score_item_lots(
        "art1", "RU", [_lot(50_000, endTime=ends_soon)], {(4, 15): _variant()}, NOW,
    )
    assert rows == []


def test_score_item_lots_skips_lot_without_key():
    """Без startTime ключа лота не существует — апсерт такой строки невозможен."""
    rows = score_item_lots(
        "art1", "RU", [_lot(50_000, startTime="")], {(4, 15): _variant()}, NOW,
    )
    assert rows == []


# ─── Идентичность лота: startTime не уникален ─────────────────────────────────

def test_lot_identity_key_distinguishes_lots_of_the_same_second():
    """
    Реальный случай, ронявший каждый цикл сбора: у wg53 два разных лота с
    одинаковым startTime (2026-08-03T13:33:08Z) — 649999 ₽ qlt=1 ptn=5 и
    550000 ₽ qlt=1 ptn=4.
    """
    start = "2026-08-03T13:33:08Z"
    first  = {"startTime": start, "buyoutPrice": 649_999, "amount": 1,
              "additional": {"qlt": 1, "ptn": 5}}
    second = {"startTime": start, "buyoutPrice": 550_000, "amount": 1,
              "additional": {"qlt": 1, "ptn": 4}}

    assert lot_identity_key(first) != lot_identity_key(second)


@pytest.mark.parametrize("field,value", [
    ("buyoutPrice", 60_000),
    ("amount", 2),
    ("additional", {"qlt": 3, "ptn": 15}),
])
def test_lot_identity_key_reacts_to_every_component(field, value):
    """Ключ обязан меняться от любой из своих составляющих, иначе лоты схлопнутся."""
    base = _lot(50_000)
    other = dict(base)
    other[field] = value
    assert lot_identity_key(base) != lot_identity_key(other)


def test_lot_identity_key_is_stable():
    """Тот же лот в следующем цикле — тот же ключ (иначе апсерт плодит дубли)."""
    assert lot_identity_key(_lot(50_000)) == lot_identity_key(_lot(50_000))


def test_lot_identity_key_fits_column():
    """Колонка lot_key — String(64): ключ обязан в неё влезать."""
    key = lot_identity_key(_lot(999_999_999, amount=99_999))
    assert 0 < len(key) <= 64


@pytest.mark.parametrize("lot", [{}, {"startTime": ""}])
def test_lot_identity_key_empty_without_start_time(lot):
    assert lot_identity_key(lot) == ""


def test_score_item_lots_keeps_both_lots_of_the_same_second():
    """
    Два лота одной секунды дают ДВЕ строки с разными ключами — раньше это была
    пара одинаковых ключей, которая роняла весь батч апсерта
    (CardinalityViolationError) и вместе с ним весь цикл сбора.
    """
    start = "2026-08-03T10:00:00Z"
    lots = [
        _lot(50_000, key=start),
        _lot(60_000, key=start),
    ]
    rows = score_item_lots("art1", "RU", lots, {(4, 15): _variant()}, NOW)

    assert len(rows) == 2
    assert len({row["lot_key"] for row in rows}) == 2
    assert len(dedupe_rows(rows)) == 2


# ─── Дедуп батча перед апсертом ───────────────────────────────────────────────

def _row(lot_key: str, profit: int = 1):
    return {"item_id": "art1", "region": "RU", "lot_key": lot_key, "profit_total": profit}


def test_dedupe_rows_keeps_last_on_collision():
    """
    Неразличимые по данным API лоты (всё совпало) схлопываются — побеждает
    последняя запись. Без этого повтор ключа внутри одного INSERT ... ON
    CONFLICT DO UPDATE роняет транзакцию целиком, а не одну строку.
    """
    deduped = dedupe_rows([_row("k", 1), _row("k", 2)])
    assert deduped == [_row("k", 2)]


def test_dedupe_rows_keeps_distinct_keys_and_order():
    rows = [_row("a"), _row("b"), _row("c")]
    assert dedupe_rows(rows) == rows


def test_dedupe_rows_separates_items_and_regions():
    """Ключ дедупа — тройка (item_id, region, lot_key), а не один lot_key."""
    rows = [
        {"item_id": "art1", "region": "RU", "lot_key": "k"},
        {"item_id": "art2", "region": "RU", "lot_key": "k"},
        {"item_id": "art1", "region": "EU", "lot_key": "k"},
    ]
    assert len(dedupe_rows(rows)) == 3


def test_dedupe_rows_on_empty_batch():
    assert dedupe_rows([]) == []


@pytest.mark.parametrize("risk", ["low", "medium", "high"])
def test_margin_adj_pct_is_profit_pct_over_risk_mult(risk):
    """
    margin_adj_pct = profit_pct / risk_mult — sargable-форма фильтра
    profit_pct >= порог × RISK_MARGIN_MULT[risk]. Порог 30% для high
    означает реальные 48%.
    """
    rows = score_item_lots("art1", "RU", [_lot(50_000)], {(4, 15): _variant(risk=risk)}, NOW)
    row = rows[0]

    assert row["risk"] == risk
    assert row["risk_mult"] == RISK_MARGIN_MULT[risk]
    assert row["margin_adj_pct"] == pytest.approx(row["profit_pct"] / RISK_MARGIN_MULT[risk], abs=0.01)


def test_visibility_threshold_by_risk():
    """Один и тот же лот при пороге 30% виден на low и скрыт на high."""
    threshold = 30.0
    visible = {}
    for risk in ("low", "medium", "high"):
        # 63 000 за штуку при опоре 100 000 (цена выхода 94 000 × 0.95 = 89 300)
        # -> ~41.7% прибыли: выше 30%, но ниже 30 × 1.6 = 48%, которые требует high.
        rows = score_item_lots(
            "art1", "RU", [_lot(63_000)], {(4, 15): _variant(risk=risk)}, NOW,
        )
        visible[risk] = bool(rows) and rows[0]["margin_adj_pct"] >= threshold

    assert visible["low"] is True
    assert visible["medium"] is True
    assert visible["high"] is False


def test_supply_counts_all_lots_of_variant():
    """Предложение варианта — Σ amount ВСЕХ его лотов среза, не только выгодных."""
    lots = [
        _lot(50_000, amount=3, key="lot-a"),
        _lot(500_000, amount=27, key="lot-b"),      # невыгодный, но это тоже предложение
        _lot(50_000, amount=5, key="lot-c", additional={"qlt": 3, "ptn": 0}),  # другой вариант
    ]
    rows = score_item_lots("art1", "RU", lots, {(4, 15): _variant()}, NOW)

    assert len(rows) == 1
    assert rows[0]["supply_coverage_days"] == supply_coverage_days(30, 3.0)


# ─── ₽/час: сортировка идёт по показанной величине ───────────────────────────

def test_profit_per_hour_total_is_the_displayed_value():
    """
    В колонке «₽/час» напечатано profit_total / est_sell_hours. Материализуем
    ровно её — колонка сортировки обязана содержать то же число.
    """
    row = score_item_lots("art1", "RU", [_lot(50_000, amount=3)], {(4, 15): _variant()}, NOW)[0]
    assert row["profit_per_hour_total"] == pytest.approx(
        row["profit_total"] / row["est_sell_hours"], abs=0.01,
    )


def test_profit_per_hour_total_scales_with_amount():
    """Прибыль на единицу в час и прибыль лота в час различаются ровно в amount раз."""
    row = score_item_lots("art1", "RU", [_lot(50_000, amount=4)], {(4, 15): _variant()}, NOW)[0]
    assert row["profit_per_hour_total"] == pytest.approx(row["profit_per_hour"] * 4, abs=0.01)


def test_sort_by_profit_per_hour_uses_the_total_column():
    """
    Сортировка ?sort=profit_per_hour идёт по колонке «со всего лота».
    Раньше здесь стояла прибыль НА ЕДИНИЦУ — для amount > 1 она расходится с
    показанным числом в amount раз и переворачивает выдачу.
    """
    assert _SORT_COLUMNS["profit_per_hour"] is FeedLot.profit_per_hour_total


def test_ordering_by_stored_column_matches_ordering_by_shown_number():
    """
    Случай QA: лот с показанными 58 287 ₽/ч стоял ниже лота с 14 946.
    Дешёвая пачка даёт меньшую прибыль на единицу, но большую со всего лота.
    """
    lots = [
        _lot(30_000, amount=10, key="батч"),     # меньше на единицу, больше итого
        _lot(20_000, amount=1,  key="штука"),    # больше на единицу, меньше итого
    ]
    rows = score_item_lots("art1", "RU", lots, {(4, 15): _variant()}, NOW)
    assert len(rows) == 2

    by_unit  = [r["lot_key"] for r in sorted(rows, key=lambda r: -r["profit_per_hour"])]
    by_total = [r["lot_key"] for r in sorted(rows, key=lambda r: -r["profit_per_hour_total"])]
    shown    = [r["lot_key"] for r in sorted(
        rows, key=lambda r: -(r["profit_total"] / r["est_sell_hours"]),
    )]

    assert by_total == shown          # сортировка = показанная величина
    assert by_unit != shown           # старая колонка давала обратный порядок


def test_profit_per_hour_total_without_hours():
    """Без прогноза времени продажи величины нет — None, а не деление на ноль."""
    variant = _variant()
    variant.sell_options = [
        {**opt, "estimated_hours": 0} for opt in variant.sell_options
    ]
    row = score_item_lots("art1", "RU", [_lot(50_000)], {(4, 15): variant}, NOW)[0]
    assert row["profit_per_hour_total"] is None


# ─── Правила витрины (чистая часть) ───────────────────────────────────────────

def test_band_bounds_applies_on_large_enough_selection():
    assert band_bounds(FEED_BAND_MIN_ROWS, 100, 500) == (100, 500)


@pytest.mark.parametrize("n", [0, 1, 2, FEED_BAND_MIN_ROWS - 1])
def test_band_bounds_degrades_on_small_selection(n):
    """На 1–3 строках перцентили схлопываются — витрина обязана не пустеть."""
    assert band_bounds(n, 100, 500) is None


# ─── Ожидаемая прибыль в час (P0-3) ──────────────────────────────────────────

def test_ev_per_hour_is_profit_per_hour_times_probability():
    """
    Один множитель к ₽/час, но он и есть смысл P0-3: profit_total отвечает
    «сколько заработаю, ЕСЛИ продам», ev_per_hour домножает на вероятность
    того, что продажа состоится.
    """
    from types import SimpleNamespace
    from app.services.analytics.survival import (
        FEATURE_POS, HORIZONS_H, Stratum, SurvivalTable,
    )

    rows = {}
    for h in HORIZONS_H:
        rows[(FEATURE_POS, "top10", h)] = Stratum(
            n_at_risk=8270, p_sold_lo=73.68, p_sold_hi=80.0,
            pct_withdrawn=6.0, pct_sold_ever=80.07, median_hours=2.0,
        )
    lots = [_lot(50_000, amount=3)]
    lots += [_lot(300_000, amount=1, key=f"2026-08-03T10:{i:02d}:00Z") for i in range(20)]

    row = score_item_lots(
        "art1", "RU", lots, {(4, 15): _variant()}, NOW, survival=SurvivalTable(rows),
    )[0]

    assert row["p_sold_6h"] == 73.68
    assert row["est_sell_hours"] == 2.0
    assert row["profit_per_hour_total"] == pytest.approx(row["profit_total"] / 2.0, abs=0.5)
    assert row["ev_per_hour"] == pytest.approx(
        row["profit_total"] * 0.7368 / 2.0, abs=0.5)
    # Ожидаемая всегда не больше валовой: вероятность не превышает единицы
    assert row["ev_per_hour"] < row["profit_per_hour_total"]


def test_ev_per_hour_is_none_without_probability():
    """
    Без измеренной вероятности величины не существует. Подставлять p = 1
    нельзя — это ровно то умолчание «продастся обязательно», от которого
    уходит P0-3; такие строки уходят в конец выдачи через nulls_last.
    """
    row = score_item_lots("art1", "RU", [_lot(50_000, amount=3)],
                          {(4, 15): _variant()}, NOW)[0]
    assert row["ev_per_hour"] is None
    assert row["profit_per_hour_total"] is not None
