# Stalcraft Trading Assistant — Контекст проекта для Claude Code

## Суть проекта

Веб-приложение для анализа аукциона игры **Stalcraft X**.
Помогает пользователю находить выгодные лоты для покупки с целью перепродажи,
управлять складом и получать прогнозы когда и за сколько продавать.
Автоматической покупки/продажи нет — только аналитика и рекомендации.

---

## Стек

| Слой | Технология |
|------|-----------|
| Backend | Python 3.12 + FastAPI |
| ORM | SQLAlchemy 2.0 async + Alembic |
| БД | PostgreSQL 16 |
| Кеш / очереди | Redis 7 + Celery |
| Frontend | React + TypeScript + Material UI (MUI) + Recharts |
| HTTP клиент | httpx (async) |
| Уведомления | python-telegram-bot + Browser Push |
| Инфра | Docker Compose |

---

## Stalcraft API

- **Demo** (без регистрации): `https://dapi.stalcraft.net`
- **Production**: `https://eapi.stalcraft.net` (Bearer token)
- **Items DB**: `https://github.com/EXBO-Studio/stalcraft-database/` — JSON с описанием предметов
- **Регионы**: RU / EU / NA / SEA

### Эндпоинты

```
GET /{region}/auction/{itemId}/lots     — активные лоты (макс 200, offset/limit)
GET /{region}/auction/{itemId}/history  — история продаж
GET /{region}/emission                  — статус выброса
```

### Rate Limit — TOKEN BUCKET

```
Ёмкость:          100 токенов / минута
Запрос /lots:     2 токена
Запрос /history:  2 токена
Запрос /emission: 1 токен
При превышении:   429 Too Many Requests → ждать следующую минуту
```

Алгоритм: Token Bucket через Redis.
- Ключ: `stalcraft:rate_limit:{user_id}` (или глобальный для demo)
- Пополнение: 100 токенов каждую минуту
- Перед каждым запросом: `acquire_token(tokens_needed)` → ждать если недостаточно

---

## Архитектура (слои)

```
Stalcraft API + GitHub
        ↓
  Collector Service (Celery tasks)
  — сбор лотов каждые 5 мин
  — сбор истории раз в час
        ↓
  PostgreSQL + Redis
        ↓
  Analytics Service
  — расчёт выгодности (маржа, риск, score)
  — прогноз времени продажи (сезонность)
  — batch matcher
        ↓
  FastAPI Backend (REST + WebSocket)
        ↓
  React Frontend
```

---

## База данных — все таблицы

### users
```sql
id, username, email, password_hash,
telegram_username, telegram_chat_id,
is_active, created_at, updated_at
```

### user_settings
```sql
user_id (FK users), min_profit_margin_percent (default 10),
exclude_less_than_amount (default 1),  -- мин. кол-во в лоте (исключить розницу)
min_sell_batch_size (default 1),       -- мин. пачка для продажи со склада
notify_telegram (bool), notify_browser_push (bool),
auto_refresh_enabled (bool), updated_at
```

### master_items  (каталог из GitHub)
```sql
id, item_id (unique), name_ru, name_en,
category, can_be_batch_traded, last_updated
```

### user_watchlist  (что отслеживает пользователь)
```sql
id, user_id (FK), item_id (FK master_items),
region (default 'eu'),
tracked_batch_sizes INTEGER[],   -- выбранные пачки: [10,20,30,40,50,100]
is_active (bool),
last_successful_check (timestamp),
error_status (text),
created_at, updated_at
UNIQUE(user_id, item_id, region)
```

### collected_data  (снэпшоты лотов каждые 5 мин)
```sql
id, user_id, item_id, region,
collect_time, collect_type,
total_lots, total_available_amount,
best_price_per_unit, best_price_total, best_price_amount, best_lot_id,
avg_price_per_unit, median_price_per_unit,
min_price_per_unit, max_price_per_unit,
best_buyout_per_unit,
raw_lots JSONB,
created_at
```

### sales_history  (история реальных продаж из API)
```sql
id, user_id, item_id, region,
sale_time, price_per_unit, amount, total_price,
additional_info JSONB,
collected_at,
will_be_deleted_at  -- collected_at + 120 дней (авто)
```

### market_statistics  (агрегаты, пересчитываются раз в час)
```sql
id, user_id, item_id, region,
avg_price_24h, min_price_24h, max_price_24h, sales_volume_24h,
avg_price_7d, median_price_7d, min_price_7d, max_price_7d, sales_volume_7d,
price_volatility_7d,
best_sell_hour, best_sell_day, weekend_bonus_percent,
avg_sell_time_hours,
batch_stats JSONB,
calculated_at
UNIQUE(user_id, item_id, region)
```

### purchase_recommendations
```sql
id, user_id, item_id, region,
lot_amount, lot_price_per_unit, lot_total_price, lot_end_time,
expected_sell_price_per_unit, expected_profit_per_unit,
expected_profit_percent, confidence_score,
recommend_sell_hour, recommend_sell_day, risk_level,
is_viewed, is_notified, expires_at, created_at
```

### user_inventory  (внутренний склад пользователя)
```sql
id, user_id, item_id, region,
quantity, avg_buy_price_per_unit,
added_at, last_updated
UNIQUE(user_id, item_id, region)
```

### sell_recommendations
```sql
id, inventory_id (FK user_inventory),
recommended_price_per_unit, recommended_batch_size,
expected_wait_hours, expected_revenue, expected_profit,
expected_profit_percent, sell_now_vs_wait_benefit,
confidence_score, created_at, is_viewed
```

### api_request_log
```sql
id, user_id, endpoint, request_time,
response_time_ms, status_code, tokens_used, error_message
```

### notification_queue
```sql
id, user_id, notification_type, channel,
payload JSONB, attempts, max_attempts,
next_attempt_at, status, created_at
```

---

## API эндпоинты (FastAPI)

### Auth
```
POST /auth/register
POST /auth/login        → JWT
POST /auth/refresh
POST /auth/logout
GET  /auth/me
```

### Каталог
```
GET  /items                  — все товары (поиск, пагинация)
GET  /items/tracked          — отслеживаемые текущим пользователем
POST /items/refresh-catalog  — обновить с GitHub
GET  /items/{item_id}        — детали
```

### Watchlist
```
GET    /watchlist
POST   /watchlist
PUT    /watchlist/{id}
DELETE /watchlist/{id}
POST   /watchlist/{id}/refresh   — ручной сбор (не чаще раз в 2 мин)
```

### Мониторинг
```
GET /monitoring/current           — выгодные предложения прямо сейчас
GET /monitoring/item/{item_id}    — данные по конкретному товару
GET /monitoring/history           — история цен для графиков (раздел «История и графики»)
```

### Склад
```
GET    /inventory
POST   /inventory
PUT    /inventory/{id}
DELETE /inventory/{id}
GET    /inventory/{id}/sell-forecast   — прогноз продажи
```

### Настройки
```
GET  /settings
PUT  /settings
POST /settings/telegram-link
```

Поля настроек в UI:
- Минимальная маржа (%)
- Мин. размер пачки для продажи (исключить розницу)
- Telegram username
- Каналы уведомлений (Telegram / Push)

### WebSocket
```
WS /ws/notifications?token={jwt}
```
Типы сообщений: `purchase_recommendation`, `sell_recommendation`, `item_error`

---

## Разделы UI (фронтенд)

| Раздел | Содержание |
|--------|------------|
| Каталог товаров | Все товары + отслеживаемые, поиск, кнопка обновления с GitHub |
| Мониторинг | Выгодные предложения (лоты, % выгоды, цена покупки/продажи, время продажи) |
| Склад | Мои товары, прогнозы, варианты «продать сейчас» или «дособрать до пачки» |
| История и графики | Графики цен, история сделок |
| Настройки | Минимальная маржа (%), мин. пачка, Telegram username, уведомления |

Дизайн: адаптивный (ПК + мобильные устройства).

---

## Алгоритмы

### Выгодность покупки
```python
expected_revenue = avg_sell_price_7d * 0.95   # комиссия продажи 5%
profit_per_unit  = expected_revenue - lot.price_per_unit
profit_percent   = profit_per_unit / lot.price_per_unit * 100
confidence       = min(1.0, sales_volume_7d / 100)
score            = profit_percent * confidence
risk             = "high" если volatility > 30%, "medium" > 15%, "low" иначе
показывать       = profit_percent >= user.min_profit_margin_percent
```

### Прогноз лучшего времени продажи (сезонность)
```python
# На основе sales_history за 120 дней
# Группировка по часу → best_hour
# Группировка по дню недели → best_day
# weekend_bonus = (avg_sat + avg_sun)/2 vs avg_weekday
```

### Batch Matcher (подбор лотов для пачки)
```python
# Цель: набрать target_quantity штук по минимальной цене
# Алгоритм: жадный — сортируем лоты по price_per_unit asc,
# берём от каждого min(lot.amount, remaining)
#
# Важно: рекомендуемый лот НЕ обязан совпадать с выбранными пачками.
# Пример: пользователь отслеживает пачки 20/30/50, но если лот на 15 шт.
# выгоден — он тоже рекомендуется. Пачки — для аналитики, не фильтр.
```

### Склад: варианты продажи
```python
# Для каждого товара на складе показываются ДВА варианта:
# 1. Продать сейчас — прогнозная цена + ожидаемое время продажи
# 2. Дособрать до пачки — купить N шт., продать оптом (выгоднее % маржи)
# Пользователь может настроить мин. размер пачки чтобы скрыть розничные предложения
```

---

## Обработка ошибок API

- При недоступности Stalcraft API: 3 попытки повтора (exponential backoff)
- После 3 неудач: в БД пишется `error_status` для watchlist записи, фронт показывает статус «товар не обновляется»
- Rate limit 429: ждать до следующей минуты (Token Bucket восстановление)

---

## Celery расписание

| Задача | Расписание |
|--------|-----------|
| Сбор активных лотов | каждые 5 минут |
| Сбор истории + пересчёт статистики | раз в час (minute=0) |
| Генерация рекомендаций | раз в час (minute=5) |
| Отправка уведомлений | каждые 2 минуты |
| Очистка данных старше 120 дней | раз в сутки (3:00) |

---

## Telegram уведомление (формат)
```
🔔 Выгодная покупка!
📦 {item_name}
💰 Цена: {price_per_unit} за шт.
📊 Количество: {amount} шт.
💎 Ожидаемая маржа: {profit_percent}%
🕐 Рекомендуемое время продажи: {best_hour}:00
```

---

## Что уже реализовано (в папке, но требует обновлений)

- `docker-compose.yml` — PostgreSQL + Redis + backend + worker + scheduler ✅
- `backend/app/core/config.py` — настройки через pydantic-settings ✅
- `backend/app/core/rate_limiter.py` — **нужно переделать на Token Bucket** ⚠️
- `backend/app/models/models.py` — базовые модели, **нужно добавить User, UserWatchlist и все остальные таблицы** ⚠️
- `backend/app/services/collector/client.py` — HTTP клиент ✅
- `backend/app/services/collector/service.py` — сервис сбора ✅
- `backend/app/tasks/tasks.py` — Celery задачи ✅
- `backend/app/api/v1/endpoints/tracked_items.py` — базовый API ✅

## Что нужно реализовать следующим

1. **Alembic** — миграция для всех таблиц
2. **Token Bucket rate limiter** — переписать `rate_limiter.py`
3. **Модели User + UserWatchlist** — добавить в `models.py`
4. **Auth** — JWT регистрация/логин
5. **Analytics service** — расчёт выгодности, прогнозы
6. **GitHub parser** — синхронизация каталога предметов
7. **React фронтенд** — 5 разделов (каталог, мониторинг, склад, история, настройки)
8. **Telegram бот** — уведомления

---

## Деплой

| Этап | Среда |
|------|-------|
| Разработка и тестирование | Локально (Docker Compose на ПК) |
| Продакшн | На сервере (позже, конфигурация аналогичная) |

---

## Что НЕ входит в проект

| Исключение | Причина |
|------------|---------|
| Автоматическая покупка/продажа через API | API Stalcraft не поддерживает |
| Сбор данных чаще 5 минут | Упираемся в rate limit |
| Интеграция с другими играми | Только Stalcraft X |
| Мобильное приложение | Только веб (адаптивный дизайн) |

---

## Правила разработки

- Весь Python код async (FastAPI + SQLAlchemy async)
- Один Celery worker на очередь collector — нет дублирования запросов
- Ручной сбор данных — не чаще раза в 2 минуты (throttle по user_id в Redis)
- История хранится 120 дней, потом автоудаление
- Комиссия: покупка 0%, продажа 5%
- Регион задаётся на уровне watchlist записи
