"""
Тесты опорной цены (ref) — ядро расчёта выгодности лотов.

Функции чистые, БД не нужна. Опорный кейс — test_yula_falling_market:
плоская медиана 7д даёт цену ~3.5-дневной давности и на падающем рынке
обещает прибыль, которой нет.
"""

import statistics
from datetime import datetime, timedelta, timezone

import pytest

from app.services.analytics.pricing import (
    COMMISSION,
    GLITCH_RATIO,
    MIN_REF_SAMPLES,
    compute_reference,
    evaluate_lot_profit,
    make_sell_options,
    weighted_median,
    weighted_reference,
)

NOW = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)


# ─── weighted_median ──────────────────────────────────────────────────────────

def test_weighted_median_empty():
    assert weighted_median([]) is None


def test_weighted_median_single():
    assert weighted_median([(6_800_000.0, 1.0)]) == 6_800_000.0


@pytest.mark.parametrize("values", [
    [1, 2, 3],
    [1, 2, 3, 4],
    [5, 1, 4, 2, 3],
    [10, 10, 20, 30],
])
def test_weighted_median_uniform_weights_equals_plain_median(values):
    """Одинаковые веса ⇒ взвешенная медиана совпадает с обычной (в т.ч. чётные выборки)."""
    pairs = [(float(v), 1.0) for v in values]
    assert weighted_median(pairs) == pytest.approx(statistics.median(values))


def test_weighted_median_recency_bias():
    """Свежие дешёвые сделки перевешивают старые дорогие."""
    pairs = [(7_000_000.0, 1.0), (7_000_000.0, 1.0), (6_000_000.0, 5.0)]
    assert weighted_median(pairs) == 6_000_000.0


# ─── weighted_reference ───────────────────────────────────────────────────────

def test_weighted_reference_empty():
    assert weighted_reference([], NOW) is None


def test_weighted_reference_skips_nonpositive_prices():
    samples = [(NOW - timedelta(hours=1), 0), (NOW - timedelta(hours=2), -5)]
    assert weighted_reference(samples, NOW) is None


def test_weighted_reference_low_confidence_on_small_sample():
    samples = [(NOW - timedelta(hours=1), 6_000_000)]
    res = weighted_reference(samples, NOW)
    assert res["samples"] == 1
    assert res["confidence"] == "low"
    assert res["ref"] == 6_000_000


def test_weighted_reference_high_confidence():
    samples = [(NOW - timedelta(hours=i), 6_000_000) for i in range(MIN_REF_SAMPLES)]
    assert weighted_reference(samples, NOW)["confidence"] == "high"


def test_weighted_reference_half_life():
    """Сделка возрастом в один период полураспада весит вдвое меньше свежей."""
    samples = [
        (NOW, 6_000_000),
        (NOW - timedelta(hours=48), 7_000_000),
        (NOW - timedelta(hours=48), 7_000_000),
    ]
    # веса: 1.0 / 0.5 / 0.5 → суммарный вес дорогих (1.0) равен весу дешёвой (1.0)
    res = weighted_reference(samples, NOW, half_life_hours=48.0)
    assert res["ref"] == pytest.approx(6_500_000)


def test_weighted_reference_future_sale_time_is_clamped():
    """Рассинхрон часов не должен давать вес > 1."""
    samples = [(NOW + timedelta(hours=5), 6_000_000)]
    assert weighted_reference(samples, NOW)["ref"] == 6_000_000


# ─── compute_reference ────────────────────────────────────────────────────────

def test_compute_reference_no_data():
    assert compute_reference() is None


def test_compute_reference_source_priority():
    assert compute_reference(
        weighted_hist=6_500_000, median_hist=6_800_000, current_min=5_900_000,
    )["source"] == "weighted_history"

    assert compute_reference(
        median_hist=6_800_000, current_min=5_900_000,
    )["source"] == "history"

    assert compute_reference(current_min=5_900_000)["source"] == "current_fallback"


def test_compute_reference_glitch_price_ignored():
    """Глитч-лот за копейки не должен становиться опорной ценой."""
    glitch = int(6_800_000 * GLITCH_RATIO) - 1
    res = compute_reference(median_hist=6_800_000, current_min=glitch)
    assert res["ref"] == 6_800_000

    # без исторического ориентира отбросить глитч не по чему — берём как есть
    assert compute_reference(current_min=glitch)["ref"] == glitch


def test_compute_reference_trend_ignores_thin_24h_sample():
    """
    Одна сделка за сутки — выброс, а не уровень рынка. Регресс: на такой выборке
    метка тренда получалась противоположной реальности (ref падал, бейдж говорил
    «рынок растёт»), а на графике инвертировалась покраска всех точек.
    """
    res = compute_reference(
        weighted_hist=38_999_999,
        median_hist=39_499_990,
        sample_count=95,
        median_24h=44_444_444,   # единственная сделка, верхний выброс
        sample_count_24h=1,
    )
    assert res["trend"] == "unknown"
    assert res["trend_pct"] is None
    assert res["samples_24h"] == 1

    # та же медиана, но подтверждённая выборкой — тренд публикуется
    ok = compute_reference(
        weighted_hist=38_999_999, median_hist=39_499_990, sample_count=95,
        median_24h=44_444_444, sample_count_24h=MIN_REF_SAMPLES,
    )
    assert ok["trend"] == "rising"
    assert ok["trend_pct"] is not None


def test_compute_reference_thin_24h_falls_back_to_asks():
    """Мало сделок за сутки → метка тренда по аскам, но без публикации процента."""
    res = compute_reference(
        weighted_hist=6_500_000, median_hist=6_800_000,
        median_24h=6_400_000, sample_count_24h=1,
        median_now=4_000_000,
    )
    assert res["trend"] == "falling"
    assert res["trend_pct"] is None


def test_compute_reference_trend_from_sales_24h():
    falling = compute_reference(
        weighted_hist=6_500_000, median_hist=6_800_000,
        median_24h=6_400_000, sample_count_24h=10,
    )
    assert falling["trend"] == "falling"
    assert falling["trend_pct"] == pytest.approx(-5.88, abs=0.01)

    stable = compute_reference(
        weighted_hist=6_800_000, median_hist=6_800_000, median_24h=6_750_000, sample_count_24h=10,
    )
    assert stable["trend"] == "stable"

    rising = compute_reference(
        weighted_hist=7_200_000, median_hist=6_800_000, median_24h=7_400_000, sample_count_24h=10,
    )
    assert rising["trend"] == "rising"


def test_compute_reference_trend_does_not_move_ref():
    """Тренд — только метка: ref определяется взвешенной медианой, а не guard'ом."""
    res = compute_reference(
        weighted_hist=6_500_000, median_hist=6_800_000, median_24h=3_000_000, sample_count_24h=10,
    )
    assert res["ref"] == 6_500_000
    assert res["trend"] == "falling"


def test_compute_reference_trend_falls_back_to_asks():
    """Нет сделок за 24ч → тренд по медиане активных лотов, но ref не трогаем."""
    res = compute_reference(
        weighted_hist=6_500_000, median_hist=6_800_000, median_now=4_000_000,
    )
    assert res["ref"] == 6_500_000
    assert res["trend"] == "falling"
    assert res["trend_pct"] is None  # проценты только по реальным сделкам


def test_compute_reference_ref_is_never_none_when_result_is_not():
    """signal_outcomes.ref_price — NOT NULL, контракт должен держаться."""
    for kwargs in (
        {"weighted_hist": 1},
        {"median_hist": 1},
        {"current_min": 1},
    ):
        res = compute_reference(**kwargs)
        assert res is not None and isinstance(res["ref"], int) and res["ref"] > 0


# ─── evaluate_lot_profit ──────────────────────────────────────────────────────

def test_evaluate_lot_profit_breakeven():
    opts = make_sell_options(7_000_000, volume_7d=100)
    res = evaluate_lot_profit(5_950_000, 1, opts, risk="low")
    assert res["breakeven_per_unit"] == int(5_950_000 / (1 - COMMISSION))  # 6 263 157


def test_evaluate_lot_profit_rejects_loss():
    opts = make_sell_options(6_000_000, volume_7d=100)
    assert evaluate_lot_profit(5_950_000, 1, opts, risk="low") is None


# ─── Опорный кейс: «Юла +15», падающий рынок ─────────────────────────────────

def _yula_sales() -> list[tuple[datetime, int]]:
    """
    42 сделки за 7 дней, 6 в сутки.

    Дни 2-6 (старые): рынок стоял на 6.8-7.0 млн.
    Дни 0-1 (свежие): просел до 6.0-6.6 млн.

    Плоская медиана 7д садится в старый уровень (~6.85 млн) — именно она
    и обещала «+316 200 при быстрой продаже» для лота за 5 950 000.
    """
    samples: list[tuple[datetime, int]] = []
    for day in range(7):
        prices = (
            [6_000_000, 6_150_000, 6_300_000, 6_450_000, 6_550_000, 6_600_000]
            if day <= 1
            else [6_800_000, 6_850_000, 6_900_000, 6_900_000, 6_950_000, 7_000_000]
        )
        for i, price in enumerate(prices):
            samples.append((NOW - timedelta(hours=day * 24 + i * 4), price))
    return samples


def test_yula_falling_market():
    samples = _yula_sales()
    prices_7d = [p for _, p in samples]
    median_7d = statistics.median(prices_7d)
    median_24h = statistics.median(
        [p for t, p in samples if t >= NOW - timedelta(hours=24)]
    )

    # sanity: данные воспроизводят наблюдаемую картину
    assert median_7d == pytest.approx(6_850_000)
    assert median_24h < median_7d * 0.95

    wr = weighted_reference(samples, NOW)
    ref_info = compute_reference(
        weighted_hist=wr["ref"],
        median_hist=median_7d,
        sample_count=wr["samples"],
        median_24h=median_24h,
        sample_count_24h=len([p for t, p in samples if t >= NOW - timedelta(hours=24)]),
    )

    # Опорная цена уехала к свежим сделкам, но не схлопнулась в минимум суток
    assert median_24h <= ref_info["ref"] < median_7d
    assert ref_info["trend"] == "falling"
    assert ref_info["source"] == "weighted_history"
    assert ref_info["confidence"] == "high"

    lot_price = 5_950_000
    opts = make_sell_options(ref_info["ref"], volume_7d=len(prices_7d))
    res = evaluate_lot_profit(lot_price, 1, opts, risk="low")

    # Лот остаётся виден (не отсечён), но прибыль честно околонулевая,
    # а не +316 200, которые обещала плоская медиана 7д.
    old_profit = int(median_7d * 0.97 * (1 - COMMISSION)) - lot_price
    assert old_profit > 300_000
    assert res is None or res["profit"] < 150_000

    # Безубыточность — середина реального суточного коридора
    assert int(lot_price / (1 - COMMISSION)) == 6_263_157
