# Заметки и идеи

---

## Задачи в очереди

- [x] **Fix: статистика карточки Избранного под фильтром qlt/ptn ← 2026-07-24** —
  ТЗ `docs/tasks/fix-favorite-card-stats-qlt-ptn.md` (buy-side = вариант B1), коммит
  `0367a96`. Ветка «с фильтром качества/заточки» эндпоинта `get_item_stats` раньше
  пересчитывала под фильтр только ценовые окна (median/volume/volatility/sell_options), а
  sell-side timing (`best_sell_*`, `sell_hours_by_day`, `weekend_bonus`), `avg_sell_time_hours`
  и `batch_stats` брала из агрегата `market_statistics` (по всему предмету). Теперь эти поля +
  buy-side (`best_buy_*`, `buy_hours_by_day`) считаются per-request из отфильтрованного
  `SalesHistory`. Новые чистые хелперы `derive_sell_timing(sales)` / `derive_buy_timing(sales)`
  в `market_stats.py` (`weighted_score` + `WEIGHT_PRICE`/`WEIGHT_VOLUME` подняты на уровень
  модуля); `monitoring.py` — 2 scalar-запроса заменены одним фетчем строк за 30д. buy-side под
  фильтром = прокси B1 (час/день с минимальной средней ценой отфильтрованных продаж) —
  осознанный семантический сдвиг источника ТОЛЬКО для ветки с фильтром; агрегатная ветка
  (`best_buy` из снэпшотов `CollectedData`) и поведение `calculate_market_stats` не менялись.
  Детали — `docs/BUSINESS_LOGIC.md` §«Статистика артефактов…», `docs/SERVICES.md`
  (market_stats.py). Файлы: `backend/app/services/analytics/market_stats.py`,
  `backend/app/api/v1/endpoints/monitoring.py`.
- [ ] **Рассинхрон агрегатных ценовых окон под фильтром qlt/ptn** (пред-существующее, вне
  фикса `0367a96`, зафиксировано 2026-07-24) — в ветке `/monitoring/item` с активным фильтром
  качества/заточки поля `min_price_7d`/`max_price_7d`/`avg_price_7d` и окна 24h/48h всё ещё
  берутся из агрегата `market_statistics` (по всему предмету), рассинхрон с отфильтрованной
  медианой. На карточке эти поля напрямую не отображаются → визуального дефекта нет; для
  полноты честного пересчёта под фильтр их тоже стоило бы считать из отфильтрованного
  `SalesHistory` за 30д.
- [x] **Fix: добавление вариаций предмета в избранное (каталог) ← 2026-07-24** — коммит
  `00b0e7e`. Кнопка «в избранное» в строке каталога защёлкивалась по одному `item_id` после
  первого добавления и блокировала добавление того же предмета с другой заточкой/качеством/
  регионом (бэкенд различает записи по кортежу `item_id+region+qlt+ptn`). Теперь кнопка всегда
  кликабельна, галочка `BookmarkOk` — информативный индикатор «уже отслеживается», не блокирует
  повторное добавление вариации. Плюс перевод 409-detail «Already in watchlist» → «Уже в
  избранном». Файлы: `frontend/src/pages/CatalogPage.tsx`,
  `backend/app/api/v1/endpoints/watchlist.py`.
- [x] **Web Push уведомления через RabbitMQ ← 2026-07-20** — ТЗ
  `docs/tasks/web-push-notifications.md`, миграция `0035` применена локально,
  QA пройден. Второй канал доставки (браузерный push, ПК + Android + iOS)
  **параллельно** Telegram, с минимальной задержкой через настоящую очередь
  событий. Продюсер (коллектор) кладёт лёгкое `{type, user_id, item, ...}` в
  RabbitMQ exchange `push.events`; отдельный контейнер `push_service` слушает
  очередь, курирует (гейт `notify_browser_push` + тариф, дедуп `push_*_sent:*`,
  все устройства) и шлёт web push (pywebpush/VAPID). Три типа событий (лоты /
  Buy Sniper / выброс). Новое: таблица `push_subscriptions`, эндпоинты
  `/push/*`, `push_broker.py`, Service Worker + PWA-манифест + тумблер
  «Browser Push» (subscribe-flow, iOS-инструкция), сервисы `rabbitmq` +
  `push_service` в оба compose. Детали — `docs/CHANGELOG.md`, `docs/DATABASE.md`,
  `docs/SERVICES.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOY.md`.
  **Задеплоено на прод 2026-07-20** (прод-VAPID + отдельный пользователь
  RabbitMQ из `.env`, не guest). Security-ревью пройдено, фиксы применены
  (коммит `e4e2949`): allowlist push-хостов в `/push/subscribe` (анти-SSRF) +
  cap 20 подписок, `timeout` в `webpush()`, dev-порты RabbitMQ на `127.0.0.1`.
  Приём push подтверждён вживую (реальные лот-пуши + тестовый emission
  `sent=2/2` дошли до устройства). У одного устройства push не показывался —
  причина на стороне браузера/ОС (разрешение/показ), не код.
- [x] **Перевести Telegram-уведомления на ту же очередь событий (RabbitMQ) ←
  2026-07-21** — ТЗ `docs/tasks/telegram-notifications.md`, QA + security-ревью
  пройдены, **не задеплоено** (коммит ещё не сделан). Рефакторинг доставки, не
  новая фича: `telegram_bot` стал консьюмером `push.events` (своя durable-очередь
  `telegram.notifications`, привязана к тому же DIRECT-exchange по routing_key
  `push`, `x-message-ttl=15 мин`) вместо polling-цикла `_notifier_loop` (чтение
  `signals:*`/`buymin:*`/`EmissionEvent` каждые 15с). Fan-out на стороне брокера:
  DIRECT-exchange отдаёт копию каждого события обеим очередям (`push.notifications`
  для web push + `telegram.notifications`). Продюсер (`collectors.py`,
  `push_broker.py`) и схема БД НЕ менялись (миграций нет). `_notifier_loop` заменён
  на `_consume_loop` с супервайзер-петлёй для самовосстановления. Дедуп выброса
  переведён с БД-флагов `EmissionEvent.notified`/`end_notified` на Redis-ключ
  `tg_emission_sent:{event_id}:{phase}` (флаги стали вестигиальными для Telegram,
  но продюсер их по-прежнему заполняет). Prod: `telegram_bot` ходит в RabbitMQ под
  `${RABBITMQ_USER}/${RABBITMQ_PASSWORD}`, `depends_on rabbitmq healthy`. Три типа
  уведомлений (лоты / Buy Sniper / выброс) и flow привязки `/link` без изменений.
  Побочно — durable-очередь смягчает потерю уведомлений при рестарт-лупе бота
  (проблема нестабильной сети прод→api.telegram.org). Детали — `docs/CHANGELOG.md`,
  `docs/SERVICES.md`, `docs/ARCHITECTURE.md`.
- [ ] **Web push: deep-link клика по уведомлению на конкретный предмет** — идея
  пользователя 2026-07-20 (после прод-деплоя push). Сейчас Service Worker при
  клике открывает захардкоженный раздел (`render_*` в `push_service/consumer.py`:
  лот → `/app/lots`, закупка → `/app/buy-sniper`, выброс → `/app`). Надо вести на
  страницу **того** предмета, по которому пришло уведомление. Данные в событии
  уже есть (`item_id`/`region`/`quality_filter`/`enchant_filter`). **Ключевой
  нюанс:** клик по push открывает URL (`clients.openWindow`), а не React-Router
  `location.state` — поэтому мало дописать `?item=` в `url`, целевая страница
  должна **читать предмет из query-параметра** (`useSearchParams`). Сейчас
  пред-выбор работает только через `location.state` (`MonitoringPage.tsx:89-105`,
  `LotsPage.tsx:192-203`) — расширить на `?item=`. Маршруты — `/app/monitoring`,
  `/app/lots`, `/app/buy-sniper` (`App.tsx:60-64`). Правки: `push_service/
  consumer.py` (`render_profitable_lot`/`render_buy_alert` — адресный `url`),
  фронт `MonitoringPage.tsx`/`BuySniperPage.tsx` (чтение `?item=`). **Открытый
  UX-вопрос (не решён пользователем):** выгодный-лот вести на карточку Избранного
  (`/app/monitoring?item=`, богатый анализ) ИЛИ на список «Лоты»
  (`/app/lots?item=`, требует тариф advanced_plus+). Требует пересборки фронта +
  редеплоя.
- [x] **Раздел «Закупки // Buy Sniper» (замена «Склада») ← 2026-07-19** — ТЗ
  `docs/tasks/buy-sniper.md`, миграция 0034 применена, QA пройден. Порог цены на
  товар из «Избранного» → Telegram-алерт «пора покупать», когда самый дешёвый лот
  ≤ порога. Новая таблица `buy_alerts` (drop `user_inventory`/`sell_recommendations`),
  эндпоинты `/buy-sniper/*` (+ `price-window` min/median/max за 3д), два тарифных
  флага `buy_sniper_access` (advanced+) / `buy_sniper_notifications` (advanced_plus+),
  Redis `buymin:*` из коллектора + `notify_buy_alerts` в боте. Frontend
  `BuySniperPage.tsx`, пункт навбара «Закупки» с гейтом; старый «Склад» удалён.
  Детали — `docs/CHANGELOG.md`, `docs/DATABASE.md`, `docs/SERVICES.md`,
  `docs/BUSINESS_LOGIC.md` §17.
  **Отложено (не в этом объёме):** browser-push для того же триггера
  (`UserSettings.notify_browser_push` уже есть); «% ниже медианы» как альтернатива
  абсолютному порогу; `last_triggered_at` в UI (дедуп живёт в Redis).
- [ ] **Внедрение Design v5 «Терминал»** — по спеке
  `docs/tasks/design-v5-implementation.md` (7 фаз, независимый деплой каждой).
  **Фазы 1–6 из 7 внедрены** (← 2026-07-18: фундамент токенов + 17 ui-компонентов,
  шелл/навбар, Избранное-эталон, Каталог+Лоты, Радар+Склад+Настройки+Новости;
  ← 2026-07-19: Фаза 6 — Лендинг + Логин, публичные страницы; детали —
  `docs/CHANGELOG.md`, conformance Избранного —
  `docs/tasks/design-v5-favorites-conformance.md`).
  **Осталась только Фаза 7 «Лента»** (новая фича) — НЕ начата, **ждёт решения
  пользователя по подходу + бэкенд-обсуждение** (материализация событий
  spike/move, эндпоинт `/feed/events`); в живом приложении FeedPage пока
  заглушка. Эталон — прототип `design/v5/`. Риск: фаза 1 сменила тему
  глобально — страницы FAQ/Admin/Register вне охвата прототипа, проверить их
  конформность (News приведена к DEL-01 в Фазе 5).
  **Известные пробелы (отложены, требуют backend-surface):** медиана 7д в
  сайдбаре Избранного не выводится (нет поля в `/watchlist`); предмет `dm6l2`
  без иконки (нет исходника у EXBO — фолбэк-буква). ~~P&L Склада → «—»~~ —
  неактуально: раздел «Склад» удалён и заменён «Закупками // Buy Sniper»
  (2026-07-19, см. выше).
- [ ] **Нестабильная сеть прод→api.telegram.org: прокси или форс IPv4 для
  `telegram_bot`** ← выявлено 2026-07-08 при деплое emission-ревизии.
  После пересборки `telegram_bot` ~14 мин крутился в рестарт-лупе с
  `telegram.error.TimedOut` на инициализации (`get_me`), затем сам поднялся
  (polling, статус Up). Это та же первопричина, из-за которой изначально
  терялись уведомления о выбросе (worker падал на Timed out). Теперь ВСЯ
  Telegram-рассылка (лоты + выброс) идёт через `telegram_bot` — при его
  недоступности/рестарт-лупе не приходят никакие уведомления. Новая логика
  смягчает частично (флаг `notified`/`end_notified` ставится только после
  успешной отправки, ретрай каждые 15с), но при недоступности бота дольше
  отсечки свежести 15 мин событие о выбросе гасится безвозвратно.
  **Смягчено с 2026-07-21** (перевод Telegram на RabbitMQ): durable-очередь
  `telegram.notifications` копит события во время рестарт-лупа и доставляет их
  после реконнекта (в пределах `x-message-ttl=15 мин` + guard свежести) —
  потеря уведомлений при коротких падениях бота устранена; глубинная сетевая
  причина (прокси/форс-IPv4) всё ещё открыта.
  **Кандидат-решение:** настроить `HTTPS_PROXY` для `telegram_bot` (PTB
  поддерживает из коробки) ИЛИ форсировать IPv4-маршрут до Telegram
  (вероятно висит IPv6-маршрут). Диагностика не завершена — curl-проверки
  IPv4/IPv6 с сервера не выполнены. Контекст — `docs/DEPLOY.md` (раздел
  «Нюансы»), `docs/tasks/emission-notify-via-bot.md`.
- [x] **Fix: задержки Telegram-уведомлений** ← 2026-07-06 — убран блокирующий
  `sleep(60)` на 429 в `StalcraftClient._request()` (retry естественно через
  `due_pairs` на следующем тике), один shared `aioredis`-клиент на весь батч
  `collect_all_active_lots` (опциональный `redis_client` в
  `rate_limiter.acquire()`), per-entry try/except в
  `notify_profitable_lots()`, лог фактической длины цикла обновления пары
  (наблюдаемость для причины B, `SIGNALS_TTL=300`с). Диагноз и реализация —
  `docs/tasks/telegram-notification-bug.md`, `docs/CHANGELOG.md`.
  **Открытые вопросы (причины C/D — не баг, ожидаемое поведение):** уточнить
  тарифы и персональные настройки прибыли (`min_profit_margin_percent`/
  `exclude_less_than_amount`) двух пожаловавшихся пользователей — тариф `base`
  не получает Telegram-уведомления by design, разные пороги прибыли легитимно
  дают разный список выгодных лотов.
- [x] **CPU-спайки: следующие шаги после прод-замеров** ← 2026-07-07 —
  прод-замеры сняты (85 уникальных пар watchlist, `calculate_all_market_stats`
  залпом 193–236с каждый час, ~2.7с/пара, однопоточный CPU-bound), выбран и
  реализован вариант «размазывание + дифф-пересчёт»: новая порционная задача
  `calculate_market_stats_batch` (10 слотов в час :12–:57, слот пары —
  `crc32 % 10`, дифф-пропуск чистых пар по `sales_history.collected_at`,
  force-круг 04:12–04:57 МСК), миграция `0032` (индекс `ix_sales_collected_at`),
  цепочка `.delay()` из `collect_all_history` удалена,
  `calculate_all_market_stats` оставлена как ручной инструмент. Коммит
  `cf239e1`, ТЗ — `docs/tasks/market-stats-spread-diff-skip.md`, задеплоено
  и проверено на проде 2026-07-07. Бонусом — фикс фильтра времени продажи
  (коммит `9a41653`): лот живёт max 48ч, фильтр аномалий `0 < hours <= 48`
  вместо 14 дней. Этап 2 (rollups) — отдельный пункт ниже.
- [ ] **Инкрементальные почасовые агрегаты (rollups) для market_stats —
  этап 2, НЕ срочно** — если фоновая стоимость пересчёта продолжит расти с
  объёмом sales_history/watchlist. Идея пользователя: предрассчитанные
  почасовые «кубики» (count/sum/min/max/sum_sq — складываются между собой;
  медианы НЕ складываются — им нужен SQL-перцентиль или сырые данные),
  статистика собирается из кубиков, а не из сырых строк. Контекст — раздел
  «На будущее (вне scope, этап 2)» в
  `docs/tasks/market-stats-spread-diff-skip.md` и пункт 2 плана в
  `docs/tasks/cpu-spikes-recurring-2026-07-06.md`.
- [x] **Повысить покрытие qlt/ptn в sales_history** — реальная причина оказалась
  не ограничением API, а багом парсинга ← 2026-06-29. Stalcraft API `/history`
  уже возвращает `additional.qlt`/`ptn` напрямую в каждой записи продажи
  (подтверждено живым запросом к API), но `_collect_history_for_item()`
  (`backend/app/tasks/collectors.py`) никогда не читал `record.get("additional")`
  — поле молча отбрасывалось, хотя запрос уже шёл с `additional=true`. Старый
  комментарий в коде, утверждавший обратное, был неверным предположением, не
  фактом. Фикс: `record.get("additional")` теперь первичный, authoritative
  источник qlt/ptn; снэпшот-матчинг (`find_lot_info`) сохранён только для
  `lot_start` (время выставления лота, для `time_on_market`). Подробности и
  диагностика — `docs/tasks/sales-history-qlt-ptn-coverage.md`.
  Дополнительно: разовый CLI backfill-скрипт
  `backend/app/scripts/backfill_sales_qlt.py` (`docker compose exec backend
  python -m app.scripts.backfill_sales_qlt --days 30`) для существующих
  записей без qlt — печатает смету по rate limit перед запуском.
  **Инцидент 2026-06-29:** первый запуск на проде (`--days 30 --yes`) почти
  сразу начал стабильно падать в `429` на каждой странице `/history` и не
  продвигался — причина в самом скрипте, не в общем rate limiter'е: постраничные
  запросы внутри `_backfill_pair()` шли без пауз (~5 запросов/сек) и при первом
  же `429` ронялась вся пара `(item_id, region)` без retry. Пользователь
  остановил скрипт вручную. Фикс — только в `backfill_sales_qlt.py`
  (`BACKFILL_PAGE_DELAY=1.0`, `BACKFILL_MAX_PAGE_RETRIES=5`), разбор причины —
  `docs/tasks/backfill-rate-limit-burst-fix.md`. **Повторный запуск на проде
  после фикса выполнен (запущен 2026-06-29) — завершён успешно (подтверждено
  2026-07-02).**
- [x] **Инцидент: CPU-спайки на проде раз в час** — устранён 2026-06-29
  (`HISTORY_CONCURRENCY=6`, параллельная обработка `collect_all_history`),
  внеплановый фикс, не из бэклога. Подробности — `docs/CHANGELOG.md`,
  `docs/SERVICES.md`. **2026-07-06: спайки вернулись в изменённом виде**
  (плато ~10 мин + отложенный скачок через ~20 мин) — новое ТЗ
  `docs/tasks/cpu-spikes-recurring-2026-07-06.md`, частичный фикс задеплоен,
  следующие шаги — см. открытый пункт «CPU-спайки: следующие шаги» выше.
- [x] **Опробовать skill `systematic-debugging`** — применён 2026-06-28 на
  реальном баге (тариф `base` видел полную историю продаж за все окна вместо
  24ч) — root cause найден чтением кода за один проход (незащищённый
  `/monitoring/sales-chart`), фикс точечный, без лишних итераций. Эффект
  положительный, закрепляем как практику. `test-driven-development` в этом
  заходе не использовался (правки тестировались curl/tsc, не автотестами) —
  оценку оставляем открытой на следующий backend-таск с тестами.
- [ ] **Роадмап подписок — оставшиеся фазы** (Phase 0 "Тарифы" реализована,
  см. `docs/CHANGELOG.md` и `docs/BUSINESS_LOGIC.md` §17):
  - [x] Статистика в админке (rate-limit consumption, уникальные карточки по
    всем пользователям) ← 2026-06-28, см. `docs/CHANGELOG.md`,
    `docs/SERVICES.md` (`GET /admin/stats`, `get_consumption_stats()`).
    Дополнено 2026-06-28 — 4 пункта, потерянных при первом восстановлении ТЗ
    (зашедшие сегодня, активные за неделю, счётчик подключивших Telegram,
    колонка Telegram в таблице пользователей): см. `docs/CHANGELOG.md`,
    `docs/SERVICES.md`, `docs/tasks/admin-stats-gaps.md`.
  - [x] Раздел новостей ← 2026-07-02, см. `docs/tasks/news-section.md`, `docs/DATABASE.md`, `docs/SERVICES.md`: таблица `news`, 6 эндпоинтов `/api/v1/news/*`, страница `/app/news` с inline-редактором для admin, фиксированные теги (обновление/тарифы/техработы/важно).
  - [ ] Форма обращений → Telegram админам.
  - [x] "Радар рынка" (кросс-юзерная агрегация watchlist, отдельный аддон не
    по тарифам, гейтинг через `User.has_market_radar_addon`; топ группируется
    по `item_id, quality_filter, enchant_filter` — один предмет может занимать
    несколько строк; метрика `profitable_offers_count` — число выгодных лотов
    в снэпшоте, дедуплицированное по лотам, не по watcher'ам) ← 2026-06-28,
    см. `docs/CHANGELOG.md`, `docs/BUSINESS_LOGIC.md` §17, `docs/SERVICES.md`
    (`GET /market-radar/`, `get_market_radar_aggregate()`).
    - [x] Ревизия 2026-06-29 — сортировка по `profitable_offers_count` (убыв.,
      `None`→0) вместо `watchers_count`, полная серверная пагинация
      (`page`/`page_size`, default 20) вместо жёсткого SQL-лимита топ-20,
      safety-cap `MAX_BUCKETS=500` на число бакетов. См.
      `docs/tasks/market-radar-sort-pagination.md`, `docs/CHANGELOG.md`,
      `docs/BUSINESS_LOGIC.md` §17, `docs/SERVICES.md`.
  - [x] FAQ-онбординг + копирайт лендинга под переименование игры в STALZONE
    ← 2026-06-29, см. `docs/tasks/faq-onboarding-stalzone-rebrand.md`,
    `docs/CHANGELOG.md`:
    - (a) ребрендинг видимого пользователю копирайта Stalcraft X → STALZONE
      (лендинг, логин, Swagger, приветствие Telegram-бота); технические
      идентификаторы внешнего API (`stalcraft.net`, `StalcraftClient`,
      Redis-ключи, Celery app name) сознательно не тронуты.
    - (b) новая страница `/faq` (MVP, без welcome-модалки/guided tour) — 12
      вопросов в 5 группах, MUI Accordion, ссылки из навбара/лендинга/экрана
      регистрации.
    - (c) внеплановое дополнение по ходу задачи — чип тарифа рядом с ником в
      навбаре (`Layout.tsx`), `TIER_LABELS`/`TIER_COLORS` вынесены в общий
      `frontend/src/constants/tiers.ts` (рефактор дублирования с
      `AdminPage.tsx`).
  - [x] Ручной override лимита избранного (watchlist) вне тарифа ← 2026-06-28,
    см. `docs/CHANGELOG.md`, `docs/BUSINESS_LOGIC.md` §17 (подраздел «Override
    лимита избранного»), `docs/DATABASE.md` (`users.favorites_limit_override`).
  Черновой план остальных пунктов — в истории чата/архиве планов, при
  возврате к теме — заново зафиксировать через `researcher`.
- [ ] **Троттлинг рассылки выброса в Telegram** (техдолг, отложено 2026-07-21) —
  мягкий `sleep`/батчинг при fan-out события `emission` всем привязанным
  пользователям. Сейчас `handle_emission` шлёт всем подряд без пауз; при заметном
  росте числа привязанных возможен упор в Telegram flood limit (~30 msg/сек
  глобально). Вернуться ДО роста аудитории. Не затрагивает Stalcraft API rate
  limit (это внешний Telegram API). Контекст — `docs/tasks/telegram-notifications.md`
  (Security, п. 4).
- [ ] **`html.escape` текстовых полей в `build_lot_message`/`build_buy_message`**
  (техдолг, 2026-07-21) — сообщения шлются с `parse_mode=HTML`; названия предметов
  и прочие подставляемые строки приходят из внешнего API и не экранируются. Риск
  низкий (данные из каталога EXBO, не пользовательский ввод), но при появлении
  `<`/`&` в названии сообщение может сломаться/не отправиться. Экранировать
  подставляемые поля перед вставкой в HTML-шаблон.
---

## API Аудит — Найденные пробелы (2026-07-02)

Полный аудит публичного API Stalcraft X (EXBO/Stalzone). Три агента исследовали кодовую базу + внешние источники (docs, GitHub, форумы). Детальный разбор — `docs/tasks/api-audit-2026-07-02.md` (создать при реализации).

### Незадействованные возможности API

- [x] **Emission-фича** ← 2026-07-06 — таблица `emission_events` (миграция `0031`), Celery-задача `collect_emission` (каждые 2 мин, 1 токен, Redis-дедупликация `emission:current_fingerprint`), эндпоинты `GET /api/v1/emission/current` и `/emission/history`, `EmissionWidget` в сайдбаре (красный при активном выбросе, золотой со счётчиком времени в ожидании, поллинг 15с/30с через `emissionStore`), Telegram broadcast всем `is_active AND is_approved AND telegram_chat_id IS NOT NULL` без гейтинга тарифом. Fix: `STALCRAFT_REGION` исправлен с `"EU"` на `"RU"`. Подробности → `docs/tasks/emission-tracker.md`. **Ревизия 2026-07-08:** рассылка перенесена из worker в `telegram_bot::notify_emission_events` (+ поле `end_notified`, миграция `0033`, + фильтр `UserSettings.notify_telegram`) — worker слал через одноразовый `Bot(token)` и терял отправки; см. `docs/tasks/emission-notify-via-bot.md`, `docs/CHANGELOG.md`. **Задеплоено на прод 2026-07-08** (`alembic current` = `0033` head, backend/worker/scheduler/telegram_bot пересобраны `--no-cache`). Операционный риск с сетью до Telegram — отдельный пункт ниже.
- [ ] **Пагинация лотов** — всегда `offset=0, limit=200`, дефолтная сортировка API неизвестна. Для предметов с >200 активными лотами `best_price_per_unit` может быть неточным. Исправить: добавить `sort=price&order=asc`, дозапросы offset=200/400... до < 200 лотов (max 1000). Учесть +2 токена за каждую доп. страницу.
- [ ] **Items Metadata (stalzone-database)** — в БД хранится только `item_id`. Полная база предметов с названиями (ru/en), категориями, цветами — на GitHub `EXBO-Studio/stalzone-database`. Перед реализацией: выяснить как сейчас приходят названия на фронт (пользователь сказал «приходят с бэка из какого-то источника» — источник не найден при аудите, требует проверки).
- [ ] **Пагинация истории** — `collect_all_history` берёт только offset=0, limit=200 раз в час. Для популярных предметов (>200 продаж/час) часть истории теряется навсегда. Аналогичное исправление через дозапросы.
- [ ] **Мультирегион** — API поддерживает RU/EU/NA/SEA, используем только RU. Кросс-региональный арбитраж недоступен. Большой scope, отложено.

### Баги и слабые места реализации

- [ ] **Snapshot-History Matching хрупкость** — окно поиска ~1.7 часа (200 снэпшотов × 20 сек). Медленно продающиеся предметы: `lot_start = NULL` навсегда. `avg_sell_time_hours` основан только на быстрых продажах — нерепрезентативен. Сложный фикс, после emission+пагинации.
- [ ] **dead column `detected_buyouts_count`** — всегда NULL в `CollectedData`. Удалить при следующей миграции.
- [ ] **Лоты в игре, которых нет в нашей БД** — расследование завершено (2026-07-02). Три независимые причины:
  1. **Главная (99% случаев): watchlist-центричная архитектура.** `collect_all_active_lots` (`collectors.py:58`) берёт только `(item_id, region)` из `user_watchlist`. Если ни один пользователь не добавил предмет в избранное — его лоты никогда не собираются. В `master_items` есть 2236 предметов, но коллектор видит только те, что кто-то добавил в вотчлист. Это архитектурное решение, не баг.
  2. **Вторичная: пагинация (1-5%).** Для предметов в вотчлисте мы берём первые 200 лотов от API (неизвестная дефолтная сортировка), затем сортируем по цене сами (`collectors.py:353`). Лоты за пределами 200 от API — невидимы.
  3. **Community report об API:** "показывает ~50% реальных лотов" — не верифицировано, требует ручной проверки (сравнить count через API vs ingame для конкретного предмета).
  - **Потенциальное решение:** фоновый сбор всех предметов из `master_items` с низкой частотой (не каждые 20 сек, а раз в час) — даст глобальную картину рынка без зависимости от watchlist. Нужно оценить нагрузку: 2236 предметов × 2 токена = 4472 токена/час = 74.5 запросов/мин (18.6% от лимита, в сумме с текущим ~32%).


### Внешняя информация

- Python-обёртка `stalcraft-api` v2.1.2 (PyPI, май 2026) — может содержать недокументированные эндпоинты, стоит проверить.
- Community report: "API не показывает ~половину реальных лотов" — требует верификации (сравнить count через API vs ingame).
- Неофициальный внутренний API задокументирован в `Art3mLapa/unofficial-stalcraft-api` (launcher, backend, CDN) — не для нашего use case.

---

## Идеи на будущее

- Уведомления в реальном времени — WebSocket push.
- Сравнение регионов — один товар, несколько регионов рядом.
- При параллельной работе нескольких сессий Claude Code в одном репозитории —
  после любой деструктивной git-операции (filter-repo, reset --hard, force-push)
  в ОДНОЙ сессии явно сверять `git log`/`git status`/`git diff` в ОСТАЛЬНЫХ
  открытых сессиях: рабочая копия может сброситься и молча потерять
  uncommitted-правки, сделанные параллельно.

---

## Архив

- Полная история закрытых задач и редизайна фронтенда → `docs/CHANGELOG.md`
- Деплой и инфраструктура (VPS, Caddy, первый запуск) → `docs/DEPLOY.md`
