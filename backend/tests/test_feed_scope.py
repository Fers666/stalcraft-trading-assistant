"""
Набор «Ленты» и качество не-артефактов (ТЗ docs/tasks/feed-gear-expansion.md).

Здесь проверяется ровно то, на чём расширение ленты на снаряжение может
сломаться МОЛЧА:

- ключ варианта считается с двух сторон — из продажи (variant_key) и из лота
  (сборщик). Разойдись они, лента по снаряжению вернула бы ноль строк без
  единой ошибки в логах: продажи ветеранского ствола легли бы в вариант (0, 0),
  а сборщик искал бы (3, 0);
- класс предмета в Python и в SQL кривой дожития обязан совпадать, иначе
  таблица считается по одному разбиению, а читается по другому;
- страта чужого класса не должна подставляться: пустая вероятность честнее
  артефактной вероятности на снаряжении.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

from app.services.analytics.pricing import (
    _lot_quality_enchant, make_sell_options, resolve_quality, resolve_variant_key,
)
from app.services.analytics.survival import (
    FEATURE_POS, HORIZONS_H, Stratum, SurvivalTable,
)
from app.services.analytics.variant_stats import variant_key
from app.services.feed.scope import (
    ARTEFACT_PREFIX, CLASS_ARTEFACT, CLASS_GEAR, FEED_GEAR_CATEGORIES, FEED_GROUPS,
    FEED_NAME_PATTERNS, FEED_RANKS, class_case_sql, feed_group_clause,
    feed_item_class, feed_item_group, feed_scope_clause,
)
from app.tasks.feed_collector import score_item_lots

NOW = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

GUN = SimpleNamespace(
    item_id="gun1", category="weapon/assault_rifle",
    color="rank_veteran", name_ru="АК-103",
)
ARTEFACT = SimpleNamespace(
    item_id="art1", category="artefact/thermal", color="rank_master", name_ru="Пламя",
)


# ─── §3.2 Качество не-артефакта: один резолвер на обе стороны ────────────────

def test_veteran_gun_takes_quality_from_catalog():
    """
    У снаряжения в лоте нет ни qlt, ни ptn — качество является свойством
    ПРЕДМЕТА (master_items.color -> _COLOR_TO_QLT: rank_veteran = 3).
    """
    assert resolve_quality({}, GUN) == 3
    assert resolve_quality(None, GUN) == 3
    assert resolve_variant_key({}, GUN) == (3, 0)


def test_lot_and_sale_give_the_same_variant_key():
    """
    Главная защита от «лента молча пустая»: ключ из ЛОТА (пустой additional) и
    ключ из ПРОДАЖИ обязаны совпасть, иначе опора варианта не найдётся.
    """
    from_lot  = resolve_variant_key({}, GUN)                    # лот снаряжения
    from_sale = variant_key({}, GUN)                            # продажа снаряжения
    from_card = _lot_quality_enchant({"additional": {}}, GUN, False)[0]

    assert from_lot == from_sale == (3, 0)
    assert from_card == from_lot[0] == 3


@pytest.mark.parametrize("color, expected", [
    ("rank_veteran", 3), ("rank_master", 4), ("rank_legend", 5), ("default", 0),
])
def test_rank_maps_to_quality(color, expected):
    master = SimpleNamespace(category="weapon/pistol", color=color, name_ru="ПМ")
    assert resolve_variant_key({}, master) == (expected, 0)


def test_unknown_color_is_not_a_quality():
    """
    Неизвестный цвет — «качество неизвестно», а не «качество 0». Ключ варианта
    при этом обязан остаться целым: колонки qlt/ptn NOT NULL.
    """
    master = SimpleNamespace(category="other", color=None, name_ru="Сезонный пропуск")
    assert resolve_quality({}, master, is_art=False) is None
    assert resolve_variant_key({}, master, is_art=False) == (0, 0)


@pytest.mark.parametrize("additional, expected", [
    (None,                      (0, 0)),
    ({},                        (0, 0)),
    ({"qlt": 4},                (4, 0)),
    ({"qlt": 4, "ptn": 15},     (4, 15)),
    ({"qlt": "4", "ptn": "15"}, (4, 15)),
])
def test_artefact_key_is_unchanged(additional, expected):
    """
    У артефактов ничего не меняется: качество берётся из лота, а цвет предмета
    (у «Пламени» это rank_master) НЕ должен подменять отсутствующий qlt — иначе
    вариант «Обычный» уехал бы в «Мастер» на всей истории.
    """
    assert variant_key(additional) == expected
    assert variant_key(additional, ARTEFACT) == expected
    assert resolve_variant_key(additional, ARTEFACT) == expected


# ─── §3.2 Тот же ключ на уровне выдачи ленты ─────────────────────────────────

def _gear_variant(ref: int = 100_000):
    return SimpleNamespace(
        ref_price=ref, sell_options=make_sell_options(ref, 70, None, None, CLASS_GEAR),
        risk="low", batch_stats=None, volatility_7d=5.0, trend_24h="stable",
        trend_24h_pct=1.0, trend_7d_pct=-2.0, sales_per_day=3.0,
        ref_confidence="high", ref_samples=70,
    )


def _gear_lots():
    end = (NOW + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [{
        "startTime": "2026-08-17T10:00:00Z", "endTime": end,
        "buyoutPrice": 50_000, "amount": 1,
        # Лот снаряжения: additional пустой — качество только из каталога.
        "additional": {},
    }]


def test_gear_lot_finds_its_variant():
    """
    Сквозная проверка §3.2: варианты собраны по ключу ПРОДАЖ, лот приходит
    без качества. Без общего резолвера сборщик искал бы (0, 0) и вернул бы
    пустой список — молча, без ошибок.
    """
    variants = {variant_key({}, GUN): _gear_variant()}
    rows = score_item_lots("gun1", "RU", _gear_lots(), variants, NOW, master=GUN)

    assert len(rows) == 1
    assert (rows[0]["qlt"], rows[0]["ptn"]) == (3, 0)


def test_gear_lot_without_master_finds_nothing():
    """
    Тот же вход, но master не передан — воспроизведение дефекта, ради которого
    резолвер и заводился. Тест сторожит вызов: если master перестанут
    прокидывать в score_item_lots, выдача по снаряжению обнулится.
    """
    variants = {variant_key({}, GUN): _gear_variant()}
    assert score_item_lots("gun1", "RU", _gear_lots(), variants, NOW) == []


# ─── §3.3 Класс предмета ─────────────────────────────────────────────────────

@pytest.mark.parametrize("category, expected", [
    ("artefact/thermal", CLASS_ARTEFACT),
    ("artefact/gravity", CLASS_ARTEFACT),
    ("weapon/assault_rifle", CLASS_GEAR),
    ("armor/heavy", CLASS_GEAR),
    ("other", CLASS_GEAR),
    (None, CLASS_GEAR),
])
def test_feed_item_class(category, expected):
    assert feed_item_class(category) == expected


def test_class_sql_matches_python():
    """
    Текстовая сверка CASE и Python-функции — та же планка, что у
    test_sql_buckets_match_python: расхождение никак иначе не проявится, кроме
    кривых чисел в UI.
    """
    sql = class_case_sql("mi")
    assert f"mi.category LIKE '{ARTEFACT_PREFIX}%'" in sql
    assert f"THEN '{CLASS_ARTEFACT}'" in sql
    assert f"ELSE '{CLASS_GEAR}'" in sql
    assert feed_item_class(ARTEFACT_PREFIX + "/thermal") == CLASS_ARTEFACT


def _pos_table(item_class: str, bucket: str = "top10"):
    rows = {}
    for h in HORIZONS_H:
        rows[(item_class, FEATURE_POS, bucket, h)] = Stratum(
            n_at_risk=4958, p_sold_lo=89.4, p_sold_hi=95.0,
            pct_withdrawn=6.0, pct_sold_ever=77.3, median_hours=0.98,
        )
    return SurvivalTable(rows)


def test_classes_do_not_borrow_each_others_strata():
    table = _pos_table(CLASS_ARTEFACT)
    assert table.summary(CLASS_ARTEFACT, FEATURE_POS, "top10") is not None
    assert table.summary(CLASS_GEAR, FEATURE_POS, "top10") is None
    assert table.get(CLASS_GEAR, FEATURE_POS, "top10", 6) is None


def test_gear_row_stays_empty_until_its_strata_appear():
    """
    Пока gear-страт нет, вероятность и ожидаемая прибыль ПУСТЫЕ, а не
    артефактные и не единичные. Подставить p = 1 значило бы вернуть допущение
    «продастся обязательно», ради снятия которого делался P0-3.
    """
    variants = {variant_key({}, GUN): _gear_variant()}
    lots = _gear_lots() + [
        {"startTime": f"2026-08-17T10:{i:02d}:00Z",
         "endTime": (NOW + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "buyoutPrice": 300_000, "amount": 1, "additional": {}}
        for i in range(20)
    ]
    row = score_item_lots(
        "gun1", "RU", lots, variants, NOW,
        survival=_pos_table(CLASS_ARTEFACT), master=GUN,
    )[0]

    assert row["p_sold_6h"] is None
    assert row["pct_sold_ever"] is None
    assert row["ev_profit"] is None
    # ...а прибыль без вероятности считается как раньше
    assert row["profit_total"] > 0


def test_artefact_row_still_gets_its_strata():
    """Зеркало предыдущего: артефакт свою кривую по-прежнему читает."""
    from app.services.analytics.pricing import make_sell_options as _mso

    variant = SimpleNamespace(
        ref_price=100_000, sell_options=_mso(100_000, 70), risk="low",
        batch_stats=None, volatility_7d=5.0, trend_24h="stable", trend_24h_pct=1.0,
        trend_7d_pct=-2.0, sales_per_day=3.0, ref_confidence="high", ref_samples=70,
    )
    end = (NOW + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lots = [{"startTime": "2026-08-17T10:00:00Z", "endTime": end,
             "buyoutPrice": 50_000, "amount": 1, "additional": {"qlt": 4, "ptn": 15}}]
    lots += [{"startTime": f"2026-08-17T10:{i:02d}:00Z", "endTime": end,
              "buyoutPrice": 300_000, "amount": 1, "additional": {"qlt": 4, "ptn": 15}}
             for i in range(20)]

    row = score_item_lots(
        "art1", "RU", lots, {(4, 15): variant}, NOW,
        survival=_pos_table(CLASS_ARTEFACT), master=ARTEFACT,
    )[0]
    assert row["p_sold_6h"] == 89.4


# ─── §3.1 Группы набора ──────────────────────────────────────────────────────

@pytest.mark.parametrize("category, name_ru, expected", [
    ("artefact/thermal",     "Пламя",                        "artefact"),
    ("weapon/assault_rifle", "АК-103",                       "weapon"),
    ("weapon_modules/x",     "Ствол",                        "weapon"),
    ("attachment/scope",     "Прицел",                       "attachment"),
    ("armor/heavy",          "Экзоскелет",                   "armor"),
    ("backpacks/large",      "Рюкзак",                       "backpacks"),
    ("other",                "Часть схемы #3: «Спаннер»",     "parts"),
    ("other",                "Премиум на 30 дней",           "pass"),
    ("other",                "Сезонный пропуск: Дюна",       "pass"),
    ("medicine",             "Аптечка",                      None),
    ("other",                None,                           None),
])
def test_feed_item_group(category, name_ru, expected):
    assert feed_item_group(category, name_ru) == expected


def test_name_rules_win_over_category():
    """
    «Часть...» в категории снаряжения относится к группе «Части»: правило по
    имени стоит раньше в FEED_GROUPS, и SQL-предикат категорийной группы такие
    предметы исключает — иначе счётчик чипа и его выдача считались бы по
    разным правилам.
    """
    assert feed_item_group("weapon/assault_rifle", "Часть схемы #1: АВТ-40") == "parts"
    assert list(FEED_GROUPS).index("parts") < list(FEED_GROUPS).index("weapon")

    sql = _sql(feed_group_clause("weapon"))
    assert "NOT" in sql and "ILIKE" in sql


def _sql(clause) -> str:
    # literal_binds удваивает % (экранирование для драйвера) — для текстовой
    # сверки шаблонов это шум.
    return str(clause.compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True},
    )).replace("%%", "%")


def test_every_group_has_a_clause_and_a_label():
    from app.services.feed.scope import FEED_GROUP_LABELS

    for group in FEED_GROUPS:
        assert FEED_GROUP_LABELS[group]
        assert _sql(feed_group_clause(group))


def test_gear_groups_require_rank():
    """
    Ранговое правило действует ВНУТРИ категорий снаряжения: в `other` лежат
    сотни косметических предметов ветеран/мастер/легенда, и один предикат по
    рангу набор бы не описал.
    """
    for group in FEED_GEAR_CATEGORIES:
        sql = _sql(feed_group_clause(group))
        assert all(rank in sql for rank in FEED_RANKS), (group, sql)
    assert all(rank not in _sql(feed_group_clause("artefact")) for rank in FEED_RANKS)


def test_scope_is_strictly_tradable():
    """
    Строгий on_auction IS TRUE, а не IS NOT FALSE: предмет с FALSE/NULL не даст
    ни одной строки, а бюджет API на его опрос потратится.
    """
    sql = _sql(feed_scope_clause())
    assert "on_auction IS true" in sql
    assert "on_auction" not in _sql(feed_scope_clause(tradable=False))


def test_scope_covers_all_groups():
    """Набор — объединение групп: новая группа обязана попасть в отбор сама."""
    sql = _sql(feed_scope_clause())
    for prefix in (ARTEFACT_PREFIX, *FEED_GEAR_CATEGORIES):
        assert f"LIKE '{prefix}%'" in sql
    for patterns in FEED_NAME_PATTERNS.values():
        for pattern in patterns:
            assert pattern in sql
