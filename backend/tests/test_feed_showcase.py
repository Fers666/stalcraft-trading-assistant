"""
Тесты модели доступа к «Ленте артефактов» (Ревизия 2 §Р2.6).

Покрывается то, что проверяемо без БД: лимит строк по тарифам (в т.ч. при
истёкшем сроке), инвариант feed_access ⇔ отсутствие лимита, отсутствие
тарифного гейта на двух негейтированных ручках и запрет тяжёлых источников
в них.

Отбор строк витрины (ценовая полоса percentile_cont, игнорирование фильтров,
пагинация) живёт в SQL и требует фикстуры БД, которой в проекте нет —
проверяется qa-tester по критериям приёмки §Р2.7 (решение зафиксировано
в ТЗ, раздел «Тесты»). Чистая часть правила полосы — band_bounds — покрыта
в test_feed_scoring.py.
"""

import ast
import asyncio
import inspect
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.v1.endpoints import feed as feed_module
from app.api.v1.endpoints.feed import FEED_MAX_LIST_VALUES, showcase_threshold
from app.api.v1.endpoints.settings import SettingsUpdate
from app.core.tiers import (
    ADMIN_LIMITS, TIERS, effective_feed_rows_limit, get_tier_limits, is_tier_expired,
)


def _user(tier: str, is_admin: bool = False, tier_expires_at=None):
    return SimpleNamespace(
        id=1, tier=tier, is_admin=is_admin, favorites_limit_override=None,
        tier_expires_at=tier_expires_at,
    )


# ─── Лимит строк по тарифам ───────────────────────────────────────────────────

@pytest.mark.parametrize("tier,expected", [
    ("base", 1),
    ("advanced", 10),
    ("advanced_plus", 20),
    ("advanced_max", None),
])
def test_feed_rows_limit_by_tier(tier, expected):
    assert effective_feed_rows_limit(_user(tier)) == expected


def test_admin_sees_full_feed_regardless_of_tier():
    """Админ на тарифе base обходит лимит целиком (ADMIN_LIMITS)."""
    assert effective_feed_rows_limit(_user("base", is_admin=True)) is None
    assert get_tier_limits(_user("base", is_admin=True)).feed_access is True


def test_unknown_tier_falls_back_to_base():
    assert effective_feed_rows_limit(_user("legacy_tier")) == TIERS["base"].feed_rows_limit


@pytest.mark.parametrize("tier", list(TIERS))
def test_feed_access_matches_absence_of_limit(tier):
    """
    Инвариант Ревизии 2: feed_access == (feed_rows_limit is None).
    На нём держится ветвление ручек по тарифу (полная лента против витрины).
    """
    limits = TIERS[tier]
    assert limits.feed_access == (limits.feed_rows_limit is None)


def test_admin_limits_hold_the_same_invariant():
    assert ADMIN_LIMITS.feed_access == (ADMIN_LIMITS.feed_rows_limit is None)


# ─── Истёкший тариф ───────────────────────────────────────────────────────────

def test_expired_max_tier_loses_full_feed():
    """
    Ленивое понижение (apply_tier_expiry) срабатывает только на HTTP-запрос
    пользователя, а sweep_expired_tiers — раз в сутки: между ними user.tier ещё
    «Макс». Лимиты обязаны считаться от current_tier, а не от user.tier.
    """
    expired = datetime.now(timezone.utc) - timedelta(minutes=1)
    user = _user("advanced_max", tier_expires_at=expired)
    assert get_tier_limits(user).feed_access is False
    assert effective_feed_rows_limit(user) == TIERS["base"].feed_rows_limit


def test_max_tier_with_valid_expiry_keeps_full_feed():
    valid = datetime.now(timezone.utc) + timedelta(days=1)
    assert effective_feed_rows_limit(_user("advanced_max", tier_expires_at=valid)) is None


def test_expired_admin_keeps_access():
    """У админа лимиты не тарифные — срок на них не влияет."""
    expired = datetime.now(timezone.utc) - timedelta(minutes=1)
    assert effective_feed_rows_limit(
        _user("advanced_max", is_admin=True, tier_expires_at=expired)
    ) is None


def test_naive_expiry_is_treated_as_utc():
    """
    tier_expires_at из БД может прийти без tzinfo (драйвер/легаси-строка) —
    сравнение с now(utc) обязано не падать, иначе проверка срывается исключением.
    """
    naive_past = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    assert is_tier_expired(_user("advanced_max", tier_expires_at=naive_past)) is True


# ─── Гейт: две ручки без него, две с ним ──────────────────────────────────────

@pytest.mark.parametrize("endpoint", [feed_module.list_feed_lots, feed_module.feed_variant])
def test_public_endpoints_have_no_tier_gate(endpoint):
    """
    /feed/lots и /feed/variant отвечают 200 на всех тарифах — лимит применяется
    выдачей (витрина), а не 403 (Ревизия 2 §Р2.3).
    """
    assert "_require_access" not in inspect.getsource(endpoint)


@pytest.mark.parametrize("endpoint", [feed_module.feed_summary, feed_module.feed_filters])
def test_gated_endpoints_require_access(endpoint):
    """Сводка 24 ч и счётчики фильтров — только полная лента."""
    assert "_require_access" in inspect.getsource(endpoint)


# ─── Требование безопасности: только чтение готовой таблицы ───────────────────

def _referenced_identifiers(module) -> set[str]:
    """Все имена, к которым обращается модуль (импорты, переменные, атрибуты)."""
    tree = ast.parse(inspect.getsource(module))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            names.update(alias.name for alias in node.names)
    return names


@pytest.mark.parametrize("forbidden", [
    "stalcraft_client",     # внешний API
    "variant_stats",        # пересчёт статистики вариантов
    "market_stats",         # пересчёт рыночной статистики
    "get_or_fetch",         # api_cache с догрузкой из API
])
def test_feed_endpoints_never_trigger_heavy_recalculation(forbidden):
    """
    Негейтированная ручка, способная запустить тяжёлый пересчёт или поход во
    внешний API, — DoS-вектор. Прямой урок проекта: get_watchlist_suggestions
    сознательно сделан cache-read-only (docs/BUSINESS_LOGIC.md §17).
    Модуль ленты читает только feed_lots + master_items + Redis.
    """
    used = _referenced_identifiers(feed_module)
    assert not [name for name in used if forbidden in name]


def _call_lots(**kwargs):
    """Прямой вызов ручки: значения по умолчанию у FastAPI — объекты Query."""
    params = {
        "item_id": None, "category": None, "qlt": None, "ptn": None, "risk": None,
        "tier": None, **kwargs,
    }
    return asyncio.run(feed_module.list_feed_lots(
        page=1, page_size=25, sort="profit_total", order="desc",
        current_user=_user("base"), db=None, **params,
    ))


@pytest.mark.parametrize("param", ["item_id", "category", "qlt", "ptn", "risk", "tier"])
def test_list_filters_are_capped(param):
    """L9: IN (...) без верхней границы принимает сколько угодно значений."""
    values = {
        "item_id": "a", "category": "weapon", "qlt": 1, "ptn": 1, "risk": "low",
        "tier": "fast",
    }[param]
    with pytest.raises(HTTPException) as exc:
        _call_lots(**{param: [values] * (FEED_MAX_LIST_VALUES + 1)})
    assert exc.value.status_code == 422


def test_unknown_category_group_is_rejected():
    """
    Группы чипов — закрытый список из scope-модуля. Незнакомое значение обязано
    падать 422, а не тихо давать пустую выдачу: «фильтр не сработал» и «лотов
    нет» — разные ответы.
    """
    with pytest.raises(HTTPException) as exc:
        _call_lots(category=["weapon", "не-группа"])
    assert exc.value.status_code == 422


def test_known_category_groups_pass_validation(monkeypatch):
    """Все группы набора обязаны приниматься ручкой — иначе чип не работает."""
    from app.services.feed.scope import FEED_GROUPS

    import app.tasks.feed_collector as feed_collector

    async def _showcase(db, region, user_min, rows_limit):
        return [], 0, None, 0.0

    async def _not_frozen(db, now):
        return None

    monkeypatch.setattr(feed_module, "_user_min_margin", _min_margin)
    monkeypatch.setattr(feed_module, "_cached_showcase", _showcase)
    # Подменяется явно, а не через заглушку db: ручка глушит ошибки проверки
    # свежести, и на живом коде тест иначе прошёл бы по except, ничего
    # фактически не проверив.
    monkeypatch.setattr(feed_collector, "market_frozen_for", _not_frozen)
    for group in FEED_GROUPS:
        assert _call_lots(category=[group]).total_count == 0


async def _min_margin(db, user):
    return 0.0


# ─── Порог: квантование витрины и серверная валидация ────────────────────────

@pytest.mark.parametrize("user_min,expected", [
    (0.0, 0.0), (4.0, 0.0), (5.0, 5.0), (9.0, 5.0),
    (12.0, 10.0), (99.0, 95.0), (100.0, 100.0), (-5.0, 0.0),
])
def test_showcase_threshold_quantizes_down(user_min, expected):
    """
    M2: порог входит и в WHERE, и в ключ кэша. Без квантования каждое значение
    даёт свой набор строк (перебор ленты по строке) и свой ключ (TTL 30 с
    обходится, percentile_cont считается заново). Вниз, а не вверх: округление
    вверх скрыло бы строки, на которые пользователь имеет право.
    """
    assert showcase_threshold(user_min) == expected


def test_showcase_cache_key_is_shared_inside_bucket(monkeypatch):
    """Соседние пороги одного шага обязаны попадать в ОДИН ключ кэша."""
    keys: list[str] = []

    async def _cache_get(key):
        keys.append(key)
        return None

    async def _cache_set(key, payload, ttl):
        pass

    async def _rows(db, region, threshold, rows_limit):
        return [], 0, None

    monkeypatch.setattr(feed_module, "_cache_get", _cache_get)
    monkeypatch.setattr(feed_module, "_cache_set", _cache_set)
    monkeypatch.setattr(feed_module, "_showcase_rows", _rows)

    for user_min in (10.0, 11.0, 14.0):
        asyncio.run(feed_module._cached_showcase(None, "RU", user_min, 1))
    assert len(set(keys)) == 1

    asyncio.run(feed_module._cached_showcase(None, "RU", 15.0, 1))
    assert len(set(keys)) == 2


@pytest.mark.parametrize("value", [-1, 101, 10_000])
def test_settings_threshold_is_validated_on_server(value):
    """
    M2/L6: кламп жил только в UI. Порог видимости за границами диапазона —
    перебор выдачи по строке и обход кэша витрины.
    """
    with pytest.raises(ValidationError):
        SettingsUpdate(min_profit_margin_percent=value)


@pytest.mark.parametrize("value", [0, 20, 100])
def test_settings_threshold_accepts_ui_range(value):
    assert SettingsUpdate(min_profit_margin_percent=value).min_profit_margin_percent == value
