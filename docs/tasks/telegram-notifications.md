# ТЗ: Перевод Telegram-уведомлений на брокер RabbitMQ (по аналогии с Web Push)

## Цель

Сделать Telegram-уведомления событийными — как web push. Сейчас Telegram уже
работает, но по устаревшей схеме: бот раз в 15 сек опрашивает Redis и БД. Web
push (внедрён 2026-07-20, коммит `921f7a7`) уже слушает настоящую очередь
RabbitMQ и рассылает с минимальной задержкой. Нужно сделать `telegram_bot`
консьюмером той же очереди событий `push.events`, убрав polling-цикл. Продюсер
(Celery-коллектор) при этом НЕ меняется — оба канала (Telegram + web push)
разбираются с одного потока событий.

Задача уже стоит в бэклоге: `docs/NOTES.md` — «Перевести Telegram-уведомления на
ту же очередь событий (RabbitMQ)» (условие: после стабилизации push в проде — оно
выполнено, push задеплоен, коммит `9a0dfb9`).

**Важно (снимает возможную путаницу в постановке):** это НЕ добавление нового
канала «с нуля» — Telegram-бот, привязка аккаунта и рассылка уже реализованы и
работают в проде. Это рефакторинг механизма доставки: `polling Redis` → `consumer
RabbitMQ`. Тексты сообщений, команды бота и flow привязки остаются прежними.

---

## Текущее состояние

### Web Push (эталон — событийная схема, RabbitMQ)

Продюсер → брокер → консьюмер:

1. **Продюсер** — Celery-коллектор `backend/app/tasks/collectors.py`. После сбора
   свежего снапшота публикует события в exchange `push.events` через
   `backend/app/services/push_broker.py` (`open_channel` / `publish_event` /
   `close_channel`). Публикация best-effort: сбой RabbitMQ не ломает сбор данных.
   - Exchange: `push.events`, тип **DIRECT**, `durable=True`, routing_key `push`.
   - Три типа событий публикуются (см. ниже «Формат событий»):
     - `profitable_lot` — `collectors.py:544` (в `_publish_signals`)
     - `buy_alert` — `collectors.py:579` (только когда цена пересекла порог закупки)
     - `emission` — `collectors.py:973` (start) и `:1018` (end), из `collect_emission`
2. **Консьюмер** — отдельный сервис `push_service/consumer.py` (контейнер
   `push_service`). Своя durable-очередь `push.notifications`, привязанная к
   `push.events` по routing_key `push`. Консьюмер сам курирует рассылку:
   - гейт канала `UserSettings.notify_browser_push`;
   - тарифный гейт (`telegram_notifications` для лотов, `buy_sniper_notifications`
     для закупки, emission — без тарифа);
   - дедуп в Redis (`push_sent:*`, `push_buy_sent:*`, `push_emission_sent:*`),
     TTL = `NOTIF_DEDUP_TTL`;
   - шлёт web push на все устройства пользователя (`pywebpush` + VAPID), мёртвые
     подписки (404/410) удаляет.
   - `set_qos(prefetch_count=20)`, best-effort `ack` всегда (без DLX, чтобы не
     зациклить requeue на «ядовитом» сообщении).

Продюсер о подписках/получателях ничего не знает — вся «курация» в консьюмере.

### Telegram (текущая — устаревшая polling-схема)

- **Отдельный сервис** `telegram_bot/bot.py` (контейнер `telegram_bot`), библиотека
  **python-telegram-bot** (`from telegram.ext import Application`), запуск
  `app.run_polling()`.
- **Команды** (обрабатываются PTB-хендлерами): `/start`, `/link CODE`, `/status`,
  `/stop`.
- **Фоновый notifier-цикл** `_notifier_loop` (стартует в `post_init` как asyncio
  task, интервал `POLL_INTERVAL = 15` сек):
  - `notify_profitable_lots` — читает предвычисленные сигналы из Redis
    (`signals_key(...)`), рендерит богатое сообщение `build_lot_message`, дедуп
    `tg_sent:*`;
  - `notify_buy_alerts` — читает `buymin_key(...)` из Redis, сверяет с
    `BuyAlert.target_price`, `build_buy_message`, дедуп `tg_buy_sent:*`;
  - `notify_emission_events` — читает `EmissionEvent` из БД, дедуп через **флаги
    БД** `notified` / `end_notified`.
  - Гейты: получатель — `User.telegram_chat_id IS NOT NULL` + `is_active`; канал
    `UserSettings.notify_telegram`; тариф `telegram_notifications` (лоты) /
    `buy_sniper_notifications` (закупка).

**Задержка:** до 15 сек (polling). Событийная схема убирает этот остаток.

### Дублирование, которое надо учесть (не трогаем в этой задаче, но фиксируем)

Есть ВТОРАЯ реализация Telegram в бэкенде: `backend/app/api/v1/endpoints/telegram.py`
— webhook-обработчик (`POST /telegram/webhook`) с теми же командами + HMAC-проверкой
секрета, и `register_webhook()` в lifespan (`main.py:25`). Это альтернатива polling.
Активна только если задан `TELEGRAM_WEBHOOK_URL`. В проде используется polling
(`bot.py`), webhook — дремлющий дубль. См. «Открытые вопросы».

### Формат событий (payload в `push.events`)

```jsonc
// profitable_lot (collectors.py:544)
{ "type": "profitable_lot", "user_id": <int>, "item_id": "<str>",
  "region": "<str>", "quality_filter": <..>, "enchant_filter": <..>,
  "item_name": "<str>", "signal": { "lots": [...], "sell_options": [...],
    "volume_7d": .., "volatility_7d": .., "trend": .., "saturation_ratio": .. } }

// buy_alert (collectors.py:579)
{ "type": "buy_alert", "user_id": <int>, "item_id": "<str>",
  "region": "<str>", "quality_filter": <..>, "enchant_filter": <..>,
  "item_name": "<str>", "target_price": <int>,
  "cheapest": { "price_per_unit": .., "amount": .., "quality_name": ..,
                "enchant": .., "start_time": ".." } }

// emission (collectors.py:973 / :1018) — БЕЗ user_id, fan-out всем
{ "type": "emission", "phase": "start"|"end", "event_id": <..>,
  "started_at": "<iso>", "ended_at": "<iso|null>" }
```

Payload несёт ВСЕ данные, которые сейчас бот читает из Redis (`signal` = тот же
объект, что кладётся в `signals_key`; `cheapest` = то, что в `buymin_key`).
Значит рендер сообщений можно оставить без изменений, поменяв только источник
данных с Redis-poll на payload события.

---

## Предлагаемая архитектура (рекомендация)

**Fan-out через существующий DIRECT-exchange + вторая durable-очередь. Продюсер
не трогаем.**

RabbitMQ DIRECT-exchange доставляет **копию** сообщения в КАЖДУЮ очередь,
привязанную с совпадающим routing key. Web push уже привязал `push.notifications`
к `push.events` (routing_key `push`). Достаточно объявить и привязать ВТОРУЮ
очередь `telegram.notifications` к тому же exchange по тому же routing_key `push`
— и Telegram-консьюмер начнёт получать свою копию каждого события. **Изменения
в `collectors.py` / `push_broker.py` не требуются.**

```
                         ┌──────────────────────┐   push.notifications   push_service
Celery collector ──publish──►  exchange          ├──(routing_key=push)──►  (web push)
  (push_broker)     push.events (DIRECT, durable) │
                         └──────────────────────┴──(routing_key=push)──►  telegram.notifications
                                                                            telegram_bot (НОВОЕ)
```

### Где живёт Telegram-консьюмер — рекомендация: ОДИН контейнер (Вариант A)

**Вариант A (рекомендуется): консьюмер внутри `telegram_bot/bot.py`.**
Заменить `_notifier_loop` (polling) на `_consume_loop` (aio_pika consumer),
стартующий в `post_init` как asyncio task в том же event loop, что и PTB. Доставку
делать через уже готовый `app.bot.send_message(...)`. Команды/привязка остаются
в том же процессе без изменений.

- Плюсы: минимум движущихся частей, один процесс = один источник истины про
  Telegram; переиспользуем `app.bot` и готовые рендеры `build_lot_message` /
  `build_buy_message`; не плодим ещё один контейнер.
- Минус: бот совмещает приём команд и рассылку. Но он это уже делает (сейчас
  polling-loop живёт рядом с хендлерами) — это НЕ регресс.

**Вариант B (не выбираем): отдельный сервис `telegram_notifier`** (по образцу
`push_service`), а `bot.py` оставить только на командах.

- Минус: Telegram-логика размазывается по двум контейнерам и двум местам рендера;
  `push_service` оправдан тем, что web push (pywebpush) не связан с командным
  ботом, а тут — связан. Избыточно для текущего масштаба (senior назвал бы
  overengineering).

**Компромисс, который принимаем:** совмещение приёма команд и консьюминга в одном
процессе. Приемлемо — нагрузка мизерная, PTB и aio_pika уживаются в одном loop.

### Что НЕ делаем и почему

- **Не меняем продюсер** (`collectors.py`, `push_broker.py`) — fan-out достигается
  на стороне брокера биндингом второй очереди.
- **Не вводим отдельный routing key / отдельный exchange для Telegram** — DIRECT +
  общий routing key `push` + разные очереди уже дают ровно fan-out. Topic-exchange
  избыточен.
- **Не трогаем схему БД** — все нужные поля уже есть (см. «Модель данных»).
- **Не убираем `telegram.py` webhook и `register_webhook`** в этой задаче (дубль
  дремлет, отдельное решение — «Открытые вопросы»).

### Плюс по надёжности (побочный эффект)

Известная проблема из NOTES: нестабильная сеть прод→`api.telegram.org` роняла
`telegram_bot` в рестарт-луп, и при поллинге терялись уведомления (Redis-сигналы
истекали по `SIGNALS_TTL`). При durable-очереди события копятся в
`telegram.notifications` и доставляются после реконнекта. Свежесть при этом
сохраняем через guard по возрасту (см. ниже), чтобы после простоя не прилетела
пачка протухших лотов.

---

## Модель данных

**Новых таблиц/полей и миграций НЕ требуется.** Всё уже есть:

- `User.telegram_chat_id` (`BigInteger`), `User.telegram_username` (`String(50)`)
  — `models.py:21-22`. Заполняются при `/link`.
- `UserSettings.notify_telegram` (`Boolean`, default `True`) — `models.py:46`.
  Тумблер канала Telegram.
- Тарифные гейты — `app.core.tiers.get_tier_limits(user)` →
  `.telegram_notifications`, `.buy_sniper_notifications`.
- `EmissionEvent.notified` / `.end_notified` — БД-дедуп выбросов (сейчас пишет бот).

Это отличие от web push, которому потребовалась таблица `push_subscriptions`
(миграция `0035`): у Telegram «подписка» = один `telegram_chat_id` на пользователя,
уже в `users`.

**Решение по дедупу выбросов (см. «Открытые вопросы»):** рекомендуется перевести
Telegram-дедуп выбросов с БД-флагов на Redis-ключ `tg_emission_sent:{event_id}:{phase}`
(зеркало `push_service`), чтобы консьюмер не зависел от опроса БД. Флаги
`notified`/`end_notified` тогда становятся вестигиальными для Telegram (их всё ещё
может использовать что-то иное — проверить, что нет; если нет — оставить как есть,
не удалять в этой задаче).

---

## Backend-задачи (по файлам)

### 1. `telegram_bot/bot.py` — заменить polling на RabbitMQ-консьюмер

- Добавить зависимость `aio_pika` (уже в образе — используется `push_service`,
  общий backend-образ; проверить `backend/requirements.txt`).
- Импортировать `EXCHANGE_NAME`, `ROUTING_KEY` из `app.services.push_broker`.
- Добавить конфиг из env: `RABBITMQ_URL` (см. задачу по compose), `QUEUE_NAME =
  "telegram.notifications"`, `PREFETCH`, `EMISSION_MAX_AGE_MIN` (уже есть).
- **Удалить** `_notifier_loop` и вызовы Redis-поллинга внутри
  `notify_profitable_lots` / `notify_buy_alerts` / `notify_emission_events`. Логику
  рендера (`build_lot_message`, `build_buy_message`, тексты выброса) — **сохранить**
  и переиспользовать в новых хендлерах событий.
- Добавить `_consume_loop(app)`:
  - `connect_robust(RABBITMQ_URL)` → channel → `set_qos(prefetch_count=...)`;
  - `declare_exchange(EXCHANGE_NAME, DIRECT, durable=True)` (идемпотентно),
    `declare_queue("telegram.notifications", durable=True)`,
    `queue.bind(exchange, routing_key=ROUTING_KEY)`;
  - `async for message in queue.iterator():` → `handle_message` → всегда `ack`
    (best-effort, как в `push_service`).
- Хендлеры событий (зеркалят `push_service`, но канал/гейт/дедуп — Telegram):
  - `handle_profitable_lot(db, r, app, event)`:
    - загрузить пользователя, гейт: `telegram_chat_id IS NOT NULL`, `is_active`,
      `is_approved or is_admin`, `notify_telegram` (если `UserSettings` есть),
      тариф `telegram_notifications` (или `is_admin`);
    - `signal = event["signal"]`; для каждого `lot` — дедуп
      `tg_sent:{user_id}:{item_id}:{region}:{q}:{e}:{start_time}`; если новый —
      `build_lot_message(...)` из данных lot/signal + `event["item_name"]`,
      `app.bot.send_message(chat_id, ..., parse_mode="HTML")`, затем `setex(dedup,
      NOTIF_DEDUP_TTL, "1")`.
  - `handle_buy_alert(...)`: гейт тариф `buy_sniper_notifications`; дедуп
    `tg_buy_sent:*`; `build_buy_message` из `event["cheapest"]` + `target_price`.
  - `handle_emission(...)`: guard свежести (`EMISSION_MAX_AGE_MIN`, как в
    `push_service.handle_emission`); дедуп `tg_emission_sent:{event_id}:{phase}`;
    получатели — все `telegram_chat_id IS NOT NULL` + `is_active` + `is_approved`
    + `notify_telegram`, без тарифного гейта; тексты выброса — как сейчас.
  - `HANDLERS = {...}`, `handle_message(body)` — по образцу `push_service`.
- В `post_init`: заменить старт `_notifier_loop` на `_consume_loop`.
- `item_name` больше НЕ надо доставать из `MasterItem` в рассылке — оно приходит
  в событии (`event["item_name"]`). Упрощает код и убирает запрос БД на каждый лот.

### 2. `docker-compose.yml` и `docker-compose.prod.yml` — env и зависимости `telegram_bot`

- Добавить сервису `telegram_bot`:
  - `RABBITMQ_URL` — dev: `amqp://guest:guest@rabbitmq:5672/`; **prod:**
    `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@rabbitmq:5672/` (как у
    `push_service` — НЕ `guest:guest`, харденинг из `e4e2949`);
  - `depends_on: rabbitmq: {condition: service_healthy}` (в дополнение к postgres/redis).
- `push_service` уже так настроен — брать за образец 1:1.

### 3. `backend/requirements.txt` — проверить `aio_pika`

- Убедиться, что `aio_pika` присутствует (добавлен в рамках web push). Если да —
  правок нет; `telegram_bot` использует общий backend-образ.

### Продюсер (`collectors.py`, `push_broker.py`) — ИЗМЕНЕНИЙ НЕТ

Fan-out достигается биндингом второй очереди; продюсер публикует ровно то, что
нужно Telegram, уже сейчас.

---

## Точки интеграции с существующим кодом

| Что | Где | Как используется |
|---|---|---|
| Exchange/routing const | `backend/app/services/push_broker.py` (`EXCHANGE_NAME`, `ROUTING_KEY`) | импорт в `bot.py` для декларации очереди |
| Формат событий | `collectors.py:544/579/973/1018` | payload читается один-в-один |
| Рендер сообщений | `telegram_bot/bot.py` (`build_lot_message`, `build_buy_message`) | переиспользуются, источник данных — payload |
| Гейт тарифа | `app.core.tiers.get_tier_limits` | `telegram_notifications` / `buy_sniper_notifications` |
| Канальный тумблер | `UserSettings.notify_telegram` (`models.py:46`) | гейт в хендлерах |
| Дедуп TTL | `app.services.profitable_lots.NOTIF_DEDUP_TTL` | `setex` для `tg_*_sent:*` |
| Эталон консьюмера | `push_service/consumer.py` | структура `_consume_loop`/`handle_*`/`ack` |

**Не пересекается с web push:** ключи дедупа Telegram (`tg_sent:*`,
`tg_buy_sent:*`, `tg_emission_sent:*`) и push (`push_sent:*` и т.д.) уже разведены
— два канала не «съедают» дедуп друг друга.

---

## Linking flow пользователя (уже существует — НЕ меняется)

1. Пользователь в приложении: Настройки → Telegram → «Получить код привязки» →
   `GET /telegram/link-code` (`api/v1/endpoints/telegram.py:70`). Генерируется
   6-значный код, TTL 10 мин в Redis (`tg_link:{code}` → `user_id`).
2. Пользователь шлёт боту `@<bot>` команду `/link 123456`.
3. `bot.py` `cmd_link` находит `user_id` по коду в Redis, пишет
   `User.telegram_chat_id` + `telegram_username`, удаляет одноразовый код.
4. Статус: `GET /telegram/status` → `is_linked=True`; `/status` в боте.
5. Отключение: `/stop` в боте или `DELETE /telegram/unlink` → обнуляет
   `telegram_chat_id`.

Рефакторинг доставки на эту цепочку не влияет: гейт «есть ли `telegram_chat_id`»
остаётся тем же.

---

## Security

Уроки харденинга web push (`e4e2949`), применимые к Telegram:

1. **RabbitMQ-креды (High).** `telegram_bot` в проде должен ходить в брокер под
   `RABBITMQ_USER/RABBITMQ_PASSWORD` (не `guest:guest`), как `push_service`.
   Dev-порты брокера уже привязаны к `127.0.0.1`. — Обязательно.
2. **Poison-message / ack.** Консьюмер обязан всегда `ack` (best-effort) и глотать
   ошибки рендера/отправки на уровне одного сообщения, иначе битое событие зациклит
   requeue. Зеркалим `push_service` (нет DLX — сознательно).
3. **Свежесть событий.** Guard `EMISSION_MAX_AGE_MIN` (и по смыслу — дедуп
   `tg_sent:*` с `NOTIF_DEDUP_TTL`) защищают от «пачки протухших» уведомлений
   после простоя консьюмера/сети.
4. **Telegram API rate limits.** Свои лимиты Telegram: ~30 msg/сек глобально,
   ~1 msg/сек в один чат. Риск — burst на `emission` (fan-out всем привязанным
   сразу). Рекомендация: мягкий троттлинг между отправками в цикле рассылки
   выброса (например, небольшой `asyncio.sleep` каждые N сообщений) и/или
   `prefetch` небольшой. НЕ влияет на Stalcraft API rate limit (это внешний
   Telegram API). — Решить объём (см. «Открытые вопросы»).
5. **Валидация payload.** Тарифный/канальный гейт — на стороне консьюмера (как у
   push): продюсер не решает, кому слать. Событие несёт `user_id`, но получатель
   валидируется по БД (активность/подтверждение/тариф/тумблер) на каждом событии.
6. **Linking-токены** уже защищены: одноразовый 6-значный код с TTL 10 мин; webhook
   (если используется) — HMAC-проверка `X-Telegram-Bot-Api-Secret-Token`
   (`telegram.py:124`). Правок не требуется.

**Не относится к Telegram:** SSRF-allowlist push-хостов — специфичен для web push
(там сервер сам стучится на endpoint браузера). Telegram шлёт на фиксированный
`api.telegram.org` — SSRF-поверхности нет.

---

## Открытые вопросы / решения для пользователя

1. **Где размещать консьюмер — Вариант A (в `telegram_bot/bot.py`, рекомендуется)
   или Вариант B (отдельный контейнер `telegram_notifier`)?** По умолчанию — A
   (минимум инфраструктуры, один источник Telegram-логики).
2. **Дедуп выброса: Redis (`tg_emission_sent:*`, зеркало push) или оставить
   БД-флаги `notified`/`end_notified`?** Рекомендую Redis — консьюмер перестаёт
   опрашивать БД. Нужно подтвердить, что флаги БД больше нигде не используются
   (быстрый аудит) перед тем как перестать их писать.
3. **Троттлинг рассылки выброса** (fan-out всем): вводить мягкий `sleep`/батчинг
   ради Telegram rate limit в v1 или отложить до наблюдаемого упора в лимит?
   Текущее число привязанных пользователей невелико — можно отложить, но зафиксировать.
4. **Типы уведомлений в v1.** По умолчанию — все три (лоты, Buy Sniper, выброс),
   1:1 с текущим поведением бота (регресса нет). Подтвердить, что не сокращаем.
5. **Персонализация фильтров лотов на пользователя** уже реализована: события
   `profitable_lot`/`buy_alert` несут `user_id` и персональные
   `quality_filter`/`enchant_filter`/пороги — рассылка адресная. Отдельной работы
   не требуется; вопрос только: подтвердить, что новых осей персонализации в этой
   задаче не добавляем.
6. **Дубль webhook-реализации** (`api/v1/endpoints/telegram.py` +
   `register_webhook` в `main.py`). Оставляем как есть (дремлет при пустом
   `TELEGRAM_WEBHOOK_URL`) или заводим отдельную задачу «убрать дубль / выбрать
   polling vs webhook как единственный путь»? Вне объёма этой задачи, но стоит
   решить, чтобы не расходились две копии команд.
7. **Порядок выкладки.** Меняется частота НЕ Stalcraft-опроса, а внутренней
   доставки — Stalcraft rate limit не затрагивается. Но: при первом старте новой
   очереди `telegram.notifications` она начнёт копить события сразу после bind;
   стоит выкатывать при живом `telegram_bot`, чтобы не накопить историю до первого
   запуска консьюмера (durable-очередь без TTL хранит сообщения). Рекомендация:
   при желании задать `x-message-ttl` на `telegram.notifications` (напр. 15 мин),
   чтобы очередь не отдавала протухшее после долгого простоя (guard свежести это
   тоже прикрывает на уровне рендера). — Решить: TTL на очереди или полагаться на
   guard.

---

## Критерии приёмки

- [ ] `telegram_bot` подключается к `push.events`, объявляет и биндит durable-очередь
      `telegram.notifications` (routing_key `push`); web push (`push.notifications`)
      продолжает получать свою копию событий — оба канала работают параллельно.
- [ ] Polling-цикл (`_notifier_loop` / чтение `signals_key`/`buymin_key` из Redis)
      удалён; уведомления приходят событийно, задержка < 15 сек (заметно быстрее).
- [ ] Три типа доходят до Telegram: `profitable_lot`, `buy_alert`, `emission` —
      с теми же текстами, что и раньше (`build_lot_message`/`build_buy_message`/
      тексты выброса без визуальных изменений).
- [ ] Гейты соблюдены: канал `notify_telegram`, тариф (`telegram_notifications` /
      `buy_sniper_notifications`), наличие `telegram_chat_id`; emission — всем
      привязанным без тарифа.
- [ ] Дедуп работает: повторное событие по тому же лоту в пределах `NOTIF_DEDUP_TTL`
      не шлёт второе сообщение (`tg_*_sent:*`); дедуп Telegram и web push независимы.
- [ ] Устойчивость: битое/неизвестное событие не роняет консьюмер (`ack` + лог);
      после простоя бота durable-очередь доставляет накопленное, а guard свежести
      отсекает протухшие выбросы.
- [ ] Команды и привязка (`/start`, `/link`, `/status`, `/stop`, `link-code`,
      `status`, `unlink`) продолжают работать без изменений.
- [ ] Prod: `telegram_bot` ходит в RabbitMQ под `RABBITMQ_USER/PASSWORD`, зависит
      от здорового `rabbitmq`.
- [ ] Схема БД не менялась (миграций нет).

---

## Маршрутизация по агентам

1. **`backend-dev`** (единственный реализующий) — вход: этот ТЗ. Правит
   `telegram_bot/bot.py`, `docker-compose.yml`, `docker-compose.prod.yml`,
   при необходимости `backend/requirements.txt`. Продюсер не трогает.
2. **`qa-tester`** (после реализации, по предложению) — проверить доставку трёх
   типов, дедуп, гейты, параллельную работу с web push, поведение при рестарте бота.
3. **`security`** (опционально, по предложению) — RabbitMQ-креды, poison-message
   ack, Telegram rate limit / троттлинг выброса.
4. **`deploy`** (по предложению) — обновлённые compose-файлы, порядок выкладки
   (см. Открытый вопрос 7).
5. **`tech-writer`** — обновить docs (см. ниже): отметить бэклог-пункт `[x]`.

Зависимости линейны: 1 → (2/3) → 4 → 5. Декомпозиция на подзадачи не требуется —
объём в пределах одного агента (один сервисный файл + compose).

---

## Документация для обновления (для `tech-writer` после реализации)

- `docs/NOTES.md`: пункт «Перевести Telegram-уведомления на ту же очередь событий
  (RabbitMQ)» → `[x]`; в известной проблеме «нестабильная сеть прод→api.telegram.org»
  отметить, что durable-очередь смягчает потерю уведомлений при рестарт-лупе.
- `docs/ARCHITECTURE.md` / `docs/SERVICES.md`: схема сбора данных — Telegram теперь
  консьюмер `push.events` (очередь `telegram.notifications`), а не polling Redis;
  описать fan-out (две очереди на один DIRECT-exchange).
- `docs/CHANGELOG.md`: запись о переводе Telegram на брокер.
- `docs/DATABASE.md`: правок нет (схема не менялась) — упомянуть явно, что новых
  таблиц/полей не потребовалось.
