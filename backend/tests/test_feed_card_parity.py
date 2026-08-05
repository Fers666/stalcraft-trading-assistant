"""
Карточка артефакта «Ленты»: источник статистики и совпадение цифр со строкой
таблицы (дефекты P2-1 и P2-2 повторного QA, docs/tasks/artifact-feed.md).

P2-1: /monitoring/item отдавал 404 на предметах вне «Избранного» (его таблицы
наполняет watchlist-коллектор) — 56 из 66 предметов ленты давали пустую
карточку. Источником стала artifact_variant_stats через GET /feed/variant.

P2-2: карточка считала от sell_options ПРЕДМЕТА без поправки на размер пачки и
с прогнозом времени продажи уровня предмета, из-за чего один и тот же лот давал
+17 486 ₽ в ленте и −1 799 ₽ в карточке. Здесь проверяется, что после перевода
на вариантную статистику обе стороны считают от одного и того же.

К БД и сети тесты не ходят — та же планка, что у остальных тестов ленты.
"""

import ast
import asyncio
import inspect
import textwrap
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import feed as feed_module
from app.services.analytics.pricing import COMMISSION, make_sell_options
from app.tasks.feed_collector import score_item_lots

NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)

# Опора варианта и его реальный прогноз времени продажи: пары «часы -> цена»
# дают fast = 0.4 × среднего (0.3 ч), а не 2 ч «по объёму» уровня предмета.
REF_PRICE = 100_000
TIME_PRICE_PAIRS = [(0.75, REF_PRICE)] * 5
SELL_OPTIONS = make_sell_options(REF_PRICE, 70, TIME_PRICE_PAIRS)

# Пачки 6-10 шт исторически уходят ДОРОЖЕ поштучных: evaluate_lot_profit
# поднимает ожидаемую цену продажи, карточка без этой поправки уходила в минус.
BATCH_STATS = {
    "by_size": {
        "x1":    {"label": "1 шт", "count": 40, "share_pct": 80.0,
                  "avg_price_per_unit": 100_000, "median_price_per_unit": 100_000},
        "x6_10": {"label": "6-10 шт", "count": 10, "share_pct": 20.0,
                  "avg_price_per_unit": 118_000, "median_price_per_unit": 118_000},
    },
    "median_amount": 1,
    "bulk_discount_pct": -18.0,
    "batch_ratio_pct": 20.0,
    "most_popular_bucket": "x1",
    "total_analyzed": 50,
}


def _variant_row(**over):
    """Строка artifact_variant_stats — ровно то, что читает GET /feed/variant."""
    data = {
        "item_id": "art1", "region": "RU", "qlt": 4, "ptn": 15,
        "ref_price": REF_PRICE, "ref_source": "weighted_history",
        "ref_confidence": "high", "ref_samples": 70,
        "median_24h": 99_000, "median_7d": 100_000, "median_30d": 101_000,
        "sales_volume_24h": 10, "sales_volume_7d": 70, "sales_volume_30d": 300,
        "sales_per_day": 10.0, "volatility_7d": 5.0, "risk": "low",
        "trend_24h": "stable", "trend_24h_pct": -1.0, "trend_7d_pct": -1.0,
        "sell_options": SELL_OPTIONS, "batch_stats": BATCH_STATS,
        "avg_sell_time_hours": 0.75, "calculated_at": NOW,
    }
    data.update(over)
    return SimpleNamespace(**data)


def _user(tier: str = "advanced_max", is_admin: bool = False):
    return SimpleNamespace(
        id=1, tier=tier, is_admin=is_admin, favorites_limit_override=None,
        tier_expires_at=None,
    )


class _VariantDB:
    """Сессия, отдающая одну строку варианта: ручка делает ровно один SELECT."""

    def __init__(self, row):
        self.row = row
        self.queries: list[str] = []

    async def execute(self, query):
        self.queries.append(str(query))
        return SimpleNamespace(scalar_one_or_none=lambda: self.row)


def _card(row=None, tier: str = "advanced_max"):
    db = _VariantDB(_variant_row() if row is None else row)
    return asyncio.run(feed_module.feed_variant(
        "art1", qlt=4, ptn=15, region="RU", current_user=_user(tier), db=db,
    )), db


def _lot(price_per_unit: int, amount: int = 1, key: str = "2026-08-03T10:00:00Z"):
    return {
        "startTime": key,
        "endTime": (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": price_per_unit * amount,
        "amount": amount,
        "additional": {"qlt": 4, "ptn": 15},
    }


def _feed_row(price_per_unit: int, amount: int, **variant_over):
    """Строка ленты по тому же варианту, что отдаёт карточке /feed/variant."""
    rows = score_item_lots(
        "art1", "RU", [_lot(price_per_unit, amount)],
        {(4, 15): _variant_row(**variant_over)}, NOW,
    )
    assert rows, "лот должен попасть в ленту — иначе тест сравнивает не то"
    return rows[0]


# ─── P2-1: карточка предмета ВНЕ «Избранного» не пустая ───────────────────────

def test_card_is_filled_for_item_outside_watchlist():
    """
    Критерий приёмки ТЗ (§882): «Модалка на предмете, которого нет в
    «Избранном»: метрики и графики заполнены». Данные берутся из
    artifact_variant_stats, которая есть по каждому предмету, что собирает
    лента, — ни MarketStatistics, ни CollectedData не нужны.
    """
    card, db = _card()

    assert card.median_price_7d == 100_000
    assert card.median_price_24h == 99_000
    assert card.sales_volume_7d == 70 and card.sales_volume_30d == 300
    assert card.reference_price == REF_PRICE
    assert card.reference_confidence == "high"
    assert card.price_volatility_7d == 5.0 and card.risk_level == "low"
    assert card.sell_options == SELL_OPTIONS
    assert card.batch_stats == BATCH_STATS
    assert card.avg_sell_time_hours == 0.75
    assert card.calculated_at == NOW
    # Одна строка по уникальному индексу uq_artifact_variant — и ничего больше
    assert len(db.queries) == 1


def test_card_source_is_the_variant_table_only():
    """
    Карточка ленты не должна зависеть от таблиц watchlist-коллектора: именно эта
    зависимость давала 404 на 85% предметов ленты.
    """
    # По именам в коде, а не по тексту: в комментариях эти таблицы упоминаются.
    tree = ast.parse(textwrap.dedent(inspect.getsource(feed_module.feed_variant)))
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}

    assert "ArtifactVariantStats" in names
    assert not names & {"MarketStatistics", "CollectedData"}


def test_card_has_no_tier_gate():
    """Витрину лимитированного тарифа можно открыть карточкой — 403 тут неуместен."""
    assert "_require_access" not in inspect.getsource(feed_module.feed_variant)


def test_card_windows_are_masked_by_tier():
    """
    Тарифные окна статистики режутся тем же _mask_stats_windows, что и в
    /monitoring/item: отдельной модели доступа у ленты не появляется.
    """
    card, _ = _card(tier="base")          # base: только 24ч
    assert card.median_price_24h == 99_000
    assert card.median_price_7d is None
    assert card.sell_options is None
    assert card.reference_price is None
    assert card.sales_volume_30d is None


def test_card_404_when_variant_has_no_stats():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(feed_module.feed_variant(
            "art1", qlt=4, ptn=15, region="RU", current_user=_user(), db=_VariantDB(None),
        ))
    assert exc.value.status_code == 404


# ─── P2-2: цифры карточки и строки ленты совпадают ───────────────────────────

def test_sell_hours_are_taken_from_the_same_variant():
    """
    Прогноз времени продажи считался на двух уровнях сразу: 0.3 ч (вариант) в
    ленте против 2.0 ч (предмет) в карточке — разрыв в 6.7 раза. Источник
    теперь один.
    """
    card, _ = _card()
    row = _feed_row(105_000, amount=7)
    fast = next(o for o in card.sell_options if o["label"] == "fast")

    assert row["est_sell_hours"] == fast["estimated_hours"] == 0.3


def test_card_profit_matches_feed_row_for_batch_lot():
    """
    Тот самый лот QA (×7): в ленте +17 486 ₽, в карточке −1 799 ₽. Причина —
    поправка на размер пачки (evaluate_lot_profit + batch_stats), которой в
    карточке не было. Карточка восстанавливает множитель из sell_price_used
    строки, второй формулы не заводя.
    """
    amount, buy_per_unit = 7, 105_000
    card, _ = _card()
    row = _feed_row(buy_per_unit, amount=amount)
    fast_price = next(o for o in card.sell_options if o["label"] == "fast")["price_per_unit"]

    # Как считала карточка ДО фикса — от цены тира без поправки на пачку
    naive_total = round((fast_price * (1 - COMMISSION) - buy_per_unit) * amount)
    assert naive_total < 0 < row["profit_total"], "тест обязан воспроизводить смену знака"

    # Как считает сейчас: множитель = sell_price_used / цена тира «Быстро»
    factor = row["sell_price_used"] / fast_price
    per_unit = round(fast_price * factor * (1 - COMMISSION) - buy_per_unit)

    assert per_unit == pytest.approx(row["profit_per_unit"], abs=1)
    assert per_unit * amount == pytest.approx(row["profit_total"], abs=amount)


def test_single_unit_lot_needs_no_batch_correction():
    """У лота из одной штуки поправки нет: множитель обязан быть ровно 1."""
    card, _ = _card()
    row = _feed_row(90_000, amount=1)
    fast_price = next(o for o in card.sell_options if o["label"] == "fast")["price_per_unit"]

    assert row["sell_price_used"] == fast_price
    assert round(fast_price * (1 - COMMISSION) - 90_000) == pytest.approx(
        row["profit_per_unit"], abs=1,
    )


def test_reference_price_of_card_and_row_is_the_same():
    """Опорная цена строки ленты — та же, что показывает карточка."""
    card, _ = _card()
    assert _feed_row(90_000, amount=1)["ref_price"] == card.reference_price
