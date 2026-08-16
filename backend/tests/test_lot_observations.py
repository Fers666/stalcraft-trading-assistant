"""
Тесты наблюдений за лотами (P1-4, фаза A — docs/tasks/lot-observations.md).

Проверяются чистые функции: маппинг среза в строки lot_observations и
классификация исхода. К БД и сети тесты не ходят — та же планка, что у
test_feed_scoring.py.

Главное, что здесь защищается, — несмещённость выборки: строка заводится на
КАЖДЫЙ просканированный лот. Если фильтровать по прибыльности (как feed_lots),
кривая дожития фазы B опишет только дешёвые лоты и завысит вероятность продажи.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.analytics.pricing import make_sell_options
from app.tasks.feed_collector import (
    LOT_OBS_EXPIRE_TOLERANCE_MINUTES,
    LOT_OBS_RESOLVE_DELAY_HOURS,
    classify_outcome,
    dedupe_rows,
    observation_rows,
    observation_update_columns,
    resolve_batch,
    resolve_cutoff,
    score_item_lots,
)

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)


def _variant(ref: int | None = 100_000):
    return SimpleNamespace(
        ref_price=ref,
        sell_options=make_sell_options(ref, 70) if ref else None,
        risk="low",
        batch_stats=None,
        volatility_7d=5.0,
        trend_24h="stable",
        trend_24h_pct=1.0,
        trend_7d_pct=-2.0,
        sales_per_day=3.0,
        ref_confidence="high",
        ref_samples=70,
    )


def _lot(price_per_unit: int, amount: int = 1, start: str = "2026-08-16T10:00:00Z", **extra):
    lot = {
        "startTime": start,
        "endTime": (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": price_per_unit * amount,
        "amount": amount,
        "additional": {"qlt": 4, "ptn": 15},
    }
    lot.update(extra)
    return lot


# ─── Запись наблюдений ────────────────────────────────────────────────────────

def test_observation_row_maps_lot():
    rows = observation_rows("art1", "RU", [_lot(50_000, amount=3)], {(4, 15): _variant()}, NOW)
    assert len(rows) == 1
    row = rows[0]

    assert row["item_id"] == "art1" and row["region"] == "RU"
    assert (row["qlt"], row["ptn"]) == (4, 15)
    assert row["lot_key"] == "2026-08-16T10:00:00Z|4|15|150000|3"
    assert row["amount"] == 3
    assert row["buyout_price"] == 150_000 and row["buyout_per_unit"] == 50_000
    assert row["start_time"] == datetime(2026, 8, 16, 10, 0, tzinfo=timezone.utc)
    assert row["end_time"] == NOW + timedelta(hours=24)
    assert row["first_seen_at"] == NOW and row["last_seen_at"] == NOW


def test_observation_rows_include_unprofitable_lots():
    """
    Ключевое требование выборки: наблюдаются ВСЕ лоты, а не только выгодные.
    Тот же лот, который score_item_lots отбрасывает как убыточный, наблюдение
    получает — иначе кривая описывала бы только дешёвые лоты.
    """
    lots = [_lot(200_000)]
    variants = {(4, 15): _variant()}

    assert score_item_lots("art1", "RU", lots, variants, NOW) == []
    assert len(observation_rows("art1", "RU", lots, variants, NOW)) == 1


def test_observation_rows_include_expiring_lot():
    """Лот в последние 2 ч аукциона неликвиден для покупки, но наблюдаем: ровно
    на нём и различаются expired и withdrawn."""
    ends_soon = (NOW + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    lots = [_lot(50_000, endTime=ends_soon)]

    assert score_item_lots("art1", "RU", lots, {(4, 15): _variant()}, NOW) == []
    assert len(observation_rows("art1", "RU", lots, {(4, 15): _variant()}, NOW)) == 1


def test_observation_rows_keep_reference_at_seen():
    """Опора варианта фиксируется в момент наблюдения — задним числом её не будет."""
    rows = observation_rows("art1", "RU", [_lot(50_000)], {(4, 15): _variant(ref=123_456)}, NOW)
    assert rows[0]["ref_price_at_seen"] == 123_456


@pytest.mark.parametrize("variants", [
    {},                          # вариант без сделок вовсе
    {(4, 15): _variant(ref=None)},  # опора ниже пола по данным (P0-2)
    {(4, 10): _variant()},       # чужой вариант не подставляется
])
def test_observation_rows_without_reference(variants):
    """Нет опоры — NULL и строка всё равно пишется, а не падение и не пропуск."""
    rows = observation_rows("art1", "RU", [_lot(50_000)], variants, NOW)
    assert len(rows) == 1
    assert rows[0]["ref_price_at_seen"] is None


@pytest.mark.parametrize("lot", [
    _lot(50_000, startTime=""),   # нет ключа идентичности
    _lot(0),                      # нет цены выкупа — сделку не сматчить
    _lot(50_000, amount=0),
])
def test_observation_rows_skip_unobservable_lots(lot):
    rows = observation_rows("art1", "RU", [lot], {(4, 15): _variant()}, NOW)
    assert rows == []


def test_repeat_observation_updates_only_last_seen():
    """
    Повторная встреча лота обновляет last_seen_at и НЕ трогает first_seen_at
    (иначе теряется момент появления — основа времени дожития), опору на момент
    наблюдения и поля исхода.
    """
    updatable = observation_update_columns()
    assert updatable == {"last_seen_at"}
    assert "first_seen_at" not in updatable
    assert "ref_price_at_seen" not in updatable
    assert not {"outcome", "resolved_at"} & updatable


def test_repeat_observation_does_not_duplicate_row():
    """Один и тот же лот в двух циклах — один ключ апсерта, дубля не будет."""
    lot = _lot(50_000)
    first = observation_rows("art1", "RU", [lot], {(4, 15): _variant()}, NOW)
    second = observation_rows(
        "art1", "RU", [lot], {(4, 15): _variant()}, NOW + timedelta(minutes=5),
    )

    assert first[0]["lot_key"] == second[0]["lot_key"]
    assert len(dedupe_rows(first + second)) == 1
    assert second[0]["last_seen_at"] == NOW + timedelta(minutes=5)


# ─── Состояние стакана на момент первого наблюдения ──────────────────────────

def _by_price(rows: list[dict]) -> dict[int, dict]:
    return {row["buyout_per_unit"]: row for row in rows}


def test_queue_rank_counts_lots_and_units_cheaper():
    """Позиция в очереди по цене и объём, стоящий перед лотом."""
    lots = [_lot(70_000), _lot(30_000, amount=2), _lot(50_000, amount=3)]
    rows = _by_price(observation_rows("art1", "RU", lots, {(4, 15): _variant()}, NOW))

    assert [rows[p]["queue_rank"] for p in (30_000, 50_000, 70_000)] == [1, 2, 3]
    assert [rows[p]["cheaper_units"] for p in (30_000, 50_000, 70_000)] == [0, 2, 5]
    assert {rows[p]["variant_live_lots"] for p in rows} == {3}


def test_queue_is_counted_per_variant_not_per_item():
    """
    Очередь считается по (item_id, qlt, ptn). Агрегат по предмету смешал бы
    разные по цене товары: дорогой лот редкого варианта выглядел бы аутсайдером
    очереди, хотя в своём варианте он первый.
    """
    other_variant = {"qlt": 4, "ptn": 10}
    lots = [
        _lot(10_000, additional=other_variant),
        _lot(20_000, additional=other_variant),
        _lot(50_000),                                   # (4, 15) — единственный
    ]
    rows = _by_price(observation_rows("art1", "RU", lots, {(4, 15): _variant()}, NOW))

    assert rows[50_000]["queue_rank"] == 1              # по предмету был бы 3-м
    assert rows[50_000]["cheaper_units"] == 0
    assert rows[50_000]["variant_live_lots"] == 1
    assert rows[20_000]["queue_rank"] == 2              # своя очередь у (4, 10)


def test_equal_prices_share_the_rank():
    """Одинаковая цена — одинаковая позиция: порядок внутри группы произволен."""
    rows = observation_rows(
        "art1", "RU", [_lot(50_000, start="2026-08-16T10:00:00Z"),
                       _lot(50_000, start="2026-08-16T11:00:00Z")],
        {(4, 15): _variant()}, NOW,
    )
    assert [row["queue_rank"] for row in rows] == [1, 1]
    assert [row["cheaper_units"] for row in rows] == [0, 0]


def test_expiring_lot_is_out_of_queue():
    """
    Лот в последние 2 ч аукциона наблюдается, но очереди покупателю не создаёт:
    у него все три поля NULL (не ноль — «не участвовал» и «первый» разные вещи)
    и в знаменателе он не учитывается.
    """
    ends_soon = (NOW + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    lots = [_lot(30_000, endTime=ends_soon), _lot(50_000)]
    rows = _by_price(observation_rows("art1", "RU", lots, {(4, 15): _variant()}, NOW))

    dying = rows[30_000]
    assert (dying["queue_rank"], dying["cheaper_units"], dying["variant_live_lots"]) == (None,) * 3
    assert rows[50_000]["queue_rank"] == 1
    assert rows[50_000]["variant_live_lots"] == 1


def test_queue_state_is_written_only_on_insert():
    """
    Состояние стакана — снимок условий, в которых лот ВЫСТАВЛЕН. Обновлять его
    на каждом цикле значит записать последнюю позицию вместо начальной и
    потерять предиктор.
    """
    assert not {
        "queue_rank", "cheaper_units", "variant_live_lots",
    } & observation_update_columns()


# ─── Резолвер исходов ─────────────────────────────────────────────────────────

def _obs(
    buyout_price: int = 150_000,
    amount: int = 3,
    first_seen_at: datetime = NOW - timedelta(hours=10),
    last_seen_at: datetime = NOW - timedelta(hours=4),
    end_time: datetime | None = NOW + timedelta(hours=20),
    id: int = 1,
):
    return SimpleNamespace(
        id=id, item_id="art1", region="RU", qlt=4, ptn=15,
        buyout_price=buyout_price, amount=amount,
        first_seen_at=first_seen_at, last_seen_at=last_seen_at, end_time=end_time,
    )


VARIANT = ("art1", "RU", 4, 15)


def test_resolve_delay_is_at_least_two_hours():
    """
    Продажи приезжают часовой дельтой (collect_artifact_history, :15). Меньше
    2 ч — и проданные лоты массово помечаются как withdrawn.
    """
    assert LOT_OBS_RESOLVE_DELAY_HOURS >= 2


def test_resolver_skips_fresh_rows():
    """Строка, виденная час назад, до границы выборки не доживает."""
    cutoff = resolve_cutoff(NOW)
    assert not (NOW - timedelta(hours=1)) < cutoff      # свежая — не берётся
    assert (NOW - timedelta(hours=3)) < cutoff          # отстоявшаяся — берётся


def test_outcome_sold_on_price_amount_and_variant_match():
    obs = _obs()
    sales = [(NOW - timedelta(hours=5), 77, 150_000, 3)]
    assert classify_outcome(obs, sales) == ("sold", 77)


def test_outcome_sold_within_delay_after_last_seen():
    """Продажа могла случиться уже после того, как лот пропал из скана."""
    obs = _obs()
    late = obs.last_seen_at + timedelta(hours=LOT_OBS_RESOLVE_DELAY_HOURS) - timedelta(minutes=1)
    assert classify_outcome(obs, [(late, 77, 150_000, 3)]) == ("sold", 77)


@pytest.mark.parametrize("sale", [
    (NOW - timedelta(hours=5), 77, 149_000, 3),             # другая цена лота
    (NOW - timedelta(hours=5), 77, 150_000, 2),             # другое количество
    (NOW - timedelta(hours=30), 77, 150_000, 3),            # раньше, чем лот появился
    (NOW + timedelta(hours=1), 77, 150_000, 3),             # позже окна наблюдения
])
def test_outcome_not_sold_on_mismatched_sale(sale):
    """Чужая сделка не закрывает лот: иначе доля sold завышена на ровном месте."""
    outcome, sale_id = classify_outcome(_obs(), [sale])
    assert outcome != "sold" and sale_id is None


def test_outcome_expired_when_lot_lived_to_the_end():
    """
    Дожил до конца аукциона и не куплен — ПОЛНОЕ наблюдение «не продался»,
    а не цензурированное.
    """
    obs = _obs(end_time=NOW - timedelta(hours=4, minutes=5))
    assert classify_outcome(obs, []) == ("expired", None)


def test_outcome_expired_within_sweep_tolerance():
    """Последний обход мог пройти чуть раньше end_time — это всё ещё expired."""
    tolerance = timedelta(minutes=LOT_OBS_EXPIRE_TOLERANCE_MINUTES)
    obs = _obs(end_time=NOW - timedelta(hours=4) + tolerance - timedelta(minutes=1))
    assert classify_outcome(obs, []) == ("expired", None)


def test_outcome_withdrawn_when_lot_vanished_before_end():
    """Пропал задолго до end_time без подходящей сделки — цензурированное."""
    assert classify_outcome(_obs(), []) == ("withdrawn", None)


def test_outcome_withdrawn_without_end_time():
    """Без end_time «дожил до конца» не доказать — цензурируем, а не гадаем."""
    assert classify_outcome(_obs(end_time=None), []) == ("withdrawn", None)


def test_sold_wins_over_expired():
    """Порядок проверок из ТЗ §5: сделка сильнее истечения срока."""
    obs = _obs(end_time=NOW - timedelta(hours=4, minutes=5))
    sales = [(NOW - timedelta(hours=5), 77, 150_000, 3)]
    assert classify_outcome(obs, sales) == ("sold", 77)


# ─── Расход сделок: одна сделка закрывает максимум одно наблюдение ────────────

def test_used_sale_is_not_reused():
    """Занятая сделка не годится второй раз — исход считается без неё."""
    sales = [(NOW - timedelta(hours=5), 77, 150_000, 3)]
    assert classify_outcome(_obs(), sales, used_sale_ids={77}) == ("withdrawn", None)


def test_collision_one_sale_closes_exactly_one_observation():
    """
    Два неразличимых наблюдения (тот же вариант, цена лота и количество) и одна
    подходящая сделка: sold ровно одно. Раньше sold получали ОБА, и доля продаж
    была завышенной верхней границей (47.5% строк sold на проде сидели в таких
    группах, худшая — 42 наблюдения на группу).
    """
    older = _obs(id=1, first_seen_at=NOW - timedelta(hours=10))
    newer = _obs(id=2, first_seen_at=NOW - timedelta(hours=6))
    sales = {VARIANT: [(NOW - timedelta(hours=5), 77, 150_000, 3)]}

    outcomes = resolve_batch([older, newer], sales)

    assert outcomes[1] == ("sold", 77)
    assert outcomes[2][0] in ("expired", "withdrawn") and outcomes[2][1] is None
    assert sum(1 for out, _ in outcomes.values() if out == "sold") == 1


def test_match_is_deterministic_regardless_of_input_order():
    """
    Порядок строк из БД (план запроса) не должен влиять на исход: сделка всегда
    достаётся самому старому наблюдению, и всегда самая ранняя подходящая.
    """
    older = _obs(id=1, first_seen_at=NOW - timedelta(hours=10))
    newer = _obs(id=2, first_seen_at=NOW - timedelta(hours=6))
    early = (NOW - timedelta(hours=5), 77, 150_000, 3)
    late  = (NOW - timedelta(hours=3), 88, 150_000, 3)

    straight = resolve_batch([older, newer], {VARIANT: [early, late]})
    shuffled = resolve_batch([newer, older], {VARIANT: [late, early]})

    assert straight == shuffled
    assert straight[1] == ("sold", 77)     # старшему наблюдению — ранняя сделка
    assert straight[2] == ("sold", 88)


def test_resolve_batch_respects_sales_used_by_previous_runs():
    """
    Резолвер идёт порциями: сделка, израсходованная прошлым прогоном
    (matched_sale_id), для нынешней порции занята.
    """
    outcomes = resolve_batch(
        [_obs(id=5)],
        {VARIANT: [(NOW - timedelta(hours=5), 77, 150_000, 3)]},
        used_sale_ids={77},
    )
    assert outcomes[5] == ("withdrawn", None)


def test_sale_of_another_variant_does_not_close_observation():
    """Сделка другого варианта (qlt/ptn) — не про этот лот."""
    outcomes = resolve_batch(
        [_obs(id=5)],
        {("art1", "RU", 4, 10): [(NOW - timedelta(hours=5), 77, 150_000, 3)]},
    )
    assert outcomes[5] == ("withdrawn", None)
