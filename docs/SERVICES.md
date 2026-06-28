# Сервисы и задачи — описание

---

## Celery задачи (расписание)

| Задача | Расписание | Модуль | Описание |
|--------|-----------|--------|----------|
| `collect_all_active_lots` | каждые 20 сек | `app.tasks.collectors` | Динамический batch: ceil(due/3), min=5, max=50. Цель: полный цикл ≤60 сек при любом объёме watchlist |
| `collect_all_history` | раз в час (мин. 0) | `app.tasks.collectors` | История для watchlist предметов |
| `calculate_all_market_stats` | раз в час (мин. 5) | `app.tasks.analyzers` | Пересчёт market_statistics (включая 24ч/48ч/7д/30д окна) |
| `delete_old_data` | ежедневно 03:00 | `app.tasks.cleanup` | Данные старше 120 дней |
| `sweep_expired_tiers` | ежедневно 03:30 | `app.tasks.tiers` | Понижение до `base` пользователей с истёкшим `tier_expires_at` + деактивация лишних карточек watchlist сверх нового лимита |

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

### Логика collect_all_active_lots (динамический batch)

Задача запускается каждые 20 секунд, обрабатывает только предметы, которым пора обновиться.
Размер батча вычисляется динамически — чтобы полный цикл обновления всех предметов укладывался в ~60 сек при любом объёме watchlist:

```python
LOTS_REFRESH_INTERVAL = 20    # секунд между запусками задачи
LOTS_REQUEST_DELAY    = 0.2   # секунд между API-запросами внутри запуска
TARGET_CYCLE_SEC      = 60    # целевой полный цикл (1 мин)
MAX_LOTS_PER_RUN      = 50    # потолок: 50 × 0.2с = 10с < 20с расписания
MIN_LOTS_PER_RUN      = 5     # минимум

refresh_threshold = now - timedelta(seconds=LOTS_REFRESH_INTERVAL)

# Берём только «просроченные» пары (order by last_successful_check ASC NULLS FIRST)
due_pairs = {
    (e.item_id, e.region): e
    for e in watchlist
    if e.last_successful_check is None or e.last_successful_check < refresh_threshold
}

# Динамический batch: сколько нужно взять чтобы покрыть всё за TARGET_CYCLE_SEC
runs_per_cycle = TARGET_CYCLE_SEC / LOTS_REFRESH_INTERVAL   # = 3 запуска за 1 мин
dynamic_batch  = max(MIN_LOTS_PER_RUN, min(ceil(len(due_pairs) / runs_per_cycle), MAX_LOTS_PER_RUN))
pairs_to_collect = dict(list(due_pairs.items())[:dynamic_batch])
```

| Уникальных предметов | batch | Цикл | Запросов/мин | % лимита |
|---|---|---|---|---|
| 15 | 5 | ~60с (~1 мин) | ~30 | 7.5% |
| 50 | 17 | ~60с (~1 мин) | ~100 | 25% |
| 100 | 34 | ~60с (~1 мин) | ~200 | 50% |
| 200 | 50 (max) | ~80с | ~300 | 75% |
| 800 | 50 (max) | ~320с | ~300 | 75% |

Лимит архитектуры: при насыщении `MAX_LOTS_PER_RUN=50` сбор лотов стабилизируется на ~150 запросов/мин (~300 токенов, 75% от 400), независимо от размера watchlist — запас остаётся для `/history` и калибровочных задач.

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

## app/services/analytics/pricing.py — общие хелперы расчёта цены

Чистые функции без обращения к БД, используются `profitable_lots.py`,
`market_stats.py` и `monitoring.py` — единая логика sell_options/риска/профита.

**Константы:**
- `COMMISSION = 0.05` — комиссия аукциона
- `GLITCH_RATIO = 0.05`, `TREND_DROP_RATIO = 0.75` — пороги для `compute_reference`
- `STALE_SECONDS = 90` — снэпшот старше → сигналу не доверяем
- `HIGH_VOLATILITY = 30.0`, `MED_VOLATILITY = 15.0` — пороги `classify_risk`
- `RISK_MARGIN_MULT = {low: 1.0, medium: 1.3, high: 1.6}` — множитель требуемой маржи
- `MIN_BATCH_SAMPLES = 3`, `BATCH_BUCKETS` — пороги/бакеты для поправки на размер пачки

**Функции:**
- `classify_risk(volatility_pct)` → `low`/`medium`/`high` по волатильности 7д
- `compute_reference(median_hist, median_now, current_min)` — опорная цена `ref`:
  приоритет `median_price_7d` (стабильный исторический ориентир, независимый от
  текущего скана — иначе профит математически невозможен). `median_now` (медиана
  текущего снэпшота) — только trend-guard: если `median_now < median_hist × 0.75`,
  рынок "просел" (`trend="falling"`), `ref` корректируется консервативно вниз.
  Возвращает `{ref, source: "history"|"current_fallback", trend}`.
- `make_sell_options(ref, volume_7d, time_price_pairs=None)` — 3 ценовые точки
  fast/normal/premium (`ref × 0.97/1.00/1.05`) с прогнозом времени (см. ниже,
  логика идентична `market_stats._calculate_sell_options`)
- `batch_bucket_for_amount(amount)` — бакет размера пачки (`x1`, `x2_5`, ... `x51_plus`)
- `evaluate_lot_profit(buyout_per_unit, amount, sell_options, risk, min_margin_pct, batch_stats)`:
  профит считается от тира **"fast"**; при ≥`MIN_BATCH_SAMPLES` реальных продажах
  в том же бакете (`market_statistics.batch_stats`) цена продажи корректируется
  пропорционально медианной цене пачки; требуемая маржа = `min_margin_pct × RISK_MARGIN_MULT[risk]`.
  Возвращает `None` если невыгодно, иначе `{profit, profit_pct, profit_per_hour, tier_used, sell_price_used}`.
- `format_hours(hours)` — человекочитаемое форматирование времени (`~3 ч`, `~2 дня`, ...)

---

## app/services/analytics/market_stats.py — calculate_market_stats

Пересчитывает `market_statistics` для одного предмета одного пользователя.

**Входные данные:**
- `sales_history` за последние 30 дней
- `collected_data` снэпшоты

**Что рассчитывается:**
- Ценовая статистика за 24ч, 48ч (Phase 0, под тарифы `advanced`+) и 7 дней
- Волатильность цены (stdev / mean * 100)
- Лучший час и день продажи (по объёму сделок)
- Бонус выходного дня (средняя цена сб+вс vs будни)
- Среднее время продажи из выкупов (`avg_sell_time_hours`)
- `sell_options` — 3 ценовых варианта с прогнозом времени
- `demand_signals` — информационный bulk_spike сигнал (`_recent_bulk_signal`): доля
  объёма продаж в пачках ≥10 шт за последние 24ч vs базовая доля за ~29 дней;
  `bulk_spike=true` при резком росте (>= `BULK_SPIKE_MIN_SHARE` и в
  `BULK_SPIKE_MULTIPLIER` раз больше базовой доли). `None`, если в одном из окон
  меньше `MIN_SALES_FOR_STATS` продаж. Не блокирует и не усиливает сигнал —
  только отображается в `/monitoring/item/{id}`.

**Алгоритм sell_options** (`pricing.make_sell_options`):

Три ценовые точки (все относительно `ref`):
- **Быстро** (`fast`): `ref × 0.97` — ниже рынка
- **Нормально** (`normal`): `ref × 1.00` — по рынку
- **Выгодно** (`premium`): `ref × 1.05` — выше рынка

`net_price_per_unit = price × 0.95` — цена после комиссии аукциона 5% (показывается рядом с ценой выставления).

**Лучший час/день продажи** (best_sell_hour / best_sell_day):  
Взвешенный скор: 60% цена + 40% объём продаж по часам/дням.  
`sell_hours_by_day` — лучший час продажи для каждого дня недели (`{"Monday": 20, ...}`).

**Лучший час/день покупки** (best_buy_hour / best_buy_day):  
Час с минимальной средней ликвидной ценой по снэпшотам `collected_data`.  
`buy_hours_by_day` — лучший час покупки для каждого дня недели.

**Прогноз времени (coverage-based):**
- `coverage = matched_count / total_sales_30d × 100%`
- **high** (≥30% AND ≥10 точек) → интерполяция по реальным данным
- **medium** (10–30% AND ≥3 точки) → среднее × множитель по тиру
- **low** (<10%) → эвристика по продажам/день:
  - >8/д: fast=2ч, normal=8ч, premium=24ч
  - >2/д: fast=8ч, normal=24ч, premium=72ч
  - >0.3/д: fast=24ч, normal=72ч, premium=168ч
  - ≤0.3/д: fast=72ч, normal=168ч, premium=336ч

`confidence`: `low` / `medium` / `high` — по coverage, не по числу выкупов.

---

## app/tasks/collectors.py — логика сбора

### `_collect_lots_for_item(db, entry)`

1. Запрашивает активные лоты через API
2. Разделяет на **ликвидные** (endTime > now + 2ч) и **истекающие** (< 2ч)
3. Рассчитывает цены только по ликвидным лотам (`best_liquid_price_per_unit`)
4. Сохраняет снэпшот в `collected_data` с `user_id=None` (глобальный)
5. Вызывает `_publish_signals` — записывает предвычисленные выгодные лоты в Redis

### `_publish_signals(db, item_id, region, snap)`

После каждого успешного сбора пишет в Redis ключ `signals:{user_id}:{item_id}:{region}:{qf}:{ef}` (TTL 300 сек) для каждой watchlist-записи с этим предметом, передавая личные `min_profit_margin_percent`/`exclude_less_than_amount` из `user_settings`.

Логика из `app/services/profitable_lots.py` (`compute_signals_for_entry`):
- Если снэпшот старше `STALE_SECONDS=90` сек — возвращает `None` (сигнал не публикуется)
- `ref`/`trend` — через `pricing.compute_reference` (приоритет `median_price_7d`, trend-guard по медиане текущего снэпшота, для фильтрованных записей — медиана по тем же qlt/ptn из `raw_lots`)
- Отфильтровывает истекающие лоты (< 2ч), лоты с `amount < exclude_less_than_amount` и невыгодные (`pricing.evaluate_lot_profit` возвращает `None`)
- Профитные лоты сортируются по `profit_per_hour` (убывание)
- Возвращает: `{lots, sell_options, volume_7d, volatility_7d, ref, ref_source, trend, risk, total_profitable_amount, saturation_ratio, computed_at}`
  - `lots[i]` дополнительно содержит `profit`, `profit_pct`, `profit_per_hour`, `tier_used`, `sell_price_used`
  - `saturation_ratio = total_profitable_amount / (sales_volume_7d / 7)` — индикатор перенасыщения рынка профитными лотами (`None`, если `sales_volume_7d` отсутствует/0)

Один и тот же ключ `signals:*` читают: Telegram-бот, `GET /monitoring/signals/{item_id}`, и фронтенд (`GlobalFeed`/`feedStore` и `LotStatCard`, поллинг 30 сек) — единая точка истины, рассинхрон между лентой/карточкой/ботом невозможен (2026-06-15).

### Калибровочный лог `signal_outcomes`

После публикации сигналов, для каждой уникальной комбинации `(quality_filter, enchant_filter)`
из watchlist-записей этого `(item_id, region)`, `_publish_signals` вызывает
`compute_signals_for_entry` ещё раз с `min_profit_margin_pct=0, exclude_less_than_amount=1`
(независимо от персональных настроек) и логирует найденные профитные лоты через
`_log_signal_outcomes` (`INSERT ... ON CONFLICT DO NOTHING` по `(item_id, region, lot_start_time)`
в таблицу `signal_outcomes`, см. `docs/DATABASE.md`). Комбинации с фильтрами обрабатываются
первыми — если один лот попадает под несколько комбинаций, в таблице остаётся запись с более
точным (не "средним по больнице") `ref`. Задача `app.tasks.analyzers.evaluate_signal_outcomes`
(раз в сутки) сверяет эти записи с `sales_history` для будущей калибровки констант `pricing.py`.

### Разовые задачи (цепочка при добавлении в watchlist)

| Задача | Модуль | Описание |
|--------|--------|----------|
| `collect_single_item(user_id, item_id, region)` | `app.tasks.collectors` | Снэпшот активных лотов |
| `collect_history_single(user_id, item_id, region)` | `app.tasks.collectors` | История продаж |
| `calculate_stats_single(item_id, region)` | `app.tasks.analyzers` | Пересчёт market_statistics |

`POST /watchlist/` запускает Celery chain: `collect_single_item → collect_history_single → calculate_stats_single`.  
Карточка заполняется за ~30–60 сек вместо ожидания планировщика (до 55 минут).

### `collect_history_single(user_id, item_id, region)` (Celery task)

Разовый сбор истории для одного предмета. Запускается сразу после добавления товара в watchlist, чтобы не ждать ближайшего планового запуска `collect_all_history`.

### `_collect_history_for_item(db, entry)`

Запрашивает историю продаж из API и сохраняет в `sales_history`.  
`price` из API — итоговая цена за весь лот, `price_per_unit = price // amount`.

**user_id:** записи сохраняются с `user_id = entry.user_id` (пользователь, чей watchlist вызвал сбор).  
`sales_history.user_id NOT NULL` — в отличие от `collected_data` и `market_statistics`.  
Дедупликация по `sale_time` работает **глобально** (без фильтра по user_id): первый коллектор сохраняет запись, остальные пропускают → данные не дублируются.

**Snapshot-history matching** — восстанавливает `lot_start` для каждой продажи:
- Для каждой новой продажи ищем лот в снэпшотах `collected_data` где:  
  `lot.buyoutPrice == sale.total_price` AND `lot.amount == sale.amount` AND `lot.endTime > sale_time`
- Лот присутствовал в снэпшоте ДО продажи и отсутствует ПОСЛЕ → выкупили
- Найденный `lot_start` сохраняется в `sales_history.additional_info`
- `время_на_рынке = sale_time - lot_start` — основа для прогноза времени продажи

---

## app/api/v1/endpoints/monitoring.py — история продаж

### `GET /monitoring/sales-chart/{item_id}?region=RU&hours=N`

Возвращает данные для графика истории продаж в карточке Избранного.

**Режим зависит от `hours`:**

| hours | mode | Что возвращает |
|-------|------|----------------|
| < 168 | `scatter` | Каждая продажа отдельно: `sale_time`, `price_per_unit`, `amount` |
| ≥ 168 (7д) | `daily` | Агрегат по дням: `min_price`, `avg_price`, `max_price`, `count` |

**Ответ:**
```json
{
  "mode": "scatter",
  "sales": [
    { "sale_time": "2026-06-01T14:23:00+03:00", "price_per_unit": 4000000, "amount": 1 }
  ],
  "days": [],
  "total_count": 39
}
```

Данные берутся из `sales_history` без фильтра по `user_id` — рыночная история публична для всех пользователей.

**Гейтинг по тарифу (Phase 0):** если запрошенный `hours` превышает максимум, разрешённый тарифом пользователя (`max_stats_hours()` в `app/core/tiers.py`), возвращается пустой результат (`sales: [], days: [], total_count: 0`), а не 403 — фронтенд (`SalesHistoryCharts.tsx`) различает «заблокировано тарифом» от «данных нет» через `user.stats_windows` (известно на фронте до запроса), не через содержимое ответа. Тот же гейт применён к `GET /monitoring/history/{item_id}` (используется не фронтендом напрямую, но публично доступен через API, дыра была идентичной).

> Это была изначально незащищённая дыра, обнаруженная после первого прохода реализации тарифов: маскировка добавлялась только в `GET /monitoring/item/{item_id}`, а графики «История продаж» идут отдельным путём через этот эндпоинт.

---

## app/core/tiers.py + app/tasks/tiers.py — тарифы (Phase 0)

`app/core/tiers.py` — центральная точка истины по лимитам тарифов (полная матрица — `docs/BUSINESS_LOGIC.md` §17). Ключевые функции:
- `get_tier_limits(user)` — лимиты для пользователя; `is_admin=True` обходит лимиты целиком независимо от `user.tier`.
- `max_stats_hours(limits)` — максимум часов истории по самому широкому разрешённому окну (`{"24h":24, "48h":48, "7d":168, "30d":720}`), используется в `monitoring.py` для гейтинга графиков.
- `apply_tier_expiry(user, db)` — ленивое понижение до `base` при истёкшем `tier_expires_at`, вызывается из `get_current_user` (`app/core/dependencies.py`) на каждый авторизованный запрос.
- `deactivate_excess_watchlist(user_id, new_limit, db)` — деактивирует (`is_active=False`) карточки watchlist сверх нового лимита, оставляя активными самые старые по `created_at`. Вызывается при ленивом понижении, в `sweep_expired_tiers` и при ручной смене тарифа админом (`POST /admin/users/{id}/tier`), если новый лимит меньше текущего.

`app/tasks/tiers.py` — Celery task `sweep_expired_tiers` (beat `crontab(hour=3, minute=30)`): SQL-выборка пользователей с `tier != 'base' AND tier_expires_at < now()`, для каждого — `deactivate_excess_watchlist` + понижение до `base`. Дополняет ленивое понижение — гарантирует, что админка не показывает устаревший тариф у давно неактивных пользователей. Не обращается к Stalcraft API.

`telegram_bot/bot.py::notify_profitable_lots` — третье условие в фильтре получателей: `user.is_admin or get_tier_limits(user).telegram_notifications` (помимо существующих `telegram_chat_id IS NOT NULL` и `user_settings.notify_telegram`). Гейтит только отправку уведомлений, не привязку аккаунта.

---

### Лента возможностей — раздел в разработке

`GET /monitoring/feed` и весь конвейер данных (`global_scanner`, таблицы
`global_item_scan`/`user_feed_exclusion`) удалены 2026-06-07 — метрика
"купи дешевле средней" оказалась методологически некорректной (средняя
цена ВЫСТАВЛЕННЫХ лотов ≠ цена реальной продажи). Вторая попытка
(`feed_watchlist`, фоновый коллектор `feed_collector.py`, 2026-06-09)
тоже убрана 2026-06-11. Подробности — см.
`docs/CHANGELOG.md`. `FeedPage.tsx` снова заглушка "в разработке", маршрут
`/app/feed` сохранён.

---

## app/services/cache/api_cache.py — ApiCache

Redis-кэш для ответов Stalcraft API. Снижает количество реальных запросов к API.

**TTL:**
- Активные лоты (`/lots`): 5 минут
- История продаж (`/history`): 60 минут

**Ключи Redis:**
- `stalcraft:cache:v2:{region}:{item_id}:lots`
- `stalcraft:cache:v2:{region}:{item_id}:history`

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

Token Bucket алгоритм для соблюдения лимита Stalcraft API (**400 запросов/мин**, verified 2026-06-07).

**Реальные параметры API:**
- Лимит: **400 запросов в минуту** (не 100 токенов!)
- Period: **60 сек ровно**
- Стоимость: /lots=2, /history=2, /emission=1
- Отслеживание: Headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`

**Хранение в Redis:**
- Ключ: `stalcraft:rate_limit`
- Поля: `tokens` (текущий остаток), `last_refill` (unix timestamp)
- TTL: 120 секунд

**Lua скрипт** обеспечивает атомарность: проверка и списание в одной операции — нет гонки при нескольких воркерах.

При недоступности Redis переключается на **in-memory fallback** (один процесс, без гарантий при нескольких воркерах).

**Минутный счётчик потребления (для админ-статистики):**
- Ключ: `stalcraft:requests:minute:{unix_minute}` (например `stalcraft:requests:minute:29234567`)
- При каждом успешном `acquire()` тот же `_LUA_ACQUIRE` атомарно делает `INCRBY needed` + `EXPIRE 120` на этот ключ — без отдельного round-trip к Redis, в той же транзакции, что списание токенов из bucket
- Метод `get_consumption_stats()` читает текущий минутный ключ, возвращает `{"requests_current_minute": int|None, "capacity_per_minute": 400, "source": "redis"|"fallback"}`
- Показывает только текущую минуту, без часовой/исторической агрегации (осознанно упрощённый скоуп — см. `docs/tasks/admin-stats.md`)
- Используется эндпоинтом `GET /admin/stats` (`backend/app/api/v1/endpoints/admin.py`) для карточки «Rate limit Stalcraft API» в `AdminPage.tsx`

---

## app/api/v1/endpoints/admin.py — GET /admin/stats

Гейтится `Depends(get_current_admin)`. Отдаёт агрегатные метрики для блока статистики в `AdminPage.tsx` одним round-trip:

- `users_by_tier: dict[str, int]` — `GROUP BY User.tier`
- `users_online_now: int` — `User.last_seen >= now() - ONLINE_THRESHOLD_MINUTES` (тот же порог, что в `GET /admin/users`)
- `unique_watchlist_pairs: int` — `DISTINCT (item_id, region) WHERE is_active=true`, та же семантика дедупликации, что в коллекторе (`collectors.py`)
- `total_watchlist_entries: int` — общее число активных записей `user_watchlist` (для контраста с уникальными парами)
- `rate_limit: dict` — результат `rate_limiter.get_consumption_stats()`

Фронтенд (`AdminPage.tsx`) грузит этот эндпоинт один раз при монтировании страницы (`loadStats()`) — без поллинга, снэпшот на момент открытия.

---

---

## Telegram-интеграция — текущая архитектура (polling)

### Почему polling, а не webhook

Хостинг-провайдер (`161.104.44.231`) блокирует исходящие TCP-соединения к диапазону Telegram Bot API (`149.154.x.x:443`). Webhook требует исходящего соединения для регистрации и для отправки сообщений. Polling работает, потому что использует long-polling GET к тем же IP, но через уже установленное соединение — видимо проходит в другой момент времени или через другой путь.

### Поток

```
telegram_bot (polling) ←→ api.telegram.org  (команды + уведомления)
backend (FastAPI)          → /api/v1/telegram/* (link-code, status, unlink)
```

**Сервис:** `telegram_bot` в `docker-compose.prod.yml` → `python /tg_bot/bot.py`  
**Код:** `telegram_bot/bot.py` — команды `/start /link /status /stop` + цикл уведомлений (каждые 30 сек)  
**Celery `scan_and_notify`:** **отключён** (дубль с polling-циклом бота)

### Поток привязки аккаунта

1. Пользователь нажимает «Получить код» → `GET /api/v1/telegram/link-code` → 6-значный код в Redis (TTL 10 мин)
2. Отправляет боту: `/link 123456`
3. Бот (polling) читает команду, ищет код в Redis → сохраняет `telegram_chat_id` в таблицу `users`
4. `GET /api/v1/telegram/status` → `is_linked: true`

### Цикл уведомлений (`bot.py`)

| Параметр | Значение |
|----------|----------|
| Интервал | каждые 15 сек (только чтение Redis — быстро) |
| Dedup TTL | 48 ч (Redis ключ `tg_sent:{user_id}:{item_id}:{region}:{qlt}:{enchant}:{startTime}`) |
| Порог прибыли | `normal_net_price > buy_price` |
| Формат сообщения | все 3 опции с ✅/❌, явно "выставить X → получишь Y → прибыль Z" |

---

## Откат Telegram на polling-режим

Если webhook перестал работать (например, домен недоступен), можно быстро вернуть `bot.py` (polling):

**Шаг 1 — вернуть сервис в `docker-compose.prod.yml`:**

```yaml
  telegram_bot:
    build: ./backend
    env_file: .env
    environment:
      DATABASE_URL: postgresql+asyncpg://stalcraft:${POSTGRES_PASSWORD}@postgres:5432/stalcraft
      REDIS_URL: redis://redis:6379/0
    volumes:
      - ./telegram_bot:/tg_bot
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: python /tg_bot/bot.py
    restart: unless-stopped
```

**Шаг 2 — убрать `TELEGRAM_WEBHOOK_URL` из `backend` environment** (или оставить пустым — `register_webhook()` пропустит регистрацию если URL пустой).

**Шаг 3 — деплой:**

```bash
docker-compose -f docker-compose.prod.yml up -d --build telegram_bot backend
```

`bot.py` использует **polling** — при старте автоматически снимает вебхук с Telegram.  
Уведомления в `bot.py` запускаются собственным asyncio-циклом (каждые 30 сек), независимо от Celery.  

> ⚠️ Polling и webhook нельзя использовать одновременно. При polling `TELEGRAM_WEBHOOK_URL` должен быть пустым, иначе при старте `backend` он снова зарегистрирует webhook и сломает polling.

---

## Правило обновления документации

При каждом изменении схемы БД:
1. Обновить `docs/DATABASE.md` (добавить поле в нужную таблицу)
2. Добавить строку в таблицу Миграции

При добавлении нового сервиса или Celery задачи:
1. Добавить раздел в `docs/SERVICES.md`
2. Если задача по расписанию — обновить таблицу расписания
