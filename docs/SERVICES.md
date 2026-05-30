# Сервисы и задачи — описание

---

## Celery задачи (расписание)

| Задача | Расписание | Модуль | Описание |
|--------|-----------|--------|----------|
| `collect_watchlist_lots` | каждые 5 мин | `app.tasks.collectors` | Уникальные пары из всех watchlist, 1 запрос/пару |
| `collect_watchlist_history` | раз в час (мин. 0) | `app.tasks.collectors` | История для watchlist предметов |
| `calculate_all_market_stats` | раз в час (мин. 5) | `app.tasks.analyzers` | Пересчёт market_statistics |
| `run_global_feed_batch` | раз в час (мин. 30) | `app.tasks.global_scanner` | ~93 предмета вне watchlist, скользящий цикл |
| `delete_old_data` | ежедневно 03:00 | `app.tasks.cleanup` | Данные старше 120 дней |

### Логика дедупликации watchlist

```python
# Вместо: for entry in all_watchlist_entries → api_call(entry.user_id, entry.item_id)
# Делаем: уникальные пары → 1 вызов на пару

unique_pairs = {(e.item_id, e.region) for e in all_active_watchlist}
for item_id, region in unique_pairs:
    data = api.get_lots(item_id, region)
    save_to_collected_data(user_id=None, item_id=item_id, region=region, data=data)
    cache.set_lots(region, item_id, data)  # Redis кэш
```

Результат: 100 пользователей следят за одним товаром → **1 API запрос**.

### Логика глобального сканера (run_global_feed_batch)

```python
# Каждый час в минуту 30:
watchlist_pairs = {(e.item_id, e.region) for e in all_active_watchlist}
all_items = master_items.query(region=DEFAULT_REGION)

# Исключаем watchlist предметы — они уже собираются каждые 5 мин
feed_items = [i for i in all_items if (i.item_id, region) not in watchlist_pairs]

# Берём следующий батч из скользящего указателя
cursor = redis.get("global_scan:cursor") or 0
batch = feed_items[cursor : cursor + BATCH_SIZE]  # ~93 предмета
redis.set("global_scan:cursor", (cursor + BATCH_SIZE) % len(feed_items))

# Лёгкий сбор — только /lots, без raw_lots
for item in batch:
    data = api.get_lots(item.item_id, region)
    upsert_global_item_scan(item_id, region, metrics_only(data))
```

Полный цикл по всем предметам ≈ 24 часа.
Захватывает прайм-тайм естественно — данные актуальны в любое время суток.

---

## app/services/collector/client.py — StalcraftClient

HTTP клиент для Stalcraft API. Все запросы проходят через rate limiter.

**Методы:**
- `get_auction_lots(item_id, offset, limit)` — активные лоты предмета
- `get_auction_history(item_id, offset, limit)` — история продаж
- `get_emission()` — статус радиационного выброса

При ответе `401` автоматически обновляет OAuth токен и повторяет запрос.  
При ответе `429` ждёт 60 секунд.

---

## app/services/auth/token_manager.py — TokenManager

OAuth2 Client Credentials flow для Stalcraft API.

**Поток:**
1. POST `https://exbo.net/oauth/token` → получаем `access_token`
2. Токен кешируется в Redis (`stalcraft:access_token`, TTL = expires_in - 60s)
3. При каждом запросе к API берём токен из кэша

**Методы:**
- `get_token()` — возвращает валидный токен (из Redis или запрашивает новый)
- `invalidate()` — сбрасывает кэш (вызывается при 401)

---

## app/services/catalog/github_parser.py — sync_catalog

Синхронизирует каталог предметов с GitHub репозиторием EXBO-Studio/stalcraft-database.

**Источник:** `https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru/listing.json`

**Логика:**
- Скачивает listing.json (~2236 предметов)
- Парсит item_id из пути (`/items/artefact/biochemical/04yr.json` → `04yr`)
- Определяет category из пути (`artefact/biochemical`)
- `can_be_batch_traded = False` для weapon, armor, attachment, weapon_modules, backpacks
- Делает UPSERT по `item_id` (обновляет если уже есть)

---

## app/services/analytics/market_stats.py — calculate_market_stats

Пересчитывает `market_statistics` для одного предмета одного пользователя.

**Входные данные:**
- `sales_history` за последние 30 дней
- `collected_data` снэпшоты

**Что рассчитывается:**
- Ценовая статистика за 24ч и 7 дней
- Волатильность цены (stdev / mean * 100)
- Лучший час и день продажи (по объёму сделок)
- Бонус выходного дня (средняя цена сб+вс vs будни)
- Среднее время продажи из выкупов (`avg_sell_time_hours`)
- `sell_options` — 3 ценовых варианта с прогнозом времени

**Алгоритм sell_options:**

Три ценовые точки:
- **Быстро**: `текущий_лучший_ликвидный * 0.99` — чуть ниже рынка
- **Нормально**: `медиана_7д * 0.97` — рыночная цена
- **Выгодно**: `медиана_7д * 1.03` — выше рынка

Прогноз времени:
- Если выкупов ≥ 5 → берём реальные данные (интерполяция по цене)
- Если выкупов 2-4 → масштабируем среднее время по тиру
- Если выкупов < 2 → эвристика: fast=3ч, normal=18ч, premium=60ч

`confidence`: `low` (<2 выкупов), `medium` (2-4), `high` (≥5).

---

## app/tasks/collectors.py — логика сбора

### `_collect_lots_for_item(db, entry)`

1. Запрашивает активные лоты через API
2. Разделяет на **ликвидные** (endTime > now + 2ч) и **истекающие** (< 2ч)
3. Рассчитывает цены только по ликвидным лотам (`best_liquid_price_per_unit`)
4. Сравнивает с предыдущим снэпшотом для **детектирования выкупов**:
   - Лот исчез ДО истечения (с буфером 10 мин) → лот выкупили
   - Создаёт запись в `sales_history` с `source=buyout_detection`
5. Сохраняет снэпшот в `collected_data`

### `_collect_history_for_item(db, entry)`

Запрашивает историю продаж из API и сохраняет в `sales_history`.  
`price` из API — это итоговая цена за весь лот, `price_per_unit = price // amount`.

---

## app/services/cache/api_cache.py — ApiCache

Redis-кэш для ответов Stalcraft API. Снижает количество реальных запросов к API.

**TTL:**
- Активные лоты (`/lots`): 5 минут
- История продаж (`/history`): 60 минут

**Ключи Redis:**
- `stalcraft:cache:{region}:{item_id}:lots`
- `stalcraft:cache:{region}:{item_id}:history`

**Методы:**
- `get_or_fetch_lots(region, item_id)` — главный метод: кэш → API → кэш
- `set_lots / set_history` — записать в кэш (вызывается worker-ом после сбора)
- `invalidate_lots` — сбросить кэш лотов

**Поток данных:**
1. Celery worker собирает лоты → сохраняет в PostgreSQL + обновляет Redis-кэш
2. `GET /api/v1/lots/{item_id}` → читает из Redis-кэша → если пуст, идёт в API

---

## app/api/v1/endpoints/lots.py — быстрый поиск лотов

`GET /api/v1/lots/{item_id}?region=RU`

Возвращает активные лоты без добавления товара в watchlist.  
Данные берутся из Redis-кэша (TTL 5 мин). Поле `from_cache` в ответе показывает источник.

Лоты в ответе:
- Отсортированы: сначала ликвидные (> 2ч), потом по цене
- Поле `is_expiring = true` если лоту осталось < 2ч
- Поле `hours_remaining` — сколько часов осталось до истечения

---

## app/core/rate_limiter.py — TokenBucketRateLimiter

Token Bucket алгоритм для соблюдения лимита Stalcraft API (100 токенов/мин).

**Хранение в Redis:**
- Ключ: `stalcraft:rate_limit`
- Поля: `tokens` (текущий остаток), `last_refill` (unix timestamp)
- TTL: 120 секунд

**Lua скрипт** обеспечивает атомарность: проверка и списание токенов в одной операции — нет гонки при нескольких воркерах.

При недоступности Redis переключается на **in-memory fallback** (один процесс, без гарантий при нескольких воркерах).

---

## Правило обновления документации

При каждом изменении схемы БД:
1. Обновить `docs/DATABASE.md` (добавить поле в нужную таблицу)
2. Добавить строку в таблицу Миграции

При добавлении нового сервиса или Celery задачи:
1. Добавить раздел в `docs/SERVICES.md`
2. Если задача по расписанию — обновить таблицу расписания
