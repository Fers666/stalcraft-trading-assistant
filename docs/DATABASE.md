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

> Колонок «Ленты артефактов» (`feed_notify_push`, `feed_notify_telegram`,
> `feed_min_profit_percent`) в таблице **нет**: у ленты нет уведомлений, объём сужен
> пользователем 2026-08-04 (`docs/tasks/artifact-feed.md`, §Ревизия 4). Из миграции `0038`
> они убраны до её применения на проде. Порог **видимости** строк ленты берётся из
> существующего `min_profit_margin_percent` — он же валидируется на сервере диапазоном
> `0..100` (`SettingsUpdate`), потому что входит и в `WHERE` ленты, и в ключ кэша витрины.

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

Источник: [EXBO-Studio/stalzone-database](https://github.com/EXBO-Studio/stalzone-database).  
Синхронизируется через `POST /api/v1/items/refresh-catalog` (только для admin).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | integer PK | Внутренний ID |
| `item_id` | varchar(50) UNIQUE | Код предмета в игре (напр. `m02wr`, `04yr`) |
| `name_ru` | varchar(200) | Русское название |
| `name_en` | varchar(200) | Английское название |
| `category` | varchar(50) | Категория (напр. `artefact/biochemical`, `weapon/assault_rifle`) |
| `bind_state` | varchar(30) | `status.state` из GitHub — **привязка**, НЕ торгуемость. Больше не источник статуса «появляется ли на аукционе» (заменён на `on_auction`, миграция 0036). Остаётся как метаданные GitHub и fallback для непроверенных предметов (`on_auction IS NULL`) в фильтре `/items` |
| `icon_path` | varchar, nullable | Путь к иконке внутри каталога EXBO (напр. `/icons/artefact/electrophysical/9nd0.png`) либо локальный `/arsenal-icons/{item_id}.webp`. Полный URL собирает `iconUrl()` (`frontend/src/utils/i18n.ts`); `NULL` → фолбэк-буква в цвете качества |
| `can_be_batch_traded` | bool | Можно ли торговать пачками (false для оружия, брони) |
| `last_updated` | timestamptz | Дата последней синхронизации с GitHub |
| `on_auction` | bool, nullable | Реальная торгуемость по данным Stalcraft API (миграция 0036). `NULL` = ещё не проверено, `TRUE` = торгуется, `FALSE` = не появляется на аукционе. Заполняется задачей `audit_auction_status` (см. `docs/SERVICES.md`) |
| `auction_checked_at` | timestamptz, nullable | Момент последней проверки через API (resumable-прогон + периодический ре-чек) |
| `history_total` | integer, nullable | Последний замер `total` из `/history` (аудит/отладка) |
| `lots_total` | integer, nullable | Последний замер `total` из `/lots` (аудит/отладка; `NULL`, если `/lots` не запрашивался — история уже дала `>0`) |

**Индексы:** `item_id` (unique), `name_ru`, `name_en`, `category`, `on_auction` (`ix_master_on_auction`, под фильтр каталога).

**Фильтрация непродаваемых предметов (с 2026-07-24, миграция 0036):** источник
статуса торгуемости — поле `on_auction` (реальная проверка через Stalcraft API),
а НЕ эвристика по `bind_state`. `GET /items` (`list_items`) фильтрует по формуле
Фазы A + gear-исключение:

```sql
(on_auction IS NOT FALSE OR gear_exempt)
AND (on_auction IS TRUE OR bind_state IS NULL OR bind_state NOT IN
     ('PERSONAL_ON_GET','PERSONAL_DROP_ON_GET'))
```

- `on_auction = FALSE` скрывает предмет (подтверждённо не торгуется), `TRUE`/`NULL`
  показывает; для `NULL` (ещё не проверен) действует старый fallback по `bind_state`.
- `gear_exempt` = категории `weapon%`/`armor%`/`attachment%`/`backpacks%` (набор
  `_SINGLE_CATEGORIES`, экипируемая снаряга). Такое gear с `on_auction=FALSE` НЕ
  прячется: каталожный `item_id` части gear даёт `0/0` по API, но надёжно отделить
  реально непродаваемое от торгуемого-под-другим-именем нельзя (id не резолвится
  через API) — весь класс gear держим видимым, чтобы не терять живое оружие.

Результат: ~519 непродаваемых **не-gear** предметов (квесты, валюта, чертежи,
крафт-патроны, поношенные/арена-стволы) убраны из каталога; всё gear видимо.
Бэкфилл на проде дал 1445 TRUE / 879 FALSE (errors=0).

> Прежняя формулировка «id-mismatch = баг» **не подтвердилась**: каталожный
> `item_id` — канонический id EXBO, AK-103 (`0/0`) реально не торгуется. Часть gear
> честно непродаваема, часть торгуется (те → TRUE); gear видим сознательно (размен:
> не терять торгуемое ценой показа пары непродаваемых). Детали расследования —
> `docs/tasks/audit-on-auction-status.md`.

**Примечание о разовом импорте (2026-07-31):** 317 предметов добавлены через скрипт
`backend/app/scripts/import_arsenal_items.py` из внешних источников ресерча (Lunar, stalzone.wiki,
stalzone-monitor, EXBO global-ветка); эти строки **не содержат** полей `name_en`, `color` и `bind_state`
(все `NULL`) до тех пор, пока EXBO официально не добавит эти `item_id` в свой каталог и обычный
`refresh-catalog` не обогатит их значениями. Статус `on_auction` для таких строк проставлен вручную
(прямая проверка через `/lots` + `/history` к Stalcraft API) и истинен, **не** автоматически через
задачу `audit_auction_status`. Поле `icon_path` у 40 из 317 записей указывает на локальные иконки
в `frontend/public/arsenal-icons/{item_id}.webp` (webp-формат), остальные имеют `icon_path = NULL`
(фолбэк-отображение буквы на фронте — см. `iconUrl()` в `frontend/src/utils/i18n.ts`).

**Откуда браузер берёт иконки (с 2026-08-31).** Не-локальные `icon_path` дополняются
базой `https://cdn.jsdelivr.net/gh/EXBO-Studio/stalzone-database@main/ru` — jsDelivr,
зеркало того же репозитория. Прямой `raw.githubusercontent.com` **заблокирован по SNI**
у российских провайдеров: DNS резолвится, TCP-коннект проходит, рвётся TLS-хендшейк,
запрос висит ~5 с и иконка не приезжает. Синк каталога (`github_parser.py`) при этом
ходит на `raw.githubusercontent.com` **по-прежнему** — он выполняется с прод-сервера,
у которого выход в GitHub есть, а jsDelivr держит ссылку на ветку `@main` в кэше до 12 ч,
что для каталога уже заметная задержка. Оба хоста менять синхронно не нужно.

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
| `user_id` | integer FK, **nullable с миграции 0038** | `NULL` = глобально собранная продажа: историю по всем 103 артефактам пишет задача `collect_artifact_history` (не watchlist-пара) — та же конвенция, что у `collected_data.user_id` и `market_statistics.user_id`. Ни один сервис по `user_id` здесь не фильтрует |
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

Легаси-индекс `ix_sales_item_time` (`user_id, item_id, sale_time`) после перевода `user_id` в nullable **оставлен как есть** — новых индексов под глобальные строки не потребовалось: чтение истории артефактов идёт по `ix_sales_item_region_time`, дедуп — по `uq_sales_history_sale`. `downgrade()` миграции 0038 перед возвратом `NOT NULL` делает `DELETE FROM sales_history WHERE user_id IS NULL` (иначе откат упадёт); данные восстановимы повторным сбором.

---

### `market_statistics` — агрегированная статистика рынка

Пересчитывается раз в час (Celery task `calculate_all_market_stats`).  
UNIQUE по `(user_id, item_id, region)` — одна запись на предмет.

| Поле | Тип | Описание |
|------|-----|----------|
| `avg_price_24h` | numeric(12,2) | Средняя цена продажи за последние 24ч |
| `min_price_24h` | bigint | Минимальная цена за 24ч |
| `max_price_24h` | bigint | Максимальная цена за 24ч |
| `median_price_24h` | numeric(12,2) | Медианная цена за 24ч (миграция 0037) — краткосрочный ориентир и база расчёта `trend` |
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
| `reference_price` | bigint | **Опорная цена `sell_options`** (миграция 0037): взвешенная по свежести медиана продаж за 7д, `pricing.weighted_reference`. **НЕ равна `median_price_7d`** — та остаётся описательной статистикой для отображения |
| `reference_weight` | numeric(10,2) | **Эффективное число сделок за опорой** (миграция 0039, nullable): `Σ 0.5 ** (age_h / 48)` по тем же сделкам, что дали `reference_price`. Из `reference_price`/`sales_volume_7d` не выводится, поэтому хранится рядом. Карточка предмета без фильтров читает опору отсюда (живой пересчёт на каждый поллинг в 30 с потребовал бы всю историю за 7д) и по нему считает `confidence`/`below_floor`. Бэкфилла нет — часовой `calculate_market_stats` заполнит; до этого `NULL` → `confidence="low"` (честнее заниженной уверенности, чем завышенная по сырому count) |
| `sell_options` | jsonb | **3 варианта цены с прогнозом времени** (см. ниже), считаются от `reference_price` |
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
    "fill_probability": 75,
    "confidence": "low|medium|high",
    "data_points": 5
  },
  { "label": "normal", ... },
  { "label": "premium", ... }
]
```
`confidence` по coverage: `coverage = matched_count / total_sales_30d × 100%`  
`high` ≥30% AND ≥10 точек, `medium` 10–30% AND ≥3 точки, `low` <10%.

`fill_probability` (75 / 50 / 25 для fast / normal / premium) — доля сделок варианта,
проходящих по цене тира или выше; добавлено 2026-08-16 вместе с калибровкой множителей
(`docs/BUSINESS_LOGIC.md` §4). Миграции нет — оба поля-носителя (`market_statistics.sell_options`
и `artifact_variant_stats.sell_options`) JSONB. **Поле опционально:** у строк, записанных до
калибровки, его нет — до ближайшего пересчёта (`calculate_market_stats` — час,
`calculate_artifact_variant_stats` — 10 мин). Потребители обязаны переживать его отсутствие;
фронт при `null` просто не рисует строку «сделок дороже» (число «по умолчанию» соврало бы
про свойство цены).

⚠ **Имя поля историческое и вводит в заблуждение: это не вероятность продажи лота**
(поправка 2026-08-16). Величина посчитана по ценам **состоявшихся** сделок, то есть это
ценовая позиция относительно потока сделок; о частоте прихода покупателей и о лотах, которые
не продались вовсе, она ничего не знает. Подпись в UI — «сделок дороже ~75 %». Настоящая
вероятность исполнения — `P(продан ≤ H)` по `lot_observations` (P1-4, фаза B).

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

### `feed_lots` — живой срез выгодных лотов «Ленты артефактов»

Миграция `0038`. **Только выгодные лоты** (`evaluate_lot_profit` вернул не-`None`) — с 2026-08-21 выгодность проверяется по **всем трём тирам** продажи, а не только по `fast`, и тир записывается в `tier_used` (ТЗ `docs/tasks/feed-multi-tier-admission.md`). Переписывается каждым циклом `collect_artifact_lots` (~раз в минуту): upsert по `(item_id, region, lot_key)`, затем `DELETE ... WHERE seen_at < cycle_started_at` по обойдённому предмету и уборка строк старше `FEED_STALE_ROW_HOURS = 1`. Единственный писатель — `backend/app/tasks/feed_collector.py`. Формулы — `docs/BUSINESS_LOGIC.md` §18.

| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|
| `id` | bigserial PK | нет | |
| `item_id` | varchar(50) FK→`master_items.item_id` | нет | |
| `region` | varchar(10) | нет | В v1 только `RU` (`settings.stalcraft_region`) |
| `lot_key` | varchar(128) | нет | Идентичность лота на аукционе: `startTime\|qlt\|ptn\|buyoutPrice\|amount` (`feed_collector.lot_identity_key`). Один `startTime` ключом быть не может — точность API секунды, у предмета висят разные лоты с одинаковым `startTime`. Реалистичный максимум ~58 символов, запас взят с прицелом на то, что переполнение роняет запись предмета целиком. Дубль ключа внутри одного батча — ошибка уровня всей транзакции (`CardinalityViolationError`), поэтому батч дополнительно схлопывается `feed_collector.dedupe_rows` перед `INSERT`: это был блокер P1, цикл сбора падал целиком |
| `qlt` | smallint | нет | Качество 0–5 (из `lot["additional"]`) |
| `ptn` | smallint | нет | Заточка 0–15 |
| `amount` | integer | нет | Штук в лоте |
| `buyout_price` | bigint | нет | Итого к оплате за лот |
| `buyout_per_unit` | bigint | нет | `buyout_price // amount` |
| `start_time` | timestamptz | да | Из `lot["startTime"]` (отдельным полем: `lot_key` составной) |
| `end_time` | timestamptz | да | Из `lot["endTime"]`. **Длительность аукциона переменная**, см. врезку ниже |
| `ref_price` | bigint | нет | Опорная цена варианта из `artifact_variant_stats.ref_price` |
| `tier_used` | varchar(10) | нет | Тир продажи, которым лот прошёл в ленту: `fast` / `normal` / `premium`. **Самый быстрый из подошедших** (`pricing.TIER_ORDER`) — отвечает на «как быстро это перепродать с прибылью», а не «где больше денег»; на второе отвечает `ev_profit`. **Все колонки прибыли посчитаны по этому тиру**, поэтому сравнивать `profit_pct` строк разных тиров напрямую нельзя: цена тира — это ещё и вероятность продажи (замер за 7 дней: `fast` 81.3 %, `normal` 74.5 %, `premium` 49.0 %). Миграция `0048`, `server_default='fast'` |
| `sell_price_used` | bigint | нет | Из `evaluate_lot_profit` |
| `breakeven_per_unit` | bigint | нет | Из `evaluate_lot_profit` (единственное место расчёта безубытка) |
| `profit_per_unit` | bigint | нет | Прибыль на единицу |
| `profit_total` | bigint | нет | `profit_per_unit × amount` — **колонка сортировки по умолчанию**, материализована |
| `profit_pct` | numeric(8,2) | нет | |
| `margin_adj_pct` | numeric(8,2) | нет | `profit_pct / risk_mult` — sargable-форма фильтра `profit_pct >= порог × risk_mult`; **основной фильтр видимости ленты** |
| `profit_per_hour` | numeric(14,2) | да | ₽/час **на единицу** (как считает `evaluate_lot_profit`) |
| `profit_per_hour_total` | numeric(14,2) | да | `profit_total / est_sell_hours` — ₽/час **со всего лота**, ровно та величина, которую печатает колонка «₽/час», и ключ её сортировки (`?sort=profit_per_hour`). Материализована, потому что сортировать надо по показанному числу: при `amount > 1` две величины расходятся в `amount` раз и выдача переворачивалась |
| `est_sell_hours` | numeric(8,2) | да | `estimated_hours` тира `tier_used` (до 2026-08-21 — всегда `fast`; часы `fast` у строки тира `premium` завышали ₽/час втрое) |
| `ev_profit` | bigint | да | **Ключ сортировки ленты по умолчанию.** Ожидаемая прибыль в рублях = максимум по сценариям всех трёх тиров, каждый взвешен своей `p_sold_6h`. `NULL` = вероятность не измерена, строка уходит в конец выдачи (`nulls_last`); подставлять `p = 1` нельзя — это вернуло бы допущение «продастся обязательно». В рублях, а не в ₽/час: часовая ставка подразумевает поток одинаковых лотов, которого на этом рынке нет |
| `p_sold_6h` | numeric(5,2) | да | P(продан ≤ 6 ч) для плановой цены продажи, **нижняя граница** (снятый лот считается непроданным). Из `sale_survival` по позиции цены в стакане варианта. `NULL`, пока страта не набрала `MIN_STRATUM_N` — отсутствие честнее выдуманного числа |
| `pct_sold_ever` | numeric(5,2) | да | Доля страты, продавшаяся когда-либо |
| `profit_total_slow` | bigint | да | Сценарий «подождать и продать дороже» — цена **следующего тира вверх** от `tier_used` (до 2026-08-21 — всегда `premium`). `NULL` у строк тира `premium`: выше тира нет, и сценарий совпал бы с самой строкой |
| `est_sell_hours_slow` | numeric(8,2) | да | Срок сценария ожидания |
| `p_sold_6h_slow` | numeric(5,2) | да | Вероятность сценария ожидания |
| `risk` | varchar(10) | нет | low / medium / high (`classify_risk` варианта) |
| `risk_mult` | numeric(3,2) | нет | 1.00 / 1.30 / 1.60 из `pricing.RISK_MARGIN_MULT` |
| `volatility_7d` | numeric(6,2) | да | |
| `trend_24h` | varchar(10) | да | falling / stable / rising / unknown — **метка**, цену не двигает |
| `trend_24h_pct` | numeric(8,2) | да | |
| `trend_7d_pct` | numeric(8,2) | да | |
| `sales_per_day` | numeric(10,2) | да | Денормализованный снимок `sales_volume_7d / 7` варианта (чтобы сортировать без join) |
| `supply_coverage_days` | numeric(10,2) | да | Σ amount **всех** живых лотов варианта / `sales_per_day`; `NULL` при отсутствии продаж |
| `stats_confidence` | varchar(10) | да | `ref_confidence` варианта (high / medium / low — по эффективному весу опоры) |
| `stats_samples` | integer | да | `ref_samples` варианта |
| `first_seen_at` | timestamptz | нет | Проставляется только при вставке — момент первого появления лота в ленте |
| `seen_at` | timestamptz | нет | Момент последнего цикла, где лот подтверждён; `max(seen_at)` = `snapshot_at` ответов API |

**Индексы:** `uq_feed_lots_lot (item_id, region, lot_key)` UNIQUE, `ix_feed_lots_profit_total (profit_total DESC)`, `ix_feed_lots_profit_pct (profit_pct DESC)`, `ix_feed_lots_margin_adj (margin_adj_pct DESC)`, `ix_feed_lots_item (item_id)`, `ix_feed_lots_variant (qlt, ptn)`, `ix_feed_lots_end_time (end_time)`, `ix_feed_lots_seen_at (seen_at)`.

> Индекса по `buyout_price` **нет намеренно**: витрина лимитированных тарифов использует его только в `percentile_cont` по всей выборке и в `BETWEEN` — на таблице в сотни–тысячи строк индекс выигрыша не даёт (Ревизия 2 ТЗ ленты отменила запланированный тогда индекс; номер `0039` позже занят миграцией `reference_weight`, к индексу отношения не имеющей).
>
> `supply_coverage_days` живёт здесь, а не в `artifact_variant_stats`: задача статистики не видит живых лотов (читает только `sales_history`), а сбор лотов видит их целиком — так у каждой таблицы остаётся **один писатель**.

---

### `artifact_variant_stats` — статистика варианта «предмет × качество × заточка»

Миграция `0038`. Опора скоринга ленты: без `ref_price`/`sell_options` варианта лоты пропускаются целиком (считать выгодность от цен **выставленных** лотов — ровно та ошибка, на которой фича умирала дважды). Пересчитывается задачей `calculate_artifact_variant_stats` каждые 10 мин по продажам за 30 дней; варианты без сделок за окно удаляются. Единственный писатель — `backend/app/services/analytics/variant_stats.py`.

| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|
| `id` | bigserial PK | нет | |
| `item_id` | varchar(50) FK→`master_items.item_id` | нет | |
| `region` | varchar(10) | нет | |
| `qlt` / `ptn` | smallint | нет | Вариант: `additional_info.qlt` 0–5, `ptn` 0–15 |
| `ref_price` | bigint | да | `pricing.compute_reference()["ref"]` — взвешенная по свежести медиана **сделок** 7 д. `NULL` = вариант в ленту не попадает: сделок за 30 д нет вовсе **либо** опора ниже пола по данным (`below_floor`, эффективный вес < `MIN_REF_WEIGHT = 5`) |
| `ref_source` | varchar(20) | да | weighted_history / history / current_fallback |
| `ref_confidence` | varchar(10) | да | high / medium / low — по **эффективному** весу опоры (`Σ 0.5 ** (age_h / 48)`), а не по сырому числу сделок |
| `ref_samples` | integer | да | Сырое число сделок за 7 д, оставшихся после отсечки выбросов |
| `median_24h` / `median_7d` / `median_30d` | numeric(14,2) | да | Описательные медианы сделок |
| `sales_volume_24h` / `_7d` / `_30d` | integer | да | Число сделок в окне |
| `sales_per_day` | numeric(10,2) | да | `sales_volume_7d / 7` |
| `volatility_7d` | numeric(6,2) | да | stdev/mean × 100 при ≥ 5 сделках |
| `risk` | varchar(10) | да | `classify_risk(volatility_7d)` |
| `trend_24h` | varchar(10) | да | Метка из `compute_reference` |
| `trend_24h_pct` | numeric(8,2) | да | |
| `trend_7d_pct` | numeric(8,2) | да | `(median_7d / median_30d − 1) × 100`, `NULL` при `median_30d` = 0/`NULL` |
| `sell_options` | jsonb | да | Результат `make_sell_options` |
| `batch_stats` | jsonb | да | `market_stats._calculate_batch_stats` по продажам варианта |
| `avg_sell_time_hours` | numeric(8,2) | да | `market_stats._avg_sell_time_from_buyouts` |
| `calculated_at` | timestamptz | нет | server_default `now()` |

**Индексы:** `uq_artifact_variant (item_id, region, qlt, ptn)` UNIQUE, `ix_avs_item (item_id, region)`.

> **Вариант ниже пола по данным** (с 2026-08-16, `docs/tasks/ref-quality-floor.md`): строка
> пишется с `ref_price = NULL` и `sell_options = NULL`, но `ref_source`/`ref_confidence`/
> `ref_samples` и все описательные медианы **сохраняются** — иначе «мало данных» не отличить
> от «сделок не было вовсе». Строк в `feed_lots` у такого варианта нет, поэтому его карточка
> (`GET /feed/variant`) достижима только переходом «Все лоты предмета» и показывает
> «недостаточно данных» вместо цены — принято сознательно (§7.4 ТЗ): цене, за которой стоит
> меньше 5 эффективных сделок, верить нельзя.

---

### `lot_observations` — наблюдения за жизнью лота (миграции `0040` + `0041`)

Одна строка = один лот, от первого наблюдения до исхода. Первый в системе источник, который
видит **непроданные** лоты: всё остальное (`sales_history`, восстановление `lot_start`,
`signal_outcomes`) по построению видит только состоявшиеся сделки. Сырьё для кривой дожития
`P(продан ≤ H)` — P1-4 фаза B.

Пишет **только** свип ленты (`collect_artifact_lots`) — там полная пагинация `/lots`, поэтому
исчезновение лота из среза настоящее. Снэпшоты watchlist (`collected_data.raw_lots`) источником
быть не могут: они обрезаны до 200 самых дешёвых лотов, и «вытеснен дешёвым» там неотличимо от
«продан». Закрывает строку `resolve_lot_observations`, удаляет — `delete_old_data`
(`resolved_at` старше `LOT_OBS_RETENTION_DAYS = 30`; открытые строки не трогаются).
Бэкфилла нет и быть не может: наблюдение — событие, а не расчёт.

| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|
| `id` | bigserial PK | нет | |
| `item_id` | varchar(50) FK→`master_items.item_id` | нет | Только артефакты (свип ленты) |
| `region` | varchar(10) | нет | |
| `qlt` / `ptn` | smallint | нет | Вариант лота |
| `lot_key` | varchar(128) | нет | `lot_identity_key` = `startTime\|qlt\|ptn\|buyoutPrice\|amount` — тот же ключ, что у `feed_lots` |
| `start_time` / `end_time` | timestamptz | да | Выставление и плановое истечение, из лота. Длительность **переменная**: 48 ч у 47 % лотов, 12 ч у 39 %, 24 ч у 11 %, 6 ч у 3 % (замер 2026-08-17) |
| `amount` | integer | нет | Штук в лоте |
| `buyout_price` / `buyout_per_unit` | bigint | нет | Цена всего лота и за штуку |
| `ref_price_at_seen` | bigint | да | Опора варианта **на момент первого наблюдения** (заморожена). `NULL` = опоры не было: нет сделок либо ниже пола по данным (P0-2) |
| `queue_rank` | integer | да | Место в очереди по цене внутри **варианта** на момент первого наблюдения: `1` = самый дешёвый живой лот. Ранг соревновательный — у лотов с одинаковой ценой он одинаковый. `NULL` = лот был неликвиден (< 2 ч до конца) и в очереди не стоял; **это не 0** — «не участвовал» и «первый» не должны слипнуться |
| `cheaper_units` | integer | да | Σ `amount` живых лотов варианта строго дешевле (единицы, а не лоты: 1 лот на 50 шт ≠ 50 лотов по 1). `NULL` — та же семантика |
| `variant_live_lots` | integer | да | Всего живых лотов варианта — знаменатель для ранга. `NULL` — та же семантика |
| `first_seen_at` | timestamptz | нет | Ставится **только при вставке** |
| `last_seen_at` | timestamptz | нет | Последний цикл, видевший лот — единственное поле, которое обновляет апсерт |
| `outcome` | varchar(12) | да | `NULL` пока лот жив; далее `sold` / `expired` / `withdrawn` (смысл — `docs/BUSINESS_LOGIC.md` §19) |
| `resolved_at` | timestamptz | да | Когда резолвер закрыл строку |
| `matched_sale_id` | bigint FK→`sales_history.id` `ON DELETE SET NULL` | да | Какая именно сделка закрыла наблюдение (миграция `0041`) |

**Индексы:** `uq_lot_obs_lot (item_id, region, lot_key)` UNIQUE, `ix_lot_obs_pending (outcome,
last_seen_at)` (выборка резолвера), `ix_lot_obs_variant (item_id, region, qlt, ptn)` (фаза B),
`uq_lot_obs_matched_sale (matched_sale_id)` UNIQUE **частичный** — `WHERE matched_sale_id IS NOT
NULL` (без предиката индекс распух бы на всех живых и незакрытых строках, где там `NULL`, а
конфликтовать они всё равно не могут).

> **Почему `matched_sale_id` — колонка, а не деталь резолвера.** До миграции `0041` резолвер
> искал **любую** подходящую сделку и не расходовал её: одна продажа помечала `sold` все
> неразличимые наблюдения варианта (та же цена лота и количество). Замер на проде: **47.5 %**
> строк `sold` (1104 из 2326) сидели в таких группах, худшая — **42 наблюдения** на одну
> возможную сделку. Уникальный частичный индекс делает правило «одна сделка = максимум одно
> наблюдение» инвариантом схемы, а не соглашением кода: при наложении двух прогонов резолвера
> второй упадёт на уникальности, а не тихо припишет сделку дважды.
>
> **`ON DELETE SET NULL` обязателен:** `sales_history` живёт 120 дней и чистится в том же
> `delete_old_data` **раньше** наблюдений (30 дней). Ссылка не должна блокировать уборку;
> `outcome` при этом остаётся `sold`, теряется только указатель.
>
> **Состояние стакана пишется на записи и не обновляется.** `queue_rank` / `cheaper_units` /
> `variant_live_lots` считаются по варианту `(item_id, qlt, ptn)`, а не по предмету — агрегат по
> предмету смешал бы разные по цене товары. Задним числом их не восстановить (нужен весь срез
> варианта на тот момент), а сборщик держит стакан в памяти в этом же проходе. Как и
> `ref_price_at_seen`, это **снимок условий, в которых лот был выставлен**: при повторной встрече
> лота апсерт их не трогает, иначе связь «цена и позиция → вероятность продажи» рассыплется.
> Бэкфилла нет — у строк до `0041` останется `NULL`.

> ⚠ **Длительность аукциона переменная — допущение «лот живёт 48 ч» неверно** (замер
> 2026-08-17, `docs/tasks/sale-survival-curve.md` §2.1). Реальное распределение
> `end_time − start_time`: **48 ч — 47.0 %, 12 ч — 38.9 %, 24 ч — 11.1 %, 6 ч — 3.0 %**.
> Следствие: 42 % лотов физически не доживают до горизонта 24 ч, и любая вероятность
> `P(продан ≤ H)` обязана считаться только по тем, у кого `end_time − start_time ≥ H`.
> Без этого фильтра дальние горизонты занижаются механически. Резолвер при этом
> корректен: у `expired` медиана `last_seen_at − end_time` = −2.9 мин, закрытых раньше
> срока нет ни одной.

> **Лот нельзя купить первые ~10 минут после `start_time`** (замер 2026-08-17, §2.2).
> Проверено независимым источником: среди 108 196 сделок с `lot_start` доля с возрастом
> лота ≤ 10 мин — **0.0 %**, ≤ 15 мин — 8.1 %, медиана 64 мин. Поэтому задержка входа
> сборщика (мода 10 мин, минимум 7) — не пропуск наблюдения, а свойство рынка: мы видим
> лот ровно тогда, когда он становится доступен. Поправка на левое усечение для
> инцидентной когорты не нужна.

---

### `sale_survival` — кривая дожития лота (миграции `0043`, `0046`)

Одна строка = страта × горизонт. Отвечает на вопрос, которого система не умела задавать:
**продастся ли лот вообще и когда**. Пересчитывается раз в сутки задачей
`recalc_sale_survival` целиком (`DELETE` + `INSERT`) — таблица производная и ~60 строк.

| Колонка | Тип | Смысл |
|---|---|---|
| `class` | varchar(8), NOT NULL | `artefact` / `gear` — класс предмета (миграция `0046`) |
| `feature` | varchar(8) | `pos` — нормированная позиция в стакане, `ratio` — цена к опоре |
| `bucket` | varchar(16) | код страты (`top10` / `r94_98` / …) |
| `horizon_h` | smallint | 1 / 3 / 6 / 12 / 24 |
| `n_at_risk` | integer | доживших **административно** до горизонта (`end_time − start_time ≥ H`) |
| `n_sold` | integer | из них проданных не позже горизонта |
| `p_sold_lo` | numeric(5,2) | `n_sold / n_at_risk` — снятый лот считается непроданным |
| `p_sold_hi` | numeric(5,2) | снятый до горизонта исключён из знаменателя |
| `pct_withdrawn` | numeric(5,2) | доля снятых до горизонта |
| `pct_sold_ever` | numeric(5,2) | продались когда-либо **среди доживших до горизонта** — знаменатель общий с `p_sold_*` |
| `median_hours` | numeric(6,2) | медиана срока **среди проданных** |

Уникальный ключ `(class, feature, bucket, horizon_h)` (индекс `uq_sale_survival`; до `0046`
был без класса). `median_hours` от горизонта не зависит и дублируется по строкам страты
намеренно — сводка читается одним запросом.

> **Класс предмета — измерение, а не колонка для отчёта** (миграция `0046`, 2026-08-17).
> Лента расширилась с артефактов на снаряжение, части предметов, премиум и сезонные пропуска
> (`docs/tasks/feed-gear-expansion.md`), и заимствовать снаряжению артефактную кривую нельзя:
> у снаряжения качество является свойством **предмета** каталога, а не лота, и своя механика
> рынка (высокие тиры чаще получают апгрейдом, чем покупают). Чужое измеренное число хуже
> отсутствия числа. Классов ровно два — дробить по категориям нельзя, страты не наберут
> `MIN_STRATUM_N = 200`.
>
> Бэкфилла нет и не нужно: существующие строки посчитаны по артефактам и получают
> `'artefact'` (`server_default` живёт ровно на время заполнения и снимается тут же — строку
> без явного класса пишет только ошибка, и падать она обязана громко). Gear-страты появляются
> сами по мере накопления наблюдений; пока их нет, `get()` возвращает `None` и потребитель
> деградирует так же, как артефакты до первого пересчёта. `downgrade` удаляет строки
> `class <> 'artefact'`: без измерения они неотличимы от артефактных и сделали бы уникальный
> ключ противоречивым.

> ⚠ **`pct_sold_ever` считается на той же цензурированной популяции, что и `p_sold_*`**
> (правка 2026-08-17 по итогам QA). Первая версия брала знаменателем всю страту, и
> величина выходила **меньше** `p_sold_24h` во **всех 59 стратах**: 6- и 12-часовые
> аукционы продаются реже и тянули её вниз. В UI это читалось как «за сутки продалось
> 89.93 %» рядом с «не продаётся 13 %» — сумма 102.9 %. Две доли, стоящие рядом, обязаны
> иметь один знаменатель.

> **Две границы, а не одна.** `withdrawn` — почти наверняка информативное цензурирование:
> продавец снимает лот, который не продаётся. Доказать независимость нельзя, поэтому
> считаются обе трактовки. В UI идёт **только `p_sold_lo`**: верхняя граница даёт 92–99 %
> во всех стратах и различия между ними стирает, решение она не поддерживает.

> **Только `source = 'live'`.** Восстановленные из снапшотов наблюдения измеряют позицию в
> книге верно (`corr = 0.992` с живым источником на 4418 общих лотах), но их **популяция**
> смещена: снапшот watchlist обрезан 200 дешёвыми лотами предмета, поэтому глубокие стаканы
> в нём не представлены (p90 размера книги **31** против **409** у живого), и он пропускает
> самые быстрые лоты — те, кого видел только живой сборщик, продаются в 80.1 % случаев с
> медианой жизни 0.61 ч против 56.9 % и 4.11 ч у общих. На одних и тех же предметах это даёт
> `P(продан ≤ 6 ч)` ниже живого на 8–16 п.п. Пул источников запрещён в коде запроса.
>
> Отсюда же поправка к прежней сверке: согласие источников **95.2 %** (6765 пар) измерено
> на общих лотах, а общее подмножество — это по построению долгожители. Цифра верна, но
> обобщать её на всю популяцию нельзя.

> **Порог `MIN_STRATUM_N = 200`.** Страта с меньшим `n_at_risk` не публикуется вовсе, и
> потребитель откатывается на прежнее поведение. Порог не «на глаз»: при n = 200 и p ≈ 0.8
> половина ширины 95 %-интервала ≈ 5.5 п.п. — меньше наименьшего разрыва между соседними
> стратами. Публиковать страту, чью погрешность не отличить от разницы с соседом, значит
> показывать шум.

> ⚠ **Ещё живые лоты входят в знаменатель** (правка 2026-08-17). Лот, переживший
> горизонт у нас на глазах, — полноценное наблюдение «за H часов не продался». Первая
> версия брала только закрытые строки, а лот закрывается через 2 ч после последнего
> появления: среди недавних успевали закрыться в основном быстро проданные. Завышение
> составляло 12.5–15.7 п.п. по горизонтам и до **21.4 п.п.** по отдельным стратам,
> причём неравномерно — сильнее по медленным, — так что искажался и уровень, и форма
> кривой. Условие «исход к горизонту известен»:
> `outcome IS NOT NULL OR life_h >= horizon_h`.

> ⚠ **Исход `blackout`** (2026-08-19). Лот, пропавший вместе со всем рынком (техработы
> на стороне игры: API отвечает 200 OK, но с `total = 0` по всем предметам),
> **исключается из популяции целиком**, а не помечается `withdrawn`. Любой не-NULL
> `outcome` завёл бы строку в знаменатель и никогда в числитель, то есть тихо просаживал
> бы вероятность — на реальной аварии так набралось 14 490 строк. Признак выводится из
> самих наблюдений: активность округляется до минуты (строки одного прохода различаются
> секундами и иначе ссылаются друг на друга), тишина — `MARKET_DARK_MINUTES = 15`, а окно
> неопределённости отсчитывается на полный круг обхода назад (`FEED_FULL_CYCLE_MINUTES`),
> потому что лот мог просто не попасть в последний проход перед остановкой.

> ⚠ **Второй путь в `blackout` — заморозка рынка** (2026-08-20). У поломки бывает вид,
> который признак выше не ловит **принципиально**: `/lots` отвечает нормально и лоты
> видны, но это застывший снимок. Тогда `last_seen_at` свежий у всех строк, тишины нет,
> и сторож молчит — на реальном случае молчал 10.8 часа. Признак заморозки другой:
> перестаёт расти `max(first_seen_at)`, то есть **новых** лотов не появляется.
> `MARKET_FROZEN_MINUTES = 45` (три полных круга обхода; в норме по рынку возникает
> минимум ~4 новых лота в минуту). При срабатывании резолв пропускается, а наблюдения,
> которые кормит застывший снимок, переводятся в `blackout`. Граница — момент появления
> последнего настоящего нового лота (`last_seen_at >= frozen_since`): что исчезло
> раньше, пропало при живом рынке и резолвится как обычно.
> Пометка держится, потому что `outcome` не входит в `observation_update_columns()`.
> Проверяется **после** темноты и только при её отсутствии — иначе долгий блэкаут
> выводил бы из выборки всю когорту вместо точечных сирот.

### `survival_calibration` — сверка публикуемых вероятностей с фактом

Замыкает петлю, которую `signal_outcomes` так и не замкнул. Проверяется ровно та
величина, которую видит пользователь: `p_sold_lo` своей страты.

| Колонка | Смысл |
|---|---|
| `class` / `feature` / `bucket` / `horizon_h` | та же координата, что у `sale_survival` |
| `window_from` / `window_to` | границы проверочного окна — без них строку нельзя перепроверить |
| `n` | наблюдений в окне (порог публикации `MIN_CALIBRATION_N = 150`) |
| `predicted` / `realized` | что публиковалось против того, что вышло |
| `error_pp` | `realized − predicted`. **Отрицательное = обещали больше, чем вышло** |

Два правила, без которых таблица бесполезна:

1. **Окно проверки открывается моментом обучения** (`computed_at` действующей
   `sale_survival`). Пересечение периодов превратило бы калибровку в подгонку — кривая
   сверялась бы с данными, на которых её и построили.
2. **Окно короче `MIN_CALIBRATION_WINDOW_HOURS = 20` отвергается.** Продажи имеют
   выраженный суточный ход (36–40 % в 2–5 утра против 54–57 % в 7–11 по Москве), и на
   коротком окне сверка измеряет время суток. Поймано на себе: ручной прогон через 5.5 ч
   после пересчёта дал −16.25 п.п. против −8.2 на полных сутках.

В сверку идут только наблюдения с **определённой на горизонте судьбой**: дожил до H на
наших глазах либо ушёл с рынка, И прошло достаточно времени, чтобы это стало известно.
Без условия зрелости в выборке остались бы одни быстрые — та же ошибка «метрика по
выжившим», что уже стоила знаменателя самой кривой.

**Измеренная кривая на проде (2026-08-17, `live`, инцидентная когорта):**

| Позиция в книге | n (6 ч) | ≤1 ч | ≤6 ч | ≤12 ч | продались вообще | медиана продажи |
|---|---|---|---|---|---|---|
| верх 10 % | 8270 | 36.92 | **73.68** | 82.86 | 80.07 | 0.86 ч |
| верх 10–25 % | 3578 | 14.36 | 42.82 | 58.89 | 51.15 | 1.56 ч |
| книга ≤ 3 лотов | 1574 | 10.68 | 30.50 | 41.70 | 36.34 | 1.29 ч |
| 25–50 % | 1580 | 6.68 | 27.53 | 42.85 | 37.28 | 2.46 ч |
| нижняя половина | 1463 | 2.52 | **10.05** | 16.54 | 14.29 | 2.58 ч |

Разброс **73.7 → 10.1 %** на горизонте 6 ч — сигнал, которого в системе не было.

> **Живая выборка пока охватывает менее суток** (сбор с 2026-08-16).
> `SURVIVAL_WINDOW_DAYS = 14` — верхняя граница окна, а не объём данных. Суточный цикл
> активности ещё не покрыт, поэтому числа будут двигаться; пересчёт идёт ежесуточно.

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
| `0035_push_subscriptions.py` | Новая таблица `push_subscriptions` (web push, ПК/Android/iOS): `user_id` FK→users CASCADE+index, `endpoint` UNIQUE, `p256dh`/`auth`/`user_agent`, `created_at`/`last_used_at` |
| `0036_master_items_on_auction.py` | Поля `master_items.on_auction` (bool nullable), `auction_checked_at` (timestamptz), `history_total`/`lots_total` (int) + индекс `ix_master_on_auction` — реальная торгуемость по Stalcraft API вместо эвристики `bind_state` (задача `audit_auction_status`) |
| `0037_market_stats_reference_price.py` | Поля `market_statistics.median_price_24h` (numeric) и `reference_price` (bigint) — опорная цена `sell_options` как взвешенная по свежести медиана продаж 7д вместо плоской `median_price_7d`. Без бэкфилла: часовой `calculate_market_stats` заполнит, до этого потребители падают на `median_price_7d` |
| `0038_artifact_feed.py` | «Лента артефактов»: новые таблицы `feed_lots` (8 индексов, включая дописанную позже колонку `profit_per_hour_total`) и `artifact_variant_stats` (2 индекса); `sales_history.user_id` → nullable (глобальная история артефактов пишется с `user_id=NULL`). Три колонки `user_settings` (`feed_notify_push`/`feed_notify_telegram`/`feed_min_profit_percent`) из миграции **убраны 2026-08-04** вместе с уведомлениями ленты. `downgrade()` перед возвратом `NOT NULL` удаляет строки `sales_history` с `user_id IS NULL` — применять **нельзя**, это уничтожает глобальную историю продаж. **На проде применена** (`alembic current` = `0038`, проверено прямым запросом 2026-08-16) |
| `0039_market_stats_reference_weight.py` | Поле `market_statistics.reference_weight` (numeric(10,2), nullable) — эффективное число сделок за опорой (пол по данным, `docs/tasks/ref-quality-floor.md`). Бэкфилла нет: часовой `calculate_market_stats` заполнит, до этого `NULL` → `confidence="low"`. ⚠ **Применять строго ДО запуска нового образа:** модель `MarketStatistics` объявляет колонку, поэтому без неё падает **любой** ORM-SELECT статистики — карточка предмета (500, `UndefinedColumnError`), watchlist-задачи и `calculate_market_stats` (на стенде — 94 ошибки за 10 минут). Ручки ленты (`/feed/lots`, `/feed/variant`) эту таблицу не читают и переживают. **На проде применена 2026-08-16** |
| `0040_lot_observations.py` | Новая таблица `lot_observations` — наблюдения за жизнью лота (P1-4, фаза A): 3 индекса (`uq_lot_obs_lot` UNIQUE, `ix_lot_obs_pending`, `ix_lot_obs_variant`). Бэкфилла нет и быть не может: наблюдение — событие, а не расчёт; таблица наполняется свипом ленты с первого цикла. **На проде применена 2026-08-16** |
| `0041_lot_obs_match_and_queue.py` | `lot_observations`: `matched_sale_id` (bigint FK→`sales_history.id` `ON DELETE SET NULL`) + **частичный** уникальный индекс `uq_lot_obs_matched_sale` (`WHERE matched_sale_id IS NOT NULL`) — одна сделка закрывает максимум одно наблюдение; и три колонки состояния стакана `queue_rank` / `cheaper_units` / `variant_live_lots`. Бэкфилла нет: у старых строк `NULL`, обе величины — снимок момента. **На проде применена 2026-08-16** (`alembic current` = `0041`) |

| `0046_sale_survival_class.py` | `sale_survival.class` (varchar(8), NOT NULL) — измерение «класс предмета» (`artefact` / `gear`) после расширения набора ленты на снаряжение; уникальный индекс `uq_sale_survival` пересоздан как `(class, feature, bucket, horizon_h)`. Бэкфилла нет: существующие строки посчитаны по артефактам и получают `'artefact'` через временный `server_default`, снимаемый в той же миграции. `downgrade` **удаляет** строки `class <> 'artefact'` — без измерения они неотличимы от артефактных. **На проде применена** (проверено 2026-08-21: до выкатки `0048` `alembic current` показывал `0047`) |
| `0048_feed_tier_used.py` | `feed_lots.tier_used` (varchar(10), NOT NULL, `server_default='fast'`) — тир продажи, которым лот прошёл в ленту. Бэкфилл не нужен: `feed_lots` — снимок, полностью перезаписываемый каждую минуту; умолчание стоит только ради окна между миграцией и запуском нового образа. ⚠ **Применять строго ДО запуска нового образа** (то же правило, что у `0039`): модель `FeedLot` объявляет колонку, без неё падает любой ORM-SELECT ленты. **На проде применена 2026-08-21** |

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
