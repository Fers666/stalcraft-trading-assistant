"""
Ценовые тиры sell_options: калибровка по вероятности исполнения (P0-1).

Тир — не «скидка N %», а цена с измеренной долей сделок варианта, проходящих
по ней или выше (docs/tasks/quantile-sell-tiers.md §2): 0.94 / 1.00 / 1.06 при
75 / 50 / 25 %. Множители применяются к каждому сигналу через
evaluate_lot_profit(tier="fast"), поэтому проверяется и то, что вторая ветка
(market_stats с собственным прогнозом времени) даёт РОВНО те же цены: раньше
там жила независимая копия констант.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.analytics.market_stats import _calculate_sell_options
from app.services.analytics.pricing import (
    COMMISSION,
    FAST_RATIO,
    FILL_PROBABILITY,
    NORMAL_RATIO,
    PREMIUM_RATIO,
    evaluate_lot_profit,
    make_sell_options,
)

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)
REF_PRICE = 1_000_000


def _opt(options: list[dict], label: str) -> dict:
    return next(o for o in options if o["label"] == label)


# ─── Калиброванные множители и вероятность исполнения ────────────────────────

def test_sell_options_use_calibrated_ratios():
    opts = make_sell_options(REF_PRICE, volume_7d=70)

    assert [o["label"] for o in opts] == ["fast", "normal", "premium"]
    assert _opt(opts, "fast")["price_per_unit"]    == int(REF_PRICE * 0.94)
    assert _opt(opts, "normal")["price_per_unit"]  == int(REF_PRICE * 1.00)
    assert _opt(opts, "premium")["price_per_unit"] == int(REF_PRICE * 1.06)


def test_sell_options_expose_fill_probability():
    """Смысл тира — доля сделок, проходящих по цене или выше, а не размер скидки."""
    opts = make_sell_options(REF_PRICE, volume_7d=70)

    assert [o["fill_probability"] for o in opts] == [75, 50, 25]


def test_ratios_are_ordered_and_match_probabilities():
    """Дешевле ⇒ исполняется чаще. Защита от перепутанных местами констант."""
    assert FAST_RATIO < NORMAL_RATIO < PREMIUM_RATIO
    assert FILL_PROBABILITY["fast"] > FILL_PROBABILITY["normal"] > FILL_PROBABILITY["premium"]


# ─── market_stats не расходится с pricing ────────────────────────────────────

class _QueueDB:
    """Сессия, отдающая заранее заданные результаты по порядку execute."""

    def __init__(self, *results):
        self._results = list(results)

    async def execute(self, statement):
        result = self._results.pop(0)
        return SimpleNamespace(
            scalar_one_or_none=lambda: result,
            all=lambda: result,
        )


def _matched_sales(count: int):
    """Продажи с восстановленным lot_start — ветка confidence="high"."""
    return [
        SimpleNamespace(
            sale_time=NOW - timedelta(hours=6 + i),
            price_per_unit=REF_PRICE,
            amount=1,
            total_price=REF_PRICE,
            additional_info={
                "lot_start": (NOW - timedelta(hours=12 + i)).isoformat(),
            },
        )
        for i in range(count)
    ]


def test_market_stats_tier_prices_match_pricing():
    """
    Обе ветки обязаны давать одинаковые цены тиров: в market_stats своя только
    оценка времени продажи, а не ценообразование.
    """
    sales = _matched_sales(20)

    options, ref_info = asyncio.run(_calculate_sell_options(
        _QueueDB(SimpleNamespace(
            best_liquid_price_per_unit=REF_PRICE,
            best_price_per_unit=REF_PRICE,
            collect_time=NOW,
        )),
        "art1", "RU", sales, [s.price_per_unit for s in sales],
        {"median": REF_PRICE, "count": len(sales)},
        {"median": REF_PRICE, "count": 4},
        NOW, NOW - timedelta(days=7), NOW - timedelta(days=30),
    ))

    # sanity: попали именно в ветку с собственным прогнозом времени
    assert _opt(options, "fast")["confidence"] == "high"

    expected = make_sell_options(ref_info["ref"], volume_7d=len(sales))
    for label in ("fast", "normal", "premium"):
        assert _opt(options, label)["price_per_unit"] == _opt(expected, label)["price_per_unit"]
        assert _opt(options, label)["net_price_per_unit"] == _opt(expected, label)["net_price_per_unit"]
        assert _opt(options, label)["fill_probability"] == FILL_PROBABILITY[label]


# ─── Влияние на сигналы ──────────────────────────────────────────────────────

def test_lot_profitable_only_at_old_fast_tier_is_rejected():
    """
    Лот между старым (0.97) и новым (0.94) тиром — ровно тот ложный сигнал,
    ради которого делалась калибровка: обещанной цены выхода рынок не даёт.
    """
    opts = make_sell_options(REF_PRICE, volume_7d=70)

    old_fast_net = int(REF_PRICE * 0.97) * (1 - COMMISSION)
    new_fast_net = int(REF_PRICE * FAST_RATIO) * (1 - COMMISSION)
    buyout = int((old_fast_net + new_fast_net) / 2)

    assert new_fast_net < buyout < old_fast_net      # sanity: лот в «вилке»
    assert evaluate_lot_profit(buyout, 1, opts, risk="low") is None


def test_profit_is_still_counted_from_fast_tier():
    """Тир, от которого считается прибыль, калибровкой не менялся."""
    opts = make_sell_options(REF_PRICE, volume_7d=70)
    res = evaluate_lot_profit(800_000, 1, opts, risk="low")

    assert res["tier_used"] == "fast"
    assert res["sell_price_used"] == int(REF_PRICE * FAST_RATIO)
    assert res["ref_used"] == int(REF_PRICE * NORMAL_RATIO)
