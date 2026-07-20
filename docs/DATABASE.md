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
| `is_approved` | bool | Доступ к порталу разрешён администратором. Новые регистрации = `false` (если не включено авто-подтверждение, см. `registration_settings`), проверяется при логине **и** теперь при каждом запросе в `get_current_user` (миграция 0026 — закрыт баг: раньше проверялся только при логине); админ выдаёт через `POST /admin/users/{id}/approve` |
| `tier` | varchar(20) | Тариф пользователя: `base` / `advanced` / `advanced_plus` / `advanced_max`. Источник истины по лимитам — `backend/app/core/tiers.py`. У `is_admin=True` хранится `advanced_max` (косметика для отображения в админке — `is_admin` обходит лимиты тарифа независимо от значения этого поля) |
| `tier_expires_at` | timestamptz, nullable | Дата окончания платного тарифа. `NULL` = бессрочно (всегда для `base`, опционально для платных тарифов). После истечения — автоматическое понижение до `base` (см. ниже) |
| `last_seen` | timestamptz, nullable | Время последнего авторизованного запроса. Обновляется в `get_current_user` не чаще раза в 60 сек (Redis-throttle). «Онлайн» в админке = `last_seen >= now() - 5 минут` |
| `has_market_radar_addon` | bool | Доступ к «Радару рынка» (кросс-юзерная агрегация watchlist) — отдельный аддон-флаг, НЕ часть `tier`. Проверяется `get_market_radar_access` (обходится `is_admin=True`); выдаётся/отзывается вручную через `POST /admin/users/{id}/market-radar-addon`. См. `docs/BUSINESS_LOGIC.md` §17 |
| `favorites_limit_override` | integer, nullable | Ручной override лимита карточек watchlist вне тарифа. `NULL` (default) = лимит = тариф (через `TIERS[user.tier].watchlist_limit`); не-`NULL` значение **заменяет** лимит тарифа целиком (не складывается). Вычисляется в `effective_watchlist_limit(user)` (`backend/app/core/tiers.py`), используется `get_tier_limits()` и при деактивации лишних карточек на смене/истечении тарифа. Выдаётся/снимается вручную через `POST /admin/users/{id}/favorites-limit-override` (`{"override": int \| null}`). См. `docs/BUSINESS_LOGIC.md` §17 |
| `created_at` | timestamptz | Дата регистрации |
| `updated_at` | timestamptz | Дата последнего изменения |

**Тарифная матрица** (полная таблица лимитов — `backend/app/core/tiers.py`):

| Тариф | Карточек watchlist | Telegram-уведомления | Окна статистики | Аукцион |
|---|---|---|---|---|
| `base` (дефолт после approve) | 6 | нет | 24ч | нет |
| `advanced` | 10 | да | 24ч+48ч | нет |
| `advanced_plus` | 20 | да | 24ч+48ч+7д | да |
| `advanced_max` | 25 | да | 24ч+48ч+7д+30д | да |
| `is_admin=True` | без лимита | да | все окна | да |

`telegram_notifications` в этой таблице — только про проактивные уведомления о выгодных лотах (гейтится в `telegram_bot/bot.py::notify_profitable_lots`). Привязка самого Telegram-аккаунта (`/telegram/link-code`, вебхук `/link`) НЕ гейтится тарифом — одинаково доступна всем (канал восстановления, используется и для пароля в будущем — см. `docs/NOTES.md`, фаза отложена).

**Авто-понижение тарифа:** при истечении `tier_expires_at` — лениво при следующем запросе пользователя (`apply_tier_expiry` в `tiers.py`) и ежесуточным Celery sweep `sweep_expired_tiers` (`backend/app/tasks/tiers.py`, beat `crontab(hour=3, minute=30)`). При понижении лишние карточки `user_watchlist` сверх нового лимита автоматически деактивируются (`is_active=False`, оставляя активными самые старые по `created_at`) — данные не удаляются.

---

### `user_settings` — настройки пользователя

Связь 1:1 с `users`. Создаётся автоматически при регистрации.

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | integer PK/FK | Ссылка на `users.id` |
| `min_profit_margin_percent` | integer | Минимальная маржа (%) для показа рекомендации (по умолчанию 10%) |
| `exclude_less_than_amount` | integer | Игнорировать лоты с количеством меньше N штук |
| `notify_telegram` | bool | Отправлять уведомления в Telegram |
| `notify_browser_push` | bool | Канальный тумблер web push. Проверяется в `push_service` перед рассылкой (аналог `notify_telegram` для Telegram). NULL-строка настроек → трактуется как True |
| `auto_refresh_enabled` | bool | Включить автоматический сбор данных по расписанию |
| `updated_at` | timestamptz | Дата изменения настроек |

---

### `push_subscriptions` — подписки устройств на web push

Миграция `0035`. Один пользователь = много подписок (ПК + телефон = отдельные записи). Создаётся при включении тумблера «Browser Push» (`POST /push/subscribe`), удаляется при отключении или когда push-сервис браузера возвращает 404/410 (мёртвая подписка — чистит `push_service`). Рассылку выполняет отдельный сервис `push_service` (см. `docs/SERVICES.md`).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | Внутренний ID |
| `user_id` | integer FK→users CASCADE, index | Владелец подписки |
| `endpoint` | text UNIQUE | Capability-URL push-сервиса браузера (FCM/Mozilla/Apple). Уникален; общий браузер → переназначается на нового `user_id` при subscribe |
| `p256dh` | text | Публичный ключ шифрования полезной нагрузки (из `PushSubscription.getKey`) |
| `auth` | text | Auth-секрет шифрования |
| `user_agent` | varchar(300), nullable | UA устройства (диагностика) |
| `created_at` | timestamptz | Дата подписки |
| `last_used_at` | timestamptz, nullable | Обновляется при upsert |

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
| `bind_state` | varchar(30) | `status.state` из GitHub: `NONE`/`NON_DROP`/`PERSONAL_ON_USE` — продаётся; `PERSONAL_ON_GET`/`PERSONAL_DROP_ON_GET` — привязывается при получении, на аукционе не появляется (исключается из `/items`) |
| `can_be_batch_traded` | bool | Можно ли торговать пачками (false для оружия, брони) |
| `last_updated` | timestamptz | Дата последней синхронизации с GitHub |

**Индексы:** `item_id` (unique), `name_ru`, `name_en`, `category`.

**Фильтрация непродаваемых предметов:** `GET /items` исключает предметы с
`bind_state IN ('PERSONAL_ON_GET', 'PERSONAL_DROP_ON_GET')` — это ~77 предметов
(квестовые расписки, личные артефакты/фрагменты), которые привязываются в момент
получения и физически не могут быть выставлены на аукцион. Подтверждено
эмпирически: `history_total=0` и `lots_total=0` через Stalcraft API для всех
проверенных предметов этих категорий.

---

### `user_watchlist` — список отслеживаемых товаров

Каждый пользователь добавляет предметы которые хочет мониторить. Celery worker (`collect_all_active_lots`, каждые 20 сек, динамический batch — см. docs/SERVICES.md) собирает по ним снэпшоты.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `user_id` | integer FK | Ссылка на `users.id` |
| `item_id` | varchar(50) FK | Ссылка на `master_items.item_id` |
| `region` | varchar(10) | Регион аукциона: `RU`, `EU`, `NA`, `SEA` |
| `quality_filter` | integer nullable | Фильтр по качеству артефакта: qlt 0–5 (`Обычный`…`Легендарный`). `NULL` = любое качество |
| `enchant_filter` | integer nullable | Фильтр по уровню заточки: 1–15. `NULL` = любая заточка |
| `tracked_batch_sizes` | integer[] | Размеры пачек для анализа (напр. `[10, 20, 50]`) |
| `is_active` | bool | Активно ли отслеживание (false = пауза) |
| `last_successful_check` | timestamptz | Время последнего успешного сбора данных |
| `error_status` | text | Текст последней ошибки при сборе (null = всё ок) |
| `created_at` | timestamptz | Дата добавления в watchlist |
| `updated_at` | timestamptz | Дата изменения |

**Уникальность (уровень приложения):** `(user_id, item_id, region, quality_filter, enchant_filter)`.  
DB-уровень unique index удалён в миграции 0012: PostgreSQL считает NULL-значения различными, что допускало дубли через БД. Дедупликация выполняется в `add_to_watchlist` через SQLAlchemy (`col == None` → `IS NULL`).

**Маппинг quality_filter:**

| qlt | Название |
|-----|---------|
| 0 | Обычный |
| 1 | Необычный |
| 2 | Особый |
| 3 | Ветеран |
| 4 | Мастер |
| 5 | Легендарный |

---

### `collected_data` — снэпшоты активных лотов

Celery worker (`collect_all_active_lots`) сохраняет агрегированный снэпшот для каждого предмета в watchlist при каждом сборе. Один снэпшот = одна запись.

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
| `detected_buyouts_count` | integer | Устарело, не используется (всегда NULL) |
| `raw_lots` | jsonb | Сырые данные первых 50 лотов от API (для snapshot-history matching) |
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
| `additional_info` | jsonb | Доп. данные. Ключи: `qlt` (integer 0-5 — качество артефакта) и `ptn` (integer 0-15 — уровень заточки; 0 = без заточки) приходят первично прямо из Stalcraft API `/history` (поле `additional` в каждой записи продажи); `lot_start` (ISO-строка startTime лота — для расчёта времени продажи) восстанавливается отдельно через снэпшот-матчинг, см. `docs/BUSINESS_LOGIC.md` |
| `collected_at` | timestamptz | Когда запись появилась в нашей БД |
| `will_be_deleted_at` | timestamptz | Дата автоудаления (= sale_time + 120 дней) |

**Важно:** `lot_start` в `additional_info` позволяет вычислить `время_на_рынке = sale_time - lot_start` — это основа для расчёта прогноза времени продажи.

**Фильтрация по качеству/заточке:** эндпоинты `/monitoring/item/` и `/monitoring/sales-chart/` принимают `quality_filter` и `enchant_filter`. SQL-фильтры:
- качество: `additional_info->>'qlt' = '<N>'`; для qlt=0 также `IS NULL` (отсутствующее поле = обычный)
- заточка: `additional_info->>'ptn' = '<level>'` (прямое целое 1-15; 0 и NULL = без заточки)

**Индексы:**
- `ix_sales_item_time (user_id, item_id, sale_time)`
- `ix_sales_cleanup (will_be_deleted_at)`
- `ix_sales_item_region_time (item_id, region, sale_time)` — миграция 0016, под запросы `/monitoring/sales-chart` и `/monitoring/item` (не содержат `user_id`)
- `uq_sales_history_sale (item_id, region, sale_time, total_price, amount)` UNIQUE — миграция 0025, защита от дублей при `INSERT ... ON CONFLICT DO NOTHING`
- `ix_sales_collected_at (collected_at)` — миграция 0032, под дифф-запрос порционного пересчёта статистики (`calculate_market_stats_batch`: поиск пар с `collected_at > market_statistics.calculated_at` в окне 26ч)

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
| `avg_price_48h` | numeric(12,2) | Средняя цена продажи за последние 48ч (миграция 0027, под тарифы `advanced`+) |
| `min_price_48h` | bigint | Минимальная цена за 48ч |
| `max_price_48h` | bigint | Максимальная цена за 48ч |
| `sales_volume_48h` | integer | Количество продаж за 48ч |
| `avg_price_7d` | numeric(12,2) | Средняя цена за 7 дней |
| `median_price_7d` | numeric(12,2) | Медианная цена за 7 дней |
| `min_price_7d` | bigint | Минимум за 7 дней |
| `max_price_7d` | bigint | Максимум за 7 дней |
| `sales_volume_7d` | integer | Количество продаж за 7 дней |
| `price_volatility_7d` | numeric(5,2) | Волатильность цены за 7 дней (stdev/mean * 100, в %) |
| `sales_volume_30d` | integer | Количество продаж за 30 дней |
| `price_volatility_30d` | numeric(5,2) | Волатильность цены за 30 дней (stdev/mean * 100, в %); `NULL` если продаж < `MIN_SALES_FOR_VOLATILITY` |
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
| `demand_signals` | jsonb | Информационный сигнал спроса (см. ниже) |
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

**Формат `demand_signals`** (`null`, если данных меньше `MIN_SALES_FOR_STATS` в одном из окон):
```json
{
  "recent_bulk_share_24h": 23.5,
  "baseline_bulk_share_29d": 8.1,
  "bulk_spike": true
}
```
Доля объёма продаж в пачках ≥10 шт за последние 24ч vs базовая доля за предыдущие ~29 дней.
`bulk_spike=true` — резкий рост доли крупных закупок (информационный флаг, ничего не блокирует/усиливает).

---

### `signal_outcomes` — лог предсказаний для калибровки (миграция 0024)

Раз за цикл сбора, для каждой уникальной комбинации `(quality_filter, enchant_filter)` из
watchlist по `(item_id, region)`, логируются текущие профитные лоты из
`compute_signals_for_entry` (margin=0, без отсечения по amount). Не используется
автоматически — данные для будущей калибровки констант `pricing.py` (97/100/105%,
пороги волатильности и т.п.) по фактическим результатам продаж.

| Поле | Тип | Описание |
|------|-----|----------|
| `item_id` / `region` | varchar | Предмет и регион |
| `quality_filter` / `enchant_filter` | integer, nullable | Комбинация фильтров watchlist-записи, для которой считался `ref` |
| `lot_start_time` | varchar(50) | `startTime` лота — естественный ключ дедупа |
| `buyout_per_unit` | bigint | Цена выкупа лота за штуку на момент предсказания |
| `ref_price` | bigint | `ref`, использованный для расчёта (см. `pricing.compute_reference`) |
| `predicted_sell_price` | bigint | Цена продажи тира "fast" (с поправкой на пачку), на которой основан профит |
| `predicted_hours` | numeric(8,2) | Прогнозируемое время продажи (fast-тир) |
| `predicted_profit_pct` | numeric(6,2) | Предсказанная маржа, % |
| `trend` | varchar(10) | `stable` / `falling` / `rising` / `unknown` на момент предсказания |
| `created_at` | timestamptz | Когда залогировано |
| `evaluated_at` | timestamptz, nullable | Когда сверено с `sales_history` (`NULL` = ожидает обработки) |
| `realized_price` | bigint, nullable | Фактическая цена найденной продажи |
| `realized_hours` | numeric(8,2), nullable | Фактическое время до продажи |
| `outcome` | varchar(20), nullable | `sold_at_or_above` / `sold_below` / `not_sold` |

**UNIQUE:** `(item_id, region, lot_start_time)` — `INSERT ... ON CONFLICT DO NOTHING`.
**Индекс** `ix_signal_outcome_pending` на `evaluated_at` — для выборки необработанных строк.

**Задача `evaluate_signal_outcomes`** (Celery beat, раз в сутки `crontab(hour=4, minute=30)`):
для строк с `evaluated_at IS NULL`, у которых прошло ≥ `predicted_hours` (или ≥7 дней —
таймаут), ищет в `sales_history` продажу того же item/region(/qlt/ptn) с ценой в пределах
±15% от `predicted_sell_price` в окне `[created_at, now]`. Найдена → `sold_at_or_above` /
`sold_below` (по сравнению с `predicted_sell_price`); не найдена после таймаута → `not_sold`.

---

### `purchase_recommendations` — рекомендации к покупке

Генерируются автоматически когда система находит выгодный лот.

| Поле | Тип | Описание |
|------|-----|----------|
| `lot_price_per_unit` | bigint | Цена лота за штуку |
| `lot_total_price` | bigint | Полная стоимость лота |
| `lot_amount` | integer | Количество в лоте |
| `lot_end_time` | timestamptz | Когда лот истекает |
| `expected_listing_price_per_unit` | bigint | За сколько выставить лот (из market_statistics, до комиссии) |
| `expected_net_revenue_per_unit` | bigint | Получишь на руки = `expected_listing_price_per_unit × 0.95` (после 5% комиссии) |
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

### `buy_alerts` — закупки (Buy Sniper)

Раздел «Закупки // Buy Sniper» (заменил «Склад» 2026-07-19). Пользователь задаёт
порог цены на товар из «Избранного»; когда самый дешёвый лот на рынке падает
≤ порога — приходит Telegram-уведомление «пора покупать». Одна закупка = одна
запись `user_watchlist` (привязка по UNIQUE FK → лимит закупок = число активных
избранных). Раньше здесь были таблицы `user_inventory` и `sell_recommendations`
(старый «Склад») — дропнуты миграцией 0034 (были не задействованы: аналитика
P&L/медиан никогда не реализовывалась).

| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|
| `id` | integer PK | нет | |
| `user_id` | integer FK→`users.id` ON DELETE CASCADE, index | нет | Владелец закупки |
| `watchlist_id` | integer FK→`user_watchlist.id` ON DELETE CASCADE, **UNIQUE** | нет | Ссылка на карточку «Избранного» — источник item_id/region/quality_filter/enchant_filter |
| `target_price` | bigint | нет | Порог ₽/шт: цена ≤ target → уведомить |
| `is_active` | bool (default true) | нет | Пауза без удаления |
| `created_at` | timestamptz | нет | |
| `updated_at` | timestamptz | да | Заполняется при PUT |

**Связи (модели `models.py`):** `User.buy_alerts` (1:N), `UserWatchlist.buy_alert`
(1:1 через UNIQUE `watchlist_id`). Класс `BuyAlert`; классы `UserInventory` и
`SellRecommendation` удалены.

**Миграция:** `0034_buy_alerts.py` (drop `sell_recommendations` → drop
`user_inventory` → create `buy_alerts`).

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

### `registration_settings` — настройки авто-подтверждения регистрации

Синглтон (всегда одна строка, `id=1`). Управляется через `GET/PUT /admin/settings/registration`.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | Всегда `1` |
| `auto_approve_enabled` | bool | `false` (дефолт) — регистрация ждёт ручного approve, как раньше. `true` — `register()` сразу выставляет `is_approved=True` + тариф/срок по полям ниже |
| `default_tier` | varchar(20) | Тариф, выдаваемый авто-подтверждённым пользователям (по умолчанию `base`) |
| `default_tier_duration_days` | integer, nullable | Срок действия выданного тарифа в днях. `NULL` = бессрочно |
| `updated_at` | timestamptz | Дата последнего изменения настроек |

---

### `news` — новости и анонсы платформы

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | |
| `author_id` | integer FK→users (SET NULL) | `NULL` если автор удалён |
| `title` | String(300) | Заголовок |
| `content` | Text | Текст (plain, `white-space: pre-wrap` на фронте) |
| `tags` | ARRAY(String) | Метки: `обновление` / `тарифы` / `техработы` / `важно` |
| `is_pinned` | Boolean | Закреплённая новость (показывается первой) |
| `is_published` | Boolean | `false` = черновик (виден только admin) |
| `created_at` | DateTime(tz) | UTC |
| `updated_at` | DateTime(tz) | Заполняется при PUT |

**Индекс:** `ix_news_published_pinned` по `(is_published, is_pinned, created_at)` — покрывает основную выборку.  
**Миграция:** `0030_news_table.py`

---

### `emission_events` — события радиационного выброса

Заполняется Celery-задачей `collect_emission` (каждые 2 мин). Каждая строка — один задетектированный выброс (start/end пара). Дедупликация на уровне Redis-fingerprint (`emission:current_fingerprint`): задача сравнивает `currentStart` из API с сохранённым значением и пишет в БД только при изменении. Worker только фиксирует события; Telegram-рассылку делает `telegram_bot` (с 2026-07-08 — см. `docs/SERVICES.md`).

**Дедуп Telegram — с 2026-07-21 в Redis, не в этих полях.** После перевода бота на консьюмер RabbitMQ (событие `emission`) дедупликация Telegram-рассылки ведётся Redis-ключом `tg_emission_sent:{event_id}:{phase}`. Поля `notified`/`end_notified` для Telegram больше **не используются** (стали вестигиальными), но остаются `NOT NULL` и по-прежнему заполняются продюсером (`collect_emission`) — их не удаляли, схема не менялась (миграций фича не потребовала).

| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|
| `id` | integer PK | нет | |
| `region` | varchar(10) | нет | Регион выброса (например `RU`) |
| `started_at` | timestamptz | нет | Время начала выброса (`currentStart` из API) |
| `ended_at` | timestamptz | да | Время окончания (заполняется когда выброс завершился; `NULL` = выброс активен) |
| `detected_at` | timestamptz | нет | Время когда задача впервые зафиксировала событие |
| `notified` | boolean | нет | Исторически `true` = Telegram-уведомление о СТАРТЕ отправлено (seed-событие первого запуска — сразу `true`). **С 2026-07-21 для Telegram-дедупа не используется** (перешёл на Redis `tg_emission_sent:*`), но продюсер поле заполняет |
| `end_notified` | boolean | нет | Исторически `true` = Telegram-уведомление о ЗАВЕРШЕНИИ отправлено (default `false`; миграция 0033 backfill'ом выставила `true` всей истории). **С 2026-07-21 для Telegram-дедупа не используется** (перешёл на Redis), но продюсер поле заполняет |

**Индексы:**
- `ix_emission_region_started (region, started_at)` — поиск событий по региону и времени
- `ix_emission_active (region, ended_at)` — быстрый поиск активных выбросов (`ended_at IS NULL`)

**Миграции:** `0031_emission_events.py`, `0033_emission_end_notified.py`

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
| `0011_master_items_color.py` | Поле `color` в `master_items` (RANK_* строки из GitHub) |
| `0012_watchlist_quality_enchant.py` | Поля `quality_filter`, `enchant_filter` в `user_watchlist`; удаляет DB-unique индекс |
| `0013_add_is_approved.py` | Поле `users.is_approved` (существующим пользователям `true`, новым — `false` по умолчанию модели) |
| `0014_market_stats_volatility_30d.py` | Поле `market_statistics.price_volatility_30d` |
| `0015_sales_volume_30d.py` | Поле `market_statistics.sales_volume_30d` |
| `0016_sales_history_item_region_idx.py` | Индекс `ix_sales_item_region_time (item_id, region, sale_time)` на `sales_history` |
| `0017_purchase_rec_rename_price_fields.py` | `purchase_recommendations.expected_sell_price_per_unit` → `expected_listing_price_per_unit` + новое поле `expected_net_revenue_per_unit` |
| `0018_global_item_scan_history.py` | Часть удалённой фичи "Лента" — таблица `global_item_scan` переведена в режим истории (дропнута миграцией 0021) |
| `0019_user_feed_exclusion.py` | Часть удалённой фичи "Лента" — таблица `user_feed_exclusion` (дропнута миграцией 0021) |
| `0020_global_scan_quality_enchant.py` | Часть удалённой фичи "Лента" — поля `quality`/`enchant` в `global_item_scan` (дропнута миграцией 0021) |
| `0021_drop_feed_tables.py` | Дроп `global_item_scan` и `user_feed_exclusion` — фича "Лента возможностей" удалена безвозвратно (downgrade не реализован) |
| `0022_master_items_bind_state.py` | Поле `bind_state` в `master_items` (статус привязки из GitHub, для фильтрации непродаваемых предметов) |
| `0023_market_demand_signals.py` | Поле `demand_signals` (jsonb) в `market_statistics` — bulk_spike сигнал |
| `0024_signal_outcomes.py` | Новая таблица `signal_outcomes` — лог предсказаний для будущей калибровки |
| `0025_dedup_sales_history.py` | Чистка дублей в `sales_history` (69 924 → 54 256 строк) + уникальный индекс `uq_sales_history_sale (item_id, region, sale_time, total_price, amount)` |
| `0026_user_tiers.py` | Поля `users.tier`, `tier_expires_at`, `last_seen`, `has_market_radar_addon`. Существующим `is_admin=True` выставляет `tier='advanced_max'` (косметика) |
| `0027_market_stats_48h.py` | Поля `avg_price_48h`, `min_price_48h`, `max_price_48h`, `sales_volume_48h` в `market_statistics` |
| `0028_registration_settings.py` | Новая таблица-синглтон `registration_settings`, сразу вставляет строку `id=1` с дефолтами |
| `0029_favorites_limit_override.py` | Поле `users.favorites_limit_override` (integer, nullable) — ручной override лимита watchlist вне тарифа |
| `0030_news_table.py` | Новая таблица `news` (новости и анонсы, 6 эндпоинтов `/api/v1/news/*`) |
| `0031_emission_events.py` | Новая таблица `emission_events` (трекер радиационных выбросов; индексы `ix_emission_region_started`, `ix_emission_active`) |
| `0032_sales_collected_at_idx.py` | Индекс `ix_sales_collected_at (collected_at)` на `sales_history` — под дифф-пропуск в `calculate_market_stats_batch` (пары с новыми продажами после `calculated_at`) |
| `0033_emission_end_notified.py` | Поле `emission_events.end_notified` (boolean NOT NULL, server_default false) + backfill `end_notified = TRUE` всей истории — рассылка о завершении выброса перенесена в `telegram_bot` |
| `0034_buy_alerts.py` | Раздел «Закупки // Buy Sniper»: drop `sell_recommendations` + `user_inventory` (старый «Склад»), create `buy_alerts` (FK→users CASCADE+index, FK→user_watchlist CASCADE UNIQUE, `target_price`, `is_active`) |

> Орфанная пара `c7bfc1ffa62c_add_feed_watchlist.py` / `e8a3d1f5c920_drop_feed_watchlist.py` — добавлена и откатана в тот же день (2026-06-11, вторая попытка "Ленты", таблица `feed_watchlist`), без следа в текущей схеме.

---

## Rate Limiter (Stalcraft API)

| Запрос | Стоимость |
|--------|-----------|
| `/auction/{id}/lots` | 2 запроса |
| `/auction/{id}/history` | 2 запроса |
| `/emission` | 1 запрос |
| Ёмкость корзины | 400 запросов / минута (verified 2026-06-07) |

Реализован через Redis (Lua script, атомарный). Fallback — in-memory при недоступности Redis.

**Redis-ключи:**
- `stalcraft:rate_limit` — состояние bucket (`tokens`, `last_refill`), TTL 120с
- `stalcraft:requests:minute:{unix_minute}` — счётчик фактически потреблённых токенов за текущую минуту (инкрементируется атомарно внутри того же Lua-скрипта при списании), TTL 120с. Питает `GET /admin/stats` (карточка «Rate limit» в админке) — см. `docs/SERVICES.md`.
