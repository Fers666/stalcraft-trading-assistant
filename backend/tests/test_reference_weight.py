"""
Эффективное число сделок за опорной ценой: market_statistics.reference_weight.

Карточке предмета без фильтров опору отдаёт часовая задача, а не живой расчёт
(запрашивать всю историю на каждый поллинг в 30с дорого). Пока веса не было,
уверенность на этой ветке приходилось оценивать по сырому count за 7д — оценка
завышенная: три сделки трёхдневной давности это ~1 эффективная сделка, а не 3.

Здесь проверяется вся цепочка: market_stats считает вес -> колонка ->
monitoring отдаёт по нему confidence, а на строках, посчитанных до миграции
(NULL), деградирует в "low", а не в завышенную уверенность.

К БД тесты не ходят: db подменяется заглушкой.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.api.v1.endpoints import monitoring as monitoring_module
from app.services.analytics.market_stats import _calculate_sell_options
from app.services.analytics.pricing import (
    MIN_REF_WEIGHT, REF_CONF_HIGH_WEIGHT, weighted_reference,
)

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)
REF_PRICE = 100_000


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


def _stats(**over):
    data = {
        "item_id": "art1", "region": "RU",
        "avg_price_24h": REF_PRICE, "median_price_24h": REF_PRICE,
        "min_price_24h": REF_PRICE, "max_price_24h": REF_PRICE, "sales_volume_24h": 10,
        "avg_price_48h": REF_PRICE, "min_price_48h": REF_PRICE, "max_price_48h": REF_PRICE,
        "sales_volume_48h": 20,
        "avg_price_7d": REF_PRICE, "median_price_7d": REF_PRICE,
        "min_price_7d": REF_PRICE, "max_price_7d": REF_PRICE, "sales_volume_7d": 70,
        "sales_volume_30d": 300,
        "price_volatility_7d": 5.0, "price_volatility_30d": 6.0,
        "best_sell_hour": 20, "best_sell_day": "Пт", "best_buy_hour": 4, "best_buy_day": "Вт",
        "sell_hours_by_day": None, "buy_hours_by_day": None,
        "weekend_bonus_percent": None, "avg_sell_time_hours": 6.0,
        "sell_options": None, "batch_stats": None, "demand_signals": None,
        "reference_price": REF_PRICE, "reference_weight": None,
        "calculated_at": NOW,
    }
    data.update(over)
    return SimpleNamespace(**data)


def _snap():
    return SimpleNamespace(
        best_liquid_price_per_unit=90_000,
        best_price_per_unit=90_000,
        median_price_per_unit=95_000,
        collect_time=NOW,
    )


def _user():
    return SimpleNamespace(
        id=1, tier="advanced_max", is_admin=False,
        favorites_limit_override=None, tier_expires_at=None,
    )


def _card(stats):
    """GET /monitoring/item без фильтров качества/заточки."""
    return asyncio.run(monitoring_module.get_item_stats(
        "art1", region="RU", quality_filter=None, enchant_filter=None,
        db=_QueueDB(stats, _snap()), current_user=_user(),
    ))


# ─── Карточка предмета читает вес из колонки ─────────────────────────────────

def test_card_confidence_comes_from_reference_weight():
    """Уверенность — по эффективному числу сделок, а не по сырому count за 7д."""
    card = _card(_stats(reference_weight=REF_CONF_HIGH_WEIGHT))
    assert card.reference_confidence == "high"

    card = _card(_stats(reference_weight=MIN_REF_WEIGHT))
    assert card.reference_confidence == "medium"

    card = _card(_stats(reference_weight=MIN_REF_WEIGHT - 0.1))
    assert card.reference_confidence == "low"


def test_card_degrades_to_low_when_weight_is_not_calculated_yet():
    """
    Строки, посчитанные до появления колонки: веса нет — честнее показать
    «мало данных», чем выдать уверенность по сырому count (70 сделок за 7д
    сами по себе high не гарантируют).
    """
    card = _card(_stats(reference_weight=None, sales_volume_7d=70))

    assert card.reference_confidence == "low"
    assert card.reference_price == REF_PRICE   # саму опору при этом не теряем


# ─── Вес доезжает из market_stats в карточку ─────────────────────────────────

def _sales(count: int, step_hours: float = 6.0):
    return [
        SimpleNamespace(
            sale_time=NOW - timedelta(hours=6 + i * step_hours),
            price_per_unit=REF_PRICE, amount=1, total_price=REF_PRICE,
            additional_info={},
        )
        for i in range(count)
    ]


def test_market_stats_reference_weight_reaches_the_card():
    """
    Одно и то же число: market_stats кладёт в колонку wr["weight"], карточка
    считает по нему уверенность. Расхождение здесь означало бы, что колонка
    заполняется не тем, что использует потребитель.
    """
    sales = _sales(12)
    cutoff_7d = NOW - timedelta(days=7)
    prices = [s.price_per_unit for s in sales]

    _, ref_info = asyncio.run(_calculate_sell_options(
        _QueueDB(_snap()), "art1", "RU", sales, prices,
        {"median": REF_PRICE, "count": len(sales)},
        {"median": REF_PRICE, "count": 4},
        NOW, cutoff_7d, NOW - timedelta(days=30),
    ))

    expected = weighted_reference([(s.sale_time, s.price_per_unit) for s in sales], NOW)["weight"]
    assert ref_info["weight"] == pytest.approx(round(expected, 2))
    assert ref_info["source"] == "weighted_history"   # условие записи колонки

    card = _card(_stats(reference_weight=ref_info["weight"]))
    assert card.reference_confidence == ref_info["confidence"]
