"""
Фейковая async-сессия для функций, которые ходят в БД, но считают чисто.

Зачем она есть. За сутки два прод-инцидента одного рода:

  * 9fc9953 — `_calculate_market_radar_aggregate` читал `stats.volatility_7d`,
    тогда как `MarketStatistics` несёт `price_volatility_7d`. Ветка бакета БЕЗ
    фильтра качества (самая частая) падала AttributeError, «Радар рынка» отдавал
    500 трое суток.
  * 50ea7dc — `compute_signals_for_entry` выбирал продажи без колонки `amount`,
    а `_calculate_batch_stats` её читает. Падала каждая watchlist-запись,
    «Избранное» осталось без сигналов.

Оба места логически чистые: вся их зависимость от БД сводится к ФОРМЕ строки.
Оба не были покрыты по одной причине — «ходит в БД» читалось как «в юнит-тестах
не вызывается», и `pytest` показывал 425 passed, пока прод лежал.

Правило фейка, ради которого он написан:

    строка несёт РОВНО те атрибуты, что перечислены в select(...)

Имена колонок берутся из самого statement (`column_descriptions`), а не пишутся
руками в тесте. Тестовые данные — это «таблица» (словарь со всеми полями), а
`select` из неё ВЫБИРАЕТ. Уберут колонку из select — строка перестанет её нести,
и код, который читает её по атрибуту, упадёт в тесте ровно так же, как упал на
проде. `MagicMock` или `SimpleNamespace` «со всеми полями» прошли бы и на
сломанном коде: именно эту дыру фейк закрывает, поэтому подменять его удобной
заглушкой нельзя.

По той же причине там, где код получает ORM-объект (`.scalars()`), тест обязан
отдавать НАСТОЯЩИЙ экземпляр модели: у него нет атрибутов, которых нет в
таблице, — так ловится ошибка вида `volatility_7d` вместо `price_volatility_7d`.
"""

from collections import namedtuple
from typing import Any

from sqlalchemy.sql.elements import TextClause

# Ключи `responses`, у которых нет ORM-сущности.
KEY_COUNT = "count"    # select(func.count()) — скаляр
KEY_TEXT  = "text"     # text("SELECT ...") — сырой SQL


def _describe(statement) -> tuple[str, tuple[str, ...], bool]:
    """(ключ маршрутизации, имена колонок, это ли select целой сущности)."""
    if isinstance(statement, TextClause):
        return KEY_TEXT, (), False

    descriptions = statement.column_descriptions
    names = tuple(d["name"] for d in descriptions)
    entities = [d["entity"] for d in descriptions if d.get("entity") is not None]
    key = entities[0].__name__ if entities else KEY_COUNT
    is_entity = (
        len(descriptions) == 1
        and descriptions[0].get("entity") is not None
        and descriptions[0].get("expr") is descriptions[0]["entity"]
    )
    return key, names, is_entity


def _build_rows(key: str, names: tuple[str, ...], dicts: list[dict]) -> list:
    """
    Строки Row с атрибутами строго по списку колонок select.

    namedtuple, а не SimpleNamespace: любое поле сверх выбранных даёт
    AttributeError — то же поведение, что у настоящего sqlalchemy.Row.
    Лишние ключи словаря молча игнорируются: словарь описывает таблицу целиком,
    а не выборку.
    """
    if not names:
        # text(): имён колонок в statement нет, берём из самих данных.
        names = tuple(dicts[0].keys())

    row_cls = namedtuple("Row", names)
    rows = []
    for i, values in enumerate(dicts):
        missing = [n for n in names if n not in values]
        if missing:
            raise AssertionError(
                f"select к {key} выбирает колонки {missing}, которых нет в тестовой "
                f"строке #{i}. Добавь им значения — либо проверь, зачем код их выбирает."
            )
        rows.append(row_cls(*(values[n] for n in names)))
    return rows


class FakeResult:
    """Результат execute(): .all() / .scalars() / .scalar_one() / итерация."""

    def __init__(self, rows: list):
        self._rows = list(rows)

    def all(self) -> list:
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)

    def first(self):
        return self._rows[0] if self._rows else None

    def scalars(self) -> "FakeResult":
        # Значения уже скалярные: на select(Model) тест отдаёт сами объекты.
        return self

    def scalar_one(self):
        if len(self._rows) != 1:
            raise AssertionError(
                f"scalar_one() на {len(self._rows)} строках — тест отдал не то, "
                "что ожидает код."
            )
        return self._rows[0]

    def scalar(self):
        return self._rows[0] if self._rows else None


class FakeSession:
    """
    Асинхронная сессия-заглушка. К БД не ходит, statement не исполняет — только
    разбирает список выбранных колонок и отдаёт по нему заранее заданные строки.

    responses: ключ → данные, где ключ это имя ORM-сущности запроса
    ("SalesHistory", "UserWatchlist", ...), KEY_COUNT для select(func.count())
    или KEY_TEXT для сырого SQL. Данные:

      * list[dict]      — строки; из каждого словаря берутся только колонки select;
      * list[объектов]  — отдаются как есть (для .scalars(), настоящие модели);
      * int             — скаляр для .scalar_one();
      * callable(names) — когда к одной сущности идут разные запросы: получает
                          имена колонок и возвращает любой из вариантов выше.
    """

    def __init__(self, responses: dict[str, Any]):
        self.responses = responses
        self.executed: list[tuple[str, tuple[str, ...]]] = []

    async def execute(self, statement, *args, **kwargs) -> FakeResult:
        key, names, is_entity = _describe(statement)
        self.executed.append((key, names))

        if key not in self.responses:
            raise AssertionError(
                f"неописанный запрос: сущность {key}, колонки {names}. "
                "Добавь данные в responses — молча отдавать пустоту нельзя, "
                "иначе тест перестанет проверять ветку."
            )

        payload = self.responses[key]
        if callable(payload):
            payload = payload(names)

        if isinstance(payload, int):
            return FakeResult([payload])

        rows = list(payload)
        if not rows:
            return FakeResult([])

        if isinstance(rows[0], dict):
            if is_entity:
                raise AssertionError(
                    f"select({key}) отдаёт ORM-объекты: тест обязан вернуть настоящие "
                    f"экземпляры {key}, иначе не поймает обращение к несуществующей "
                    "колонке (ровно так пропустили volatility_7d в 9fc9953)."
                )
            return FakeResult(_build_rows(key, names, rows))

        return FakeResult(rows)


# ─── Кривая дожития ──────────────────────────────────────────────────────────
#
# Радар читает её из БД (load_survival, сырой SQL), сигналы получают готовую
# таблицу аргументом. Набор строк общий, чтобы вероятности продажи в обоих
# тестах были одни и те же.

_SURVIVAL_BUCKETS = {
    # бакет по отношению цены к опоре → (p_sold_lo на 6ч, медиана часов)
    "r94_98":   (81.3, 3.0),    # цена тира fast    (ref * 0.94)
    "r98_103":  (74.5, 6.0),    # цена тира normal  (ref * 1.00)
    "r103_110": (49.0, 12.0),   # цена тира premium (ref * 1.06)
}


def survival_rows(item_class: str = "artefact") -> list[dict]:
    """Строки sale_survival в том виде, в каком их отдаёт запрос load_survival."""
    from app.services.analytics.survival import HORIZONS_H

    return [
        {
            "item_class": item_class,
            "feature": "ratio",
            "bucket": bucket,
            "horizon_h": horizon,
            "n_at_risk": 5000,
            "p_sold_lo": p_sold_6h if horizon >= 6 else p_sold_6h / 2,
            "p_sold_hi": 95.0,
            "pct_withdrawn": 8.0,
            "pct_sold_ever": 88.0,
            "median_hours": median_hours,
        }
        for bucket, (p_sold_6h, median_hours) in _SURVIVAL_BUCKETS.items()
        for horizon in HORIZONS_H
    ]


def reset_survival_cache() -> None:
    """
    Сбрасывает процессный кэш load_survival.

    Кэш живёт в глобальной переменной модуля и держится 60 с — без сброса
    таблица протекала бы между тестами.
    """
    from app.services.analytics import survival

    survival._cache = None


async def load_fake_survival(item_class: str = "artefact"):
    """
    Таблица дожития через НАСТОЯЩИЙ load_survival поверх фейковой сессии.

    Второй сборки SurvivalTable в тестах не заводим: разойдись она с загрузчиком,
    тесты считали бы вероятности не так, как прод.
    """
    from app.services.analytics.survival import load_survival

    reset_survival_cache()
    table = await load_survival(FakeSession({KEY_TEXT: survival_rows(item_class)}))
    reset_survival_cache()
    return table
