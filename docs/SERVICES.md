# Сервисы и задачи — описание

---

## Celery задачи (расписание)

| Задача | Расписание | Модуль | Описание |
|--------|-----------|--------|----------|
| `collect_all_active_lots` | каждые 20 сек | `app.tasks.collectors` | Динамический batch: ceil(due/3), min=5, max=50. Цель: полный цикл ≤60 сек при любом объёме watchlist |
| `collect_all_history` | раз в час (мин. 0) | `app.tasks.collectors` | История для watchlist предметов. Обрабатывает уникальные пары параллельно (`HISTORY_CONCURRENCY=6` чанков, см. ниже) — фикс CPU-спайков на проде 2026-06-29. Окно :00–:11 зарезервировано под неё (сдвиг фаз с `calculate_market_stats_batch`); цепочка `calculate_all_market_stats.delay()` в конце удалена 2026-07-07 |
| `calculate_market_stats_batch` | каждые 5 мин (:12–:57) | `app.tasks.analyzers` | Порционный пересчёт market_statistics: 10 слотов в час, слот пары = `crc32(f"{item_id}\|{region}") % 10`; дифф-пропуск пар без новых продаж (один SQL-запрос: `sales_history.collected_at > market_statistics.calculated_at`, окно 26ч, индекс `ix_sales_collected_at`); пары без строки market_statistics считаются всегда; в 04:12–04:57 МСК — force-круг без диффа (полное обновление всех пар раз в сутки). Введена 2026-07-07 вместо ежечасного залпа 193–236с |
| `calculate_all_market_stats` | — (ручной инструмент, из расписания и цепочки убрана 2026-07-07) | `app.tasks.analyzers` | Полный пересчёт market_statistics всех активных пар (включая 24ч/48ч/7д/30д окна) — запуск вручную через `celery call`, например после миграций |
| `delete_old_data` | ежедневно 03:00 | `app.tasks.cleanup` | Данные старше 120 дней |
| `sweep_expired_tiers` | ежедневно 03:30 | `app.tasks.tiers` | Понижение до `base` пользователей с истёкшим `tier_expires_at` + деактивация лишних карточек watchlist сверх нового лимита |
| `collect_emission` | каждые 2 мин | `app.tasks.collectors` | Опрос `GET /RU/emission`, детект start/end выброса, Redis-дедупликация (`emission:current_fingerprint`), запись событий в `emission_events` (старт → `notified=False`; конец → `ended_at`; seed первого запуска → `notified=True, end_notified=True`). С 2026-07-08 worker сам НЕ рассылает Telegram — рассылку делает `telegram_bot::notify_emission_events` (см. раздел Telegram) |

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
При ответе `429` — немедленный `raise RuntimeError` без блокировки worker-слота
(с 2026-07-06; ранее был блокирующий `sleep(60)`, растягивавший весь батч).
Retry происходит естественно через механизм `due_pairs`: упавший item не
получает `last_successful_check` и попадает в следующий 20-секундный тик
коллектора. Исключение: `backend/app/scripts/backfill_sales_qlt.py` держит
свою явную паузу 60с перед ретраем страницы внутри самого скрипта.

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
- `_build_sales_filter(quality_filter, enchant_filter)` — строит доп. условия фильтрации `SalesHistory` по `qlt`/`ptn` из `additional_info` (перенесена сюда 2026-06-28 из `app/api/v1/endpoints/monitoring.py`, чтобы сервисный слой `market_radar.py` не импортировал из слоя api/endpoints); используется в `monitoring.py` (history-эндпоинты) и в `market_radar.py` (медиана 7д для бакетов с заданным quality/enchant).
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

**Переиспользование под фильтром qlt/ptn** (← 2026-07-24, коммит `0367a96`):  
Блок «лучшее время продажи» вынесен в чистый хелпер `derive_sell_timing(sales)`
(`weighted_score` + `WEIGHT_PRICE`/`WEIGHT_VOLUME` подняты на уровень модуля), buy-side-прокси —
`derive_buy_timing(sales)` (час/день с минимальной средней ценой отфильтрованных продаж, вариант
B1). Ветка «с фильтром качества/заточки» эндпоинта `GET /monitoring/item/{id}` вызывает эти
хелперы + `_calculate_batch_stats`/`_avg_sell_time_from_buyouts` на отфильтрованном
`sales_history` за 30д (один фетч строк вместо двух scalar-запросов), чтобы `best_sell_*`,
`sell_hours_by_day`, `weekend_bonus`, `avg_sell_time_hours`, `batch_stats` и `best_buy_*`
соответствовали выбранной вариации. `calculate_market_stats` (агрегатная ветка) по поведению
не изменилась.

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

### `collect_all_history` — параллельная обработка (фикс CPU-спайков 2026-06-29)

Раньше обрабатывала все уникальные пары `(item_id, region)` watchlist строго
последовательно (один `await` за раз) — прогон занимал 50+ секунд и
пересекался по времени с `collect_all_active_lots` (каждые 20с) на втором
forked worker-процессе, нагружая оба vCPU прода одновременно раз в час.

Теперь `unique_entries` делится round-robin на `HISTORY_CONCURRENCY = 6`
чанков (`unique_entries[i::HISTORY_CONCURRENCY]`), чанки обрабатываются
параллельно через `asyncio.gather`, каждый — в своей корутине со своей
`get_celery_db_session()` на весь чанк (одна `AsyncSession` нельзя
использовать параллельно из нескольких корутин). Внутри чанка items
обрабатываются последовательно с тем же per-item `try/except` +
`logger.error`. Количество запросов к Stalcraft API не изменилось
(`rate_limiter.py` централизован, не зависит от конкурентности вызовов) —
изменилось только время выполнения (секунды вместо 50+).
`force_refresh_all_history` и `_collect_history_for_item` не затронуты.

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

Один и тот же ключ `signals:*` читают: `GET /monitoring/signals/{item_id}` и фронтенд (`GlobalFeed`/`feedStore` и `LotStatCard`, поллинг 30 сек) — единая точка истины, рассинхрон между лентой и карточкой невозможен (2026-06-15). До 2026-07-21 из `signals:*` уведомления читал и Telegram-бот (polling); теперь он консьюмер RabbitMQ (событие `profitable_lot` несёт тот же `signal`) — см. раздел «Telegram».

**Публикация `buymin:*` для Buy Sniper (2026-07-19):** дополнительно, для каждой
активной watchlist-записи `_publish_signals` вычисляет `cheapest_matching_lot`
(`app/services/profitable_lots.py` — проходит `snap.raw_lots`, фильтрует по
`_is_liquid` и `quality_filter`/`enchant_filter`, возвращает лот с минимальной `buyout // amount`)
и пишет Redis-ключ `buymin:{user_id}:{item_id}:{region}:{qlt}:{ench}` (JSON лота,
TTL `SIGNALS_TTL=300`с). В отличие от `signals:*` публикуется **всегда** — даже
когда лот не прибыльный для перепродажи (buy-alert срабатывает на любой лот
≤ порога, независимо от `evaluate_lot_profit`). Ключ читает эндпоинт
`GET /buy-sniper/` (обогащение `current_min`). До 2026-07-21 его читал и бот
(polling `notify_buy_alerts`); теперь бот получает `cheapest` прямо из события
`buy_alert` в RabbitMQ — из `buymin:*` уже не читает.

**Публикация push-событий в RabbitMQ (2026-07-20):** параллельно записи в Redis
`_publish_signals` публикует события в exchange `push.events` через
`app/services/push_broker.py`: `profitable_lot` (когда есть выгодные лоты, несёт
весь signal) и `buy_alert` (только при пересечении `BuyAlert.target_price`).
`_collect_emission_async` публикует `emission` start/end. Канал открыт на батч и
закрыт в finally (как `redis_client`). Публикация **best-effort** — недоступность
RabbitMQ не ломает сбор данных. Потребители — ДВЕ durable-очереди на одном
DIRECT-exchange `push.events` (fan-out по routing_key `push`): `push.notifications`
(сервис `push_service`, web push) и с 2026-07-21 `telegram.notifications` (сервис
`telegram_bot`). Продюсер не меняется от добавления второй очереди — см. разделы
«Web Push» и «Telegram».

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
- `get_tier_limits(user)` — лимиты для пользователя; `is_admin=True` обходит лимиты целиком независимо от `user.tier`. `watchlist_limit` в результате строится через `effective_watchlist_limit(user)` — учитывает override.
- `effective_watchlist_limit(user) -> int | None` — эффективный лимит карточек watchlist: `None` для `is_admin=True`; иначе `user.favorites_limit_override`, если задан (не `NULL`), иначе `TIERS[user.tier].watchlist_limit`. Override **заменяет** лимит тарифа целиком, не складывается с ним (см. `docs/BUSINESS_LOGIC.md` §17, подраздел «Override лимита избранного»). Используется в `get_tier_limits()` и при деактивации лишних карточек на смене/истечении тарифа — override переживает смену тарифа пользователя.
- `max_stats_hours(limits)` — максимум часов истории по самому широкому разрешённому окну (`{"24h":24, "48h":48, "7d":168, "30d":720}`), используется в `monitoring.py` для гейтинга графиков.
- `apply_tier_expiry(user, db)` — ленивое понижение до `base` при истёкшем `tier_expires_at`, вызывается из `get_current_user` (`app/core/dependencies.py`) на каждый авторизованный запрос. Использует `effective_watchlist_limit(user)` (не жёсткий лимит `base`) при деактивации лишних карточек — override не сбрасывается понижением тарифа.
- `deactivate_excess_watchlist(user_id, new_limit, db)` — деактивирует (`is_active=False`) карточки watchlist сверх нового лимита, оставляя активными самые старые по `created_at`. Вызывается при ленивом понижении, в `sweep_expired_tiers`, при ручной смене тарифа админом (`POST /admin/users/{id}/tier`) и при установке/снижении `favorites_limit_override` через `POST /admin/users/{id}/favorites-limit-override`, если новый эффективный лимит меньше текущего количества активных карточек.

`app/tasks/tiers.py` — Celery task `sweep_expired_tiers` (beat `crontab(hour=3, minute=30)`): SQL-выборка пользователей с `tier != 'base' AND tier_expires_at < now()`, для каждого — `deactivate_excess_watchlist` + понижение до `base`. Дополняет ленивое понижение — гарантирует, что админка не показывает устаревший тариф у давно неактивных пользователей. Не обращается к Stalcraft API.

`POST /admin/users/{user_id}/favorites-limit-override` (`backend/app/api/v1/endpoints/admin.py`, `Depends(get_current_admin)`) — устанавливает или снимает `User.favorites_limit_override` (`{"override": int | None}`, `Field(None, ge=0)`). Если новый эффективный лимит меньше текущего количества активных карточек пользователя — вызывает `deactivate_excess_watchlist`. `set_user_tier` обновлён аналогично: при смене тарифа лишние карточки деактивируются по `effective_watchlist_limit(user)`, а не по жёсткому лимиту нового тарифа — override переживает смену тарифа.

`telegram_bot/bot.py::notify_profitable_lots` — третье условие в фильтре получателей: `user.is_admin or get_tier_limits(user).telegram_notifications` (помимо существующих `telegram_chat_id IS NOT NULL` и `user_settings.notify_telegram`). Гейтит только отправку уведомлений, не привязку аккаунта. С 2026-07-06 тело цикла `for entry in watchlist:` обёрнуто в try/except с per-entry логированием — сбой одной watchlist-записи (например, транзиентная ошибка БД) не прерывает обработку остальных записей и пользователей в текущем 15-секундном цикле.

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

`acquire()` принимает опциональный параметр `redis_client` (2026-07-06): `collect_all_active_lots` создаёт один shared `aioredis`-клиент на весь батч и передаёт его сюда (а также в `_publish_signals`) — вместо нового TCP-соединения на каждый вызов (до 100+ хендшейков за 20-секундный батч). По умолчанию `None` — прежнее поведение (собственное соединение) для всех вызовов вне батча, например `collect_all_history`.

**Минутный счётчик потребления (для админ-статистики):**
- Ключ: `stalcraft:requests:minute:{unix_minute}` (например `stalcraft:requests:minute:29234567`)
- При каждом успешном `acquire()` тот же `_LUA_ACQUIRE` атомарно делает `INCRBY needed` + `EXPIRE 120` на этот ключ — без отдельного round-trip к Redis, в той же транзакции, что списание токенов из bucket
- Метод `get_consumption_stats()` читает текущий минутный ключ, возвращает `{"requests_current_minute": int|None, "capacity_per_minute": 400, "source": "redis"|"fallback"}`
- Показывает только текущую минуту, без часовой/исторической агрегации (осознанно упрощённый скоуп — см. `docs/tasks/admin-stats.md`)
- Используется эндпоинтом `GET /admin/stats` (`backend/app/api/v1/endpoints/admin.py`) для карточки «Rate limit Stalcraft API» в `AdminPage.tsx`

---

## app/api/v1/endpoints/admin.py — GET /admin/stats

Гейтится `Depends(get_current_admin)`. Отдаёт агрегатные метрики для блока статистики в `AdminPage.tsx` одним round-trip:

- `users_by_tier: dict[str, int]` — `GROUP BY User.tier`, с явным zero-fill: словарь инициализируется `{tier: 0 for tier in TIERS}` и затем дополняется реальными счётчиками — гарантирует все 4 тарифа в ответе (с `0`, если по тарифу пока нет пользователей), а не только встретившиеся в `GROUP BY`. Фикс 2026-06-28 (карточка «Тарифы» в `AdminPage.tsx` изначально показывала только тарифы, у которых есть хотя бы один пользователь).
- `users_online_now: int` — `User.last_seen >= now() - ONLINE_THRESHOLD_MINUTES` (тот же порог, что в `GET /admin/users`)
- `users_active_today: int` — количество пользователей с `last_seen` после начала **текущих суток по московскому времени** (`timezone(timedelta(hours=3))`, тот же паттерн, что в `market_stats.py`) — календарный день МСК, не скользящие 24ч.
- `users_active_week: int` — количество пользователей с `last_seen` за последние 7×24 часа (скользящее окно от `datetime.now(timezone.utc)`, без привязки к календарной неделе — для скользящего окна MSK-сдвиг не имеет значения).
- `users_telegram_linked: int` — количество пользователей с `telegram_chat_id IS NOT NULL`. Это единственный достоверный признак реального подключения Telegram-бота (`telegram_username` сам по себе подключение не доказывает) — тот же признак использует `GET /telegram/status` (`telegram.py`).
- `unique_watchlist_pairs: int` — `DISTINCT (item_id, region) WHERE is_active=true`, та же семантика дедупликации, что в коллекторе (`collectors.py`)
- `total_watchlist_entries: int` — общее число активных записей `user_watchlist` (для контраста с уникальными парами)
- `rate_limit: dict` — результат `rate_limiter.get_consumption_stats()`

Фронтенд (`AdminPage.tsx`) грузит этот эндпоинт один раз при монтировании страницы (`loadStats()`) — без поллинга, снэпшот на момент открытия.

`UserAdminResponse` (`GET /admin/users`) дополнен полем `telegram_chat_id: int | None` (рядом с уже существующим `telegram_username`) — заполняется в `list_users`. Используется как раздельный источник данных от `telegram_username`: таблица пользователей в `AdminPage.tsx` показывает именно `telegram_username` (введённый юзернейм), а агрегатная метрика `users_telegram_linked` выше — `telegram_chat_id` (факт подключения бота). Это намеренная асимметрия между отображением в таблице и подсчётом статистики, не баг.

Добавлены 2026-06-28 — устранение пробела, см. `docs/tasks/admin-stats-gaps.md`.

---

## app/api/v1/endpoints/news.py — новости и анонсы

Файл: `backend/app/api/v1/endpoints/news.py`. Prefix `/news`, tags=["News"]. Подключён в `main.py` после `telegram_router`.

**Допустимые теги:** `обновление`, `тарифы`, `техработы`, `важно` (константа `ALLOWED_TAGS`, валидируется через `@validator` на входе). Поле `author_id` = `current_admin.id` при создании; SET NULL при удалении пользователя.

| Метод | URL | Auth | Описание |
|-------|-----|------|----------|
| GET | `/api/v1/news/` | user | Список опубликованных (`is_published=True`), `skip/limit=20`, ORDER BY `is_pinned DESC, created_at DESC` |
| GET | `/api/v1/news/{id}` | user | Одна новость (только published), 404 если нет |
| GET | `/api/v1/news/admin/all` | admin | Все новости включая черновики, `skip/limit=20` |
| POST | `/api/v1/news/` | admin | Создать, `author_id = current_admin.id` |
| PUT | `/api/v1/news/{id}` | admin | Частичное обновление (только переданные не-None поля) |
| DELETE | `/api/v1/news/{id}` | admin | Удалить, 404 если нет |

> `/api/v1/news/admin/all` объявлен до `/{id}` — FastAPI не трактует строку `"admin"` как `news_id`.

**Ответ (`NewsResponse`):** `id`, `author_id`, `author_username` (из `selectinload(News.author)`, `null` если автор удалён), `title`, `content`, `tags`, `is_pinned`, `is_published`, `created_at`, `updated_at`.

---

## app/services/analytics/market_radar.py — get_market_radar_aggregate

«Радар рынка» — кросс-юзерная агрегация `user_watchlist` (аддон `User.has_market_radar_addon`, не тариф, см. `docs/BUSINESS_LOGIC.md` §17). Эндпоинт `GET /market-radar/` (`backend/app/api/v1/endpoints/market_radar.py`), гейтится `Depends(get_market_radar_access)`.

**Входные данные:** только собственная БД — `user_watchlist`, `master_items`, `market_statistics`. Не делает новых обращений к Stalcraft API, не затрагивает rate limit.

**SQL-агрегация** (без новой Celery-задачи и без новой таблицы):
1. `SELECT item_id, quality_filter, enchant_filter, COUNT(DISTINCT user_id) AS watchers_count, COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '24 hours') AS new_watchers_24h FROM user_watchlist WHERE is_active=true GROUP BY item_id, quality_filter, enchant_filter LIMIT 500`. **Ревизия 2026-06-28:** `GROUP BY` дополнен `quality_filter, enchant_filter` (раньше — только `item_id`) — один `item_id` может занять несколько строк топа для разных комбинаций фильтров среди watcher'ов; `NULL`/`NULL` — отдельный бакет, PostgreSQL естественно разделяет его от заданных значений без доп. логики. **Ревизия 2026-06-29:** убран `ORDER BY watchers_count DESC` и `LIMIT 20` на этом запросе — `LIMIT` заменён на safety-cap `MAX_BUCKETS=500` (страховка от деградации при росте watchlist, не финальная сортировка). Реальная сортировка и обрезка на страницу — отдельный шаг после п.6, по `profitable_offers_count`.
2. JOIN `master_items` по `item_id` из топа — имя/иконка (`name_ru`, `name_en`, `icon_path`).
3. **Источник цены/объёма ветвится по бакету:**
   - `quality_filter IS NULL AND enchant_filter IS NULL` — JOIN глобальной `market_statistics` (`user_id IS NULL`) по `item_id` — `avg_price_24h`, `sales_volume_24h`, `demand_signals.bulk_spike`, `price_window="24h"`; `null`, если записи нет.
   - Бакет с хотя бы одним заданным фильтром — прямой запрос к `SalesHistory` (`price_per_unit`, `sale_time >= now() - 7d`, без фильтра по `region`) отфильтрованный через `_build_sales_filter(quality_filter, enchant_filter)` — функция перенесена из `backend/app/api/v1/endpoints/monitoring.py` в `backend/app/services/analytics/pricing.py` (общий сервисный модуль, чтобы services не импортировал из слоя api/endpoints; оба вызова в `monitoring.py` обновлены на импорт из нового места). Цена-ориентир = `statistics.median(prices)`, объём = `len(prices)`, `price_window="7d"`. Историческое покрытие qlt/ptn в `sales_history` было низким из-за бага парсинга `/history` (фикс 2026-06-29, см. `docs/NOTES.md`, `docs/BUSINESS_LOGIC.md`) — для старых записей без backfill `prices` всё ещё может быть пуст → оба поля `null` — ожидаемое поведение, строка не скрывается из топа.
   - `null` в обоих случаях — UI показывает «нет данных», предмет/бакет не скрывается из топа.
4. Сводка: `total_active_watchers` (`COUNT(*)` активных записей `user_watchlist`), `unique_items_tracked` (`COUNT(DISTINCT item_id)` активных).
5. Ответ API на каждый элемент `top_items` дополнен `quality_filter`, `enchant_filter`, `price_window` — фронт (`MarketRadarPage.tsx`) показывает чип качества/суффикс заточки и подпись окна цены под каждой строкой.
6. **`profitable_offers_count` (ревизия 2026-06-28, `_count_profitable_offers`):** на каждый бакет топа, если есть `avg_price` (п.3) — подзапрос `SELECT DISTINCT region FROM user_watchlist WHERE item_id=... AND is_active=true` (регионы по `item_id`, без фильтра quality/enchant — снэпшот лотов общий для всех бакетов одного `item_id`), затем на каждый найденный регион — последний глобальный снэпшот `SELECT * FROM collected_data WHERE item_id=... AND region=... AND user_id IS NULL ORDER BY collect_time DESC LIMIT 1`. `sell_options = make_sell_options(int(avg_price), sales_volume)` считается один раз на бакет (переиспользует уже посчитанные в п.3 значения, без повторного запроса). Каждый лот `raw_lots` снэпшота проверяется на `buyout>0`, `amount>0`, ликвидность (`_is_liquid`) и совпадение `quality_filter`/`enchant_filter` бакета (`_lot_quality_enchant`), затем `evaluate_lot_profit(risk="low", min_margin_pct=0.0)` — канонический порог без риск-надбавки (при `min_margin_pct=0.0` `risk` не влияет на результат математически, но передаётся явно, не как побочный эффект). Сумма выгодных лотов across регионов = `profitable_offers_count`; считается по уникальным физическим лотам снэпшота, не по watcher'ам — число не зависит от `watchers_count`. `None`, если `avg_price` бакета `None`. Не увеличивает TTL/не добавляет Celery-задачу — рост стоимости одного cache-miss (до ~60 доп. SQL-запросов снэпшотов на полный пересчёт топ-20, по индексу) признан некритичным при TTL=60с (см. `docs/tasks/market-radar.md`, ревизия 2, п.6).
   - **Перенос хелперов:** `_is_artefact`, `_lot_quality_enchant`, `_is_liquid` перенесены из `backend/app/services/profitable_lots.py` в `backend/app/services/analytics/pricing.py` (в дополнение к `_build_sales_filter`, перенесённой ревизией 1) — общий сервисный слой; `profitable_lots.py` импортирует их обратно.

Без минимального порога анонимности — в топ попадают предметы даже с 1 watcher'ом (Phase 1, осознанное решение).

7. **Сортировка и пагинация (ревизия 2026-06-29):** после п.6 (`profitable_offers_count` для всех бакетов до `MAX_BUCKETS=500`) — финальная сортировка по `profitable_offers_count DESC` (`None` → `0`). `watchers_count` больше не влияет на порядок.

**Сигнатура и кэш:** `get_market_radar_aggregate(db: AsyncSession, page: int = 1, page_size: int = 20) -> dict`. Redis, ключ `market_radar:aggregate`, TTL 60 сек (не изменился) — кэшируется **весь** отсортированный список бакетов (не срез страницы), пагинация — `top_items[start:end]` в Python после чтения из кэша, без отдельного ключа на страницу и без `COUNT(*) OVER()` (метрика сортировки вычисляется в Python над JSON `raw_lots`, не SQL-колонка — пагинация на уровне SQL для неё невозможна). При недоступности Redis читает/пишет с `logger.warning` и просто пересчитывает на каждый запрос (без хард-фейла). Ответ дополнен `total_count` (длина полного списка), `page`, `page_size`. **Важно:** стоимость cache-miss (полный пересчёт `profitable_offers_count`) больше не зафиксирована на топ-20 — растёт линейно с числом бакетов до потолка `MAX_BUCKETS=500`; при текущих ~18 бакетах не критично, при росте watchlist может потребовать пересмотра TTL/safety-cap.

---

## Telegram-интеграция — текущая архитектура

**Приём команд — polling** (`app.run_polling()`); **доставка уведомлений — консьюмер
RabbitMQ** (с 2026-07-21, ранее был polling Redis каждые 15 сек). Оба живут в одном
процессе `telegram_bot`.

### Почему polling (команд), а не webhook

Хостинг-провайдер (`161.104.44.231`) блокирует исходящие TCP-соединения к диапазону Telegram Bot API (`149.154.x.x:443`). Webhook требует исходящего соединения для регистрации и для отправки сообщений. Polling работает, потому что использует long-polling GET к тем же IP, но через уже установленное соединение — видимо проходит в другой момент времени или через другой путь.

### Поток

```
telegram_bot (polling) ←→ api.telegram.org  (команды + уведомления)
backend (FastAPI)          → /api/v1/telegram/* (link-code, status, unlink)
```

**Сервис:** `telegram_bot` в обоих compose → `python /tg_bot/bot.py`; `depends_on rabbitmq healthy`. В проде ходит в RabbitMQ под `${RABBITMQ_USER}/${RABBITMQ_PASSWORD}` (не guest, харденинг как у `push_service`).  
**Код:** `telegram_bot/bot.py` — команды `/start /link /status /stop` + консьюмер уведомлений `_consume_loop` (событийный, слушает очередь `telegram.notifications`; ранее — polling-цикл `_notifier_loop` каждые 15 сек). `_consume_loop` обёрнут супервайзер-петлёй для авто-реконнекта.  
**Celery `scan_and_notify`:** **отключён** (дубль с рассылкой бота)

### Поток привязки аккаунта

1. Пользователь нажимает «Получить код» → `GET /api/v1/telegram/link-code` → 6-значный код в Redis (TTL 10 мин)
2. Отправляет боту: `/link 123456`
3. Бот (polling) читает команду, ищет код в Redis → сохраняет `telegram_chat_id` в таблицу `users`
4. `GET /api/v1/telegram/status` → `is_linked: true`

### Доставка уведомлений — консьюмер RabbitMQ (`_consume_loop`, с 2026-07-21)

Событийная (было: polling Redis каждые 15 сек). Бот объявляет и биндит собственную
durable-очередь `telegram.notifications` к DIRECT-exchange `push.events` по
routing_key `push` (`x-message-ttl=15 мин`) — брокер отдаёт копию каждого события,
которое публикует коллектор (fan-out параллельно `push.notifications` для web push).
Обработчики зеркалят `push_service`, но канал/гейт/дедуп — Telegram-специфичные.

| Параметр | Значение |
|----------|----------|
| Механизм | consumer `telegram.notifications` (best-effort `ack`, без DLX — не зациклить requeue на «ядовитом» событии) |
| Задержка | событийная (< 15 сек, заметно быстрее прежнего polling) |
| Dedup TTL | 48 ч (Redis ключ `tg_sent:{user_id}:{item_id}:{region}:{qlt}:{enchant}:{startTime}`, отдельно от `push_*_sent:*`) |
| Порог прибыли | `normal_net_price > buy_price` |
| Формат сообщения | все 3 опции с ✅/❌, явно "выставить X → получишь Y → прибыль Z" (рендер `build_lot_message` без изменений; `item_name` берётся из события, не из БД) |

### Уведомления о выбросе (`handle_emission`, bot.py)

С 2026-07-08 рассылку о старте/завершении выброса выполняет `telegram_bot`, а не Celery worker (worker через одноразовый `Bot(token)` терял отправки — Timed out / ConnectError). С 2026-07-21 срабатывает событийно на событие `emission` из очереди `telegram.notifications` (было: `notify_emission_events` в polling-цикле каждые 15 сек, выборка из БД по флагам).

- **Триггер:** событие `emission` (`phase=start|end`, несёт `event_id`) — fan-out всем привязанным без опроса БД.
- **Отсечка свежести:** `EMISSION_MAX_AGE_MIN = 15` мин — устаревшие события отбрасываются без рассылки (защита от спама историей после простоя бота/накопления в durable-очереди).
- **Получатели:** `telegram_chat_id IS NOT NULL` + `is_active` + `is_approved` + `UserSettings.notify_telegram` (нет строки настроек → считается True). Tier-гейт НЕ применяется — выброс глобальное событие, в отличие от премиум-сигналов по лотам.
- **Дедупликация через Redis** (с 2026-07-21): ключ `tg_emission_sent:{event_id}:{phase}` (зеркало `push_emission_sent:*`, отдельно от web push). Ранее — БД-флаги `emission_events.notified`/`end_notified`; теперь для Telegram они вестигиальны (продюсер их по-прежнему заполняет, см. `docs/DATABASE.md`).
- **Отправка:** живой `app.bot.send_message`, `parse_mode=HTML`, per-chat try/except; префикс `[STAGE]` при `IS_STAGE`.

### Уведомления Buy Sniper (`handle_buy_alert`, bot.py)

Раздел «Закупки // Buy Sniper» (2026-07-19). С 2026-07-21 срабатывает событийно на
событие `buy_alert` из очереди `telegram.notifications` (было: `notify_buy_alerts` в
polling-цикле каждые 15 сек с чтением `buymin:*`).

- **Триггер:** коллектор публикует `buy_alert` **только** при пересечении
  `price_per_unit ≤ BuyAlert.target_price` (`collectors.py`) — само условие
  срабатывания теперь проверяет продюсер; событие несёт `cheapest` + `target_price`.
- **Получатели:** `telegram_chat_id IS NOT NULL`, `is_active`, `UserSettings.notify_telegram`
  и тариф-гейт **`buy_sniper_notifications`** (только `advanced_plus`/`advanced_max`;
  на `advanced` раздел работает как ручной список целей без алертов) — это отдельный
  гейт от `telegram_notifications`, которым гейтятся уведомления о прибыльных лотах.
- **Сообщение:** «🛒 Дешёвый лот!» (`build_buy_message` из `event["cheapest"]` +
  `target_price`, рендер без изменений).
- **Дедупликация по лоту:** Redis-ключ `tg_buy_sent:{user}:{item}:{region}:{qlt}:{ench}:{start_time}`,
  TTL `NOTIF_DEDUP_TTL` (48ч) — один и тот же лот не спамит; новый более
  дешёвый лот (другой `start_time`) уведомит снова.

**Redis-ключи Buy Sniper:**

- `buymin:{user}:{item}:{region}:{qlt}:{ench}` — текущий самый дешёвый подходящий
  лот (JSON), TTL 300с, пишет коллектор в `_publish_signals`; читает только
  `GET /buy-sniper/` (бот с 2026-07-21 получает лот из события, не из этого ключа)
- `tg_buy_sent:{user}:{item}:{region}:{qlt}:{ench}:{start_time}` — дедуп отправки,
  TTL 48ч, пишет бот

---

## Web Push (push_service) — 2026-07-20

Второй канал уведомлений (браузерный web push) **параллельно** Telegram, с
минимальной задержкой через RabbitMQ. Полное ТЗ — `docs/tasks/web-push-notifications.md`.

```
collectors.py (_publish_signals / _collect_emission_async)
      │ publish {type, user_id, item, ...}
      ▼
RabbitMQ  exchange push.events (direct, key "push")  →  queue push.notifications
      ▼                                              └→  queue telegram.notifications (telegram_bot, с 2026-07-21)
push_service (consumer.py)  →  pywebpush + VAPID  →  FCM/Mozilla/Apple  →  Service Worker
```

Fan-out: DIRECT-exchange отдаёт копию каждого события обеим очередям (web push +
Telegram); каналы независимы (свой гейт, свой Redis-дедуп). См. раздел «Telegram».

**Сервис:** `push_service` в обоих compose → `python /push_service/consumer.py`
(переиспользует backend-образ, как `telegram_bot`). Async-консьюмер aio-pika,
prefetch 20, manual ack (без DLX — best-effort, всегда ack, нет бесконечного requeue).

**Типы событий и гейт по тарифу** (зеркалит Telegram):

| Событие | Тариф-гейт | Канальный тумблер |
|---|---|---|
| `profitable_lot` | `telegram_notifications` (advanced+) | `notify_browser_push` |
| `buy_alert` | `buy_sniper_notifications` (advanced_plus+) | `notify_browser_push` |
| `emission` (start/end) | без тарифа (как в боте) | `notify_browser_push` |

**Обработка:** грузит пользователя+настройки → гейт → грузит все
`push_subscriptions` (устройства) → рендерит компактный payload `{title, body, url, tag}`
→ шлёт на каждое устройство. На 404/410 подписка удаляется из БД (мёртвая).

**Дедуп (Redis, TTL 48ч, отдельно от `tg_*`):**
`push_sent:{user}:{item}:{region}:{qlt}:{ench}:{start_time}` (лоты),
`push_buy_sent:...:{start_time}` (закупки), `push_emission_sent:{event_id}:{phase}`
(выброс). Ключ ставится только при ≥1 успешной отправке.

**API (`backend/app/api/v1/endpoints/push.py`, prefix `/push`):**
`GET /vapid-public-key` (503 без ключей), `POST /subscribe` (upsert по endpoint, 204),
`POST /unsubscribe` (204). Таблица `push_subscriptions` — `docs/DATABASE.md`.

**Конфиг/секреты:** `RABBITMQ_URL`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`
(генерация и деплой — `docs/DEPLOY.md`).

**Telegram на той же очереди** (реализовано 2026-07-21): `telegram_bot` — второй
консьюмер `push.events` (очередь `telegram.notifications`). См. раздел «Telegram».

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
