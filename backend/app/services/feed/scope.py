"""
Набор предметов «Ленты» — ЕДИНСТВЕННЫЙ источник правила отбора.

ТЗ: docs/tasks/feed-gear-expansion.md §3.1. До этой задачи маска
`category LIKE 'artefact%'` была зашита в шести местах (сборщик, пересчёт
вариантов, /feed/summary, два скрипта), и любое расширение набора означало
шесть независимых правок. Правило живёт здесь и больше нигде: разъехавшиеся
копии набора — это молча пустая лента по части предметов.

Предмет входит в набор, если он торгуется (`on_auction IS TRUE`) и попадает в
одну из групп ниже. Группы — они же чипы фильтра в UI (§3.5), поэтому они
ОБЯЗАНЫ разбивать набор без пересечений: иначе счётчик чипа и его выдача
считались бы по разным правилам. Разбиение обеспечивается порядком
FEED_GROUPS (правила по имени идут первыми) и исключением шаблонов имени из
категорийных правил.

Строгий `on_auction IS TRUE`, а не `IS NOT FALSE`: предмет с FALSE/NULL не даст
ни одной строки, а бюджет API на его опрос потратится. Следствие —
новый предмет после refresh-catalog приходит с NULL и в ленту не попадёт, пока
не отработает `POST /admin/audit-auction-status` (docs/NOTES.md).
"""

from sqlalchemy import func, not_, or_
from sqlalchemy.sql.elements import ColumnElement

from app.models.models import MasterItem

# ─── Класс предмета (измерение кривой дожития, §3.3) ─────────────────────────
# Ровно два: у снаряжения качество — свойство предмета из каталога, а не лота,
# и своя механика рынка (высокие тиры получают апгрейдом, а не покупкой).
# Дробить мельче нельзя — страты не наберут MIN_STRATUM_N.
CLASS_ARTEFACT = "artefact"
CLASS_GEAR     = "gear"

ARTEFACT_PREFIX = "artefact"

# Категории снаряжения. Ранговое правило действует ВНУТРИ них: в категории
# `other` 361 предмет с рангами veteran/master/legend — почти сплошь косметика
# (облики, скины, эмоции), и один предикат по рангу набор бы не описал.
FEED_GEAR_CATEGORIES: tuple[str, ...] = ("weapon", "attachment", "armor", "backpacks")

# Качество ветеран/мастер/легенда (master_items.color). Ниже рангом снаряжение
# в перепродажу не идёт: замер §2 ТЗ — чем выше ранг, тем реже предмет вообще
# появляется на аукционе, но и цена ниже ранга не окупает места в бюджете API.
FEED_RANKS: tuple[str, ...] = ("rank_veteran", "rank_master", "rank_legend")

# Правила по имени. Части предметов и премиум лежат в категории `other`, а
# сезонные пропуска пришли разовым импортом с color = NULL — категорией и
# рангом их не выделить.
FEED_NAME_PATTERNS: dict[str, tuple[str, ...]] = {
    "parts": ("Часть%",),
    "pass":  ("Премиум на %", "Сезонный пропуск%"),
}

GROUP_ARTEFACT   = "artefact"
GROUP_PARTS      = "parts"
GROUP_PASS       = "pass"

# ПОРЯДОК = приоритет: предмет относится к первой подошедшей группе. Правила по
# имени идут раньше категорийных, потому что именно они втягивают предмет в
# набор независимо от ранга.
FEED_GROUPS: tuple[str, ...] = (
    GROUP_PARTS, GROUP_PASS, GROUP_ARTEFACT, *FEED_GEAR_CATEGORIES,
)

FEED_GROUP_LABELS: dict[str, str] = {
    GROUP_PARTS:  "Части",
    GROUP_PASS:   "Пропуска и премиум",
    GROUP_ARTEFACT: "Артефакты",
    "weapon":     "Оружие",
    "attachment": "Обвесы",
    "armor":      "Броня",
    "backpacks":  "Рюкзаки",
}


def feed_item_class(category: str | None) -> str:
    """
    Класс предмета: `artefact` или `gear` (всё остальное в наборе).

    Тот же предикат, что в class_case_sql — расхождение означало бы, что
    кривая дожития считается по одному разбиению, а читается по другому.
    Проверяется тестом test_class_sql_matches_python.
    """
    return CLASS_ARTEFACT if (category or "").startswith(ARTEFACT_PREFIX) else CLASS_GEAR


def class_case_sql(alias: str = "mi") -> str:
    """CASE для класса предмета в сыром SQL (агрегат кривой дожития)."""
    return (
        f"CASE WHEN {alias}.category LIKE '{ARTEFACT_PREFIX}%' "
        f"THEN '{CLASS_ARTEFACT}' ELSE '{CLASS_GEAR}' END"
    )


def feed_item_group(category: str | None, name_ru: str | None) -> str | None:
    """
    Группа предмета (чип фильтра) или None, если предмет вне набора.

    Ранг здесь не проверяется намеренно: функция вызывается для предметов,
    которые УЖЕ дали строки в ленте, то есть ранговое правило прошли. Для
    отбора предметов существует feed_scope_clause().
    """
    name = name_ru or ""
    for group, patterns in FEED_NAME_PATTERNS.items():
        if any(_name_matches(name, pattern) for pattern in patterns):
            return group

    cat = category or ""
    if cat.startswith(ARTEFACT_PREFIX):
        return GROUP_ARTEFACT
    for prefix in FEED_GEAR_CATEGORIES:
        if cat.startswith(prefix):
            return prefix
    return None


def _name_matches(name: str, pattern: str) -> bool:
    """ILIKE-шаблон в Python. Шаблоны набора — только с хвостовым `%`."""
    return name.lower().startswith(pattern.rstrip("%").lower())


# ─── SQL-предикаты ───────────────────────────────────────────────────────────

def _name_clause(pattern: str) -> ColumnElement[bool]:
    # coalesce обязателен: NULL ILIKE ... даёт NULL, и в NOT (...) такой предмет
    # выпал бы из ВСЕХ категорийных групп.
    return func.coalesce(MasterItem.name_ru, "").ilike(pattern)


def _any_name_clause() -> ColumnElement[bool]:
    return or_(*[
        _name_clause(pattern)
        for patterns in FEED_NAME_PATTERNS.values()
        for pattern in patterns
    ])


def feed_group_clause(group: str) -> ColumnElement[bool]:
    """
    Предикат по MasterItem для одной группы. Группы не пересекаются: из
    категорийных исключены предметы, подходящие под шаблоны имени (они уже
    учтены в parts/pass, стоящих раньше в FEED_GROUPS).
    """
    if group in FEED_NAME_PATTERNS:
        return or_(*[_name_clause(pattern) for pattern in FEED_NAME_PATTERNS[group]])

    not_named = not_(_any_name_clause())
    if group == GROUP_ARTEFACT:
        return MasterItem.category.like(f"{ARTEFACT_PREFIX}%") & not_named
    if group in FEED_GEAR_CATEGORIES:
        return (
            MasterItem.category.like(f"{group}%")
            & MasterItem.color.in_(FEED_RANKS)
            & not_named
        )
    raise ValueError(f"неизвестная группа набора ленты: {group}")


def feed_groups_clause(groups) -> ColumnElement[bool]:
    """Предикат по нескольким группам (серверный фильтр чипов, §3.5)."""
    return or_(*[feed_group_clause(group) for group in groups])


def feed_scope_clause(tradable: bool = True) -> ColumnElement[bool]:
    """
    Набор ленты целиком: объединение групп + торгуемость.

    tradable=False — только для разбора ИСТОРИЧЕСКИХ данных (снапшоты
    восстановления): предмет, снятый с торгов сегодня, месяц назад торговался.
    Для всего, что расходует лимит API, торгуемость обязательна.
    """
    scope = feed_groups_clause(FEED_GROUPS)
    return scope & MasterItem.on_auction.is_(True) if tradable else scope
