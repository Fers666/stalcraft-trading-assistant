# ТЗ: Перенос Telegram-рассылки уведомлений о выбросе из Celery worker в telegram_bot

## Контекст

Уведомления о старте/конце выброса не доходят до пользователей, хотя уведомления о выгодных лотах работают. Диагностика (подтверждена): детекция выброса в `collect_emission` работает корректно (опрос каждые 2 мин, задержка ≤90 сек, события пишутся в `emission_events`), но рассылку worker делает сам через `send_telegram_message` — одноразовый `Bot(token)` на каждое сообщение, и эти отправки падают (Timed out / ConnectError). При этом `event.notified = True` ставится безусловно (collectors.py:873) даже при полном провале рассылки, т.к. `_emission_broadcast` глотает исключения per-chat_id.

Решение (согласовано с пользователем): worker только фиксирует события; рассылает telegram_bot — сервис с живым PTB `Application` и работающим `_notifier_loop` (каждые 15 сек), который уже успешно шлёт уведомления о лотах.

## Затронутые файлы

- `backend/app/tasks/collectors.py` — убрать рассылку из `_collect_emission_async`, удалить `_emission_broadcast`
- `backend/app/models/models.py` — модель `EmissionEvent`: новое поле `end_notified`
- `backend/alembic/versions/0033_emission_end_notified.py` — новая миграция
- `telegram_bot/bot.py` — новая функция `notify_emission_events`, вызов в `_notifier_loop`
- `backend/app/services/telegram_sender.py` — НЕ трогать (см. «Что остаётся»)

## Архитектурное решение: как бот узнаёт о конце выброса

**Выбрано: поле `end_notified BOOLEAN NOT NULL DEFAULT FALSE` в `emission_events` + polling из бота.**

Обоснование:
- Бот уже опрашивает состояние каждые 15 сек (`_notifier_loop`), добавление одного лёгкого SELECT к крошечной таблице (несколько строк в день) — нулевая стоимость. Отдельный индекс не нужен.
- БД-флаг переживает рестарты бота/Redis и даёт естественную дедупликацию (флаг ставится только после успешной отправки). Альтернатива — сигнал через Redis (pub/sub или ключ) — менее надёжна (потеря при рестарте, TTL), добавляет второй механизм состояния при том, что флаг `notified` для старта всё равно живёт в БД. Отклонено ради симметрии и простоты.
- Семантика: `notified` — «уведомление о старте отправлено», `end_notified` — «уведомление о завершении отправлено».

## Решение по кругу получателей

Текущие критерии в `_emission_broadcast` (collectors.py:926-931): `telegram_chat_id IS NOT NULL`, `is_active`, `is_approved`.
Критерии в `notify_profitable_lots` (bot.py:153-167): `telegram_chat_id`, `is_active`, + `UserSettings.notify_telegram` (или настроек нет), + tier-гейт `is_admin or get_tier_limits(user).telegram_notifications`.

**Выбрано для выброса:** `telegram_chat_id IS NOT NULL` + `is_active` + `is_approved` + **уважать `UserSettings.notify_telegram`** (нет строки настроек → считаем True). **Tier-гейт НЕ применять.**

Обоснование:
- `notify_telegram` — явный пользовательский opt-out от Telegram-уведомлений; игнорировать его для любого типа уведомлений нельзя.
- Tier-гейт (`telegram_notifications=False` у тира `base`) ограничивает премиум-фичу «сигналы по выгодным лотам». Выброс — глобальное игровое событие, исторически рассылалось всем без тир-ограничений; сохраняем прежний охват, чтобы миграция логики не сузила аудиторию незаметно. Если позже решим монетизировать — отдельная задача.
- `is_approved` сохраняем (был в исходных критериях).

## Изменения по слоям

### Backend — модель и миграция

**`backend/app/models/models.py`** (класс `EmissionEvent`, ~строка 391) — добавить после `notified`:

```python
end_notified = Column(Boolean, nullable=False, default=False)  # Telegram о завершении отправлен
```

**`backend/alembic/versions/0033_emission_end_notified.py`** (down_revision = "0032" — проверено, 0032 актуальная голова):

- `upgrade()`:
  - `op.add_column("emission_events", sa.Column("end_notified", sa.Boolean(), nullable=False, server_default=sa.false()))`
  - Backfill, чтобы бот после деплоя не разослал уведомления по всей истории: `op.execute("UPDATE emission_events SET end_notified = TRUE")` (все существующие строки считаем отработанными; свежесть новых защищена отсечкой 15 мин, см. ниже).
- `downgrade()`: `op.drop_column("emission_events", "end_notified")`.

### Backend — worker (`backend/app/tasks/collectors.py`)

`_collect_emission_async` больше НЕ шлёт Telegram:

1. Убрать импорт `send_telegram_message` (строка 848) и неиспользуемый после этого импорт `User` (строка 846), если он больше нигде в функции не нужен.
2. Ветка «начало выброса» (строки 861-877): оставить создание `EmissionEvent(..., notified=False)` + commit + запись fingerprint в Redis. **Удалить** вызов `_emission_broadcast` и строку `event.notified = True` (строки 872-873). `end_notified` для нового события — False по default модели.
3. Ветка «первый запуск / seed» (879-898): при создании seed-события дополнительно ставить `end_notified=True` (наряду с существующим `notified=True`) — историческое событие не должно рассылаться.
4. Ветка «конец выброса» (900-916): оставить `active.ended_at = datetime.now(...)` + commit + удаление Redis-ключа. **Удалить** вызов `_emission_broadcast` (строка 913). `end_notified` у события уже False — бот подхватит.
5. **Удалить целиком** функцию `_emission_broadcast` (строки 921-955) — других использований нет (проверено grep по всему репо).
6. Обновить docstring задачи `collect_emission` (строка 836): рассылку выполняет telegram_bot.

### telegram_bot (`telegram_bot/bot.py`)

1. Импорты: `from datetime import timedelta` (datetime/timezone уже есть), `EmissionEvent` добавить в импорт из `app.models.models` (строка 34).
2. Константа `EMISSION_MAX_AGE_MIN = 15` — отсечка свежести.
3. Новая функция `notify_emission_events(app: Application)`:

   **Выборка событий** (одна сессия `SessionLocal`):
   - старты: `SELECT * FROM emission_events WHERE notified = false`
   - концы: `SELECT * FROM emission_events WHERE ended_at IS NOT NULL AND end_notified = false`
   - Если оба списка пусты — return (быстрый выход, обычный случай).

   **Отсечка свежести** (защита от спама историей после простоя бота):
   - старт: если `now_utc - started_at > 15 мин` → `notified = True`, commit, НЕ рассылать;
   - конец: если `now_utc - ended_at > 15 мин` → `end_notified = True`, commit, НЕ рассылать.

   **Получатели** (только если есть что рассылать):
   ```python
   rows = (await db.execute(
       select(User, UserSettings)
       .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
       .where(
           User.telegram_chat_id.isnot(None),
           User.is_active == True,
           User.is_approved == True,
       )
   )).all()
   recipients = [u for u, us in rows if us is None or us.notify_telegram]
   ```
   Если получателей нет — пометить событие обработанным (`notified=True` / `end_notified=True`), commit (иначе вечный retry на каждой итерации).

   **Тексты сообщений** — перенести 1:1 из `_emission_broadcast` (collectors.py:936-949):
   - старт: `<b>Выброс начался</b>\nВремя: {HH:MM} МСК\nАукционная активность снижена (~15 мин)` — время: `event.started_at.astimezone(timezone(timedelta(hours=3))).strftime("%H:%M")`;
   - конец: `<b>Выброс завершён</b>{ (длился N мин)}\nАукцион возвращается к норме` — длительность `round((ended_at - started_at).total_seconds() / 60)`, суффикс только если вычислима.
   - Опционально для консистентности с лотами: префикс `[STAGE] ` при `IS_STAGE` (в build_lot_message он есть) — добавить.

   **Отправка:** через `app.bot.send_message(chat_id=..., text=..., parse_mode="HTML")` (живой PTB-бот, как в notify_profitable_lots:235). Per-chat_id try/except с логированием, считать успехи.

   **Ключевое правило:** `notified = True` (или `end_notified = True`) ставить ТОЛЬКО если успешных отправок ≥ 1. Если все отправки упали — флаг не ставить, commit не делать (или commit без флага), бот повторит через 15 сек; отсечка 15 мин гарантирует, что ретраи не бесконечны.

4. В `_notifier_loop` (строка 261-269) добавить вызов в тот же try:
   ```python
   await notify_profitable_lots(app)
   await notify_emission_events(app)
   ```
   Внутри `notify_emission_events` — собственный try/except не обязателен (loop уже ловит), но per-chat_id обработка обязательна.

### Что остаётся без изменений

- `backend/app/services/telegram_sender.py` — **оставить**: используется в `backend/app/api/v1/endpoints/telegram.py:50-51` (`_bot_send` — сервисные сообщения при привязке аккаунта). После правок collectors.py это единственный потребитель.
- Redis-ключ `EMISSION_REDIS_KEY` и логика fingerprint в worker — без изменений.
- `backend/app/api/v1/endpoints/emission.py` — читает события, полей notified/end_notified не касается, правки не нужны.

## Верифицируемые критерии приёмки

1. Grep по `backend/app/tasks/collectors.py`: нет упоминаний `_emission_broadcast`, `send_telegram_message`, `telegram_sender`.
2. Миграция 0033 применяется и откатывается (`alembic upgrade head` / `downgrade -1`); после upgrade у всех существующих строк `emission_events.end_notified = true`.
3. Симуляция старта: `INSERT INTO emission_events (region, started_at, notified, end_notified) VALUES ('RU', now(), false, false)` → в течение ≤30 сек бот шлёт «Выброс начался …» привязанным пользователям, после чего `notified = true`.
4. Симуляция конца: `UPDATE emission_events SET ended_at = now() WHERE id = <тот же>` → бот шлёт «Выброс завершён (длился N мин)», `end_notified = true`.
5. Отсечка: событие с `started_at = now() - interval '1 hour'`, `notified = false` → бот НЕ шлёт, но ставит `notified = true` в течение ≤30 сек. Аналогично для `ended_at`/`end_notified`.
6. Фильтры: пользователь с `notify_telegram = false` в UserSettings уведомление НЕ получает; пользователь тира `base` (при notify_telegram=true, is_approved=true) — ПОЛУЧАЕТ.
7. При недоступности Telegram API (все отправки упали) флаг остаётся false, ошибки в логах бота, worker продолжает работать.
8. `notify_profitable_lots` продолжает работать (сбой emission-части не ломает loop).

## План деплоя (прод)

Порядок важен. Нюанс: `telegram_bot` собирается из образа `./backend` (docker-compose.prod.yml:79), а `bot.py` примонтирован волюмом (`./telegram_bot:/tg_bot`). Изменение модели `EmissionEvent` живёт в образе → **restart бота НЕдостаточен, нужен rebuild** telegram_bot вместе с backend/worker/beat.

1. `git pull` на сервере.
2. `docker compose -f docker-compose.prod.yml build backend worker beat telegram_bot` (или общий `up -d --build`).
3. `docker compose -f docker-compose.prod.yml up -d`.
4. `docker compose -f docker-compose.prod.yml exec backend alembic upgrade head` (миграция 0033).
5. Проверить логи: `docker compose -f docker-compose.prod.yml logs -f telegram_bot worker`.

Переходное окно: если старый worker закроет выброс до перезапуска — возможен дубль «Выброс завершён» (старый worker + новый бот). Окно минимально при одновременном `up -d --build`; выброс длится ~4-5 мин — риск принимаем, компенсация не нужна.

Локально: `docker compose up -d --build` + `docker compose exec backend alembic upgrade head`.

## Документация для обновления (tech-writer, после реализации)

- `docs/NOTES.md`: отметить задачу выполненной / добавить запись о переносе рассылки в бот.
- `docs/SERVICES.md`: `collect_emission` больше не шлёт Telegram (только фиксация событий); в описание telegram_bot добавить `notify_emission_events` в `_notifier_loop`.
- `docs/DATABASE.md`: `emission_events` — новое поле `end_notified`, миграция 0033.

## Маршрутизация по агентам

1. `backend-dev` — вся реализация (collectors.py, models.py, миграция 0033, bot.py — бот-код тоже Python/SQLAlchemy, фронтенда нет). Вход: этот файл.
2. `qa-tester` — предложить после реализации (критерии приёмки 1-8).
3. `deploy` — предложить после QA (раздел «План деплоя»).
4. `tech-writer` — обновление docs/ по разделу выше.

## Открытые вопросы / требует подтверждения

- Tier-гейт для emission-уведомлений НЕ применяется (сохранён исторический охват «всем привязанным») — если пользователь хочет тир-ограничение, сказать backend-dev до реализации.
- Префикс `[STAGE] ` в emission-сообщениях на stage-окружении — предложено добавить для консистентности; если не нужен, убрать из ТЗ.
- Rate limit Stalcraft API не затрагивается (частота опроса /emission не меняется) — подтверждение не требуется.
