# Web Push уведомления через RabbitMQ ← 2026-07-20

Второй канал доставки уведомлений (браузерный web push, ПК + Android + iOS) **параллельно** Telegram, с минимальной задержкой. Мотивация: Telegram шлёт с задержкой (цепочка `Celery beat 20с → Redis-ключ TTL 300с → polling бота 15с` + троттлинг Telegram). Push вводит настоящую очередь событий (RabbitMQ) — задержка сокращается до миллисекунд от публикации до доставки в браузер.

## Разделение ответственности
- **Продюсер** (Celery-коллектор) кладёт лёгкое событие `{type, user_id, item_id, region, quality_filter, enchant_filter, ...}` в RabbitMQ и НИЧЕГО не знает о подписках.
- **Push-сервис** (отдельный контейнер `push_service`) — единственный владелец «курации»: слушает очередь, проверяет гейт (канал `notify_browser_push` + тариф), дедуплицирует, грузит все устройства пользователя и рассылает.

## Поток
```
Событие (collectors.py)          RabbitMQ                       push_service                    Браузер
_publish_signals / emission ─pub→ exchange push.events (direct) ─→ queue push.notifications ─→ pywebpush(VAPID) ─→ FCM/Mozilla/Apple ─→ SW push
{type,user_id,item,...}          routing key "push"              • гейт notify_browser_push+тариф
                                                                  • дедуп Redis push_*_sent:*
                                                                  • push_subscriptions[] (все устройства)
                                                                  • рендер компактного payload
                                                                  • 404/410 → удалить подписку
```
Типы событий и тарифный гейт (зеркалит Telegram):
- `profitable_lot` → `telegram_notifications` (advanced+)
- `buy_alert` → `buy_sniper_notifications` (advanced_plus+); публикуется только при пересечении порога `BuyAlert.target_price`
- `emission` (start/end) → без тарифного гейта, всем с включённым каналом; отсечка свежести 15 мин

## Компоненты
**Backend**
- Модель `PushSubscription` (`backend/app/models/models.py`), миграция `0035_push_subscriptions.py`.
- Публикатор `backend/app/services/push_broker.py` (`open_channel`/`publish_event`/`close_channel`, aio-pika). Best-effort: RabbitMQ недоступен → no-op, сбор данных и Telegram не ломаются.
- Продюсер-вызовы в `backend/app/tasks/collectors.py`: `_publish_signals` (lots + buy, канал открыт на батч и закрыт в finally как redis_client), `_collect_emission_async` (start/end, short-lived канал).
- API `backend/app/api/v1/endpoints/push.py` (prefix `/push`): `GET /vapid-public-key`, `POST /subscribe` (upsert по endpoint), `POST /unsubscribe`.
- Конфиг `backend/app/core/config.py`: `RABBITMQ_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Зависимости: `aio-pika`, `pywebpush`, `py-vapid`.

**push_service** (`push_service/consumer.py`) — переиспользует backend-образ (как `telegram_bot`), `sys.path.insert(0,"/app")`. Async-консьюмер aio-pika, prefetch 20, manual ack (без DLX — best-effort). Дедуп-ключи Redis `push_sent:*` / `push_buy_sent:*` / `push_emission_sent:*` (TTL 48ч, отдельно от `tg_sent:*`). Ключ ставится только при `sent>0`.

**Frontend** — `public/sw.js` (только push+notificationclick, без offline-кэша), `public/manifest.webmanifest` (PWA для iOS-установки), `src/lib/push.ts` (SW + `Notification.requestPermission` + `pushManager.subscribe` + POST на бэк; helpers `isIOS`/`isStandalone`), тумблер «Browser Push» в `src/pages/SettingsPage.tsx` запускает flow + iOS-инструкция «Добавить на домашний экран», регистрация SW в `src/main.tsx`. `nginx.conf` отдаёт `/sw.js` и `/manifest.webmanifest` с `Cache-Control: no-cache`.

**Инфра** — сервисы `rabbitmq` (rabbitmq:3-management) и `push_service` в `docker-compose.yml` (+ порты 5672/15672) и `docker-compose.prod.yml` (без публикации портов). `RABBITMQ_URL` добавлен воркеру. VAPID-ключи — в `.env` (не в git).

## Ключевые решения
- Брокер **RabbitMQ** (per-message ack, routing, low latency) — не Redis Streams/Kafka.
- Web push — **дополнительный** канал, Telegram не трогали.
- **iOS**: push работает только из PWA, добавленного на домашний экран (iOS 16.4+) — в обычной вкладке Safari недоступен (ограничение Apple); отсюда манифест + инструкция.
- Согласие: браузерный prompt только при явном включении тумблера в Настройках.
- Таблица `NotificationQueue` (существует, не используется) не задействована — очередь теперь RabbitMQ.

## Статус
- Реализовано и раскатано локально 2026-07-20; QA-проход пройден (API, консьюмер, гейт, дедуп, удаление мёртвых подписок, регрессия Telegram, прод-сборка фронта `npm run build` exit 0).
- **Не проверено (требует живого браузера):** реальный приём push на устройстве.
- **Не задеплоено на прод.** Перед деплоем: сгенерировать отдельные прод-VAPID-ключи, применить миграцию `0035`, пересобрать backend/worker/frontend + поднять `rabbitmq`/`push_service`. Детали — `docs/DEPLOY.md`. Guest-креды RabbitMQ на проде — закрыть (security).

## Будущее
Перевести **Telegram** на чтение той же очереди (отдельный durable-queue к тому же exchange) — уберёт задержку и для Telegram, унифицирует конвейер. Отдельная задача ПОСЛЕ стабилизации push; ключевой момент — воспроизвести freshness-семантику Redis-TTL (message-TTL очереди + timestamp-guard). См. `docs/NOTES.md`.
