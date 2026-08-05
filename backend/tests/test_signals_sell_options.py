"""
Прогноз времени продажи в сигналах «Избранного» (compute_signals_for_entry).

Дефект P2-1 QA: ₽/час в Ленте и в карточке «Избранного» расходились до 4 раз
на одном и том же лоте. Прибыль считалась одинаково (ref, breakeven, profit_pct
совпадали) — расходился вход make_sell_options: Лента передавала реальные пары
«часы на рынке → цена», карточка не передавала ничего и получала грубую
эвристику по объёму продаж.

Здесь проверяется, что карточка использует те же пары и даёт тот же прогноз,
что и статистика вариантов Ленты. К БД тесты не ходят: db подменяется заглушкой,
возвращающей заранее заданные строки продаж.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.analytics.pricing import make_sell_options
from app.services.analytics.variant_stats import compute_variant
from app.services.profitable_lots import compute_signals_for_entry

REF_PRICE = 100_000
SELL_HOURS = 6.0        # реальное время на рынке во всех тестовых продажах


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeDB:
    """Заглушка сессии: любой execute отдаёт один и тот же набор продаж."""

    def __init__(self, rows):
        self.rows = rows
        self.calls = 0

    async def execute(self, statement):
        self.calls += 1
        return _FakeResult(self.rows)


def _sale(now: datetime, hours_ago: float, price: int = REF_PRICE, with_lot_start: bool = True):
    sale_time = now - timedelta(hours=hours_ago)
    additional = {"qlt": 4, "ptn": 15}
    if with_lot_start:
        lot_start = sale_time - timedelta(hours=SELL_HOURS)
        additional["lot_start"] = lot_start.isoformat().replace("+00:00", "Z")
    return SimpleNamespace(
        sale_time=sale_time,
        price_per_unit=price,
        amount=1,
        total_price=price,
        additional_info=additional,
    )


def _sales(now: datetime, count: int = 10, with_lot_start: bool = True):
    """Продажи за последнюю неделю, равномерно по часам."""
    return [
        _sale(now, hours_ago=6 + i * 12, with_lot_start=with_lot_start)
        for i in range(count)
    ]


def _entry(quality_filter=None, enchant_filter=None):
    return SimpleNamespace(
        id=1, user_id=1, item_id="art1", region="RU",
        quality_filter=quality_filter, enchant_filter=enchant_filter,
    )


def _master():
    return SimpleNamespace(
        item_id="art1", category="artefact/thermal", color="default",
        name_ru="Артефакт", name_en="Artifact",
    )


def _snap(now: datetime):
    lots = [{
        "startTime": (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "endTime":   (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": 50_000,
        "amount": 1,
        "additional": {"qlt": 4, "ptn": 15},
    }]
    return SimpleNamespace(
        raw_lots=lots,
        collect_time=now,
        best_liquid_price_per_unit=50_000,
        best_price_per_unit=50_000,
        median_price_per_unit=50_000,
    )


def _stats(volume_7d: int = 10):
    return SimpleNamespace(
        sales_volume_7d=volume_7d,
        sales_volume_24h=2,
        reference_price=REF_PRICE,
        median_price_7d=REF_PRICE,
        median_price_24h=REF_PRICE,
        price_volatility_7d=5.0,
        batch_stats=None,
    )


def _fast(sell_options: list[dict]) -> dict:
    return next(o for o in sell_options if o["label"] == "fast")


async def _compute(sales, entry, stats=None):
    now = datetime.now(timezone.utc)
    return await compute_signals_for_entry(
        _FakeDB(sales), entry, _master(), stats, _snap(now),
    )


# ─── Пары попадают в make_sell_options в обеих ветках ─────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("entry", [
    _entry(),                       # без фильтров качества/заточки
    _entry(quality_filter=4, enchant_filter=15),
])
async def test_sell_options_use_real_time_price_pairs(entry):
    """
    Прогноз времени строится по реальным парам «часы на рынке → цена»:
    confidence = medium, fast = 0.4 × среднего времени продажи.
    """
    now = datetime.now(timezone.utc)
    result = await _compute(_sales(now), entry, stats=_stats())

    fast = _fast(result["sell_options"])
    assert fast["confidence"] == "medium"
    assert fast["estimated_hours"] == pytest.approx(round(SELL_HOURS * 0.4, 1))


@pytest.mark.asyncio
async def test_sell_options_differ_from_volume_heuristic():
    """
    Регрессия P2-1: раньше карточка считала время по объёму продаж и на этих же
    данных обещала 8 ч вместо 2.4 ч — отсюда расхождение ₽/час в разы.
    """
    now = datetime.now(timezone.utc)
    result = await _compute(_sales(now), _entry(quality_filter=4, enchant_filter=15), _stats())

    by_volume = _fast(make_sell_options(REF_PRICE, 10))
    assert by_volume["confidence"] == "low"
    assert _fast(result["sell_options"])["estimated_hours"] != by_volume["estimated_hours"]


@pytest.mark.asyncio
async def test_sell_options_fall_back_to_volume_without_coverage():
    """
    Одна продажа с lot_start из тридцати — покрытия нет, эвристика по объёму
    остаётся фоллбеком (правило то же, что в market_stats и variant_stats).
    """
    now = datetime.now(timezone.utc)
    sales = _sales(now, count=29, with_lot_start=False) + [_sale(now, 6)]
    result = await _compute(sales, _entry(quality_filter=4, enchant_filter=15), _stats())

    assert _fast(result["sell_options"])["confidence"] == "low"


# ─── Согласованность с Лентой ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_card_and_feed_agree_on_estimated_hours():
    """
    Критерий приёмки P2-1: на одних и тех же продажах карточка «Избранного» и
    статистика варианта Ленты дают ОДИН прогноз времени продажи.
    """
    now = datetime.now(timezone.utc)
    sales = _sales(now)

    card = await _compute(sales, _entry(quality_filter=4, enchant_filter=15), _stats())
    feed = compute_variant(sales, now)

    assert card["ref"] == feed["ref_price"]
    assert [o["estimated_hours"] for o in card["sell_options"]] == \
           [o["estimated_hours"] for o in feed["sell_options"]]
