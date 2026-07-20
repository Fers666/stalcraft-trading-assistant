# Архитектура сбора данных

## Проблема наивного подхода

Если хранить сбор данных **per-user**, при росте числа пользователей возникает катастрофическое дублирование:

```
100 пользователей × 50 товаров в watchlist = 5000 пар (item_id, region)
5000 × 2 запроса = 10 000 запросов за один цикл сбора → лимит 400 запросов/мин → НЕВОЗМОЖНО
```

Также нет смысла собирать данные по одному `(item_id, region)` 100 раз —
рыночные данные одинаковы для всех пользователей.

---

## Решение: единый слой сбора

**Кто:** объединение уникальных пар `(item_id, region)` из watchlist **всех** пользователей (дедупликация).
**Как часто:** `collect_all_active_lots` — каждые 20 сек, динамический batch
(min=5, max=50 пар за запуск), цель — полный цикл по всем парам ≤60 сек.
Сначала обрабатываются наиболее просроченные пары (`last_successful_check ASC NULLS FIRST`).
Формула батча и таблица примеров → `docs/SERVICES.md`.
**Что собирает:** полный снэпшот лотов — raw_lots, liquid/expiring split, snapshot-history matching.
**Где хранит:** `collected_data` с `user_id = NULL` (глобальная запись).
**user_id в смежных таблицах:** `market_statistics` — также `NULL` (глобальная
запись на пару item/region); `sales_history` — `NOT NULL`, но дедупликация по
`(item_id, region, sale_time)` идёт без фильтра по `user_id` (данные фактически
глобальные). Подробности полей → `docs/DATABASE.md`.
**После каждого сбора:** `_publish_signals` пересчитывает выгодные лоты и пишет в Redis
`signals:{user_id}:{item_id}:{region}:{qf}:{ef}` (TTL 300 сек). Параллельно (2026-07-20)
публикует push-события в RabbitMQ (`push.events`, DIRECT-exchange, routing_key `push`) —
низколатентный конвейер уведомлений (best-effort, не ломает сбор при недоступности брокера).
Fan-out на стороне брокера: к `push.events` привязаны ДВЕ durable-очереди с тем же
routing_key — `push.notifications` (web push, сервис `push_service`) и (с 2026-07-21)
`telegram.notifications` (сервис `telegram_bot`); брокер отдаёт копию каждого события
обоим каналам. Продюсер о получателях/каналах не знает — курация в консьюмерах.
См. `docs/SERVICES.md` (разделы «Web Push» и «Telegram»),
`docs/tasks/telegram-notifications.md`, `docs/tasks/web-push-notifications.md`.
**Эффект:** 100 пользователей следят за одним товаром → **1 API запрос**, не 100.

```
Watchlist всех пользователей:
  user1: [m02wr/RU, 04yr/RU]
  user2: [m02wr/RU, y1q9/EU]
  user3: [m02wr/RU]

Дедупликация → уникальные пары:
  m02wr/RU, 04yr/RU, y1q9/EU

Результат: 3 API запроса вместо 7
```

> **История:** ранее существовал второй слой сбора ("Лента возможностей" /
> `global_item_scan`) для discovery предметов вне watchlist — реализован и
> удалён дважды (2026-06-07, 2026-06-11). Метрика "дешевле средней цены
> выставленных лотов" оказалась методологически некорректной. `/app/feed`
> остаётся заглушкой. Подробности → `docs/CHANGELOG.md`.

---

## Схема потоков данных

```
                    ┌─────────────────────────────────┐
                    │         master_items             │
                    │         (2236 предметов)         │
                    └────────────┬────────────────────-┘
                                  │
                     Уникальные пары (item_id, region)
                        из watchlist всех пользователей
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  collect_all_active_lots   │
                    │  каждые 20 сек, дин. batch │
                    └────────────┬───────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │       collected_data       │
                    │       user_id = NULL       │
                    └────────────┬───────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │      Analytics Service     │
                    │  market_statistics         │
                    │  pricing.py                │
                    └────────────┬───────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │     Redis signals:*        │
                    │     (TTL 300 сек)          │
                    └────────────┬───────────────┘
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                            ▼
   GET /monitoring/signals/{item_id}          Фронтенд (GlobalFeed/
                                               feedStore, LotStatCard;
                                               поллинг 30 сек)

  Параллельно уведомления: _publish_signals → RabbitMQ push.events (DIRECT)
  → fan-out → telegram.notifications (telegram_bot) + push.notifications (push_service)
  — событийная доставка; с 2026-07-21 Telegram тоже консьюмер, а не поллинг Redis.
```

---

## Персонализация

Сбор данных глобальный, персонализация — на уровне запроса:

| Что | Уровень |
|-----|---------|
| Цены, лоты, история | Глобальный (1 запись на пару) |
| Мин. маржа (10%) | Личный (user_settings) |
| Уведомления | Личный (user_settings) |
| Tracked batch sizes | Личный (user_watchlist) |
| Ручной refresh | Личный (user_id в collected_data) |
| Статистика по quality/enchant | На лету (фильтрация sales_history при запросе) |

### Фильтрация по quality/enchant (карточка Избранного)

`market_statistics` хранит глобальные агрегаты без разбивки по качеству/заточке.
Когда watchlist-запись имеет `quality_filter` или `enchant_filter`, три блока карточки получают данные по-разному:

| Блок | Источник | Как фильтруется |
|------|---------|-----------------|
| Выгодные лоты | `GET /lots/{id}` + фронт | `profitableLots` сравнивает `quality_name`/`enchant_level` |
| Варианты продажи | `GET /monitoring/item/{id}?quality_filter=…` | На лету: `median_price_7d`, `sales_volume_7d`, `sell_options` из отфильтрованных `sales_history`; `best_sell_hour`/`buy_hours` и проч. берутся из глобальной `market_statistics` |
| История продаж | `GET /monitoring/sales-chart/{id}?quality_filter=…` | SQL-фильтр по `additional_info->>'qlt'` / `upgrade_bonus` |

`sell_options` в режиме с фильтром считаются с `confidence=low` (только объём, без lot_start пар), поскольку выборка по одному качеству/заточке обычно мала для статистической уверенности.

---

## Celery-расписание и автообновление фронтенда

Актуальное расписание Celery-задач, разовые задачи и цепочка при добавлении
в watchlist → `docs/SERVICES.md`.

**Автообновление фронтенда:** `LotStatCard` и `GlobalFeed` поллят
`GET /monitoring/signals/{item_id}` каждые 30 сек — те же данные из Redis
`signals:*`, что пишет `_publish_signals`. Полный refresh страницы не требуется.
(Telegram-бот с 2026-07-21 читает уведомления не из Redis `signals:*`, а из
очереди `telegram.notifications` — см. `docs/SERVICES.md`.)
