# ТЗ: `_publish_signals` — TypeError `'NoneType' object is not iterable`

Дата: 2026-06-28
Источник: `qa-tester`, верификация фазы «Админ-статистика» (баг найден случайно, не
связан с этой фазой). Воспроизводится стабильно в логах `docker compose logs worker`.

## Контекст

В Celery worker регулярно повторяется ошибка:

```
_publish_signals: entry user=1 6goy/RU: 'NoneType' object is not iterable
```

`_publish_signals` (`backend/app/tasks/collectors.py:337`) ловит исключение для каждой
watchlist-записи отдельно (`try/except Exception` внутри цикла `for entry in entries`,
строки 392-409) и логирует только `str(e)` без traceback — поэтому в логе виден только
текст ошибки, не источник. Не блокирует коллектор: ошибка изолирована per-entry,
остальные записи и сбор лотов продолжают работать. Но конкретная watchlist-запись
(`user_id=1, item_id=6goy, region=RU`) никогда не получает сигналы в Redis — пользователь
не видит выгодных лотов для этого фильтра.

Это регрессия от ранее реализованного и задеплоенного фикса **Fix 8** из
`docs/tasks/security-and-bugfix.md` (2026-06-17, см. `docs/CHANGELOG.md`): тогда было
исправлено вычисление `vol_for_opts`/`sell_options` в `profitable_lots.py`, чтобы при
отсутствии истории продаж под активным фильтром `sell_options` корректно становился
`None` (а не наследовал объём всех качеств). Фикс корректен и работает как задумано —
но downstream-потребитель `sell_options` (`evaluate_lot_profit` в `pricing.py`) не был
обновлён под новый легитимный случай `sell_options=None`, и безусловно итерирует по нему.

## Текущий код — зафиксированные факты

**Root cause: `backend/app/services/analytics/pricing.py:184`**

```python
def evaluate_lot_profit(
    buyout_per_unit: int,
    amount: int,
    sell_options: list[dict],
    risk: str,
    min_margin_pct: float = 0.0,
    batch_stats: Optional[dict] = None,
) -> Optional[dict]:
    ...
    fast   = next((o for o in sell_options if o["label"] == "fast"), None)   # ← строка 184
    normal = next((o for o in sell_options if o["label"] == "normal"), None)
    if not fast or not normal:
        return None
```

`sell_options` типизирован как `list[dict]` (без `Optional`), но вызывающий код может
передать `None`. Итерация `for o in sell_options` на `None` бросает
`TypeError: 'NoneType' object is not iterable` — это и есть `str(e)`, который попадает
в лог `_publish_signals`.

**Откуда приходит `sell_options=None` — `backend/app/services/profitable_lots.py`:**

- Строка 184: `vol_for_opts = vol if prices else None`
- Строка 194: `sell_options = make_sell_options(ref, vol_for_opts) if vol_for_opts is not None else None`
- Строки 216-220: `evaluate_lot_profit(buyout_per_unit, amount, sell_options, risk, min_profit_margin_pct, batch_stats)` —
  `sell_options` передаётся как есть, может быть `None`.

`vol_for_opts = None` возникает, когда у `entry` задан `quality_filter`/`enchant_filter`
(ветка `else` строки 138-184), но в `sales_history` за последние 7 дней нет ни одной
продажи, совпадающей с этим фильтром (`prices = []`, строка 167-184).

**Подтверждение на реальных данных (БД, 2026-06-28):**

```sql
-- watchlist-запись:
SELECT id, user_id, item_id, region, quality_filter, enchant_filter, is_active
FROM user_watchlist WHERE item_id='6goy' AND region='RU';
--  id | user_id | item_id | region | quality_filter | enchant_filter | is_active
--  68 |       1 | 6goy    | RU     |              3 |             15 | t

-- sales_history за 7д, всего vs совпадающих с фильтром:
SELECT count(*) AS total_7d,
  count(*) FILTER (WHERE additional_info->>'qlt'='3' AND additional_info->>'ptn'='15') AS matching_filter
FROM sales_history
WHERE item_id='6goy' AND region='RU' AND sale_time >= now() - interval '7 days';
--  total_7d | matching_filter
--       225 |               0   ← prices=[] → vol_for_opts=None → sell_options=None

-- master_items: 6goy — артефакт (is_art=True в _lot_quality_enchant)
SELECT item_id, category, color FROM master_items WHERE item_id='6goy';
--  6goy | artefact/other_arts | default

-- В текущем снэпшоте (raw_lots) ЕСТЬ 6 лотов с qlt=3 AND ptn=15 — то есть цикл
-- for lot in snap.raw_lots (profitable_lots.py:199) реально доходит до них,
-- проходит фильтр quality/enchant и вызывает evaluate_lot_profit(..., sell_options=None, ...)
SELECT lot->'additional'->>'qlt' AS qlt, lot->'additional'->>'ptn' AS ptn, count(*)
FROM collected_data, jsonb_array_elements(raw_lots) AS lot
WHERE id = 42569 GROUP BY 1,2 ORDER BY 3 DESC;
--  qlt=3, ptn=15 → count=6   (среди прочих комбинаций)
```

Цепочка полностью подтверждена фактами: `prices=[]` (0 совпадающих продаж за 7д) →
`vol_for_opts=None` → `sell_options=None` → лот с `qlt=3,ptn=15` в снэпшоте проходит
фильтр → `evaluate_lot_profit(..., sell_options=None, ...)` → `for o in None` → `TypeError`.

Условие срабатывает для любой watchlist-записи с заданными `quality_filter`/
`enchant_filter`, для которой нет совпадающих продаж в `sales_history` за 7 дней, но
есть хотя бы один совпадающий лот в текущем снэпшоте — то есть редкая комбинация
качества/заточки без истории продаж, но присутствующая на аукционе сейчас.

## Затронутые файлы

- `backend/app/services/analytics/pricing.py` — единственный файл с правкой.

## Изменения по слоям

### Backend

Точечный guard в начале `evaluate_lot_profit` (`pricing.py`, строка ~184), до текущей
итерации:

```python
# БЫЛО:
fast   = next((o for o in sell_options if o["label"] == "fast"), None)
normal = next((o for o in sell_options if o["label"] == "normal"), None)
if not fast or not normal:
    return None

# СТАЛО:
if not sell_options:
    return None
fast   = next((o for o in sell_options if o["label"] == "fast"), None)
normal = next((o for o in sell_options if o["label"] == "normal"), None)
if not fast or not normal:
    return None
```

Сигнатура параметра приводится в соответствие фактическому поведению
(`sell_options: list[dict]` → `sell_options: Optional[list[dict]]`), чтобы тип отражал
реальность и подобные регрессии было проще ловить статическим анализом/ревью:

```python
def evaluate_lot_profit(
    buyout_per_unit: int,
    amount: int,
    sell_options: Optional[list[dict]],
    risk: str,
    min_margin_pct: float = 0.0,
    batch_stats: Optional[dict] = None,
) -> Optional[dict]:
```

Семантика результата не меняется: лот без `sell_options` (нет данных для оценки
выгодности) и раньше эффективно должен был игнорироваться — теперь это явный,
не аварийный `return None`, поведение остаётся «лот не считается выгодным», но без
исключения. Никаких других изменений в `pricing.py` или `profitable_lots.py`/
`collectors.py` не требуется — `_publish_signals` и `compute_signals_for_entry`
менять не нужно (Simplicity First: фикс ровно там, где небезопасная итерация).

### Frontend

Не затронут.

### Design

Не затронут.

## Документация для обновления

- `docs/NOTES.md`: убрать из логов-блокеров (если был зафиксирован отдельно) /
  отметить как закрытый. Можно добавить короткую запись в архив о регрессии после
  Fix 8 и её устранении — для истории отладки.
- `docs/CHANGELOG.md`: добавить запись о фиксе (после реализации), со ссылкой на
  исходный Fix 8 (`security-and-bugfix.md`, 2026-06-17) как на связанный контекст.
- `docs/BUSINESS_LOGIC.md` / `docs/SERVICES.md`: изменений в формулах/контракте сервиса
  нет (фикс защитный, не меняет бизнес-логику расчёта прибыли) — обновление не требуется.

## Открытые вопросы / требует подтверждения

Не требует подтверждения пользователя — фикс не затрагивает частоту опроса API/rate
limit, изменение из одной функции, без миграций. Рекомендуется тест-кейс (unit) на
`evaluate_lot_profit(sell_options=None)` → `None` без исключения, и регрессионный
кейс на `compute_signals_for_entry` с фильтром, для которого `prices=[]`, но снэпшот
содержит совпадающий лот (воспроизводит ровно сценарий `6goy/RU`).

## Маршрутизация по агентам

1. `backend-dev` — применить точечный фикс по этому ТЗ (`backend/app/services/analytics/pricing.py`).
2. `tech-writer` — обновить `docs/CHANGELOG.md` (и `docs/NOTES.md`, если запись об
   ошибке была туда добавлена отдельно).
3. (опционально, по желанию пользователя) `qa-tester` — подтвердить, что ошибка
   `_publish_signals: entry user=1 6goy/RU` больше не появляется в логах worker после
   следующего цикла сбора для этого item/region.
