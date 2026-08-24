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
    """
    Продажи за последнюю неделю, равномерно по часам.

    Шаг 6 часов: на десяти сделках это даёт эффективный вес 6.4 — выше пола
    MIN_REF_WEIGHT, иначе опора считается недостаточной и сигнала нет
    (это проверяется отдельно, test_no_signal_when_reference_is_below_floor).
    """
    return [
        _sale(now, hours_ago=6 + i * 6, with_lot_start=with_lot_start)
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


def _snap(now: datetime, buyout: int = 50_000):
    """
    Снапшот из одного лота. buyout выбирает, по каким тирам лот выгоден:
    при ref = 100 000 цены тиров выходят 94 000 / 100 000 / 106 000, поэтому
    50 000 — выгоден по fast, 92 000 — только по normal, 98 000 — только по
    premium (проверено в тестах допуска ниже).
    """
    lots = [{
        "startTime": (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "endTime":   (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": buyout,
        "amount": 1,
        "additional": {"qlt": 4, "ptn": 15},
    }]
    return SimpleNamespace(
        raw_lots=lots,
        collect_time=now,
        best_liquid_price_per_unit=buyout,
        best_price_per_unit=buyout,
        median_price_per_unit=buyout,
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


async def _compute(sales, entry, stats=None, buyout: int = 50_000):
    now = datetime.now(timezone.utc)
    return await compute_signals_for_entry(
        _FakeDB(sales), entry, _master(), stats, _snap(now, buyout),
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


# ─── Пол по данным ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_signal_when_reference_is_below_floor():
    """Две сделки за неделю — сигнала «Избранного» быть не должно."""
    now = datetime.now(timezone.utc)
    assert await _compute(_sales(now, count=2), _entry(), _stats()) is None


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


# ─── Допуск в сигнал: только тир fast ─────────────────────────────────────────
#
# Сигнал «Избранного» пускает лот, только если он выгоден по цене fast
# (SIGNAL_TIERS, 2026-08-24). Лента и Радар остались на всех трёх тирах
# (TIER_ORDER) — асимметрия намеренная: там пользователь сам просматривает
# выдачу, а сигнал по своему предмету адресный, и ждать продажи с вероятностью
# 49 % за 6 часов (premium) он не должен.


@pytest.mark.asyncio
@pytest.mark.parametrize("buyout,tier_if_all_tiers", [
    (92_000, "normal"),
    (98_000, "premium"),
])
async def test_signal_admits_fast_tier_only(buyout, tier_if_all_tiers, monkeypatch):
    """
    Лот, выгодный только по normal или только по premium, в сигнал не попадает.

    Проверка двусторонняя: тот же лот при трёх тирах допуска БЫЛ БЫ принят
    именно этим тиром. Без второй половины тест зелёный и на лоте, который
    просто невыгоден, — то есть не сторожил бы сужение.
    """
    import app.services.profitable_lots as profitable_lots
    from app.services.analytics.pricing import TIER_ORDER

    now = datetime.now(timezone.utc)
    entry = _entry(quality_filter=4, enchant_filter=15)

    narrowed = await _compute(_sales(now), entry, _stats(), buyout=buyout)
    assert narrowed["lots"] == []

    monkeypatch.setattr(profitable_lots, "SIGNAL_TIERS", TIER_ORDER)
    widened = await _compute(_sales(now), entry, _stats(), buyout=buyout)
    assert [l["tier_used"] for l in widened["lots"]] == [tier_if_all_tiers]


@pytest.mark.asyncio
async def test_signal_keeps_full_sell_options_when_no_lot_admitted():
    """
    Сужен допуск лотов, а не панель цен: sell_options остаются со всеми тремя
    тирами даже когда допущенных лотов нет. Карточка обязана показывать, за
    сколько предмет продаётся быстро, нормально и дорого.
    """
    now = datetime.now(timezone.utc)
    result = await _compute(_sales(now), _entry(quality_filter=4, enchant_filter=15),
                            _stats(), buyout=98_000)

    assert result["lots"] == []
    assert {o["label"] for o in result["sell_options"]} == {"fast", "normal", "premium"}


@pytest.mark.asyncio
async def test_signal_still_admits_fast_lot():
    """Обратная сторона сужения: выгодный по fast лот проходит и помечен fast."""
    now = datetime.now(timezone.utc)
    result = await _compute(_sales(now), _entry(quality_filter=4, enchant_filter=15),
                            _stats(), buyout=85_000)

    assert [l["tier_used"] for l in result["lots"]] == ["fast"]


def test_narrowing_did_not_leak_into_feed_and_radar():
    """
    Сужение — решение ТОЛЬКО про сигналы «Избранного».

    Свести все три потребителя к одному набору тиров выглядит уборкой («формула
    же общая»), но это молча выключит из ленты и Радара normal/premium, которых
    там большинство: замер прода 2026-08-24 — 1308 premium и 419 normal против
    272 fast. Сторожим именно границу.
    """
    import inspect

    from app.services.analytics.market_radar import _count_profitable_offers
    from app.services.profitable_lots import SIGNAL_TIERS
    from app.tasks.feed_collector import score_item_lots

    assert SIGNAL_TIERS == ("fast",)
    assert "tiers=SIGNAL_TIERS" in inspect.getsource(compute_signals_for_entry)
    assert "tiers=TIER_ORDER" in inspect.getsource(score_item_lots)
    assert "tiers=TIER_ORDER" in inspect.getsource(_count_profitable_offers)
