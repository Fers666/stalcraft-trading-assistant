# Архив закрытых задач

Исторический changelog, перенесён из NOTES.md 2026-06-15.
Не входит в роутер CLAUDE.md — не загружается по умолчанию в контекст задач.
Факты, релевантные для текущей архитектуры/БД/бизнес-логики, продублированы
(в актуальном виде) в ARCHITECTURE.md / DATABASE.md / BUSINESS_LOGIC.md / SERVICES.md.

---

## Закрытые задачи

- [x] **Повысить покрытие qlt/ptn в sales_history — баг парсинга, не ограничение
  API ← 2026-06-29** — диагностировано живым запросом к Stalcraft API через
  рабочий backend-контейнер (`stalcraft_client.get_auction_history(...)`,
  read-only): каждая запись `/history` уже содержит `additional.qlt`/`ptn`
  напрямую (запрос уже шёл с `additional=true`), но
  `_collect_history_for_item()` (`backend/app/tasks/collectors.py`) никогда не
  читал `record.get("additional")` — поле молча отбрасывалось при парсинге.
  Старый комментарий в коде (`find_lot_info` docstring), утверждавший, что API
  не возвращает это поле, был неверным предположением — первая версия ТЗ
  изначально пошла по этому ложному следу (планировала новую таблицу
  `lot_identity`/расширение окна снэпшотов), пока диагностика не опровергла
  его прямой проверкой. Полная история — `docs/tasks/sales-history-qlt-ptn-coverage.md`.
  - Фикс: `_collect_history_for_item()` теперь читает `record.get("additional")`
    и использует его как первичный, authoritative источник `qlt`/`ptn` для
    каждой записи (новой и существующей-но-неполной), независимо от возраста
    продажи и видимости в снэпшотах. Снэпшот-матчинг (`find_lot_info`) сохранён,
    но теперь нужен только для `lot_start` (время выставления лота, для
    `time_on_market`) — API-данные приоритетнее при пересечении по qlt/ptn.
    Комментарий в `find_lot_info` docstring исправлен.
  - Новый файл `backend/app/scripts/backfill_sales_qlt.py` — разовый CLI
    backfill для уже существующих записей `sales_history` без qlt (на момент
    написания — 63 175 из 71 811 строк, 31 пара item_id/region). Запуск
    вручную: `docker compose exec backend python -m
    app.scripts.backfill_sales_qlt --days 30` (флаг `--days`, default=30).
    Печатает смету стоимости (число API-запросов/токенов rate limit) и просит
    подтверждения перед основным проходом; использует общий
    `stalcraft_client`/Redis token bucket rate limiter, без отдельного
    троттлинга. **Backfill пока не запускался.**
  - Не затронуто: новых таблиц/миграций нет, `SNAPSHOT_MATCH_WINDOW_HOURS`
    (200 снэпшотов, ~1.7ч) не менялся, Celery beat-расписание не менялось,
    frontend не затронут (формат `additional_info`/API contract не меняется).

- [x] **Инцидент: CPU-спайки на проде раз в час ← 2026-06-29** — диагностировано
  вживую через `docker stats` + worker-логи (2026-06-28): раз в час оба vCPU
  прода прыгали до ~70%. Причина — Celery-задача `collect_all_history`
  (`backend/app/tasks/collectors.py`, `crontab(minute="0")`) обрабатывала все
  уникальные пары `(item_id, region)` watchlist строго последовательно (один
  `await` за раз), прогон занимал 50+ секунд (подтверждено логом: `Task ...
  collect_all_history[...] succeeded in 50.722s`) и пересекался по времени с
  `collect_all_active_lots` (каждые 20с) на втором forked worker-процессе
  (`worker_concurrency=2`) — обе задачи одновременно грузили оба ядра
  2-vCPU сервера.
  - Фикс: новая константа `HISTORY_CONCURRENCY = 6` в `collectors.py`.
    `collect_all_history` делит `unique_entries` round-robin на 6 чанков
    (`unique_entries[i::HISTORY_CONCURRENCY]`) и обрабатывает их параллельно
    через `asyncio.gather` — каждый чанк в своей корутине-воркере с
    собственной `get_celery_db_session()` на весь чанк (одна `AsyncSession`
    не может использоваться параллельно из нескольких корутин, поэтому
    сессия отдельная на воркер, не на item). Внутри чанка items
    обрабатываются последовательно с тем же per-item `try/except` +
    `logger.error`, что и раньше.
  - Количество запросов к Stalcraft API не изменилось — `rate_limiter.py`
    централизован и не зависит от конкурентности вызовов; изменилось только
    время выполнения (тот же объём работы укладывается в секунды вместо
    50+).
  - `force_refresh_all_history`, `collect_all_active_lots`,
    `_collect_history_for_item` не изменялись.
  - QA: локальный прогон задачи — 6.3с вместо 50.7с, все пары watchlist
    обработаны без пропусков, ошибок нет.

- [x] **Админ-статистика — устранение пробела после фазы «Статистика в
  админке» ← 2026-06-28** — при реализации той фазы (см. запись «Админ-статистика —
  следующая фаза роадмапа подписок» ниже) черновой план обсуждался в чате, но
  не зафиксировался структурно в `docs/NOTES.md` — ТЗ восстанавливалось по
  куцей записи и 4 пункта из оригинального запроса потерялись. Эта задача их
  добавляет поверх уже реализованного, ничего из сделанного ранее не
  переписывает. ТЗ — `docs/tasks/admin-stats-gaps.md`.
  - Backend (`backend/app/api/v1/endpoints/admin.py`): `AdminStatsResponse`
    дополнен тремя полями после `users_online_now` — `users_active_today`
    (количество пользователей с `last_seen` после начала текущих суток по
    московскому времени, `timezone(timedelta(hours=3))`, тот же паттерн что в
    `market_stats.py` — календарный день МСК, не скользящие 24ч),
    `users_active_week` (скользящее окно последних 7×24 часа от UTC),
    `users_telegram_linked` (`telegram_chat_id IS NOT NULL` — единственный
    достоверный признак подключения бота, тот же признак что в `GET
    /telegram/status`). `get_admin_stats` считает все три новых поля.
  - `UserAdminResponse` дополнен полем `telegram_chat_id: int | None` (рядом
    с уже существующим `telegram_username`), `list_users` заполняет его из
    `User.telegram_chat_id`. Никаких новых миграций — все используемые поля
    (`last_seen`, `telegram_chat_id`) уже существовали, Alembic head не
    менялся.
  - Frontend (`frontend/src/pages/AdminPage.tsx`): интерфейсы `AdminStats` и
    `AdminUser` дополнены соответствующими полями. В блок System stats (после
    карточки «Rate limit Stalcraft API») добавлены 3 новые карточки тем же
    визуальным паттерном: «Зашли сегодня», «Активны за неделю», «Подключили
    Telegram» (иконка `TelegramIcon`). В таблицу пользователей добавлена
    колонка «Telegram» (между «До» и «Был онлайн») — показывает `@username`
    из `telegram_username` либо «—».
  - **Решение пользователя, зафиксировано явно:** колонка «Telegram» в
    таблице показывает `telegram_username` напрямую, **независимо** от
    `telegram_chat_id` — то есть отражает введённый username, а не факт
    реального подключения бота. Это осознанная асимметрия с метрикой
    `users_telegram_linked` (которая использует только `telegram_chat_id`) —
    не баг, два разных способа определения «телеграма» в одной фиче
    намеренно не унифицированы.

- [x] **Fix: карточка тарифов в админке всегда показывает все 4 уровня ← 2026-06-28** —
  блок «Тарифы» в `AdminPage.tsx` рендерил чипы напрямую из `Object.entries(stats.users_by_tier)`
  — если по какому-то тарифу не было ни одного пользователя, `GROUP BY User.tier` не возвращал
  для него строку, и чип тарифа пропадал из карточки целиком (а не показывал `0`). Фикс на
  backend (`get_admin_stats`, `backend/app/api/v1/endpoints/admin.py`): `users_by_tier`
  инициализируется `{tier: 0 for tier in TIERS}` и затем дополняется реальными счётчиками —
  все 4 тарифа всегда присутствуют в ответе. Фронтенд не менялся. См. `docs/SERVICES.md`
  (`GET /admin/stats`).

- [x] **Ручной override лимита избранного (watchlist) вне тарифа ← 2026-06-28** —
  следующая фаза роадмапа подписок (роадмап остаётся открытым пунктом, см.
  `docs/NOTES.md`; новости, форма обращений, FAQ/STALZONE — не реализованы).
  - Поле `User.favorites_limit_override` (`Integer`, nullable, default `None`,
    миграция `0029_favorites_limit_override.py`, down_revision `0028`). `NULL`
    = нет override, лимит = тариф; не-`NULL` значение **заменяет** лимит
    тарифа целиком (не складывается с ним).
  - `backend/app/core/tiers.py`: новая функция `effective_watchlist_limit(user)
    -> int | None` (`is_admin` → без лимита; иначе override если задан, иначе
    лимит тарифа). `get_tier_limits()` теперь строит `watchlist_limit` через
    эту функцию (`dataclasses.replace`) — единая точка истины, все читатели
    лимита (`POST /watchlist/`, `UserResponse.watchlist_limit`) учитывают
    override автоматически. `apply_tier_expiry()` и `set_user_tier`
    (`admin.py`) используют `effective_watchlist_limit(user)` вместо жёсткого
    лимита тарифа при деактивации лишних карточек — override переживает смену
    или истечение тарифа.
  - Новый эндпоинт `POST /admin/users/{user_id}/favorites-limit-override`
    (`{"override": int | None}`, `Field(None, ge=0, le=100_000)` — верхняя
    граница добавлена после security-ревью, чтобы исключить необработанный
    `DataError` Postgres при значениях за пределами диапазона `Integer`) —
    устанавливает/снимает
    override; если новый эффективный лимит меньше текущего количества активных
    карточек пользователя — деактивирует лишние (`deactivate_excess_watchlist`),
    как при понижении тарифа. `UserAdminResponse` дополнен полями
    `favorites_limit_override` (сырое значение) и `effective_watchlist_limit`
    (готовое число для отображения). `UserResponse` (`GET /auth/me`) дополнен
    `favorites_limit_override`.
  - Frontend: `authStore.ts` — поле `favorites_limit_override` в `User`.
    `MonitoringPage.tsx` — золотой `Chip` «Расширенный лимит» с тултипом рядом
    с «ИЗБРАННОЕ · N/лимит», если у пользователя есть override. `AdminPage.tsx`
    — колонка «Карточек» показывает `watchlist_count / effective_watchlist_limit`
    (`∞` без лимита) + `TextField` с кнопкой «Применить» для установки/снятия
    override конкретному пользователю (пустое поле = снять override).
  - Архитектурное решение: override — числовая правка значения внутри
    существующей тарифной матрицы (`TierLimits.watchlist_limit`), а не отдельная
    фича вне тарифов, поэтому не использует булевый паттерн
    `has_market_radar_addon` буквально — структура («отдельное поле на `User`,
    отдельный admin-эндпоинт, без биллинга») та же. Подробности и альтернативы
    (сложение vs замена лимита) — `docs/tasks/favorites-limit-override.md`.
  - ТЗ — `docs/tasks/favorites-limit-override.md`.

- [x] **«Радар рынка» — кросс-юзерная агрегация watchlist, отдельный аддон ← 2026-06-28** —
  следующая фаза роадмапа подписок (роадмап остаётся открытым пунктом, см.
  `docs/NOTES.md`; новости, форма обращений, FAQ/STALZONE — не реализованы).
  - Гейтинг — отдельный boolean-флаг `User.has_market_radar_addon` (поле
    существовало с миграции `0026_user_tiers.py` как задел без логики, новая
    миграция не нужна), НЕ часть тарифной лестницы `TierLimits`. Новый
    dependency `get_market_radar_access` (`backend/app/core/dependencies.py`)
    пропускает `is_admin=True` или `has_market_radar_addon=True`, иначе 403.
  - Backend: новый сервис `app/services/analytics/market_radar.py`
    (`get_market_radar_aggregate`) — SQL-агрегация `user_watchlist`
    (`COUNT(DISTINCT user_id)` GROUP BY `item_id`, `FILTER` по `created_at >=
    now()-24h` для прироста), JOIN `master_items` + глобальная
    `market_statistics` (`user_id IS NULL`) для контекста цены/объёма.
    ORDER BY count DESC LIMIT 20. Redis-кэш TTL 60 сек
    (`market_radar:aggregate`). Не делает новых обращений к Stalcraft API —
    агрегация только над собственной БД, rate limit не затронут.
  - Новый эндпоинт `GET /market-radar/`
    (`backend/app/api/v1/endpoints/market_radar.py`), зарегистрирован в
    `main.py`. `UserResponse` (`auth.py`) и `UserAdminResponse`/`list_users`
    (`admin.py`) дополнены полем `has_market_radar_addon`. Новый эндпоинт
    `POST /admin/users/{id}/market-radar-addon` (`{"enabled": bool}`) для
    ручной выдачи/отзыва аддона — без биллинга, по аналогии с выдачей `tier`.
  - Никаких новых миграций — Alembic head остаётся `0028_registration_settings.py`.
  - Frontend: новый пункт навигации «Радар рынка» в `Layout.tsx` (гейт с
    tooltip «Доступно как отдельный аддон — обратитесь к администратору»;
    рефакторинг — добавлен словарь `gateKey`/`GATE_TOOLTIP`, чтобы у «Лотов»
    (`auction_access`) остался прежний тарифный текст). Новая страница
    `MarketRadarPage.tsx` — топ-20 предметов (ранг, иконка, имя,
    watchers_count + прирост 24ч, avg_price_24h/sales_volume_24h или «нет
    данных», чип SPIKE при `bulk_spike`), сводка `total_active_watchers`/
    `unique_items_tracked` в шапке, отдельный экран при 403. Роут
    `/app/market-radar` в `App.tsx`, поле `has_market_radar_addon` в
    `authStore.ts`.
  - **Ревизия 1 (тот же день):** топ перегруппирован с `item_id` на
    `(item_id, quality_filter, enchant_filter)` — один предмет может занимать
    несколько строк топа для разных комбинаций фильтров среди watcher'ов.
    Источник цены/объёма ветвится: бакет без фильтра — как раньше, из
    глобальной `market_statistics` (`price_window="24h"`); бакет с заданным
    фильтром — медиана `SalesHistory.price_per_unit` за 7д через
    `_build_sales_filter` (перенесена из `monitoring.py` в новый общий
    `backend/app/services/analytics/pricing.py`), `price_window="7d"`. Ответ
    API дополнен `quality_filter`, `enchant_filter`, `price_window`.
  - **Ревизия 2 (тот же день):** добавлена метрика
    `profitable_offers_count: int | None` — число реально выгодных лотов в
    текущем снэпшоте аукциона для бакета, **дедуплицированное по физическим
    лотам, не по пользователям** (10 watcher'ов одного выгодного лота видят
    число `1`, не `10`); отдельная метрика от `watchers_count`, показывается
    рядом. Расчёт (`_count_profitable_offers`,
    `backend/app/services/analytics/market_radar.py`): по регионам активных
    watcher'ов `item_id` берётся последний глобальный снэпшот
    `CollectedData`, `sell_options` считаются один раз на бакет через
    `make_sell_options(int(avg_price), sales_volume)` (переиспользуя уже
    посчитанные значения ревизии 1), затем каждый лот `raw_lots` фильтруется
    по базовым условиям/`quality_filter`/`enchant_filter` бакета и проверяется
    через `evaluate_lot_profit(risk="low", min_margin_pct=0.0)` — канонический
    неперсонализированный порог. `None`, если у бакета нет `avg_price`. Хелперы
    `_is_artefact`, `_lot_quality_enchant`, `_is_liquid` перенесены из
    `profitable_lots.py` в `pricing.py` (в дополнение к `_build_sales_filter`).
    Кэш/Celery не менялись — TTL остаётся 60с, без новой периодической задачи.
    Frontend (`MarketRadarPage.tsx`): новый блок «ВЫГОДНЫХ» в строке карточки
    — `null` → серое «нет данных», `0` → обычный текст, `>0` → зелёный акцент.
  - ТЗ — `docs/tasks/market-radar.md` (включая обе ревизии).

- [x] **Fix: `_publish_signals` падал с `'NoneType' object is not iterable` ← 2026-06-28** —
  регрессия от **Fix 8** (`docs/tasks/security-and-bugfix.md`, 2026-06-17, см. запись
  ниже): тот фикс корректно научил `profitable_lots.py` возвращать `sell_options=None`,
  когда под активный `quality_filter`/`enchant_filter` watchlist-записи нет совпадающих
  продаж за 7д, но downstream `evaluate_lot_profit` (`backend/app/services/analytics/pricing.py`)
  не был обновлён под этот легитимный случай и безусловно итерировал `sell_options` —
  `TypeError` на каждом цикле сбора для затронутой записи, видимый в логах worker как
  `_publish_signals: entry user=1 6goy/RU: 'NoneType' object is not iterable`.
  - Подтверждено на реальных данных: watchlist `user_id=1, item_id=6goy, region=RU`
    (`quality_filter=3, enchant_filter=15`) — 225 продаж за 7д, 0 совпадающих с
    фильтром (`prices=[]` → `sell_options=None`), но 6 лотов с тем же качеством/заточкой
    есть в текущем снэпшоте `raw_lots` → проходят фильтр → вызывают
    `evaluate_lot_profit(..., sell_options=None, ...)`.
  - Фикс: guard `if not sell_options: return None` в начале `evaluate_lot_profit`,
    сигнатура параметра `sell_options: list[dict]` → `Optional[list[dict]]`. Один файл,
    без миграций. Семантика не меняется — лот без данных для оценки и раньше не должен
    был считаться выгодным, теперь это явный `return None` вместо исключения.
  - Найден случайно `qa-tester` при верификации фазы «Админ-статистика» (не связан с
    ней) — баг изолирован per-entry, не блокировал коллектор и остальные watchlist-записи.
  - ТЗ — `docs/tasks/fix-publish-signals-nonetype.md`.

- [x] **Админ-статистика — следующая фаза роадмапа подписок ← 2026-06-28** —
  новый блок метрик "здоровья системы" в админке (роадмап подписок остаётся
  открытым пунктом, см. `docs/NOTES.md`; остальные части роадмапа — новости,
  форма обращений, "Радар рынка", FAQ/STALZONE — не реализованы).
  - Backend: новый эндпоинт `GET /admin/stats` (`backend/app/api/v1/endpoints/admin.py`,
    `Depends(get_current_admin)`) — `AdminStatsResponse`: `users_by_tier`
    (`GROUP BY User.tier`), `users_online_now` (порог `ONLINE_THRESHOLD_MINUTES`),
    `unique_watchlist_pairs` (`DISTINCT (item_id, region) WHERE is_active=true`
    — та же семантика дедупликации, что в `collectors.py`),
    `total_watchlist_entries`, `rate_limit`.
  - `TokenBucketRateLimiter` (`backend/app/core/rate_limiter.py`): Lua-скрипт
    `_LUA_ACQUIRE` расширен — при успешном списании токенов атомарно
    инкрементирует минутный Redis-счётчик `stalcraft:requests:minute:{unix_minute}`
    (`INCRBY needed` + `EXPIRE 120`), без отдельного round-trip. Новый метод
    `get_consumption_stats()` возвращает `{requests_current_minute, capacity_per_minute,
    source}` с graceful fallback при ошибке Redis. Показывает только текущую
    минуту — без часовой/исторической агрегации (осознанно упрощённый скоуп).
  - Никаких новых миграций — Alembic head остаётся `0028_registration_settings.py`.
  - Frontend (`AdminPage.tsx`): новый блок из 4 карточек между блоком Tasks и
    карточкой настроек регистрации — «Уникальных товаров в отслеживании»,
    «Онлайн сейчас», «Тарифы» (Chip-ряд по `TIER_LABELS`/`TIER_COLORS`), «Rate
    limit Stalcraft API» (`LinearProgress`, пороги <50%/50-80%/>80%). Новая
    функция `loadStats()` вызывается один раз при монтировании — без
    поллинга, снэпшот на момент открытия страницы (сознательное решение
    пользователя, Simplicity First).
  - ТЗ — `docs/tasks/admin-stats.md`.

- [x] **Система тарифов (подписок) — Phase 0 роадмапа ← 2026-06-28** — 5 уровней
  доступа (`base`/`advanced`/`advanced_plus`/`advanced_max`/admin), источник
  истины `backend/app/core/tiers.py`; полная матрица лимитов — `docs/BUSINESS_LOGIC.md`
  §17. Миграции `0026`-`0028`: `users.tier/tier_expires_at/last_seen/has_market_radar_addon`,
  `market_statistics.*_48h`, новая таблица-синглтон `registration_settings`.
  - Гейтинг: лимит карточек watchlist, доступ к аукциону, окна статистики
    (24ч/48ч/7д/30д), проактивные Telegram-уведомления (НЕ привязка аккаунта —
    она осталась одинаковой для всех тарифов).
  - Авто-понижение истёкшего тарифа до `base`: лениво (`get_current_user`) +
    ежесуточный Celery sweep `sweep_expired_tiers` (`app/tasks/tiers.py`,
    03:30). При понижении лишние карточки watchlist сверх нового лимита
    автоматически деактивируются (не удаляются) — оставляются самые старые.
  - Admin: `POST /admin/users/{id}/tier`, `POST /admin/users/{id}/tier/extend`,
    `GET/PUT /admin/settings/registration` (авто-подтверждение регистрации с
    выбором дефолтного тарифа/срока — выключено по умолчанию).
  - Frontend: колонки тариф/срок/онлайн/карточек в `AdminPage.tsx` (раздельные
    действия "Сменить тариф" / "Установить дату" / "Бессрочно" — не единая
    кнопка, см. баг ниже), индикатор `X/Y` карточек в `MonitoringPage.tsx`,
    блокировка пункта навигации «Лоты» в `Layout.tsx`, визуальные замки
    (вместо пустых данных) в `SalesHistoryCharts.tsx`/`LotStatCard.tsx`.
  - Попутно закрыт существующий баг: `get_current_user` не проверял
    `is_approved`/учитывал только `is_active` — теперь 403 для неподтверждённых.
  - **Баг №1 (найден после первого прохода реализации):** `GET
    /monitoring/sales-chart/{id}` и `GET /monitoring/history/{id}` изначально
    не были защищены гейтингом по тарифу вообще (только `/monitoring/item/{id}`
    был замаскирован) — пользователь на `base` видел полную историю продаж за
    все окна. Найдено через skill `systematic-debugging`, фикс — `max_stats_hours()`
    в `tiers.py`, оба эндпоинта возвращают пустой результат при превышении.
  - **Баг №2:** в админке кнопка «Применить» одновременно отправляла выбранный
    тариф И дату из поля — пустое поле даты при нажатии тихо сбрасывало
    существующий срок подписки на «бессрочно» (даже сразу после `+1 мес`).
    Разделено на независимые действия + кнопка «Установить дату» теперь
    неактивна без выбранной даты; явная отдельная кнопка «Бессрочно» для
    намеренной очистки срока.
  - **Баг №3 (UX):** колонка «До» показывала голый `—` для бессрочных
    тарифов — неотличимо от «что-то не так». Заменено на текст «Бессрочно».
  - **Отложено пользователем (не реализовано в этом заходе):** обязательная
    привязка Telegram при регистрации + восстановление пароля через неё —
    см. `docs/NOTES.md`. Остальные фазы роадмапа (статистика админки за
    пределами сделанного, новости, форма обращений, «Радар рынка»,
    FAQ-онбординг + копирайт лендинга под STALZONE) — также не реализованы,
    в очереди.
  - ТЗ — `docs/tasks/subscription-tiers.md`.

- [x] **Установлены Claude Code skills из obra/superpowers ← 2026-06-23** — точечно (файлами в `.claude/skills/`, без плагин-маркетплейса) добавлены 8 скиллов: `test-driven-development`, `systematic-debugging`, `using-git-worktrees`, `verification-before-completion`, `finishing-a-development-branch`, `receiving-code-review`, `dispatching-parallel-agents`, `writing-skills`. `tools:` агентов `backend-dev`/`frontend-dev` дополнен `Skill`. Сознательно не устанавливались `brainstorming`/`writing-plans`/`executing-plans`/`subagent-driven-development` (конкурирующий пайплайн, конфликтует с Блоком 3 CLAUDE.md о подтверждениях) и `requesting-code-review`/`using-superpowers` (избыточны — есть нативные `/code-review`, `/review`, `/security-review`).

- [x] **Security-инцидент: утечка секретов в публичном GitHub-репозитории, устранена ← 2026-06-23** — при подготовке к установке security-guidance плагина Claude Code обнаружено, что в репозитории `github.com/Fers666/stalcraft-trading-assistant` в открытом виде были закоммичены реальные креды: `STALCRAFT_CLIENT_SECRET` и `STALCRAFT_CLIENT_ID` (хардкод в `deploy.sh` и в нескольких permission-записях `.claude/settings.json`), `TELEGRAM_BOT_TOKEN` (хардкод в `deploy.sh`), несколько тестовых паролей пользователей (в `.claude/settings.json`, использовались в debug-командах).
  - Все секреты убраны из текущих файлов (`.claude/settings.json`, `deploy.sh`).
  - `deploy.sh` переработан: `STALCRAFT_CLIENT_ID`, `STALCRAFT_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN` теперь обязательные переменные окружения, проверяются на старте через `: "${VAR:?...}"` — скрипт падает с понятной ошибкой, если переменная не задана, вместо хардкода значений в коде скрипта.
  - Добавлен `.claude/claude-security-guidance.md` — policy-файл с project-specific правилами для будущих security-ревью (секреты, IDOR, rate-limiter, admin-проверки, SQL, JWT, telegram-бот).
  - Вся git-история репозитория переписана через `git-filter-repo` (146 коммитов) — все исторические вхождения секретов заменены на `***REMOVED***`; сделан force-push переписанной истории в `origin/main`.
  - Ротация самих credential'ов (Stalcraft secret, Telegram bot token) — сознательно отложена пользователем (старые значения формально остаются валидными до отдельного решения о ротации).
  - Прод (`161.104.44.231`, `/home/evgen/app`) синхронизирован с переписанной историей: `git fetch && git reset --hard origin/main` (обычный `git pull` не сработал бы — история переписана); пересобраны `backend`+`frontend` (`docker compose -f docker-compose.prod.yml build --no-cache backend frontend && up -d`); миграций не было; сайт подтверждён рабочим (HTTP 200, после хард-рефреша браузера — без него виден стейл JS-бандл из кэша).
  - **Не пересобраны** `worker`, `scheduler`, `telegram_bot` — отдельные образы, не покрываются командой `build backend frontend`; сегодня не критично (изменения не затрагивали их код), но это пробел в инструкции деплоя — см. предостережение в `docs/DEPLOY.md`.

- [x] **Карточка Избранного: редизайн по макету «Магма» (этап 2) ← 2026-06-15** — `LotStatCard.tsx` приведена к новому макету `design/magma-redesign.html` (этап 1 — `design/favorites-page.html` — завершён ранее).
  - Шапка: убраны разнесённые блоки «МЕДИАНА 7Д» (правый верх) и «ПРОДАЖ 7Д» (статус-бар) — единая строка из 3 статов под тегами риска/качества: Медиана 7д / Продаж 7д / **Лучшая прибыль** (новый показатель, `bestProfit = max(...profits.perUnit)` по `profitableLots` — чисто фронтовый расчёт, без новых запросов).
  - Теги риска (7д/30д) — нейтральный стиль (`tokens.bg1` + рамка `tokens.border`) с цветной точкой (`RISK_DOT_COLOR`: success/warning/error) вместо цветных `Chip`; подписи в нижнем регистре («низкий риск» / «умеренный риск» / «высокий риск»).
  - Чип качества — добавлена точка-индикатор цвета `qualityColor(...)`.
  - «обновлено HH:MM» — переехало из статус-бара в `head-right` (под кнопками поиска/удаления), без иконки.
  - «Выгодные лоты»: вместо тоггла «Сейчас/Неделя» в заголовке секции — бейдж «источник: рынок · сейчас/неделя»; новая строка `.qbar` с фильтром качества (если все лоты одной заточки), тогглом «Сейчас/Неделя» (переехал сюда) и подсказкой «прибыль = чистыми (−5% комиссии) − цена лота».
  - Заголовки колонок sell-options в таблице — вторая строка мелким текстом с `estimated_hours_display`.
  - Под таблицей — подсказка «кликните лот → «Варианты продажи» пересчитаются от его цены» (если профитных лотов больше одного).
  - «Варианты продажи» — подпись «Расчёт для лота X ₽» (`baseBuy`/`cheapestBuy` вынесены из IIFE в общие переменные компонента).
  - `sellOptionColor`: `normal` золотой→оранжевый (`#F5B74F`), `premium` `#F5B74F`→ярко-золотой (`#F2C94C`).
  - `PriceChart.tsx`: легенда daily-режима переименована («Диапазон»→«Коридор мин–макс», «Средняя»→«Средняя цена»); для scatter-режима добавлена подпись «N сделок · наведите на точку».
  - `SalesHistoryCharts.tsx` — добавлен заголовок секции «ИСТОРИЯ ПРОДАЖ» + подпись «медиана и коридор мин/макс» (дублирующийся заголовок убран из `MonitoringPage.tsx`).

- [x] **GlobalFeed: лента показывала лоты, по которым бот не присылал уведомление ← 2026-06-15** — `feedStore.loadAllLots` считал «выгодность» по собственной формуле (`buyPerUnit < median_price_7d × 0.95`), не учитывающей trend-guard, риск-маржу и тариф «fast», которые использует `compute_signals_for_entry` (переработка `8b65790` от 14.06). Лот мог попасть в «мёртвую зону» между порогом сигнала (`ref × 0.97 × 0.95`, а при `min_profit_margin_percent > 0` — ещё выше из-за риск-множителя) и порогом ленты (`median × 0.95`) — карточка в ленте показывалась, а Redis `signals:*` для бота лот не содержал → уведомление не приходило.
  - Исправлено: `loadAllLots` теперь берёт `/monitoring/signals/{item_id}` (тот же источник, что бот и `LotStatCard`) — `profitableItemIds`/`feedItems` строятся из `signals.lots`.
  - Убраны параллельные запросы `/monitoring/item` и `/lots` и связанный с ними клиентский расчёт (`stats`, `lotsMap`, `isLotProfitable`, `FEED_COMMISSION`) — единая точка истины для ленты/карточки/бота.

- [x] **Дубликаты в sales_history (24% записей) ← 2026-06-15** — проверка алгоритма сбора истории продаж выявила, что `_collect_history_for_item` дедуплицировал новые продажи только против записей, УЖЕ сохранённых в БД до начала текущего прохода — повторы той же продажи в одном ответе `/history` (API иногда отдаёт одну сделку дважды) проходили мимо проверки и вставлялись дважды в одном `commit()`. Дополнительно дедуп-ключ был `sale_time` (округление до секунды) без цены/количества — две разные продажи в одну секунду схлопывались в одну запись. Итог: 69 924 строки, из них 16 694 дублей (24%, 822 группы) — раздували `sales_volume_24h/7d/30d` и смещали `avg`/`median` цену в статистике и графиках.
  - Дедуп-ключ переписан на `(sale_time ± 1с, total_price, amount)` — устраняет коллизии разных продаж в одну секунду.
  - Новые записи сразу добавляются в индекс текущего прохода — повтор той же продажи в одном ответе `/history` больше не создаёт вторую строку.
  - `INSERT` переведён на `pg_insert(...).on_conflict_do_nothing(index_elements=[item_id, region, sale_time, total_price, amount])` — защита от гонок между параллельными задачами (`worker_concurrency=2`).
  - Миграция `0025`: чистка существующих дублей (приоритет — запись с заполненным `qlt` в `additional_info`, иначе меньший `id`) + уникальный индекс `uq_sales_history_sale (item_id, region, sale_time, total_price, amount)`. После чистки: 69 924 → 54 256 строк, 0 дублей.
  - `collect_all_history` (часовая задача) теперь дедуплицирует watchlist по `(item_id, region)` перед сбором, как `force_refresh_all_history` — было до 3 лишних API-запросов/час на одинаковые предметы разных пользователей.
  - Заодно исправлен мёртвый импорт в `force_refresh_all_history` (`from app.tasks.analyzers import calculate_market_stats` — функции там не существует, задача падала с `ImportError` сразу при запуске, ни разу не отработав).
  - Прогнан `force_refresh_all_history` — пересобрана история и пересчитана `market_statistics` для всех 10 уникальных пар `(item_id, region)`, новых дублей не появилось.

- [x] **Карточка Избранного: автообновление сигналов без перезагрузки страницы ← 2026-06-15** — `LotStatCard.tsx` грузил `/monitoring/item`, `/lots`, `/monitoring/signals` только при монтировании. Бэкенд пересчитывает сигналы в Redis каждые ~20 сек, но фронт их не перезапрашивал — новый выгодный лот появлялся только после F5. Исправлено: данные перезапрашиваются по `setInterval` каждые 30 сек (как у `GlobalFeed`), спиннер показывается только при первой загрузке.

- [x] **Баг: выбор товара в Избранном сбрасывался обратно на сигнал ← 2026-06-15** — найден сразу после автообновления выше. Переход по сигналу из `GlobalFeed` кладёт `location.state.scrollTo`. `MonitoringPage` слушал `[location.state, watchlist]` и при КАЖДОМ обновлении `watchlist` (каждые 5 мин из `GlobalFeed.loadWatchlistAndStats`, или каждые 30 сек при непроверенных позициях) повторно срабатывал на тот же `scrollTo` и перекидывал выбранную карточку обратно на исходный сигнал — даже если пользователь давно переключился на другой товар. Раньше это маскировалось необходимостью вручную F5 (state терялся при перезагрузке); теперь страница живёт дольше и баг стал заметен. Исправлено: эффект привязан к `location.key` (уникален на каждую навигацию) через `handledScrollKeyRef` — срабатывает один раз на переход по сигналу, повторные обновления `watchlist` больше не сбрасывают выбор.

- [x] **Переработан алгоритм поиска выгодных лотов (signals) ← 2026-06-14** — `compute_signals_for_entry` (питает Redis `signals:*`, бот и `/monitoring/signals/{item_id}`) переписан с учётом 12 найденных проблем старой версии.
  - Новый общий модуль `backend/app/services/analytics/pricing.py` (без обращения к БД): `classify_risk` (риск по волатильности 7д), `compute_reference` (расчёт `ref` + trend-guard), `make_sell_options` (fast/normal/premium от `ref`), `evaluate_lot_profit` (профит лота с поправкой на пачку и риск-маржу), `format_hours`. Используется коллектором, ботом и `market_stats`/`monitoring` — убрано дублирование логики sell_options.
  - **Trend-guard**: `ref` берётся из `median_price_7d` (как и раньше), но теперь сравнивается с медианой ТЕКУЩЕГО снэпшота (`median_price_per_unit`, для фильтрованных watchlist-записей — медиана по тому же qlt/ptn из `raw_lots`). Если рынок "просел" (`median_now < median_hist × 0.75`) — `trend="falling"`, `ref` консервативно корректируется вниз (не на полный возврат к старой медиане, но и не на полную текущую просадку).
  - **Профит считается от тира "fast"** (`ref × 0.97`, после комиссии 5%), а не "normal" — реалистичнее для "выгодно купить и быстро продать".
  - **Поправка на размер пачки**: если в `market_statistics.batch_stats` есть ≥3 реальных продаж в том же бакете объёма (`pricing.BATCH_BUCKETS`), ожидаемая цена продажи корректируется пропорционально медианной цене пачки.
  - **Риск-маржа**: требуемая `min_profit_margin_pct` умножается на `RISK_MARGIN_MULT` (`low`×1.0 / `medium`×1.3 / `high`×1.6) в зависимости от волатильности — при высокой волатильности нужен больший запас прибыли.
  - **Ranking**: профитные лоты сортируются по `profit_per_hour` (прибыль / время до продажи на тарифе "fast"), а не по абсолютному профиту.
  - **Staleness-проверка**: если снэпшот старше `STALE_SECONDS=90` сек — сигнал не строится (`None`), чтобы не давать рекомендации по устаревшим данным.
  - Новые параметры/поля: `exclude_less_than_amount` (фильтр по `user_settings`), `total_profitable_amount` и `saturation_ratio` (= профитный объём / (sales_volume_7d / 7)) — индикатор "рынок не успеет переварить столько лотов".
  - `telegram_bot/bot.py`: сообщение теперь показывает `profit_per_hour`, предупреждение при `trend=="falling"` и при `saturation_ratio > 1`.
  - **Demand-signal (`market_statistics.demand_signals`, миграция `0023`)**: `_recent_bulk_signal` сравнивает долю объёма в крупных пачках (≥10 шт) за последние 24ч с базовой долей за ~29 дней; `bulk_spike=True` — информационный флаг резкого роста крупных закупок, отображается в `/monitoring/item/{id}`, ничего не блокирует/усиливает автоматически.
  - **Калибровочный лог `signal_outcomes` (миграция `0024`)**: раз за цикл сбора, для каждой уникальной комбинации `(quality_filter, enchant_filter)` из watchlist по `(item_id, region)`, в таблицу логируются текущие профитные лоты (`ref`, `predicted_sell_price`, `predicted_hours`, `predicted_profit_pct`, `trend`) с `ON CONFLICT DO NOTHING` по `(item_id, region, lot_start_time)`. Разные качества/заточки имеют разные цены — `ref` считается отдельно для каждой комбинации (более специфичные фильтры обрабатываются первыми, чтобы при пересечении лотов в записи остался точный `ref`). Новая задача `evaluate_signal_outcomes` (раз в сутки, `crontab(hour=4, minute=30)`) сверяет необработанные записи с `sales_history` (±15% от `predicted_sell_price`, с учётом qlt/ptn, `qlt/ptn==0` = "0 или не указано") и ставит `outcome ∈ {sold_at_or_above, sold_below, not_sold}` (таймаут 7 дней). Таблица не используется автоматически — данные для будущей калибровки констант (97/100/105%, пороги волатильности и т.п.).
  - Удалён мёртвый код: `app/services/analytics/profitability.py` (не импортировался, риск-классификация перенесена в `pricing.classify_risk`), `app/tasks/notifications.py` (`scan_and_notify` — дублировал `profitable_lots.py`, отключён ещё в 2026-06-07, реальные уведомления шлёт `telegram_bot` polling).
  - Проверено: ресурсная нагрузка от per-combo логирования — ~1мс на доп. запрос к `sales_history` (использует существующий индекс `ix_sales_item_region_time`), без новых вызовов Stalcraft API; не заметно на графиках.

- [x] **Каталог: скрыты непродаваемые предметы (привязка на получение) ← 2026-06-14** — пользователь заметил, что часть предметов в каталоге нельзя выставить на аукцион. Источник: `status.state` (BindState) из `listing.json` (EXBO-Studio/stalcraft-database) — `PERSONAL_ON_GET`/`PERSONAL_DROP_ON_GET` означают привязку в момент получения (квестовые расписки, "личные" артефакты/фрагменты). Подтверждено эмпирически через реальный Stalcraft API: для всех проверенных предметов этих категорий (24 шт., разные подкатегории) `history_total=0` и `lots_total=0` — никогда не появлялись на аукционе ни разу. Остальные статусы (`NONE`/`NON_DROP`/`PERSONAL_ON_USE`) подтверждённо продаются (история от 574 до 1 003 625 сделок). Реализовано: поле `master_items.bind_state` (миграция `0022`), `github_parser.py` сохраняет `status.state` при синке, `GET /items` исключает `bind_state IN ('PERSONAL_ON_GET','PERSONAL_DROP_ON_GET')`. Каталог: 2303 → 2226 видимых предметов (скрыто 77: 26 расписок + 51 артефакт/фрагмент).

- [x] **Объединение "Избранное" и "История продаж" в одну страницу ← 2026-06-14** — карточки старого `MonitoringPage` (520×840px `ItemCard` со статами/выгодными лотами/sell options) убраны безвозвратно. Содержимое `SalesHistoryPage.tsx` (`LotStatCard` + 4 графика истории + сайдбар) перенесено в `MonitoringPage.tsx` под маршрутом `/app/monitoring` — теперь это главная страница портала, заголовок "Избранное". `SalesHistoryPage.tsx` и его импорт/роут в `App.tsx` удалены.
  - `LotStatCard.tsx`: новые опциональные пропсы `onViewLots`/`onDelete` — кнопки в шапке карточки. "Все лоты" (иконка поиска) → переход на `/app/lots` с параметрами товара (item_id/region/quality_filter/enchant_filter и т.д.). "Удалить из Избранного" (иконка корзины) → диалог подтверждения, `DELETE /watchlist/{id}` + `removeEntry` в `feedStore`.
  - Клик по сигналу в `GlobalFeed` (`navigate('/app/monitoring', { state: { scrollTo: id } })`) выбирает соответствующий товар в сайдбаре нового `MonitoringPage` — два `useEffect`: начальный выбор по `scrollTo`/первому элементу списка, и переключение выбора при повторном клике на сигнал, когда страница уже открыта.
  - Сайдбар "Избранное": рекомендованные (выгодные, `profitableItemIds`) товары теперь поднимаются в начало списка (стабильная сортировка, остальные — в прежнем порядке); стартовый выбор товара при загрузке страницы берётся из этого отсортированного списка.
  - *Фикс: фильтры качества/заточки сбрасывались на `/app/lots` после перехода по "Все лоты"* — `LotsPage.tsx` уже умел читать `quality_filter`/`enchant_filter` из `location.state` (через `pendingQualityRef`/`pendingEnchantRef`), но `React.StrictMode` дважды вызывал mount-эффект → `fetchLots` срабатывал два раза → второй `setResult` находил уже очищенные ref'ы и сбрасывал фильтры в `'all'`. Исправлено: `navStateAppliedRef` гарантирует, что обработка `location.state` и первый `fetchLots` выполняются один раз.

- [x] **Три бага из-за `worker_concurrency: 1 → 2` ← 2026-06-11** — переход на 2 воркера (см. фикс лага ниже) вскрыл скрытые проблемы с Celery-кэшированием соединений между задачами (каждая задача = новый `asyncio.new_event_loop()`, кэшированное соединение из прошлой задачи становится невалидным):
  1. *Rate limiter возвращал "attempt to compare nil with number"* — `acquire(cost=...)` передавал `cost` как `IntEnum` (`TokenCost.LOTS` и т.п.), redis-py кодировал его через `repr()` → Lua получал nil вместо числа, тихо падал в in-memory fallback (с `-c 2` это давало 2 независимых бакета по 400/мин = фактически 800/мин). Исправлено: `int(cost)` перед `r.eval()` (`rate_limiter.py`). Проверено на проде — `tokens` в Redis (`stalcraft:rate_limit`) теперь реальные float (398, 390.42), корректно убывают/пополняются.
  2. *Кэш лотов никогда не наполнялся ("Cache write error: Event loop is closed")* — `ApiCache` кэшировал `self._redis` соединение между вызовами; во второй Celery-задаче event loop уже закрыт. Исправлено: `api_cache.py` создаёт свежее соединение `aioredis.from_url(...)` на каждый вызов с `try/finally: await r.aclose()`. Проверено — 14 ключей `stalcraft:cache:v2:RU:*:lots` наполняются, предупреждения исчезли.
  3. *Каскад `NumericValueOutOfRangeError` в часовой `calculate_all_market_stats`* — глитч-цена в `sales_history` раздувала `price_volatility_7d`/`30d` или `weekend_bonus_percent` (`Numeric(5,2)`, макс ±999.99) за пределы диапазона. Ошибка при flush одного предмета НЕ откатывала сессию → все следующие предметы в этом запуске падали с "Session has been rolled back". Исправлено: `db.rollback()` в except-блоке (`analyzers.py`) + `_clamp_pct()` ограничивает три поля диапазоном ±999.99 (`market_stats.py`). Проверено локально — все 15 пар watchlist (включая ранее падавший `wglp/RU`) посчитаны без ошибок.

- [x] **Лаг мониторинга Избранного: 15 мин → ~1 мин ← 2026-06-11** — причина: Celery worker запускался с `-c 1` (concurrency=1), а часовые задачи `collect_all_history`/`calculate_all_market_stats` (~150 уникальных предметов, минуты `:00`/`:05`) полностью занимали единственный воркер на несколько минут — всё это время `collect_all_active_lots` (каждые 20с) не выполнялся и копился в очереди. Лот, появившийся в API ровно в момент старта часовых задач, попадал на сайт/в Telegram только после их завершения (~15 мин). Исправлено:
  - `worker_concurrency: 1 → 2` (`celery_app.py`, флаг `-c 2` в `docker-compose.yml`/`docker-compose.prod.yml`) — часовые задачи больше не блокируют мониторинг.
  - `collectors.py`: `TARGET_CYCLE_SEC 120 → 60`, `MAX_LOTS_PER_RUN 35 → 50`, `LOTS_REQUEST_DELAY 0.5 → 0.2` — при 150 предметах цикл обновления ~60с (было ~120с), при 200 — ~80с. Токены: батч 50×2/20с = 300/мин = 75% от лимита 400/мин (было 150/мин = 37.5%), запас 25% хватает на часовой всплеск `collect_all_history`.

- [x] **"Лента" (feed_watchlist) убрана повторно ← 2026-06-11** — попытка из `97abe4d` (research-watchlist с фоновым адаптивным сбором `feed_collector.py`, бюджет = остаток rate-limit после мониторинга) свёрнута. Удалены: модель `FeedWatchlist`, эндпоинты `/feed/*` (`feed.py`), `feed_stats.py`, `feed_collector.py` (+ запись из celery beat/include); таблица `feed_watchlist` дропнута миграцией `e8a3d1f5c920`. `FeedPage.tsx` снова стал заглушкой "в разработке" — нав-пункт «Лента» и маршрут `/app/feed` сохранены (как после первой попытки, см. `0021_drop_feed_tables` ниже).

- [x] **"Лента" переработана в "Лента возможностей" — прогноз "что добавить в Избранное сейчас" ← 2026-06-07** — раздел `/app/feed` показывает предметы всего аукциона (вне Избранного), текущая цена которых заметно ниже средней за 24ч — то есть прямо сейчас выгодный момент для закупки.
  - *Метрика (правка по фидбеку пользователя)*: первая версия ранжировала по историческому минимуму `(avg − min) / avg` — показывала "где была самая большая просадка за сутки", но не отвечала на вопрос "что выгодно добавить в Избранное прямо сейчас" (просадка могла случиться 20ч назад, цена уже отскочить — поздно). Переделано на `opportunity_pct = (avg_price_24h − current_price) / avg_price_24h × 100` — ранжирование по текущей цене относительно средней, это и есть actionable-сигнал. Добавлен фильтр неликвида (`liquid_lot_count >= MIN_LIQUID_LOTS_FOR_FEED = 2`) — иначе в топ попадали бы редкие предметы, которые потом некому перепродать.
  - *БД*: `global_item_scan` переведён из режима "снэпшот-перезапись" (один ряд на `item_id+region`, `on_conflict_do_update`) в режим "история" (новая строка на каждый скан). Миграция `0018`: убран уникальный индекс `(item_id, region)`, добавлен составной `(item_id, region, scanned_at)` для быстрой выборки окна 24ч. `prev_best_price`/`price_change_pct` теперь считаются по `ORDER BY scanned_at DESC LIMIT 1`.
  - *Объём*: ~17 280 строк/день, за 120 дней ≈ 2.1 млн строк (несколько сотен МБ с индексами) — не критично. Чистка добавлена в `cleanup.delete_old_data` вместе с остальными снэпшотами.
  - *API*: `GET /monitoring/feed` агрегирует историю за 24ч (`MIN`/`AVG` по `item_id`, `HAVING count >= 2`), джойнит с последним сканом каждого предмета (`DISTINCT ON (item_id) ORDER BY scanned_at DESC` — текущая цена и ликвидность сейчас), сортирует по `opportunity_pct` desc, отдаёт топ-N с деталями: `current_price`, `min_price_24h`, `avg_price_24h`, `min_price_at`/`hours_since_min` (исторический минимум — доп. контекст "насколько вообще качает товар").
  - *Frontend*: `FeedPage.tsx` — карточки показывают "лучшую цену за 24ч" с пометкой "N ч назад", текущую/среднюю цену и чип `−X% от средней`. Заголовок страницы — "Лента возможностей" (название "Лента" в нав-пункте сохранено по просьбе пользователя), иконка `TrendingUpIcon` → `LocalOfferIcon` (`Layout.tsx`, `Navbar.tsx`, `LandingPage.tsx`, `FeedPage.tsx`).
  - **Доработка по фидбеку пользователя ← 2026-06-07 (тот же день)**:
    - *Качество/заточка — отдельные единицы ← правка 2026-06-07 (после доп. фидбека)*: первая версия считала `best_price`/`avg_price` ТОЛЬКО по лотам базового варианта (без качества/заточки), игнорируя остальные — пользователь уточнил, что хочет видеть КАЖДУЮ заточку (`+0`, `+5`, `+10`...) как отдельный товар со своей карточкой в ленте, а не игнорировать. Переделано: `global_scanner._scan_single_item` группирует лоты по варианту `(additional.qlt, additional.ptn)` и пишет ОТДЕЛЬНУЮ строку скана на каждый встреченный вариант (`quality`/`enchant` — новые колонки `global_item_scan`, миграция `0020`, индекс `(item_id, region, quality, enchant, scanned_at)`). `prev_best_price`/`price_change_pct` теперь считаются по истории того же варианта. Объём строк вырос (несколько вариантов на предмет вместо одного), но без доп. запросов к API — группировка в памяти по уже полученным лотам.
    - *Выгодность с учётом комиссии*: метрика `opportunity_pct` (сырая % скидка от средней) заменена на `est_profit_pct`/`est_profit_per_unit` — реальная прибыль "на руки" при покупке сейчас и продаже позже по средней цене 24ч за вычетом 5% комиссии аукциона: `est_profit_pct = (avg_price_24h × 0.95 − current_price) / current_price × 100`. Фильтр `discount_expr > 0` заменён на `profit_per_unit_expr > 0` — в ленту попадают только сделки, прибыльные именно после комиссии. Сортировка — по `est_profit_pct` desc (это и есть "выгодность", а не просто скидка).
    - *Цена за 1 шт.*: уточнили у пользователя — текущая нормализация `price // amount` (цена за штуку, а не за лот) уже корректна, доп. логика сравнения "пачка vs поштучно" не нужна; добавили подпись "за 1 шт." на карточке для ясности.
    - *Скрытие из ленты*: новая таблица `user_feed_exclusion` (миграция `0019`, per-user, уникальность по `user_id+item_id+region`) + эндпоинты `POST/DELETE /monitoring/feed/exclude`, `GET /monitoring/feed/excluded`. `/feed` исключает товары из `user_feed_exclusion` через `NOT IN` подзапрос. На фронте — кнопка "Скрыть" на карточке и диалог "Скрытые из ленты" со списком и кнопкой "Вернуть" (`FeedPage.tsx`).
    - *Кнопки на карточке*: "Перейти в лоты" (навигация на `/app/lots`) и "В Избранное" (`POST /watchlist/`) — оба передают `quality_filter`/`enchant_filter` КОНКРЕТНОГО варианта карточки (`item.quality`/`item.enchant`, не захардкоженный `0`), чтобы попасть именно в ту заточку, для которой посчитана выгодность.
    - *API `/feed`*: агрегация и джойн с последним сканом теперь по составному ключу `(item_id, quality, enchant)` — каждый вариант ранжируется и показывается отдельно. Ответ дополнен полями `quality`, `enchant`, `variant_label` (человекочитаемое "Легендарный +12" / "+5" / `null` для базового варианта — `_variant_label()` в `monitoring.py`). На фронте — чип с `variant_label` рядом с названием товара (`FeedPage.tsx`).
    - *Баг найден на локалхосте при тестировании*: старые строки `global_item_scan` (до миграции `0020`) хранят `quality`/`enchant = NULL`. JOIN по `==` даёт `NULL = NULL → NULL` (не true) — вся история без вариантов выпадала из ленты, выдача становилась пустой/урезанной. Исправлено через `COALESCE(quality, 0)`/`COALESCE(enchant, 0)` (он же `qlt_expr`/`ptn_expr`) применительно ко всем местам — `GROUP BY`, `DISTINCT ON`, условие `JOIN` — старые записи приравниваются к базовому варианту `(0, 0)`.
    - *Цена — только реальный выкуп*: `buyout_per_unit()` в `global_scanner.py` больше не подставляет `startPrice`, если у лота нет `buyoutPrice` — такие лоты только аукционные (нельзя купить мгновенно по стартовой цене ставки), их учёт искажал бы "цену сейчас".
    - *Глитч-лоты ломали est_profit_pct абсурдными значениями (баг найден локально, юзер увидел карточки "+1671089.3%" и "+996398.9%")*: причина — `avg_price = mean(prices)` НЕ устойчив к редким лотам-глитчам/троллингу с ценой "1" или "999999999" среди обычных ~10000–50000: один такой лот утраивает/удесятеряет среднее (напр. у "Стандартные инструменты" при типичной цене ~11500 средняя улетела до 202 млн, у "Кисель" — с ~7000 до 73 млн). Грейпинг по варианту при этом был и остаётся корректным (для "Кисель" отдельные строки на каждое качество подтверждены в БД) — проблема именно в среднем арифметическом ВНУТРИ варианта. Фикс: `avg_price` теперь = МЕДИАНА цен варианта (устойчива к выбросам, пока их < половины лотов), а `best_price`/`price_spread` считаются по `sane_prices` — подмножеству в диапазоне ×0.1…×10 от медианы (отсекает сами лоты-глитчи, которые иначе становились бы "лучшей ценой"). Доп. подстраховка — `MAX_SANE_PROFIT_PCT=1000` в `/feed`, отсекает уже накопленные (старые) аномальные записи, пока они не выйдут из 24-часового окна.
    - *Пагинация карточек ← правка 2026-06-07*: фронт грузит до `FEED_LIMIT=90` вариантов разом и листает их клиентским `Pagination` по `PAGE_SIZE=12` карточек — без доп. запросов к API на каждую страницу (`FeedPage.tsx`).
  - **Фича удалена ← 2026-06-07 (тот же день, после серии патчей выше)**: пользователь указал на фундаментальный изъян метрики — `avg_price_24h` это средняя ВЫСТАВЛЕННЫХ на аукционе цен, а не цена реальной продажи ("средняя — не значит, что за неё можно продать", пример карточки Steyr AUG A3 с нереалистичной % выгоды). Все патчи выше (медиана, фильтр глитчей, `MAX_SANE_PROFIT_PCT`) лечили симптомы, а не корень: само определение "выгодной покупки" было методологически некорректным без данных о реальных продажах (`SalesHistory` — per-user, для глобального рынка не годится). Решение — не патчить дальше, а убрать раздел целиком и переосмыслить подход. Удалено:
    - `backend/app/tasks/global_scanner.py` (вся задача скана) + запись `app.tasks.global_scanner` из `celery_app.include`
    - эндпоинты `/monitoring/feed`, `/monitoring/feed/exclude` (POST/DELETE), `/monitoring/feed/excluded` и вспомогательные классы/константы (`OpportunityItem`, `ExcludedItem`, `_variant_label`, `MIN_LIQUID_LOTS_FOR_FEED`, `MAX_SANE_PROFIT_PCT`, `FEED_COMMISSION`) из `monitoring.py`
    - модели `GlobalItemScan`, `UserFeedExclusion` из `models.py`
    - таблицы `global_item_scan` (~млн строк истории сканов) и `user_feed_exclusion` — дропнуты миграцией `0021_drop_feed_tables` (без даунгрейда — данные не сохраняются, фича не возвращается в прежнем виде)
    - описание фичи на лендинге (`LandingPage.tsx`) заменено на "раздел в разработке"
  - `FeedPage.tsx` оставлена как лёгкая заглушка "Лента возможностей в разработке" — нав-пункт «Лента» и маршрут `/app/feed` сохранены, раздел вернётся позже на честной метрике (вероятно — на основе `min_price_24h` или реальных продаж, а не средней выставленных цен).

- [x] **Динамический batch коллектора лотов ← 2026-06-07** — при 200+ уникальных предметах фиксированный `LOTS_PER_RUN=5` давал цикл ~13 мин, сигналы (TTL 150с) постоянно протухали. Решение: batch вычисляется динамически `ceil(due / (TARGET_CYCLE_SEC / LOTS_REFRESH_INTERVAL))`, min=5, max=35. При 200 предметах → batch=34, цикл ~2 мин. `LOTS_REQUEST_DELAY` снижен 1→0.5с (35 предметов × 0.5с = 17.5с < 20с расписания). `SIGNALS_TTL` поднят 150→300с. Токены: ~65/мин = 16% от лимита 400. Формула масштабирования: безопасен до ~800 уникальных предметов (100% rate limit).

- [x] **Rate limit Stalcraft API: полная экспериментальная проверка ← 2026-06-07** — Документация была НЕВЕРНА (100 токенов). Реальный лимит: **400 запросов/минута** (период ровно 60 сек, verified experimentally). Стоимость: /emission=1, /lots=2, /history=2. Текущее использование: 54.5 запроса/мин = 13.6% от лимита. Запас 86.4%. ПОЛНОСТЬЮ БЕЗОПАСНО. Детальный анализ в `RATE_LIMIT_VERIFIED.md` (реальные результаты тестов). Обновлены: `rate_limiter.py` (CAPACITY 100→400), комментарии в коде.

- [x] **Торможение вачлиста при 15+ товарах (история продаж)** — два независимых источника тормозов:
  1. *N+1 запросов при монтировании страницы*: компонент `PriceChart` рендерился для всех карточек сразу и немедленно стрелял запросом к `/monitoring/sales-chart/{id}`. С 15 карточками — 15 одновременных тяжёлых запросов к БД (GROUP BY день за 7 дней или выборка отдельных продаж). При переключении периода (24ч / 48ч / 7д / 30д) также срабатывали все видимые карточки. Исправлено: `IntersectionObserver` в `PriceChart.tsx` — запрос откладывается до момента, когда карточка попадает в зону видимости (+100px опережение). Карточки ниже экрана не грузят данные.
  2. *Неподходящий индекс на `sales_history`*: запрос в `/monitoring/sales-chart` фильтрует по `(item_id, region, sale_time)`, а существующий индекс `ix_sales_item_time` начинался с `user_id` (которого в запросе нет) — PostgreSQL не мог его использовать и делал full scan. Добавлен индекс `ix_sales_item_region_time (item_id, region, sale_time)` (миграция 0016), точно совпадающий с условиями запроса.

- [x] **GlobalFeed: карточки не отображались (лента выгодных лотов)** — два независимых бага:
  1. *Race condition*: Layout резервировал место по `profitableItemIds`, а GlobalFeed вычислял `feedItems` локально → рассинхронизация → пустой тёмный бар. Исправлено: `feedItems` вычисляется атомарно в сторе (`feedStore.ts`) в одном `set()` вместе с `profitableItemIds`.
  2. *MUI sx ловушка*: разделитель `<Box sx={{ width: 1 ... }}>` — в MUI sx `width: 1` = `width: 100%` (не 1px!). Разделитель занимал весь контейнер → карточкам не оставалось места. Исправлено на `width: '1px'`.
  Дополнительно: контейнер карточек требует явного `height: ${FEED_HEIGHT}px` — без него браузер вычисляет высоту как 0 для flex-item с `overflow: auto` внутри `align-items: center` родителя.

- [x] **JWT refresh token flow** — access_token протухал через 60 минут и пользователя выбрасывало на логин. Добавлен endpoint `POST /auth/refresh` (принимает refresh_token, возвращает новую пару). Фронт сохраняет `refresh_token` в localStorage при логине; axios interceptor при 401 сначала пробует обновить токен (с очередью параллельных запросов), и только при неудаче редиректит на `/login`. Access token = 60 мин, refresh token = 30 дней.

- [x] **Статистика артефактов по quality+enchant (реальные продажи)** — Stalcraft API `/history` не возвращает `qlt`/`ptn` ни с каким параметром *(это утверждение позже опровергнуто и исправлено — см. запись «Повысить покрытие qlt/ptn в sales_history ← 2026-06-29» выше: API возвращает qlt/ptn в поле `additional`, код их просто не читал)*. Единственный источник quality/enchant для проданных лотов — матчинг `SalesHistory` с `CollectedData.raw_lots` через `lot.startTime == additional_info['lot_start']`. Функция `find_lot_info` расширена: при матче из лота извлекаются `qlt` и `ptn` и сохраняются в `additional_info` вместе с `lot_start`. Ретроактивный SQL-патч (UPDATE 143 записей) через JOIN по `startTime`. Окно матчинга расширено с 10 до 200 снэпшотов (~1.7 ч). Snapshot-fallback (цены выставленных лотов) убран из `/monitoring/item` и `/monitoring/sales-chart` — все расчёты и предложения строятся исключительно на реальных продажах; при недостатке данных показывается честный "Нет данных". Добавлена кнопка "Пересобрать историю" в AdminPage → `POST /admin/tasks/force-refresh-history`.

- [x] **Баг: ложные "выгодные лоты" при падении рынка** — `sell_options` хранились в `market_statistics` (JSONB) и пересчитывались раз в час. При резком падении рынка (пример: m02wr) `normal_price` оставался старым (высоким), лоты по новой (низкой) цене показывались как выгодные, хотя продать дороже уже невозможно. Исправление: `GET /monitoring/item/{id}` теперь при каждом запросе берёт последний снапшот (`CollectedData`) и пересчитывает `sell_options` "на лету" через `_make_sell_options(current_min_liquid, sales_volume_7d)`. Задержка реакции сокращена с ~1 часа до ~5 минут (интервал коллектора снапшотов). Сохранённые в БД `sell_options` остаются как fallback если снапшота нет.

- [x] **Каталог: фильтры по категориям + пагинация** — добавлен сайдбар 230px с деревом категорий: Оружие (7 подгрупп), Броня (3), Артефакты (4), Обвесы (7), + 8 одиночных категорий. Предметы загружаются автоматически при смене категории (без ввода поискового запроса). Поиск и категория комбинируются. Пагинация 50 предметов/стр с MUI Pagination. Исправлен баг бэкенда: `category ILIKE 'weapon%'` совпадал с `weapon_modules` — заменено на `category = 'weapon' OR category ILIKE 'weapon/%'`. Добавлены переводы в `i18n.ts`: `optical_sights`, `foregrip`, `underbarrel`, `stock`, `special`.

- [x] **Карточка Избранного: волатильность за 30 дней** — добавлено поле `price_volatility_30d` в модель `MarketStatistics` (миграция 0014), сервис `market_stats.py` вычисляет его по всем `sales_30d`. API `MonitoringItemResponse` возвращает оба поля; для фильтрованных запросов (quality/enchant) 30д пересчитывается из отфильтрованных продаж. В карточке — два компактных чипа `7д · С/У/В` и `30д · С/У/В` (С=Стабильный, У=Умеренный, В=Высокий риск), расшифровка и числовое значение % в тултипе.
- [x] **Баг: волатильность null → "Стабильный"** — `volatilityRisk(null)` возвращал `'low'`, из-за чего товары без достаточного числа продаж показывали "Стабильный" вместо отсутствия данных. Исправлено: `null` → chip `7д · ?` / `30д · ?` с тултипом "Мало продаж — волатильность не рассчитана". Порог расчёта поднят с 2 до 5 продаж (`MIN_SALES_FOR_VOLATILITY = 5`), отделён от `MIN_SALES_FOR_STATS = 3`.
- [x] **Размазывание нагрузки watchlist-коллектора** — `collect_all_active_lots` переведён на запуск каждую минуту с фильтрацией по `last_successful_check < now - 5 мин`. Батч ≤ 10 пар/мин, пауза 2 сек между запросами. Предметы обновляются по своему таймеру, а не все разом по crontab.
- [x] **Ускорение глобального сканера** — `run_global_feed_batch` запускается каждую минуту (было: раз в час), 12 предметов/запуск с паузой 3 сек. Полный цикл ~3 часа (было ~24 часа).

- [x] **Redis кэш: версионирование ключей** — старые данные в Redis (без полей `ptn`/`qlt`) отображались в UI после изменений бэкенда. Добавлена константа `CACHE_VERSION = "v2"` в `api_cache.py`; ключи теперь вида `stalcraft:cache:v2:{region}:{item_id}:lots`. При изменении структуры кэша — достаточно сменить версию, старые ключи умрут по TTL (5 мин для лотов, 60 мин для истории).

- [x] **Качество артефактов: "Не точёный" (ptn=0) и уровни 1–15** — В Stalcraft артефакты имеют систему точности: `ptn=0` / отсутствие `ptn` = "Не точёный", `ptn=1–15` = уровень качества. Ранее `ptn=0` скрывался как null (только уровни 1–15 отображались). Исправлено:
  - *Backend*: `lots.py` — для артефактов возвращает `enchant_level=0` вместо `null` при `ptn=0`/отсутствии `ptn`; неартефакты без изменений.
  - *Backend*: `monitoring.py` — `_build_sales_filter` при `enchant_filter=0` ищет `ptn IS NULL OR ptn='0'` (старые записи без ptn + новые с ptn=0).
  - *Backend*: `collectors.py` — критичный баг: `ptn=0` пропускался как falsy (`if lot_add["ptn"]`), из-за чего "не точёные" продажи не сохранялись в `sales_history`. Исправлено на `is not None`.
  - *Frontend*: `LotsPage` — чип "Не точёный" в колонке Заточка, "Не точёный (N)" в фильтре, тултип кнопки «В Избранное».
  - *Frontend*: `MonitoringPage` — бейдж "Не точёный" рядом с названием карточки, правильный `hasQuality` (`!= null` вместо falsy), отображение в списке выгодных лотов.
  - *Frontend*: `CatalogPage` — опция "Не точёный" добавлена в диалог "Добавить в Избранное" перед +1..+15.
  - Все расчёты (волатильность, медиана, sell_options, выгодные лоты) корректно фильтруются для `enchant_filter=0`.
- [x] **Лоты: кнопка «В Избранное» с параметрами лота** — в каждой строке таблицы лотов добавлена кнопка `BookmarkAdd`. При нажатии вызывает `POST /watchlist/` с `quality_filter=lot.quality_value` и `enchant_filter=lot.enchant_level`. Кнопка переходит в состояние `BookmarkAdded` после успеха или 409. Snackbar-уведомление на 2.5 сек. Бэкенд: добавлено поле `quality_value` (raw qlt 0-5, только для артефактов) в `LotItem`.
- [x] **Лоты: заточка и качество в API-ответе (`additional=true`)** — Stalcraft API не возвращал `additional.ptn`/`additional.qlt` для лотов без параметра `additional=true`. Python `True` → httpx отправлял `"True"` (заглавная), API игнорировал. Исправлено на строку `"true"` в `client.py`. Теперь `enchant_level` и `quality_name` корректно заполняются для всех предметов с заточкой/качеством.
- [x] **Navbar: кнопка «Админ» перенесена в навигацию** — вместо иконки в правом углу — полноценная кнопка в основном меню (только для `is_admin`), единый стиль с остальными nav-пунктами.
- [x] **Баг: `_build_sales_filter` — неверное поле заточки** — `monitoring.py` использовал `additional_info->>'upgrade_bonus'` (умноженный на 100) вместо корректного `additional_info->>'ptn'`. Поле `ptn` — прямое целое 0–15 (Stalcraft API). Фильтр заточки в статистике и графике продаж не работал. Исправлено в `monitoring.py`. Лишние импорты `cast`, `Numeric` удалены.
- [x] **Баг: `MIN_BUYOUTS_FOR_TIME_MODEL` не определена** — константа использовалась в `_estimate_hours` (`market_stats.py`) но нигде не была объявлена → `NameError` при расчёте прогноза времени продажи. Добавлено `MIN_BUYOUTS_FOR_TIME_MODEL = 5` рядом с остальными константами.
- [x] **Дефолтный регион watchlist** — `WatchlistCreate.region` был `"EU"`, хотя фронтенд и UI используют `"RU"`. Исправлено на `"RU"` (значение всё равно приходит с фронта явно, но дефолт логичнее).

- [x] **Каталог: история поиска** — последние 10 текстовых запросов хранятся в `localStorage` (`catalog_search_history`). Отображаются чипсами с иконкой поиска под строкой ввода, пока нет результатов. Клик — заполняет поле и запускает поиск. Повторный запрос поднимается в начало списка.
- [x] **Каталог: кнопка «Watchlist» переименована в «Избранное»** — в таблице результатов и в тексте уведомления об успехе.
- [x] **Карточка Избранного: фильтрация лотов/статистики/истории по quality+enchant** — три блока теперь учитывают `quality_filter`/`enchant_filter` записи в watchlist:
  - *Выгодные лоты* — `profitableLots` фильтрует по `quality_name` и `enchant_level` на фронте.
  - *Варианты продажи* — `/monitoring/item/{id}` с `quality_filter`/`enchant_filter` вычисляет `median_price_7d`/`sales_volume_7d`/`sell_options` на лету из отфильтрованных `sales_history` (остальные поля из глобальной `market_statistics`).
  - *История продаж* — `/monitoring/sales-chart/{id}` фильтрует `sales_history` по `additional_info->>'qlt'` и `additional_info->>'ptn'` в SQL.
  - Исправлена коллизия stats-ключей на фронте: ключ сменён с `entry.item_id` на `entry.id`, иначе две карточки одного товара с разными фильтрами перезаписывали друг друга.
- [x] **MonitoringPage: заменить нативный `confirm()` на MUI Dialog** — при удалении карточки из Избранного открывается стилизованный диалог (название, качество, зачарование, регион) с кнопками «Отмена» / «Удалить». Стиль совпадает с CatalogPage.
- [x] **Watchlist: quality_filter + enchant_filter** — поля добавлены в `user_watchlist` (миграция 0012). При добавлении в каталоге открывается диалог с выбором региона, качества (qlt 0–5) и заточки (1–15). Фильтры передаются в `/lots/{item_id}` как query-params. В карточке: заточка справа от названия, качество под иконкой.
- [x] **Каталог: синхронизация master_items** — все 2236 предметов загружены из GitHub с полем `color` (миграция 0011).
- [x] **Таблица лотов: колонки quality + enchant** — в блоке "Выгодные лоты" добавлена колонка КАЧЕСТВО если хоть один лот имеет quality/enchant данные.
- [x] **Карточка Избранного: фиксированный размер** — 520×900px, flex-wrap layout вместо Grid2; overflow: hidden + тонкий scrollbar внутри CardContent.
- [x] **Карточка Избранного: таблица «Выгодные лоты»** — колонки БЫСТРО/НОРМАЛЬНО/ВЫГОДНО теперь фиксированные 86px (было `auto`); заголовки подписаны цветом варианта. Фикс плавания: отдельные гриды строк с `auto`-колонками не синхронизировали ширину друг с другом.
- [x] **403 при загрузке страницы** — `HTTPBearer(auto_error=False)` + явный 401 когда заголовок авторизации отсутствует.
