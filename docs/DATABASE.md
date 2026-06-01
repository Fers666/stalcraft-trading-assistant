# База данных — структура и назначение полей

PostgreSQL 16. Часовой пояс: `Europe/Moscow` (UTC+3).  
ORM: SQLAlchemy 2.0 async. Миграции: Alembic.

---

## Таблицы

### `users` — пользователи приложения

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | Внутренний идентификатор |
| `username` | varchar(50) UNIQUE | Имя пользователя для входа |
| `email` | varchar(100) UNIQUE | Email, используется для логина |
| `password_hash` | varchar(255) | bcrypt-хэш пароля |
| `telegram_username` | varchar(50) | Ник в Telegram (для уведомлений) |
| `telegram_chat_id` | bigint | ID чата Telegram (заполняется при /link) |
| `is_active` | bool | Аккаунт активен; false = заблокирован |
| `is_admin` | bool | Права администратора (refresh-catalog и др.) |
| `created_at` | timestamptz | Дата регистрации |
| `updated_at` | timestamptz | Дата последнего изменения |

---

### `user_settings` — настройки пользователя

Связь 1:1 с `users`. Создаётся автоматически при регистрации.

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | integer PK/FK | Ссылка на `users.id` |
| `min_profit_margin_percent` | integer | Минимальная маржа (%) для показа рекомендации (по умолчанию 10%) |
| `exclude_less_than_amount` | integer | Игнорировать лоты с количеством меньше N штук |
| `notify_telegram` | bool | Отправлять уведомления в Telegram |
| `notify_browser_push` | bool | Отправлять browser push-уведомления |
| `auto_refresh_enabled` | bool | Включить автоматический сбор данных по расписанию |
| `updated_at` | timestamptz | Дата изменения настроек |

---

### `master_items` — каталог предметов игры

Источник: [EXBO-Studio/stalcraft-database](https://github.com/EXBO-Studio/stalcraft-database).  
Синхронизируется через `POST /api/v1/items/refresh-catalog` (только для admin).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | Внутренний ID |
| `item_id` | varchar(50) UNIQUE | Код предмета в игре (напр. `m02wr`, `04yr`) |
| `name_ru` | varchar(200) | Русское название |
| `name_en` | varchar(200) | Английское название |
| `category` | varchar(50) | Категория (напр. `artefact/biochemical`, `weapon/assault_rifle`) |
| `can_be_batch_traded` | bool | Можно ли торговать пачками (false для оружия, брони) |
| `last_updated` | timestamptz | Дата последней синхронизации с GitHub |

**Индексы:** `item_id` (unique), `name_ru`, `name_en`, `category`.

---

### `user_watchlist` — список отслеживаемых товаров

Каждый пользователь добавляет предметы которые хочет мониторить. Celery worker собирает данные по ним каждые 5 минут.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `user_id` | integer FK | Ссылка на `users.id` |
| `item_id` | varchar(50) FK | Ссылка на `master_items.item_id` |
| `region` | varchar(10) | Регион аукциона: `RU`, `EU`, `NA`, `SEA` |
| `tracked_batch_sizes` | integer[] | Размеры пачек для анализа (напр. `[10, 20, 50]`) |
| `is_active` | bool | Активно ли отслеживание (false = пауза) |
| `last_successful_check` | timestamptz | Время последнего успешного сбора данных |
| `error_status` | text | Текст последней ошибки при сборе (null = всё ок) |
| `created_at` | timestamptz | Дата добавления в watchlist |
| `updated_at` | timestamptz | Дата изменения |

**Ограничение UNIQUE:** `(user_id, item_id, region)` — один предмет/регион на пользователя.

---

### `collected_data` — снэпшоты активных лотов

Celery worker сохраняет агрегированный снэпшот каждые 5 минут для каждого предмета в watchlist. Один снэпшот = одна запись.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `user_id` | integer FK nullable | NULL = глобальный снэпшот; `<id>` = ручной refresh пользователя |
| `item_id` | varchar(50) | Код предмета |
| `region` | varchar(10) | Регион |
| `collect_time` | timestamptz | Время сбора |
| `collect_type` | varchar(20) | `auto` (по расписанию) или `manual` (запрос пользователя) |
| `total_lots` | integer | Общее число активных лотов на аукционе |
| `total_available_amount` | integer | Суммарное количество единиц товара во всех лотах |
| `best_price_per_unit` | bigint | Минимальная цена за штуку среди всех лотов |
| `best_price_total` | bigint | Полная стоимость лучшего лота |
| `best_price_amount` | integer | Количество штук в лучшем лоте |
| `best_lot_id` | varchar(100) | startTime лучшего лота (используется как уникальный идентификатор) |
| `avg_price_per_unit` | numeric(12,2) | Средняя цена за штуку |
| `median_price_per_unit` | numeric(12,2) | Медианная цена за штуку |
| `min_price_per_unit` | bigint | Минимальная цена (= best_price_per_unit) |
| `max_price_per_unit` | bigint | Максимальная цена за штуку |
| `best_buyout_per_unit` | bigint | Лучшая цена выкупа среди всех лотов |
| `liquid_lots_count` | integer | Лотов с остатком времени ≥ 2ч (ликвидные) |
| `expiring_lots_count` | integer | Лотов с остатком < 2ч (неликвид — скоро истекут) |
| `best_liquid_price_per_unit` | bigint | Лучшая цена только среди ликвидных лотов |
| `detected_buyouts_count` | integer | Число выкупленных лотов, обнаруженных с прошлого снэпшота |
| `raw_lots` | jsonb | Сырые данные первых 50 лотов от API (для детектирования выкупов) |
| `created_at` | timestamptz | Дата записи в БД |

**Почему `expiring_lots_count` важен:** лот с остатком < 2ч и не купленный означает, что цена нерыночная — никто не захотел покупать по этой цене.

---

### `sales_history` — история реальных продаж

Заполняется из API `/history` — реальные сделки из Stalcraft (раз в час).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `user_id` | integer FK | |
| `item_id` | varchar(50) | |
| `region` | varchar(10) | |
| `sale_time` | timestamptz | Время продажи |
| `price_per_unit` | bigint | Цена за единицу |
| `amount` | integer | Количество проданных единиц |
| `total_price` | bigint | Итоговая сумма сделки |
| `additional_info` | jsonb | Доп. данные. Snapshot matching: `{"lot_start":"<startTime>"}` — время появления лота на рынке |
| `collected_at` | timestamptz | Когда запись появилась в нашей БД |
| `will_be_deleted_at` | timestamptz | Дата автоудаления (= sale_time + 120 дней) |

**Важно:** `lot_start` в `additional_info` позволяет вычислить `время_на_рынке = sale_time - lot_start` — это основа для расчёта прогноза времени продажи.

---

### `market_statistics` — агрегированная статистика рынка

Пересчитывается раз в час (Celery task `calculate_all_market_stats`).  
UNIQUE по `(user_id, item_id, region)` — одна запись на предмет.

| Поле | Тип | Описание |
|------|-----|----------|
| `avg_price_24h` | numeric(12,2) | Средняя цена продажи за последние 24ч |
| `min_price_24h` | bigint | Минимальная цена за 24ч |
| `max_price_24h` | bigint | Максимальная цена за 24ч |
| `sales_volume_24h` | integer | Количество продаж за 24ч |
| `avg_price_7d` | numeric(12,2) | Средняя цена за 7 дней |
| `median_price_7d` | numeric(12,2) | Медианная цена за 7 дней |
| `min_price_7d` | bigint | Минимум за 7 дней |
| `max_price_7d` | bigint | Максимум за 7 дней |
| `sales_volume_7d` | integer | Количество продаж за 7 дней |
| `price_volatility_7d` | numeric(5,2) | Волатильность цены за 7 дней (stdev/mean * 100, в %) |
| `best_sell_hour` | integer | Час суток (0-23, MSK) — лучший для продажи (взвешенный: 60% цена + 40% объём) |
| `best_sell_day` | varchar(10) | День недели с лучшим взвешенным скором (Monday…Sunday) |
| `best_buy_hour` | integer | Час суток (0-23, MSK) — минимальная средняя ликвидная цена |
| `best_buy_day` | varchar(10) | День недели с минимальной средней ликвидной ценой |
| `sell_hours_by_day` | jsonb | Лучший час продажи для каждого дня: `{"Monday": 20, "Tuesday": 19, ...}` |
| `buy_hours_by_day` | jsonb | Лучший час покупки для каждого дня: `{"Monday": 2, "Tuesday": 3, ...}` |
| `weekend_bonus_percent` | numeric(5,2) | Разница средней цены в выходные vs будни (%) |
| `avg_sell_time_hours` | numeric(8,2) | Среднее время продажи в часах (из snapshot-history matching) |
| `sell_options` | jsonb | **3 варианта цены с прогнозом времени** (см. ниже) |
| `batch_stats` | jsonb | Статистика по пачкам (резерв) |
| `calculated_at` | timestamptz | Время последнего пересчёта |

**Формат `sell_options`:**
```json
[
  {
    "label": "fast",
    "label_ru": "Быстро",
    "price_per_unit": 3464990,
    "estimated_hours": 3.0,
    "estimated_hours_display": "~3 ч",
    "confidence": "low|medium|high",
    "data_points": 5
  },
  { "label": "normal", ... },
  { "label": "premium", ... }
]
```
`confidence` по coverage: `coverage = matched_count / total_sales_30d × 100%`  
`high` ≥30% AND ≥10 точек, `medium` 10–30% AND ≥3 точки, `low` <10%.

---

### `purchase_recommendations` — рекомендации к покупке

Генерируются автоматически когда система находит выгодный лот.

| Поле | Тип | Описание |
|------|-----|----------|
| `lot_price_per_unit` | bigint | Цена лота за штуку |
| `lot_total_price` | bigint | Полная стоимость лота |
| `lot_amount` | integer | Количество в лоте |
| `lot_end_time` | timestamptz | Когда лот истекает |
| `expected_sell_price_per_unit` | bigint | Ожидаемая цена продажи (из market_statistics) |
| `expected_profit_per_unit` | bigint | Прибыль за штуку |
| `expected_profit_percent` | numeric(5,2) | Маржа в % |
| `confidence_score` | numeric(3,2) | Уверенность 0.0–1.0 (зависит от объёма продаж) |
| `recommend_sell_hour` | integer | Рекомендуемый час выставления на продажу |
| `recommend_sell_day` | varchar(10) | Рекомендуемый день |
| `risk_level` | varchar(20) | `low` / `medium` / `high` (зависит от volatility) |
| `is_viewed` | bool | Пользователь видел уведомление |
| `is_notified` | bool | Уведомление отправлено |
| `expires_at` | timestamptz | Рекомендация устаревает |

---

### `user_inventory` — склад пользователя

Товары, которые пользователь купил и планирует продать.

| Поле | Тип | Описание |
|------|-----|----------|
| `item_id` | varchar(50) | Код предмета |
| `region` | varchar(10) | Регион |
| `quantity` | integer | Количество единиц на складе |
| `avg_buy_price_per_unit` | bigint | Средняя цена покупки (для расчёта прибыли) |
| `added_at` | timestamptz | Когда добавлен |

---

### `sell_recommendations` — рекомендации по продаже склада

Связь с `user_inventory`. Генерируются на основе `market_statistics`.

| Поле | Тип | Описание |
|------|-----|----------|
| `recommended_price_per_unit` | bigint | Рекомендуемая цена выставления |
| `recommended_batch_size` | integer | Рекомендуемый размер пачки |
| `expected_wait_hours` | numeric(8,2) | Ожидаемое время продажи (из sell_options) |
| `expected_revenue` | bigint | Ожидаемая выручка |
| `expected_profit` | bigint | Ожидаемая прибыль (с учётом avg_buy_price) |
| `expected_profit_percent` | numeric(5,2) | Маржа в % |
| `sell_now_vs_wait_benefit` | numeric(5,2) | Выгода от ожидания лучшего момента |
| `confidence_score` | numeric(3,2) | Уверенность 0.0–1.0 |

---

### `api_request_log` — лог запросов к Stalcraft API

Для мониторинга расхода токенов rate limiter и диагностики ошибок.

| Поле | Тип | Описание |
|------|-----|----------|
| `endpoint` | varchar(200) | URL запроса |
| `request_time` | timestamptz | Время запроса |
| `response_time_ms` | integer | Время ответа в мс |
| `status_code` | integer | HTTP статус |
| `tokens_used` | integer | Потрачено токенов (2 для lots/history, 1 для emission) |
| `error_message` | text | Текст ошибки если был |

---

### `notification_queue` — очередь уведомлений

| Поле | Тип | Описание |
|------|-----|----------|
| `notification_type` | varchar(30) | `purchase_recommendation` / `sell_recommendation` |
| `channel` | varchar(20) | `telegram` / `browser_push` |
| `payload` | jsonb | Данные уведомления |
| `attempts` | integer | Число попыток отправки |
| `max_attempts` | integer | Максимум попыток (default 3) |
| `next_attempt_at` | timestamptz | Когда повторить |
| `status` | varchar(20) | `pending` / `sent` / `failed` |

---

### `global_item_scan` — лёгкий скан всех предметов вне watchlist

Заполняется глобальным сканером (слой 2). Содержит только агрегированные метрики —
без `raw_lots` и детального анализа. Одна запись на пару `(item_id, region)`, обновляется при каждом проходе.

**Почему отдельная таблица, а не `collected_data`:**
`collected_data` хранит подробные снэпшоты с `raw_lots` JSON и buyout detection —
это тяжело и нужно только для watchlist-предметов. Для 2000+ предметов глобального скана
достаточно 7 числовых полей.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `item_id` | varchar(50) FK | Ссылка на `master_items.item_id` |
| `region` | varchar(10) | Регион аукциона |
| `scanned_at` | timestamptz | Время последнего скана |
| `lot_count` | integer | Число активных лотов |
| `liquid_lot_count` | integer | Лотов с остатком ≥ 2ч (ликвидные) |
| `best_price` | bigint | Лучшая цена выкупа за штуку |
| `avg_price` | numeric(12,2) | Средняя цена за штуку |
| `total_volume` | integer | Суммарное кол-во единиц во всех лотах |
| `prev_best_price` | bigint | Лучшая цена предыдущего скана (для расчёта изменения) |
| `price_change_pct` | numeric(5,2) | Изменение лучшей цены с прошлого скана, % |
| `tradability_score` | numeric(8,2) | Скор торгуемости (см. ниже) |

**UNIQUE:** `(item_id, region)` — одна актуальная запись, перезаписывается при каждом скане.

**Формула tradability_score:**
```
price_spread_pct = (max_price - min_price) / min_price × 100
tradability_score = liquid_lot_count × total_volume / (1 + price_spread_pct)
```
Смысл: чем больше ликвидных лотов и объёма, тем выше скор.
Чем больше разброс цен (нестабильный рынок) — тем ниже.

---

### Изменения в существующих таблицах (миграции 0005–0006)

**`collected_data.user_id`** — становится nullable:
- `NULL` = глобальный снэпшот (из watchlist коллектора, один на пару item/region)
- `<user_id>` = ручной refresh конкретного пользователя

**`market_statistics.user_id`** — становится nullable:
- `NULL` = глобальная статистика (одна на пару item/region)
- Все пользователи читают одну запись, применяют личные фильтры на уровне API

**Почему это важно:**
До изменения — 100 пользователей с одним товаром = 100 API запросов каждые 5 минут.
После — 1 API запрос, 1 запись в БД, все 100 пользователей читают её.

---

## Миграции

| Файл | Что делает |
|------|-----------|
| `0001_initial.py` | Создаёт все таблицы |
| `0002_add_is_admin.py` | Добавляет `users.is_admin` |
| `0003_collected_data_liquid_fields.py` | Добавляет поля ликвидности в `collected_data` |
| `0004_market_stats_sell_options.py` | Добавляет `sell_options` в `market_statistics` |
| `0005_collected_data_user_nullable.py` | `collected_data.user_id` → nullable (глобальный сбор) |
| `0006_market_stats_user_nullable.py` | `market_statistics.user_id` → nullable |
| `0007_global_item_scan.py` | Новая таблица `global_item_scan` |
| `0008_master_items_icon_path.py` | Поле `icon_path` в `master_items` |
| `0009_market_stats_best_buy.py` | Поля `best_buy_hour`, `best_buy_day` в `market_statistics` |
| `0010_market_stats_hours_by_day.py` | Поля `sell_hours_by_day`, `buy_hours_by_day` в `market_statistics` |

---

## Rate Limiter (Stalcraft API)

| Запрос | Стоимость |
|--------|-----------|
| `/auction/{id}/lots` | 2 токена |
| `/auction/{id}/history` | 2 токена |
| `/emission` | 1 токен |
| Ёмкость корзины | 100 токенов / минута |

Реализован через Redis (Lua script, атомарный). Fallback — in-memory при недоступности Redis.
