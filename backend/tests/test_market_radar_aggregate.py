"""
Полный прогон _calculate_market_radar_aggregate — «Радар рынка».

Регрессия 9fc9953: агрегат читал `stats.volatility_7d`, тогда как
`MarketStatistics` несёт `price_volatility_7d` (`volatility_7d` есть у
artifact_variant_stats и feed_lots, но не у неё). Ветка бакета БЕЗ фильтров
качества/заточки — самая частая — падала AttributeError на первом же бакете,
страница отдавала 500 трое суток.

Функция не была покрыта, потому что «ходит в БД». Здесь она вызывается целиком
поверх FakeSession: ORM-объекты — настоящие модели (у них нет колонок, которых
нет в таблице), строки колоночных выборок несут ровно то, что перечислено в
select(). Тест обязан падать на откате 9fc9953; проверено вручную.

Прогоняются ОБЕ ветки бакета: без фильтров (market_statistics) и с фильтром
(sales_history), плюс порядок выдачи — по ожидаемым рублям убыв.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.models.models import CollectedData, MarketStatistics, MasterItem
from app.services.analytics.market_radar import _calculate_market_radar_aggregate
from tests.fake_db import KEY_COUNT, KEY_TEXT, FakeSession, reset_survival_cache, survival_rows

REF_PRICE = 100_000
NOW = datetime.now(timezone.utc)

# Бакет без фильтров считается по market_statistics, с фильтром — по продажам
# за 7 дней. Продажи дешевле опоры статистики, поэтому ожидаемая прибыль у
# второго бакета заведомо ниже: на этом проверяется порядок выдачи.
SALES_PRICE = 80_000


@pytest.fixture(autouse=True)
def _no_survival_cache():
    """Кэш кривой дожития процессный и живёт 60 с — между тестами не протекает."""
    reset_survival_cache()
    yield
    reset_survival_cache()


def _lot(buyout: int, qlt: int, ptn: int, amount: int = 1) -> dict:
    return {
        "startTime":   (NOW - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "endTime":     (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": buyout,
        "amount":      amount,
        "additional":  {"qlt": qlt, "ptn": ptn},
    }


def _sale(hours_ago: float) -> dict:
    return {
        "sale_time":       NOW - timedelta(hours=hours_ago),
        "price_per_unit":  SALES_PRICE,
        "amount":          1,
        "total_price":     SALES_PRICE,
        "additional_info": {"qlt": 4, "ptn": 15},
    }


def _watchlist(names: tuple[str, ...]):
    """
    К user_watchlist идут два разных запроса — маршрутизируем по колонкам.

    Бакеты агрегата (с счётчиками watcher'ов) и список регионов внутри
    _count_profitable_offers.
    """
    if "watchers_count" in names:
        return [
            # Бакет БЕЗ фильтров — та самая ветка, что падала.
            {"item_id": "art1", "quality_filter": None, "enchant_filter": None,
             "watchers_count": 12, "new_watchers_24h": 3},
            # Бакет С фильтром — ветка по sales_history.
            {"item_id": "art1", "quality_filter": 4, "enchant_filter": 15,
             "watchers_count": 5, "new_watchers_24h": 1},
        ]
    return ["RU"]      # select(UserWatchlist.region).distinct() → scalars


def _db(stats: MarketStatistics | None = None) -> FakeSession:
    return FakeSession({
        KEY_TEXT: survival_rows(),          # sale_survival (load_survival)
        KEY_COUNT: 17,                      # обе сводные метрики — один и тот же счётчик
        "UserWatchlist": _watchlist,
        "MasterItem": [MasterItem(
            item_id="art1", category="artefact/thermal", color="default",
            name_ru="Артефакт", name_en="Artifact", icon_path="art1.png",
        )],
        # Настоящая модель: только на ней видно обращение к несуществующей
        # колонке — SimpleNamespace или MagicMock отдали бы что угодно.
        "MarketStatistics": [stats or MarketStatistics(
            item_id="art1", region="RU", user_id=None,
            avg_price_24h=REF_PRICE, median_price_24h=REF_PRICE,
            sales_volume_24h=14, sales_volume_7d=40,
            reference_price=REF_PRICE, price_volatility_7d=5.0,
            demand_signals={"bulk_spike": True},
        )],
        "SalesHistory": [_sale(6 + i * 6) for i in range(10)],
        "CollectedData": [CollectedData(
            item_id="art1", region="RU", user_id=None, collect_time=NOW,
            raw_lots=[
                _lot(buyout=50_000, qlt=4, ptn=15),
                _lot(buyout=55_000, qlt=2, ptn=0),
            ],
        )],
    })


@pytest.mark.asyncio
async def test_aggregate_computes_both_bucket_branches():
    """
    Прогон целиком. Бакет без фильтров берёт цену/объём/волатильность из
    market_statistics (здесь и был AttributeError), бакет с фильтром — из
    продаж за 7 дней.
    """
    result = await _calculate_market_radar_aggregate(_db())

    by_filter = {x["quality_filter"]: x for x in result["top_items"]}
    assert set(by_filter) == {None, 4}

    plain = by_filter[None]
    assert plain["price_window"] == "24h"
    assert plain["avg_price_24h"] == float(REF_PRICE)
    assert plain["sales_volume_24h"] == 14
    assert plain["bulk_spike"] is True
    assert plain["name_ru"] == "Артефакт"

    filtered = by_filter[4]
    assert filtered["price_window"] == "7d"
    assert filtered["avg_price_24h"] == float(SALES_PRICE)   # медиана продаж
    assert filtered["sales_volume_24h"] == 10                # число сделок за 7д

    # Обе ветки досчитали метрики выгодности: None означало бы, что ориентира
    # цены нет, и обе ветки молча выродились бы в пустую страницу.
    for row in (plain, filtered):
        assert row["profitable_offers_count"] is not None
        assert row["ev_offers_total"] is not None

    assert result["total_active_watchers"] == 17
    assert result["unique_items_tracked"] == 17


@pytest.mark.asyncio
async def test_bucket_without_filters_reads_context_from_market_statistics_row():
    """
    Ветка без фильтров берёт ВЕСЬ контекст цены из строки market_statistics —
    цену, объём, волатильность, demand_signals — и читает их до проверки
    «есть ли ориентир цены». Строка без цен обязана давать метрики None, а не
    выдуманные числа.

    Волатильность отдельным числом не проверить: наружу она не выходит, а её
    единственный потребитель (classify_risk → required_margin) в Радаре
    умножается на min_margin_pct = 0.0, то есть на результат не влияет.
    Поэтому сторож у неё один — падение на чужом имени колонки: у настоящей
    MarketStatistics атрибута volatility_7d нет (9fc9953).
    """
    no_price = MarketStatistics(
        item_id="art1", region="RU", user_id=None,
        avg_price_24h=None, reference_price=None,
        sales_volume_24h=None, price_volatility_7d=42.0,
        demand_signals=None,
    )

    result = await _calculate_market_radar_aggregate(_db(no_price))
    plain = next(x for x in result["top_items"] if x["quality_filter"] is None)

    assert plain["avg_price_24h"] is None
    assert plain["bulk_spike"] is None
    assert plain["profitable_offers_count"] is None
    assert plain["ev_offers_total"] is None
    # Соседний бакет считается по своей ветке и от пустой статистики не страдает.
    filtered = next(x for x in result["top_items"] if x["quality_filter"] == 4)
    assert filtered["ev_offers_total"] is not None


@pytest.mark.asyncio
async def test_aggregate_sorted_by_expected_value_desc():
    """
    Порядок страницы — по ожидаемым рублям убыв., а не по числу выгодных лотов
    и не по watcher'ам (у бакета с фильтром их меньше, но проверяем не это).
    """
    result = await _calculate_market_radar_aggregate(_db())
    ev = [x["ev_offers_total"] or 0 for x in result["top_items"]]

    assert ev == sorted(ev, reverse=True)
    # Опора бакета без фильтров выше (100 000 против медианы продаж 80 000),
    # значит и ожидаемая прибыль его лотов больше — он идёт первым.
    assert result["top_items"][0]["quality_filter"] is None
    assert ev[0] > ev[1] > 0
