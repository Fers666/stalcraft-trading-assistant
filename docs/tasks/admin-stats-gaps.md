# ТЗ: Админ-статистика — недореализованные пункты (gaps)

## Контекст

При реализации фазы «Статистика в админке» (см. `docs/tasks/admin-stats.md`,
закрыта в `docs/CHANGELOG.md` 2026-06-28) черновой план обсуждался в чате, но
не был зафиксирован структурно — ТЗ восстанавливалось по куцей записи в
`docs/NOTES.md`. При сверке с оригинальным запросом пользователя выяснилось,
что 4 пункта из исходного списка потерялись при восстановлении и не были
реализованы:

1. Количество пользователей, зашедших сегодня.
2. Активные пользователи за неделю.
3. Количество пользователей, подключивших Telegram.
4. Вывод Telegram пользователя в таблице админки.

Это ТЗ — **добавление** этих 4 пунктов поверх уже реализованного
(`GET /admin/stats`, блок System stats из 4 карточек, таблица пользователей).
Ничего из уже сделанного не трогаем, не дублируем, не переписываем.

## Текущий код — зафиксированные факты

### Backend — `admin.py`

- `AdminStatsResponse` (`backend/app/api/v1/endpoints/admin.py:135-143`):
  ```python
  class AdminStatsResponse(BaseModel):
      users_by_tier: dict[str, int]
      users_online_now: int
      unique_watchlist_pairs: int
      total_watchlist_entries: int
      rate_limit: dict
  ```
- `get_admin_stats` (`admin.py:146-184`, эндпоинт `GET /admin/stats`) считает
  все 5 текущих полей. `users_online_now` использует
  `ONLINE_THRESHOLD_MINUTES = 5` (`admin.py:40`) и сравнение
  `User.last_seen >= datetime.now(timezone.utc) - timedelta(minutes=5)`
  (`admin.py:157-160`) — это и есть готовый шаблон для метрик "сегодня"/"за
  неделю", только с другим порогом и другой границей (не "N минут назад", а
  "начало календарного дня"/"7 суток назад").
- `UserAdminResponse` (`admin.py:18-37`) уже включает `telegram_username:
  str | None` (строка 22) — это уже отдаётся в `GET /admin/users`. Поля
  `telegram_chat_id` в ответе **нет**.
- `list_users` (`admin.py:43-81`) заполняет `telegram_username=user.telegram_username`
  (строка 66) — `telegram_chat_id` не читается и не отдаётся.

### Backend — `User` модель и timezone

- `backend/app/models/models.py:14-32` (`class User`):
  - `telegram_username = Column(String(50))` (строка 21) — текстовое поле,
    **не подтверждает** реальное подключение бота; заполняется ботом при
    `/link`, но теоретически могло остаться от предыдущей привязки если когда-то
    появится путь рассинхрона (на сегодня в коде такого пути нет — см. ниже).
  - `telegram_chat_id = Column(BigInteger)` (строка 22) — заполняется
    **только** через реальный webhook от Telegram-бота.
  - `last_seen = Column(DateTime(timezone=True), nullable=True)` (строка 28)
    — `TIMESTAMPTZ`, пишется как `datetime.now(timezone.utc)`
    (`backend/app/core/dependencies.py:28`, throttle раз в 60 сек — см. ниже).
  - `created_at = Column(DateTime(timezone=True), server_default=func.now())`
    (строка 31).
- **Throttle-логика `last_seen`** (`backend/app/core/dependencies.py:18-31`,
  `_throttled_update_last_seen`): на каждый авторизованный запрос проверяется
  Redis-ключ `last_seen:{user.id}` (`SETEX … 60 "1"`); если ключа нет —
  обновляет `user.last_seen = datetime.now(timezone.utc)` и коммитит, ключ
  живёт 60 сек. То есть `last_seen` обновляется не чаще раза в минуту на
  пользователя, но это не влияет на корректность дневных/недельных границ
  (точность в минутах более чем достаточна).
- **Часовой пояс БД** (`backend/app/db/session.py:15-19`, `set_timezone`):
  при каждом новом подключении выполняется `SET TIMEZONE TO 'Europe/Moscow'`
  (то же самое в `get_celery_db_session`, строки 53-57). Это влияет на
  отображение/интерпретацию `TIMESTAMPTZ` в рамках сессии Postgres, но сам
  столбец `last_seen` физически хранит момент времени в UTC (тип
  `TIMESTAMPTZ` не зависит от session timezone для **хранения** — только для
  вывода и для интерпретации naive-литералов). Подтверждено `docs/DATABASE.md:3`:
  «PostgreSQL 16. Часовой пояс: `Europe/Moscow` (UTC+3)».
  **Важный вывод:** так как код пишет `last_seen` через aware
  `datetime.now(timezone.utc)`, а не через `func.now()` SQL-стороны, сравнения
  `User.last_seen >= X` в Python/SQLAlchemy с aware datetime корректны
  независимо от session timezone — но "начало сегодняшнего дня" и "7 дней
  назад" нужно считать в **московском времени**, иначе календарная граница
  "сегодня" будет сдвинута на 3 часа относительно ожиданий админа,
  который мыслит локальным (MSK) днём.
  - Уже существующий в проекте паттерн для локальной (MSK) границы:
    `backend/app/services/analytics/market_stats.py:137,170,220,236` —
    `sale_local = s.sale_time.astimezone(timezone(timedelta(hours=3)))`.
    Использовать тот же паттерн `timezone(timedelta(hours=3))` для
    консистентности (а не `zoneinfo.ZoneInfo("Europe/Moscow")`, которого в
    коде сейчас нигде нет — DST не актуален для России с 2014, фиксированный
    offset безопасен и уже принят как конвенция проекта).

### Backend — `telegram.py` (привязка Telegram)

- `GET /telegram/status` (`backend/app/api/v1/endpoints/telegram.py:91-99`)
  уже использует именно `telegram_chat_id is not None` как признак привязки:
  ```python
  return TelegramStatusResponse(
      is_linked=current_user.telegram_chat_id is not None,
      telegram_username=current_user.telegram_username,
  )
  ```
- Webhook `/link {code}` (`telegram.py:209-248`) — единственное место, где
  `telegram_chat_id` записывается (строка 236, синхронно с
  `telegram_username` строка 237).
- `/stop` (строки 191-206) и `DELETE /telegram/unlink` (строки 102-111) —
  оба поля очищаются **парой** (`telegram_chat_id = None` и
  `telegram_username = None` вместе) — в текущем коде нет сценария, где
  `telegram_username` заполнен, а `telegram_chat_id` пуст (или наоборот) —
  поля всегда синхронны. Тем не менее семантически достоверный признак
  подключения — **`telegram_chat_id IS NOT NULL`**, не `telegram_username` —
  именно так это уже трактует `GET /telegram/status`. `telegram_username` сам
  по себе не доказывает подключение бота (по описанию задачи это поле "может
  быть введено без реального подключения" — хотя в текущем коде такого пути
  заполнения вручную нет, this отражает корректную семантику на случай, если
  в будущем появится отдельное поле для "введённого, но не подтверждённого"
  username).

### Frontend — `AdminPage.tsx`

- `AdminUser` интерфейс (`frontend/src/pages/AdminPage.tsx:57-74`) уже
  объявляет `telegram_username: string | null` (строка 61) — поле приходит с
  backend, но не используется ни в одной ячейке таблицы.
- `AdminStats` интерфейс (`AdminPage.tsx:82-92`) — текущие 4 метрики
  (`users_by_tier`, `users_online_now`, `unique_watchlist_pairs`,
  `total_watchlist_entries`, `rate_limit`).
- Блок System stats (`AdminPage.tsx:420-550`) — 4 карточки в общем `Box`
  (`display:flex, gap:2, flexWrap:wrap`, строка 421): «Уникальных товаров в
  отслеживании» (423-446), «Онлайн сейчас» (448-469), «Тарифы» (471-506),
  «Rate limit Stalcraft API» (508-549). Паттерн карточки: `Box` с
  `px:2.5, py:1.5, background:BG2, border:1px solid BORDER,
  borderRadius:'10px', minWidth:140-220`, заголовок — `Typography
  fontSize:0.68rem, color:T2, letterSpacing:0.06em, uppercase`, опционально
  иконка 14px цвета `G2` перед заголовком, число — `Typography
  fontSize:1.4rem/700` (или `1rem/700` для составной метрики с
  прогресс-баром), `CircularProgress size={16}` на время `statsLoading`.
- Таблица пользователей: заголовки — массив строк
  (`AdminPage.tsx:696`) `['Пользователь', 'Email', 'Статус', 'Зарегистрирован',
  'Тариф', 'До', 'Был онлайн', 'Карточек', 'Радар рынка', 'Действие']` — нет
  «Telegram». Тело строки (709-963) — `<TableCell>` идут в том же порядке;
  после ячейки "До" (`tier_expires_at`, строки 855-860) и **перед** ячейкой
  "Был онлайн" (862-874) — естественное место для новой колонки Telegram (по
  смыслу группировки: идентификационные данные пользователя — email уже
  стоит рядом с username, Telegram логично туда же, до операционных метрик
  тариф/онлайн/карточки). Ячейка "Был онлайн" — паттерн цветного индикатора
  (`Box` 7×7px circle + `Typography` цветом по состоянию, строки 863-874) —
  пригоден как образец для индикации "подключён/не подключён".
- `fmtDate`/`fmtRelative` — готовые хелперы форматирования дат
  (`fmtDate` строки 330-333), переиспользовать без изменений.
- Импортированные MUI-иконки (строки 8-16): `CheckCircleOutlineIcon,
  BlockIcon, PendingActionsIcon, AdminPanelSettingsIcon, SyncIcon, TuneIcon,
  InventoryIcon, WifiTetheringIcon, SpeedIcon` — для карточки/колонки
  Telegram нужна новая иконка, не входящая в этот список (например
  `TelegramIcon` из `@mui/icons-material/Telegram`, существует в MUI Icons).

## Затронутые файлы

- `backend/app/api/v1/endpoints/admin.py` — расширение `AdminStatsResponse`,
  `get_admin_stats`, `UserAdminResponse`, `list_users`.
- `frontend/src/pages/AdminPage.tsx` — расширение интерфейсов `AdminStats`,
  `AdminUser`, новые карточки в System stats, новая колонка в таблице.

## Изменения по слоям

### Backend

**1. Метрика "зашедших сегодня" — `users_active_today`**

Семантика "сегодня" = календарный день по московскому времени (UTC+3),
поскольку БД и весь проект (`market_stats.py`) уже трактуют локальное время
как MSK, а не UTC. Граница — начало текущих суток в MSK, переведённое в UTC
для сравнения (сравнение в SQLAlchemy всё равно идёт по aware datetime,
конвертация явная):

```python
from datetime import timezone as dt_timezone

MSK = dt_timezone(timedelta(hours=3))

def _start_of_today_msk() -> datetime:
    now_msk = datetime.now(MSK)
    return now_msk.replace(hour=0, minute=0, second=0, microsecond=0)

today_start = _start_of_today_msk()
users_active_today = (await db.execute(
    select(func.count()).select_from(User).where(User.last_seen >= today_start)
)).scalar_one()
```

Имя поля — `users_active_today` (не `users_visited_today`, для единообразия
с уже существующим `users_online_now`).

**2. Метрика "активные за неделю" — `users_active_week`**

```python
week_threshold = datetime.now(timezone.utc) - timedelta(days=7)
users_active_week = (await db.execute(
    select(func.count()).select_from(User).where(User.last_seen >= week_threshold)
)).scalar_one()
```

Здесь календарная граница не нужна (это не "с начала недели по календарю", а
скользящее окно "последние 7×24 часа") — `timezone.utc` достаточно, MSK-сдвиг
не имеет значения для скользящего окна (в отличие от "сегодня", где имеет
значение начало суток).

**3. Метрика "подключивших Telegram" — `users_telegram_linked`**

```python
users_telegram_linked = (await db.execute(
    select(func.count()).select_from(User).where(User.telegram_chat_id.is_not(None))
)).scalar_one()
```

Явно **не** `telegram_username.is_not(None)` — см. факты выше,
`telegram_chat_id` — единственное поле, гарантированно отражающее реальное
подключение бота (то же поле, что использует `GET /telegram/status`).

**4. Обновлённый `AdminStatsResponse`**

```python
class AdminStatsResponse(BaseModel):
    users_by_tier: dict[str, int]
    users_online_now: int
    users_active_today: int
    users_active_week: int
    users_telegram_linked: int
    unique_watchlist_pairs: int
    total_watchlist_entries: int
    rate_limit: dict
```

Три новых поля вставлены сразу после `users_online_now` — логическая
группировка "активность пользователей" (online/today/week) вместе, перед
"watchlist" и "rate_limit".

**5. `UserAdminResponse` — добавить `telegram_chat_id`**

Нужно для фронта, чтобы различить "ввёл username" и "подключил бота" (если
выбран вариант с визуальным различием — см. "Открытые вопросы" п.2). Минимум
достаточно отдавать булево, но проще и честнее — отдать сырое поле, фронт
сам решает что показать:

```python
class UserAdminResponse(BaseModel):
    id: int
    username: str
    email: str
    telegram_username: str | None
    telegram_chat_id: int | None   # новое — None = бот не подключён, даже если telegram_username заполнен
    is_admin: bool
    ...
```

И в `list_users` (`admin.py:62-79`) добавить
`telegram_chat_id=user.telegram_chat_id` в конструктор `UserAdminResponse`.

**Не делать:** отдельный `bool is_telegram_linked` вместо сырого
`telegram_chat_id` — поле и так nullable int, фронт получает ту же
информацию через `!= null`, плюс необработанный chat_id может быть полезен
для будущей админ-функциональности (например прямая отправка сообщения
через бота конкретному пользователю) без новой миграции backend-ответа.
Simplicity First — не вводить лишний derived-флаг там, где исходное поле уже
самодостаточно.

**6. Никаких новых миграций.** Все 4 метрики читают существующие колонки
(`last_seen`, `telegram_chat_id`) без изменения схемы. Alembic head не
меняется.

### Frontend

**1. `AdminStats` интерфейс** (`AdminPage.tsx:82-92`) — добавить 3 поля:

```typescript
interface AdminStats {
  users_by_tier: Record<string, number>
  users_online_now: number
  users_active_today: number
  users_active_week: number
  users_telegram_linked: number
  unique_watchlist_pairs: number
  total_watchlist_entries: number
  rate_limit: { ... }  // без изменений
}
```

**2. `AdminUser` интерфейс** (`AdminPage.tsx:57-74`) — добавить:

```typescript
interface AdminUser {
  ...
  telegram_username: string | null
  telegram_chat_id: number | null   // новое
  ...
}
```

**3. Новые карточки в System stats** (после строки 549, внутри того же
`Box` со строки 421, перед закрывающим `</Box>` строки 550) — три новые
карточки тем же визуальным паттерном:

- «Зашли сегодня» — `stats.users_active_today`, иконка
  `WifiTetheringIcon` уже занята "Онлайн сейчас" — предложение: без иконки
  или `TodayIcon`/`EventAvailableIcon` (нейтральный выбор, не критично).
- «Активны за неделю» — `stats.users_active_week`.
- «Подключили Telegram» — `stats.users_telegram_linked`, иконка
  `TelegramIcon` (`@mui/icons-material/Telegram`) — новый импорт.

Можно объединить «Зашли сегодня» / «Активны за неделю» в одну карточку с
двумя числами (по аналогии с «Уникальных товаров» — `47 / 132`), но это
семантически разные знаменатели (не "часть от целого"), поэтому рекомендация
— **две отдельные карточки**, проще для восприятия, не вводит в заблуждение
форматом "X / Y" который читается как "X из Y".

Размещение «Подключили Telegram» — либо четвёртой картой в System stats,
либо рядом с «Тарифы» (смысловая близость: обе про "сколько юзеров обладают
свойством X"). Рекомендация — добавить в конец ряда System stats, простое
расширение `flexWrap: 'wrap'` уже обрабатывает перенос на новую строку при
нехватке места по ширине — никакой доп. вёрстки не требуется.

**4. Новая колонка "Telegram" в таблице**

Заголовок — вставить `'Telegram'` в массив (`AdminPage.tsx:696`) после
`'До'` и перед `'Был онлайн'`:
```typescript
['Пользователь', 'Email', 'Статус', 'Зарегистрирован', 'Тариф', 'До', 'Telegram', 'Был онлайн', 'Карточек', 'Радар рынка', 'Действие']
```

Ячейка — вставить новый `<TableCell>` между ячейкой "До" (заканчивается
строка 860) и ячейкой "Был онлайн" (начинается строка 862):

```tsx
{/* Telegram */}
<TableCell>
  <Typography sx={{ fontSize: '0.78rem', color: u.telegram_username ? T1 : T2 }}>
    {u.telegram_username ? `@${u.telegram_username}` : '—'}
  </Typography>
</TableCell>
```

**Решение пользователя:** колонка показывает `telegram_username` напрямую
(`@username` либо `—`), **независимо** от `telegram_chat_id` — то есть
отражает введённый username, а не факт реального подключения бота. Это
осознанный выбор, отличный от первоначальной рекомендации исследователя
("—" при пустом `telegram_chat_id"): в текущем коде оба поля всегда
заполняются/очищаются парой (см. факты выше про `telegram.py`), поэтому
сегодня поведение визуально не отличается от альтернативы — но если в
будущем появится путь заполнения `telegram_username` без подключения бота,
колонка покажет этот username как есть, без проверки `telegram_chat_id`.
`telegram_chat_id` всё равно добавляется в `UserAdminResponse` (backend,
п.5 выше) — он не используется в этой ячейке, но остаётся доступен на
фронте для будущих нужд (например прямая отправка сообщений через бота) и
используется отдельно в метрике `users_telegram_linked` (счётчик подключивших
бота, см. Backend.3 — та метрика однозначно основана на `telegram_chat_id`,
выбор пользователя касается только отображения в таблице, не подсчёта
статистики).

## Документация для обновления

- `docs/NOTES.md`: отметить эти 4 пункта как реализованные (дополнение к уже
  закрытой записи «Статистика в админке» 2026-06-28), либо отдельной строкой
  со ссылкой на этот файл, по решению `tech-writer`.
- `docs/SERVICES.md`: дополнить описание `GET /admin/stats` тремя новыми
  полями (`users_active_today`, `users_active_week`, `users_telegram_linked`)
  рядом с уже описанными `users_online_now`/`unique_watchlist_pairs`.
- `docs/DATABASE.md`: без изменений — никаких новых таблиц/колонок.
- `docs/BUSINESS_LOGIC.md`: не затрагивается.

## Порядок реализации (зависимости)

1. **backend-dev** — три новые метрики в `AdminStatsResponse`/
   `get_admin_stats`, плюс `telegram_chat_id` в `UserAdminResponse`/
   `list_users` (все правки локализованы в `admin.py`).
2. **frontend-dev** — после подтверждения точной формы JSON-ответа: три
   новые карточки в System stats + новая колонка "Telegram" в таблице
   (`AdminPage.tsx`).
3. **tech-writer** — обновление `docs/SERVICES.md` и `docs/NOTES.md`.

Декомпозиция на отдельные backend/frontend ТЗ не требуется — скоуп
небольшой (точечные добавления в один существующий эндпоинт и один
существующий компонент), оба агента читают этот документ.

## Открытые вопросы / требует подтверждения

1. **Семантика "сегодня" — календарный день по MSK, не скользящие 24 часа.**
   Зафиксировано как начало текущих суток по московскому времени
   (`timezone(timedelta(hours=3))`, тот же паттерн, что уже используется в
   `market_stats.py`). Альтернатива — "последние 24 часа от текущего
   момента" (скользящее окно, как у `users_active_week`) дала бы другое
   число и не требовала бы вычисления локальной полуночи. Календарный день
   выбран как более интуитивный для админа, открывающего страницу утром
   ("кто заходил сегодня" обычно подразумевает "с полуночи", не "за последние
   24ч") — но фиксирую как явное архитектурное решение, не самоочевидный
   факт, на случай других ожиданий пользователя.

2. **Различение "ввёл username" vs "подключил бота" в таблице.**
   Рекомендация исследователя — **не различать визуально** третье состояние,
   поскольку оно недостижимо в текущих данных (см. изменения по слоям,
   п. Frontend.4) — колонка показывает либо "—" (не подключён, независимо от
   username), либо `@username`/`Подключён` (если `telegram_chat_id` задан).
   Если пользователь имел в виду другую семантику (например хочет видеть
   именно сырой `telegram_username`, даже когда `telegram_chat_id` пуст —
   на случай ручного редактирования БД администратором напрямую через
   psql, минуя API) — это меняет рендеринг ячейки на простой вывод
   `telegram_username ?? '—'` без проверки `telegram_chat_id`, но тогда
   колонка не отражает реальный статус подключения бота, что противоречит
   цели пункта 3 исходного запроса ("кто **подключил** телеграм").

3. **Состав и порядок новых карточек в System stats.** Предложено добавить
   все 3 новые метрики (today/week/telegram) как отдельные карточки в конец
   существующего ряда из 4 карточек (итого 7). Альтернатива — объединить
   «Зашли сегодня» и «Активны за неделю» в одну составную карточку (как уже
   сделано для «Уникальных товаров», формат `X / Y`) — рекомендация
   исследователя против объединения (разные знаменатели, см. Frontend.3),
   но если пользователь предпочитает компактность — это тривиальная правка
   на этапе frontend-dev, не блокирует начало работы.
