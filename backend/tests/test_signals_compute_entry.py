"""
Полный прогон compute_signals_for_entry — сигналы «Избранного».

Регрессия 50ea7dc: выборка sales_30d брала только sale_time / price_per_unit /
additional_info, а `_calculate_batch_stats` (её зовёт вариантная ветка) читает
`s.amount`. Падала КАЖДАЯ watchlist-запись — «_publish_signals: entry user=1
qodk/RU: amount». Сигналы не писались, ключи signals:* разошлись по TTL, и
«Избранное» осталось без выгодных лотов примерно на 12 минут.

Функция не была покрыта, потому что «ходит в БД». В БД она ходит ровно за
формой строки, поэтому здесь она вызывается целиком поверх FakeSession: строки
несут ровно те колонки, что перечислены в select(...), а stats/snap — настоящие
ORM-объекты. Тест обязан падать на откате 50ea7dc; проверено вручную (строки
теряют amount → AttributeError в _calculate_batch_stats).
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.models.models import CollectedData, MarketStatistics, MasterItem
from app.services.profitable_lots import (
    NOTIFY_TIERS, SIGNAL_TIERS, compute_signals_for_entry, notifiable_lots,
)
from tests.fake_db import FakeSession, load_fake_survival

REF_PRICE = 100_000
SELL_HOURS = 6.0        # время на рынке во всех тестовых продажах


def _sale(now: datetime, hours_ago: float, amount: int = 1) -> dict:
    """
    Продажа как СТРОКА ТАБЛИЦЫ: со всеми полями, а не только выбранными.

    Какие из них попадут в Row, решает select() внутри compute_signals_for_entry —
    в этом весь смысл проверки.
    """
    sale_time = now - timedelta(hours=hours_ago)
    lot_start = sale_time - timedelta(hours=SELL_HOURS)
    return {
        "sale_time":       sale_time,
        "price_per_unit":  REF_PRICE,
        "amount":          amount,
        "total_price":     REF_PRICE * amount,
        "additional_info": {
            "qlt": 4, "ptn": 15,
            "lot_start": lot_start.isoformat().replace("+00:00", "Z"),
        },
    }


def _sales(now: datetime, count: int = 10, batch_every: int = 0) -> list[dict]:
    """
    Продажи одного варианта (4, 15) с шагом 6 часов: эффективный вес 6.4 — выше
    пола MIN_REF_WEIGHT, иначе опоры нет и сигнала тоже.

    batch_every=N — каждая N-я продажа пачкой (amount > 1). Нужно для
    `_calculate_batch_stats`: при доле пачек ниже 10 % она возвращает None.
    """
    return [
        _sale(now, hours_ago=6 + i * 6,
              amount=5 if batch_every and i % batch_every == 0 else 1)
        for i in range(count)
    ]


def _lot(now: datetime, buyout: int, qlt: int, ptn: int, amount: int = 1) -> dict:
    return {
        "startTime":   (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "endTime":     (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": buyout,
        "amount":      amount,
        "additional":  {"qlt": qlt, "ptn": ptn},
    }


def _snap(now: datetime, lots: list[dict]) -> CollectedData:
    # Настоящая модель, а не заглушка: обращение к несуществующей колонке
    # снэпшота должно падать в тесте так же, как на проде.
    return CollectedData(
        item_id="art1", region="RU", user_id=None,
        collect_time=now, raw_lots=lots,
        best_price_per_unit=min(l["buyoutPrice"] for l in lots),
        best_liquid_price_per_unit=min(l["buyoutPrice"] for l in lots),
        median_price_per_unit=min(l["buyoutPrice"] for l in lots),
    )


def _stats() -> MarketStatistics:
    return MarketStatistics(
        item_id="art1", region="RU", user_id=None,
        sales_volume_7d=10, sales_volume_24h=2,
        reference_price=REF_PRICE, median_price_7d=REF_PRICE,
        median_price_24h=REF_PRICE, price_volatility_7d=5.0,
        batch_stats=None,
    )


def _master() -> MasterItem:
    return MasterItem(
        item_id="art1", category="artefact/thermal", color="default",
        name_ru="Артефакт", name_en="Artifact",
    )


def _entry():
    return SimpleNamespace(
        id=1, user_id=1, item_id="art1", region="RU",
        quality_filter=None, enchant_filter=None,
    )


async def _compute(sales: list[dict], lots: list[dict], now: datetime):
    db = FakeSession({"SalesHistory": sales})
    signal = await compute_signals_for_entry(
        db, _entry(), _master(), _stats(), _snap(now, lots),
        survival=await load_fake_survival(),
    )
    return db, signal


@pytest.mark.asyncio
async def test_signal_lots_reference_their_own_variant():
    """
    Прогон целиком: лоты есть, каждый несёт ссылку на вариант, уровень опоры,
    ожидаемую прибыль и тир.
    """
    now = datetime.now(timezone.utc)
    lots = [
        _lot(now, buyout=50_000, qlt=4, ptn=15),   # вариант со своими продажами
        _lot(now, buyout=60_000, qlt=2, ptn=0),    # вариант без продаж → опора предмета
    ]
    db, signal = await _compute(_sales(now), lots, now)

    assert signal is not None
    assert len(signal["lots"]) == 2

    for lot in signal["lots"]:
        assert lot["variant_key"]
        assert lot["ref_scope"] in ("variant", "item")
        assert lot["ev_profit"] is not None
        # Допуск сигнала — только fast (SIGNAL_TIERS), см. profitable_lots.
        assert lot["tier_used"] in SIGNAL_TIERS

    by_key = {lot["variant_key"]: lot for lot in signal["lots"]}
    assert by_key["4:15"]["ref_scope"] == "variant"   # свои продажи
    assert by_key["2:0"]["ref_scope"] == "item"       # фоллбек на опору предмета

    # Карта вариантов содержит ровно те ключи, на которые ссылаются лоты: лишние
    # записи уезжали в Redis мёртвым грузом (44 КБ на ключ), недостающие оставили
    # бы потребителя без опоры, которой посчитан лот.
    assert set(signal["variants"]) == set(by_key)

    # Ранжирование — по ожидаемым рублям убыв.
    ev = [lot["ev_profit"] for lot in signal["lots"]]
    assert ev == sorted(ev, reverse=True)

    # Запрос к продажам был ровно один: 7д и 30д считаются из одной выборки.
    assert [key for key, _ in db.executed] == ["SalesHistory"]


@pytest.mark.asyncio
async def test_notification_gate_applied_to_computed_signal():
    """
    Гейт уведомлений на РЕАЛЬНО посчитанном сигнале, а не на словарях руками.

    Будим только по лоту, посчитанному своей опорой варианта: лот на предметном
    фоллбеке (ref_scope="item") остаётся виден в карточке, но телефон не будит —
    предметная опора смешивает разнородный товар и завышает прибыль
    (замер 2026-08-22, 384f143).
    """
    now = datetime.now(timezone.utc)
    lots = [
        _lot(now, buyout=50_000, qlt=4, ptn=15),
        _lot(now, buyout=60_000, qlt=2, ptn=0),
    ]
    _, signal = await _compute(_sales(now), lots, now)

    notifiable = notifiable_lots(signal["lots"])
    assert [lot["variant_key"] for lot in notifiable] == ["4:15"]
    assert {lot["tier_used"] for lot in notifiable} <= set(NOTIFY_TIERS)


@pytest.mark.asyncio
async def test_signal_computes_batch_stats_of_variant():
    """
    Путь, на котором прод и упал: продажи пачками (amount > 1) заставляют
    `_calculate_batch_stats` читать `s.amount` у каждой строки выборки.

    Если select перестанет выбирать amount, строка Row его не понесёт и вызов
    упадёт AttributeError — как 2026-08-22 на каждой watchlist-записи.
    """
    now = datetime.now(timezone.utc)
    sales = _sales(now, batch_every=2)          # половина продаж пачками по 5
    lots = [_lot(now, buyout=50_000, qlt=4, ptn=15, amount=10)]

    _, signal = await _compute(sales, lots, now)

    assert signal is not None
    batch_stats = signal["variants"]["4:15"]["batch_stats"]
    assert batch_stats is not None, "статистика пачек варианта не посчиталась"
    assert batch_stats["by_size"]["x2_5"]["count"] == len(
        [s for s in sales if s["amount"] == 5]
    )
    assert signal["lots"][0]["amount"] == 10
