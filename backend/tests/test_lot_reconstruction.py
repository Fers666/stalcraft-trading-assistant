"""
Тесты восстановления жизни лотов из снапшотов
(docs/tasks/history-lot-reconstruction.md, критерии §5.1).

К БД и сети не ходят: восстановитель — чистый автомат над потоком срезов,
исход считает тот же resolve_batch, что и живой резолвер. Отдельно
проверяется, что дыра в сборе даёт ЦЕНЗУРИРОВАНИЕ, а не «снят»: это главный
способ получить фальшивую статистику снятий на ровном месте.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.scripts.reconstruct_lot_history import (
    STATE_GAP,
    STATE_OPEN,
    STATE_RESOLVABLE,
    LotHistoryReconstructor,
    classify_rows,
    upsert_statement,
)

NOW = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)
MAX_GAP = timedelta(minutes=15)
VARIANT = ("art1", "RU", 4, 15)


def _lot(price_per_unit: int, amount: int = 1, start: str = "2026-08-16T09:00:00Z", **extra):
    lot = {
        "startTime": start,
        "endTime": (NOW + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
        "buyoutPrice": price_per_unit * amount,
        "amount": amount,
        "additional": {"qlt": 4, "ptn": 15},
    }
    lot.update(extra)
    return lot


def _reconstruct(snapshots, max_gap=MAX_GAP, sales=None, resolved_at=NOW):
    """Прогоняет срезы через восстановитель и считает исходы, как это делает скрипт."""
    worker = LotHistoryReconstructor("art1", "RU", max_gap)
    for collect_time, lots in snapshots:
        worker.push(collect_time, lots)
    worker.close()

    rows = worker.rows
    stats = classify_rows(rows, sales or {}, set(), resolved_at)
    return worker, {row["lot_key"]: row for row in rows}, stats


def _at(minutes: int) -> datetime:
    return NOW + timedelta(minutes=minutes)


# ─── Появление и исчезновение ────────────────────────────────────────────────

def test_lot_lifetime_between_two_snapshots():
    """Границы наблюдения: первый срез, где лот есть, и последний, где он ещё есть."""
    lot = _lot(50_000)
    worker, rows, _ = _reconstruct([
        (_at(0), []),
        (_at(2), [lot]),
        (_at(4), [lot]),
        (_at(6), []),
    ])

    row = next(iter(rows.values()))
    assert row["first_seen_at"] == _at(2)
    assert row["last_seen_at"] == _at(4)
    assert row["_state"] == STATE_RESOLVABLE
    assert worker.report.lots == 1


def test_lot_seen_once_is_still_an_observation():
    """Лот, попавший ровно в один срез, — полноценное наблюдение нулевой длины."""
    _, rows, _ = _reconstruct([(_at(0), [_lot(50_000)]), (_at(2), [])])
    row = next(iter(rows.values()))
    assert row["first_seen_at"] == row["last_seen_at"] == _at(0)


def test_lot_in_last_snapshot_is_censored_administratively():
    """Дожил до конца окна — outcome NULL, а не «снят» (§2.1.4 ТЗ)."""
    worker, rows, stats = _reconstruct([(_at(0), [_lot(50_000)]), (_at(2), [_lot(50_000)])])

    row = next(iter(rows.values()))
    assert row["_state"] == STATE_OPEN
    assert row["outcome"] is None
    assert stats["censored"] == 1 and worker.report.censored_admin == 1


def test_reconstruction_does_not_restore_reference_price():
    """ref_price_at_seen задним числом не восстановим — только NULL (§2.4 ТЗ)."""
    _, rows, _ = _reconstruct([(_at(0), [_lot(50_000)]), (_at(2), [])])
    assert next(iter(rows.values()))["ref_price_at_seen"] is None


def test_rows_are_marked_as_snapshot_source():
    """Пометка происхождения обязательна: у источников разные смещения (§2.3 ТЗ)."""
    _, rows, _ = _reconstruct([(_at(0), [_lot(50_000)]), (_at(2), [])])
    assert next(iter(rows.values()))["source"] == "snapshot"


# ─── Дыры в сборе (§4.3 ТЗ) ──────────────────────────────────────────────────

def test_gap_larger_than_max_gap_censors_instead_of_withdrawing():
    """
    Пауза в сборе (рестарт, 429, парковка) — не исчезновение лота. Иначе каждая
    пауза давала бы пачку фальшивых «снятий», а доля withdrawn описывала бы
    надёжность инфраструктуры, а не поведение продавцов.
    """
    worker, rows, stats = _reconstruct([
        (_at(0), [_lot(50_000)]),
        (_at(40), []),          # 40 минут тишины — лот пропал не на наших глазах
    ])

    row = next(iter(rows.values()))
    assert row["_state"] == STATE_GAP
    assert row["outcome"] is None
    assert worker.report.censored_gap == 1 and worker.report.gaps == 1
    assert stats["censored"] == 1


def test_disappearance_within_max_gap_is_a_real_outcome():
    """Тот же сценарий с нормальным шагом обхода закрывается как withdrawn."""
    _, rows, stats = _reconstruct([
        (_at(0), [_lot(50_000)]),
        (_at(2), []),
    ])
    assert next(iter(rows.values()))["outcome"] == "withdrawn"
    assert stats["withdrawn"] == 1


def test_censored_by_gap_lot_does_not_consume_a_sale():
    """
    Цензурированное наблюдение сделок не расходует: его судьба неизвестна, а
    занятая им сделка не досталась бы тому, чья судьба известна.
    """
    censored = _lot(50_000, start="2026-08-16T09:00:00Z")
    normal   = _lot(50_000, start="2026-08-16T09:30:00Z")
    sales = {VARIANT: [(_at(45), 77, 50_000, 1)]}

    _, rows, stats = _reconstruct([
        (_at(0),  [censored]),
        (_at(40), [normal]),        # дыра: censored цензурирован, normal появился
        (_at(42), []),              # normal исчез штатно
    ], sales=sales)

    assert rows[censored["startTime"] + "|4|15|50000|1"]["outcome"] is None
    assert rows[normal["startTime"] + "|4|15|50000|1"] ["outcome"] == "sold"
    assert stats["sold"] == 1


def test_lot_returning_after_a_miss_is_the_same_observation():
    """
    Пропуск лота одним срезом — не смерть и не второй лот: наблюдение
    продолжается, first_seen_at сохраняется, ложное цензурирование снимается.
    """
    lot = _lot(50_000)
    worker, rows, _ = _reconstruct([
        (_at(0),  [lot]),
        (_at(40), []),          # дыра + пропажа -> цензурирование
        (_at(42), [lot]),       # лот на месте: исчезновения не было
        (_at(44), [lot]),
    ])

    assert len(rows) == 1
    row = next(iter(rows.values()))
    assert row["first_seen_at"] == _at(0) and row["last_seen_at"] == _at(44)
    assert worker.report.resurrected == 1
    assert worker.report.censored_gap == 0


# ─── Неполные срезы: сбой пагинации сбора ────────────────────────────────────

def _stack(size: int, start_minute: int = 0) -> list:
    """Стакан из size различимых лотов одного варианта."""
    return [
        _lot(10_000 + i, start=f"2026-08-16T09:{(start_minute + i) % 60:02d}:{i % 60:02d}Z")
        for i in range(size)
    ]


def test_partial_snapshot_is_skipped_not_treated_as_mass_disappearance():
    """
    Замер на стенде (jkq7, 2026-07-17 18:36): 102 -> 50 -> 102 лота за две
    минуты — сбоит пагинация /lots, и в базу ложится подмножество рынка.
    Принять такой срез значит закрыть половину стакана как «снятые».
    """
    full = _stack(40)
    worker, rows, _ = _reconstruct([
        (_at(0), full),
        (_at(1), full[:15]),        # неполный ответ сбора
        (_at(2), full),
        (_at(3), full),
    ])

    assert worker.report.partial_skipped == 1
    assert worker.report.snapshots == 3
    assert worker.report.resurrected == 0
    assert all(row["_state"] == STATE_OPEN for row in rows.values())
    assert all(row["last_seen_at"] == _at(3) for row in rows.values())


def test_real_market_drop_is_accepted_after_it_repeats():
    """
    Настоящий обвал стакана от сбоя отличается повторением: если следующий срез
    такой же маленький, он принимается как новая норма — теряется ровно одна
    точка обхода, а не предмет целиком.
    """
    full = _stack(40)
    worker, _, _ = _reconstruct([
        (_at(0), full),
        (_at(1), full[:15]),
        (_at(2), full[:15]),
        (_at(3), full[:15]),
    ])

    assert worker.report.partial_skipped == 1
    assert worker.report.snapshots == 3


def test_small_stack_drop_is_not_treated_as_defect():
    """На мелком стакане перепад в треть — обычная торговля, а не сбой сбора."""
    lots = _stack(6)
    worker, _, _ = _reconstruct([(_at(0), lots), (_at(1), lots[:2]), (_at(2), lots)])
    assert worker.report.partial_skipped == 0


def test_stack_change_after_a_long_gap_is_not_a_defect():
    """После дыры в сборе стакан имеет право стать другим — решает MAX_GAP."""
    full = _stack(40)
    worker, _, _ = _reconstruct([(_at(0), full), (_at(60), full[:10])])
    assert worker.report.partial_skipped == 0
    assert worker.report.gaps == 1


# ─── Левое усечение (§4.2 ТЗ) ────────────────────────────────────────────────

def test_left_truncated_lot_is_counted():
    """Лот, висевший до начала окна, входит в выборку в середине жизни."""
    worker, _, _ = _reconstruct([
        (_at(0), [_lot(50_000, start="2026-08-16T09:00:00Z")]),   # выставлен 3 ч назад
        (_at(2), []),
    ])
    assert worker.report.left_truncated == 1


def test_lot_appeared_within_the_sweep_step_is_not_left_truncated():
    fresh = (NOW + timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    worker, _, _ = _reconstruct([
        (_at(0), []),
        (_at(2), [_lot(50_000, start=fresh)]),
        (_at(4), []),
    ])
    assert worker.report.left_truncated == 0


# ─── Состояние стакана (§5.1 ТЗ) ─────────────────────────────────────────────

def test_queue_rank_is_counted_per_variant():
    """
    Очередь считается по (item_id, qlt, ptn). Агрегат по предмету смешал бы
    разные по цене товары — дорогой лот редкого варианта выглядел бы
    аутсайдером, будучи первым в своём.
    """
    other = {"qlt": 4, "ptn": 10}
    _, rows, _ = _reconstruct([
        (_at(0), [
            _lot(10_000, additional=other, start="2026-08-16T09:00:00Z"),
            _lot(20_000, additional=other, start="2026-08-16T09:01:00Z"),
            _lot(50_000, start="2026-08-16T09:02:00Z"),
        ]),
        (_at(2), []),
    ])

    by_price = {row["buyout_per_unit"]: row for row in rows.values()}
    assert by_price[50_000]["queue_rank"] == 1              # по предмету был бы 3-м
    assert by_price[50_000]["variant_live_lots"] == 1
    assert by_price[20_000]["queue_rank"] == 2


def test_queue_state_is_taken_from_the_first_snapshot():
    """Стакан — снимок условий, в которых лот выставлен, а не последних."""
    watched = _lot(50_000, start="2026-08-16T09:00:00Z")
    cheaper = _lot(10_000, start="2026-08-16T09:30:00Z")

    _, rows, _ = _reconstruct([
        (_at(0), [watched]),               # один в очереди
        (_at(2), [watched, cheaper]),      # появился дешёвый — позиция не переписывается
        (_at(4), []),
    ])
    assert rows["2026-08-16T09:00:00Z|4|15|50000|1"]["queue_rank"] == 1
    assert rows["2026-08-16T09:00:00Z|4|15|50000|1"]["variant_live_lots"] == 1


# ─── Расход сделок (§2.2 ТЗ) ─────────────────────────────────────────────────

def test_one_sale_closes_exactly_one_observation():
    """
    Два неразличимых по цене и количеству лота, одна подходящая сделка: sold
    получает ровно один. Без расхода сделок одна продажа помечала sold всю
    группу — ровно этот баг чинили в живом резолвере.
    """
    first  = _lot(50_000, start="2026-08-16T09:00:00Z")
    second = _lot(50_000, start="2026-08-16T09:30:00Z")

    _, rows, stats = _reconstruct([
        (_at(0), [first, second]),
        (_at(2), []),
    ], sales={VARIANT: [(_at(1), 77, 50_000, 1)]})

    assert stats["sold"] == 1
    assert rows["2026-08-16T09:00:00Z|4|15|50000|1"]["outcome"] == "sold"     # старейшему
    assert rows["2026-08-16T09:00:00Z|4|15|50000|1"]["matched_sale_id"] == 77
    assert rows["2026-08-16T09:30:00Z|4|15|50000|1"]["matched_sale_id"] is None


def test_sale_distribution_is_deterministic_regardless_of_lot_order():
    """
    Порядок лотов внутри среза (raw_lots отсортирован по цене) не должен
    влиять на раздачу: сделка всегда достаётся самому старому наблюдению.
    """
    first  = _lot(50_000, start="2026-08-16T09:00:00Z")
    second = _lot(50_000, start="2026-08-16T09:30:00Z")
    sales = {VARIANT: [(_at(1), 77, 50_000, 1)]}

    _, straight, _ = _reconstruct([(_at(0), [first, second]), (_at(2), [])], sales=sales)
    _, shuffled, _ = _reconstruct([(_at(0), [second, first]), (_at(2), [])], sales=sales)

    assert {key: row["outcome"] for key, row in straight.items()} == \
           {key: row["outcome"] for key, row in shuffled.items()}
    assert straight["2026-08-16T09:00:00Z|4|15|50000|1"]["outcome"] == "sold"


def test_expired_lot_is_a_complete_observation():
    """Дожил до конца аукциона и не куплен — «не продался», а не цензурирование."""
    ended = (NOW - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    _, rows, stats = _reconstruct([
        (_at(-4), [_lot(50_000, endTime=ended)]),
        (_at(-2), []),
    ])
    assert next(iter(rows.values()))["outcome"] == "expired"
    assert stats["expired"] == 1


# ─── Идемпотентность (§3 ТЗ) ─────────────────────────────────────────────────

def test_repeated_reconstruction_is_stable():
    """Повторный прогон на том же окне даёт те же строки и те же границы."""
    snapshots = [
        (_at(0), [_lot(50_000)]),
        (_at(2), [_lot(50_000), _lot(30_000, start="2026-08-16T09:30:00Z")]),
        (_at(4), [_lot(30_000, start="2026-08-16T09:30:00Z")]),
    ]
    _, first, _ = _reconstruct(snapshots)
    _, second, _ = _reconstruct(snapshots)

    assert first.keys() == second.keys()
    assert {key: row["first_seen_at"] for key, row in first.items()} == \
           {key: row["first_seen_at"] for key, row in second.items()}


def test_upsert_never_moves_first_seen_at_forward():
    """
    Апсерт хранит САМЫЙ РАННИЙ момент появления: прогон на более узком окне не
    должен состарить лот задним числом. Плюс сделка не переезжает внутри одного
    оператора (matched_sale_id обнуляется и проставляется отдельным UPDATE) —
    иначе уникальный индекс падает на перестановке.
    """
    from sqlalchemy.dialects import postgresql

    _, rows, _ = _reconstruct([(_at(0), [_lot(50_000)]), (_at(2), [])])
    sql = str(upsert_statement(list(rows.values())).compile(dialect=postgresql.dialect()))

    assert "ON CONFLICT (source, item_id, region, lot_key)" in sql
    assert "first_seen_at = least(" in sql
    assert "first_seen_at = excluded.first_seen_at" not in sql
    assert "matched_sale_id = NULL" in sql


@pytest.mark.parametrize("state", [STATE_RESOLVABLE, STATE_GAP, STATE_OPEN])
def test_every_row_gets_resolved_at(state):
    """
    resolved_at ставится всем восстановленным строкам, включая цензурированные:
    для них он значит «скрипт с ними разобрался». Без него цензурированные
    строки никогда не попадут под ретеншен delete_old_data.
    """
    rows = [{"lot_key": "k", "_state": state, "first_seen_at": NOW, "last_seen_at": NOW,
             "start_time": NOW, "end_time": None, "buyout_price": 1, "amount": 1,
             "item_id": "art1", "region": "RU", "qlt": 4, "ptn": 15}]
    classify_rows(rows, {}, set(), NOW)
    assert rows[0]["resolved_at"] == NOW
