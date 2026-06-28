# ТЗ: ручной override лимита избранного (watchlist) вне тарифа

## Контекст

Пользователь хочет вручную увеличивать (для конкретного пользователя
приложения) количество лотов в «избранном» сверх лимита его тарифа — без
смены самого тарифа.

**Важная находка №1 — терминология.** В коде и БД нет отдельной сущности
«favorites» — то, что в UI называется «Избранное» (`MonitoringPage.tsx:203`,
`ИЗБРАННОЕ · {watchlist.length}/{watchlistLimit}`; кнопка «добавить в
избранное» в `CatalogPage.tsx:163` вызывает `POST /watchlist/`), на backend —
это **`UserWatchlist`** (`backend/app/models/models.py:88`), а лимит — это
**`TierLimits.watchlist_limit`** (`backend/app/core/tiers.py:19`). Далее в
этом ТЗ «избранное» и «watchlist» — синонимы одной и той же сущности.

**Важная находка №2 — лимит хранится в коде, не в БД.** Это не отдельная
таблица тарифов с редактируемым полем, а захардкоженный словарь
`TIERS: dict[str, TierLimits]` в `backend/app/core/tiers.py:25-30`:

```python
TIERS: dict[str, TierLimits] = {
    "base":          TierLimits(watchlist_limit=6,  ...),
    "advanced":      TierLimits(watchlist_limit=10, ...),
    "advanced_plus": TierLimits(watchlist_limit=20, ...),
    "advanced_max":  TierLimits(watchlist_limit=25, ...),
}
ADMIN_LIMITS = TierLimits(watchlist_limit=None, ...)  # без лимита
```

`get_tier_limits(user)` — единственная и единая точка истины:
если `user.is_admin` — возвращает `ADMIN_LIMITS` (без лимита), иначе берёт
`TIERS[user.tier]`. Других мест, где лимит вычисляется или проверяется
повторно, нет.

**Единственная точка проверки лимита при добавлении** —
`backend/app/api/v1/endpoints/watchlist.py:116-125` (`add_to_watchlist`):

```python
limits = get_tier_limits(current_user)
if limits.watchlist_limit is not None:
    count = (await db.execute(... COUNT активных записей ...)).scalar_one()
    if count >= limits.watchlist_limit:
        raise HTTPException(403, f"Лимит карточек watchlist для вашего тарифа: {limits.watchlist_limit}")
```

Других ручек, которые проверяют лимит при создании, нет (`PUT`/`DELETE`/
`refresh` лимит не трогают). Лимит также используется (но не для блокировки,
а для **показа**) в:
- `UserResponse.watchlist_limit` (`backend/app/api/v1/endpoints/auth.py:49,70`)
  → попадает на фронт через `GET /auth/me`, читается в
  `frontend/src/store/authStore.ts:14` и отображается в
  `frontend/src/pages/MonitoringPage.tsx:31-32,200-203` («ИЗБРАННОЕ ·
  N/лимит», цвет меняется на «danger» при достижении).
- `deactivate_excess_watchlist()` (`backend/app/core/tiers.py:55-71`) —
  вызывается при **понижении** тарифа (`set_user_tier`,
  `apply_tier_expiry`), чтобы деактивировать карточки сверх нового лимита.
  Override не должен сломать эту логику понижения тарифа (см. ниже).

**Референс-паттерн — `has_market_radar_addon`** (аддон вне тарифной
лестницы, недавно реализован, см. `docs/BUSINESS_LOGIC.md` §17 подраздел
«Радар рынка»):
- Поле на `User`: `has_market_radar_addon` (`models.py:29`, boolean,
  `nullable=False, default=False, server_default="false"`), добавлено
  отдельной миграцией `0026_user_tiers.py`.
- Админский эндпоинт: `POST /admin/users/{id}/market-radar-addon` с телом
  `{"enabled": bool}` (`admin.py:245-259`) — простой PATCH-по-смыслу
  (используется `POST`, не `PATCH` — таков стиль всех мутирующих ручек в
  `admin.py`: `/tier`, `/tier/extend`, `/approve`, `/revoke` — все `POST`).
  Точечно меняет одно поле, коммитит, возвращает `{"ok": True}`.
- Видимость для пользователя: поле включено в `UserResponse`
  (`auth.py:53,74`) → видно через `GET /auth/me`.
- Видимость в админке: поле включено в `UserAdminResponse`
  (`admin.py:32,74`) → отдаётся в `GET /admin/users`, но **фронтенд админки
  (`AdminPage.tsx`) пока не отображает это поле и не имеет тоггла для него**
  — `interface AdminUser` во фронтенде (строки 57-71) не содержит
  `has_market_radar_addon`, UI для него не реализован. Это значит: паттерн
  «бэкенд есть, фронт админки ещё не дотянут» уже существует в проекте на
  момент этого исследования, и в данной задаче фронтенд для override нужно
  делать с нуля по образцу существующего блока «Тариф» в таблице
  (`AdminPage.tsx:714-810` — `Select` + кнопка «Сменить»), а не ждать, что
  паттерн уже где-то готов.

Это **числовой**, а не булевый аддон — прямое использование паттерна
`has_market_radar_addon` не подходит буквально (там `enabled: bool`), но
структура «отдельное поле на `User`, отдельный admin-эндпоинт, не часть
тарифной матрицы» переносится без изменений.

## Архитектурное решение

### 1. Поле на `User`: `favorites_limit_override` (nullable int), а не сложение с тарифом

**Выбор:** `User.favorites_limit_override: int | None = Column(Integer,
nullable=True, default=None)`. `NULL` = «нет override, лимит = тариф».
Не-`NULL` значение **заменяет** лимит тарифа целиком (не складывается с
ним) — `effective_limit = override if override is not None else
tier_limit`.

**Почему заменяет, а не складывается:**
- Семантика «вне тарифа» из формулировки задачи лучше описывается как
  «администратор устанавливает индивидуальный лимит для этого пользователя»,
  а не «бонус сверху». Замена — более предсказуема и проще объяснить
  пользователю/админу («у тебя лимит 50», а не «у тебя 20 от тарифа + 30
  бонусом = непонятно почему 50 без контекста»).
- Сложение усложняет UX админки: при каждой смене тарифа пользователя
  итоговый лимит «прыгает» (override остаётся, базовый меняется) —
  непрозрачно для админа, который видит только число override, а не
  итоговую сумму без дополнительного вычисления в уме.
- Замена даёт более простую и предсказуемую реализацию: одна функция
  `get_tier_limits(user)` возвращает готовый `effective` лимит, не нужно
  передавать два числа дальше по коду или менять сигнатуру `TierLimits`
  (датакласс остаётся `frozen`, с одним полем `watchlist_limit` как сейчас —
  никакой вызывающий код, кроме самой `get_tier_limits`, не меняется).
- Админ, желающий «тариф + N» может просто посчитать сумму сам и ввести её
  как абсолютное число — это не теряет функциональность, только убирает
  скрытую арифметику из системы.

**Назначение override = `0` или отрицательное число:** не валидируем как
спец-случай «отключить избранное» — `0` технически означает лимит 0
карточек (что валидно, хоть и не имеет практического смысла). Отрицательные
числа — отклонять на уровне Pydantic-валидации в admin-эндпоинте (`ge=0`),
чтобы не открывать путь к багам в SQL/UI на пустом месте.

**Что не делаем:** не вводим отдельную таблицу `favorites_overrides` — на
масштабе проекта (override — редкое ручное действие админа, не более
нескольких записей одновременно) одно nullable-поле на `User` достаточно,
по той же логике, что `has_market_radar_addon` не вынесен в отдельную
таблицу аддонов.

### 2. Где менять логику проверки лимита — внутри `get_tier_limits()`, а не в `watchlist.py`

**Выбор:** расширить `get_tier_limits(user: User) -> TierLimits` в
`backend/app/core/tiers.py` одной дополнительной веткой **после** вычисления
базового лимита:

```python
def get_tier_limits(user: User) -> TierLimits:
    """is_admin обходит все лимиты целиком, независимо от user.tier."""
    if user.is_admin:
        return ADMIN_LIMITS
    base = TIERS.get(user.tier, TIERS[DEFAULT_TIER])
    if user.favorites_limit_override is not None:
        return replace(base, watchlist_limit=user.favorites_limit_override)
    return base
```

(`dataclasses.replace` — `TierLimits` уже `@dataclass(frozen=True)`, новый
импорт `from dataclasses import replace` в начало файла.)

**Почему здесь, а не точечно в `watchlist.py:116-125`:** `get_tier_limits`
— единственная и единственная задокументированная точка истины по лимитам
(см. docstring файла: «Везде, где нужен текущий тариф пользователя,
использовать... get_tier_limits(), а не читать user.tier напрямую»). Любой
код, который сейчас читает `limits.watchlist_limit` (сейчас это
`watchlist.py` для проверки и `auth.py` для отображения в `UserResponse`),
**автоматически** получает override без отдельных правок — не нужно трогать
`add_to_watchlist()` и `UserResponse.from_user()` вообще. Это самое
точечное изменение, которое решает задачу везде одной правкой.

**Trade-off, который принимаем:** `is_admin` продолжает безусловно обходить
`get_tier_limits` целиком (возвращает `ADMIN_LIMITS` до проверки override) —
у админов лимита нет в принципе, и `favorites_limit_override` для
админ-пользователя визуально ни на что не влияет. Это ожидаемо (админам
override не нужен), но если админ когда-нибудь сам станет
`is_admin=False` — override на нём сработает задним числом. Не считаем
это проблемой (соответствует текущему поведению `tier` на админах — поле
хранится, но не действует, пока `is_admin=True`).

**Что не делаем:** не меняем `add_to_watchlist()` — она уже корректно
работает через `get_tier_limits(current_user)`, никаких изменений там не
требуется.

### 3. Влияние override на понижение лимита (`deactivate_excess_watchlist`)

`deactivate_excess_watchlist()` (`tiers.py:55-71`) вызывается в двух местах:
`set_user_tier` (admin, при смене тарифа) и `apply_tier_expiry` (авто-
понижение по истечении срока). Оба вызова сейчас передают
`TIERS[payload.tier].watchlist_limit` / `TIERS["base"].watchlist_limit`
напрямую — **не** через `get_tier_limits(user)` — поэтому override **не
будет** учтён автоматически в этих местах, если override выставлен.

**Решение:** это и есть желаемое поведение, а не баг для исправления здесь.
Override — отдельный механизм лимита, который должен **переживать** смену
тарифа (иначе он бесполезен — админ выдал override именно чтобы он не
зависел от тарифа). Если при смене/истечении тарифа `deactivate_excess_
watchlist` использовала бы `effective_limit` с учётом override, она могла
бы деактивировать карточки пользователя с override даже когда лимит
override выше базового — что и есть желаемый исход (override должен
оставаться в силе после смены тарифа). Поэтому **`set_user_tier` нужно
доработать**: при смене тарифа использовать
`effective_limit = user.favorites_limit_override if user.favorites_limit_override is not None else TIERS[payload.tier].watchlist_limit`
вместо прямого обращения к `TIERS[payload.tier].watchlist_limit` — иначе
понижение тарифа деактивирует карточки пользователя, у которого есть
override, разрешающий их держать активными. `apply_tier_expiry` (понижение
до `base` по истечении) — аналогично, передавать в
`deactivate_excess_watchlist` `effective_limit` пользователя, а не жёстко
`TIERS["base"].watchlist_limit`.

**Самый чистый способ реализовать это без дублирования формулы** — вынести
вычисление `effective_limit` отдельной маленькой функцией
`effective_watchlist_limit(user: User) -> int | None` в `tiers.py`,
использовать её и в `get_tier_limits`, и в обоих местах вызова
`deactivate_excess_watchlist`. backend-dev может выбрать این рефакторинг
вместо дублирования тройной проверки `if ... is not None` в трёх местах.

## Затронутые файлы

### Backend
- `backend/app/models/models.py` — добавить поле `favorites_limit_override`
  в класс `User` (после `has_market_radar_addon`, строка ~29):
  `favorites_limit_override = Column(Integer, nullable=True, default=None)`.
- `backend/alembic/versions/0029_favorites_limit_override.py` (новая
  миграция, `down_revision = "0028"`) — `op.add_column("users",
  sa.Column("favorites_limit_override", sa.Integer(), nullable=True))`;
  `downgrade()` — `op.drop_column(...)`. По образцу `0026_user_tiers.py`
  (docstring с обоснованием — «ручной override лимита избранного вне
  тарифа, NULL = лимит тарифа без изменений»).
- `backend/app/core/tiers.py`:
  - добавить `from dataclasses import dataclass, replace` (расширить
    существующий импорт).
  - новая функция `effective_watchlist_limit(user: User) -> int | None`
    (см. секцию 3 архитектурного решения) — инкапсулирует
    `is_admin`/override/tier-фоллбэк.
  - `get_tier_limits()` — использовать `effective_watchlist_limit(user)`
    вместо прямого `TIERS[user.tier].watchlist_limit` при построении
    результата для не-админов.
  - `set_user_tier`-логика деактивации (вызывается из `admin.py`) —
    использовать `effective_watchlist_limit` вместо
    `TIERS[payload.tier].watchlist_limit` (правка фактически в `admin.py`,
    т.к. там вызывается `deactivate_excess_watchlist`, но обновлённую
    сигнатуру/значение нужно протащить из `tiers.py`).
  - `apply_tier_expiry()` — аналогично, передать `effective_watchlist_limit`
    пользователя (с учётом override) вместо жёсткого
    `TIERS["base"].watchlist_limit` в вызове `deactivate_excess_watchlist`.
- `backend/app/api/v1/endpoints/admin.py`:
  - новая Pydantic-модель `FavoritesLimitOverrideRequest` с полем
    `override: int | None = Field(None, ge=0)` (по аналогии с
    `MarketRadarAddonRequest`, секция «Радар рынка», строки 241-243).
  - новый эндпоинт `POST /admin/users/{user_id}/favorites-limit-override`
    (по аналогии с `set_market_radar_addon`, строки 245-259): найти
    пользователя по `id`, выставить `user.favorites_limit_override =
    payload.override` (включая `None` — это и есть способ «снять
    override», отдельной ручки revoke не нужно, `None` в теле запроса
    делает то же самое), `db.commit()`, вернуть `{"ok": True}`.
    Дополнительно — если новый `effective_limit` меньше текущего числа
    активных карточек пользователя, по аналогии с `set_user_tier`
    выполнить `deactivate_excess_watchlist(user_id, effective_limit, db)`
    (через `effective_watchlist_limit`), чтобы понижение override сразу
    деактивировало лишние карточки, а не оставляло их в неконсистентном
    состоянии до следующего добровольного `PUT`.
  - `UserAdminResponse` — добавить поле `favorites_limit_override: int |
    None` и `effective_watchlist_limit: int | None` (последнее — для
    удобства фронта, чтобы не пересчитывать тариф+override на клиенте;
    вычисляется через `effective_watchlist_limit(user)` при сборке ответа
    в `list_users`).
- `backend/app/api/v1/endpoints/auth.py`:
  - `UserResponse` — добавить поле `favorites_limit_override: int | None`
    (рядом с `watchlist_limit`, строка ~49) — пользователь должен видеть
    в своём профиле/`GET /auth/me`, что у него есть индивидуальный override
    (что и так совпадёт с уже отдаваемым `watchlist_limit`, который теперь
    автоматически содержит override-значение благодаря правке в
    `get_tier_limits`, но отдельное поле `favorites_limit_override`
    позволяет фронту показать явную плашку «у вас расширенный лимит» вместо
    того, чтобы гадать, обычный лимит тарифа это или override).
  - `UserResponse.from_user()` — `favorites_limit_override=user.
    favorites_limit_override`.

### Frontend
- `frontend/src/store/authStore.ts` — добавить `favorites_limit_override:
  number | null` в `interface User` (строка ~14, рядом с
  `watchlist_limit`).
- `frontend/src/pages/MonitoringPage.tsx` — в блоке «ИЗБРАННОЕ · N/лимит»
  (строки ~200-203), если `user?.favorites_limit_override != null`,
  показать небольшую визуальную отметку (например, иконка/Chip «Расширенный
  лимит» рядом с числом, тот же золотой акцент, что у остального тарифного
  UI) — минимальное изменение, не отдельный блок.
- `frontend/src/pages/AdminPage.tsx`:
  - `interface AdminUser` (строки 57-71) — добавить
    `favorites_limit_override: number | null` и
    `effective_watchlist_limit: number | null`.
  - Новый небольшой блок в ячейке `TableCell` колонки «Карточек» (сейчас
    строки 833-836, просто выводит `u.watchlist_count`) — расширить:
    показывать `u.watchlist_count` / `u.effective_watchlist_limit ?? '∞'`
    (как на `MonitoringPage`), плюс под числом — `TextField` (`type=
    "number"`, по образцу поля «ДНЕЙ» в карточке регистрации, строки
    560-573) с текущим значением `favorites_limit_override` (пустое поле =
    `null` = нет override) и кнопка «Применить», вызывающая `POST /admin/
    users/{id}/favorites-limit-override` с `{ override: <число или null> }`
    — по образцу `applyTierChange`/`applyExpiryDate` (локальный `Record<number,
    string>` state для текущего ввода по `id` + функция-обработчик,
    обновляющая `users` после успешного запроса).
  - Состояние ввода — новый `useState<Record<number, string>>` (например,
    `favOverrideInput`), аналогично существующим `tierSelect`/`tierDate`.

### Design
- Не требуется отдельный макет — изменение укладывается в существующую
  визуальную схему таблицы админки (`Select`/`TextField`/`Button` уже есть
  в этом же файле для тарифов) и существующий блок «ИЗБРАННОЕ · N/лимит» на
  `MonitoringPage`. `designer` не привлекается.

## Документация для обновления

- `docs/NOTES.md` — добавить пункт в «Задачи в очереди» (или отдельной
  строкой, если пользователь подтвердит реализацию) с описанием фичи;
  отметить `[x]` после реализации со ссылкой на `docs/CHANGELOG.md`.
- `docs/BUSINESS_LOGIC.md` §17 — новый подраздел «Override лимита избранного
  (вне тарифа)», по аналогии с подразделом «Радар рынка (аддон, не тариф)»:
  описание `favorites_limit_override`, формула `effective_watchlist_limit`,
  отличие от `has_market_radar_addon` (числовой override конкретного лимита
  vs булевый гейтинг отдельной фичи).
- `docs/DATABASE.md` — новая строка в таблице `users` (после
  `has_market_radar_addon`): `favorites_limit_override` — описание и
  ссылка на §17; новая строка в перечне миграций
  (`0029_favorites_limit_override.py`).
- `docs/SERVICES.md` — если там описан `tiers.py` отдельным разделом
  (проверить на этапе ревью; в текущем исследовании файл не читался
  целиком) — дополнить описанием `effective_watchlist_limit`.

## Порядок реализации и агенты

1. **`backend-dev`** — миграция, поле модели, `effective_watchlist_limit()`
   в `tiers.py`, правка `get_tier_limits()`, правка `set_user_tier`/
   `apply_tier_expiry` (использование эффективного лимита при деактивации
   лишних карточек), новый admin-эндпоинт, поля в `UserResponse`/
   `UserAdminResponse`. Получает на вход этот файл
   (`docs/tasks/favorites-limit-override.md`).
2. **`frontend-dev`** — после backend (нужен финальный shape ответа
   `GET /admin/users` и контракт нового эндпоинта): поле в `authStore`,
   отметка на `MonitoringPage`, блок ввода override в таблице
   `AdminPage.tsx`. Получает на вход этот файл + согласованный контракт.
3. **`tech-writer`** — после реализации обоих слоёв: обновление
   `docs/NOTES.md`, `docs/BUSINESS_LOGIC.md` §17, `docs/DATABASE.md`,
   `docs/CHANGELOG.md`.

`designer` и `deploy` не требуются на старте; `qa-tester`/`security`
предложить пользователю после реализации, как обычно по Блоку 2.

## Открытые вопросы / требует подтверждения

1. **Замена лимита тарифа override'ом (выбрано) vs сложение с тарифом.**
   Выбрана замена — проще реализовать, проще объяснить в UI, не требует
   менять структуру `TierLimits`/протаскивать два числа по коду. Если
   нужно именно «лимит тарифа + бонус N» (например, чтобы override
   автоматически рос/падал при смене тарифа пользователя) — реализация
   сложнее (нужно хранить именно «бонус», а не «итоговое число», и менять
   сигнатуру `TierLimits` или вычислять сумму в каждой точке использования).
   **Нужно подтвердить перед началом `backend-dev`.**
2. **Деактивация лишних карточек при понижении/снятии override.** Предложено:
   если админ уменьшает или снимает override ниже текущего количества
   активных карточек пользователя — лишние карточки автоматически
   деактивируются (`is_active=False`, как при понижении тарифа), а не
   блокируется сам запрос на изменение override. Это соответствует
   текущему поведению `set_user_tier`. Подтвердить, что это ожидаемое
   поведение (альтернатива — отказывать в установке override меньше
   текущего количества, требуя от пользователя сначала вручную удалить
   лишние карточки — более жёсткий, но менее автоматический вариант).
3. **Видимость override в профиле пользователя.** Предложено отдавать поле
   `favorites_limit_override` в `GET /auth/me` и показывать небольшую
   визуальную отметку на `MonitoringPage` (само число `watchlist_limit`
   там уже автоматически учитывает override благодаря правке в
   `get_tier_limits`, отдельная отметка — только косметика, чтобы было
   понятно, что лимит «нестандартный»). Если эта косметика не нужна на
   первом проходе — можно отложить правку `MonitoringPage.tsx` и оставить
   только число (уже корректное за счёт backend-логики) без визуальной
   плашки, сократив объём фронтенд-правок.
4. **Валидация `override`.** Предложено принимать только `int >= 0` или
   `null` (Pydantic `ge=0`), без верхнего предела — администратор может
   поставить произвольно большое число. Подтвердить, что верхний предел не
   нужен (это ручной механизм только для админов, риска массового абьюза
   нет, в отличие от пользовательского ввода).
5. **Название поля.** Предложено `favorites_limit_override`, отражающее
   пользовательскую терминологию «избранное» из формулировки задачи, при
   том что в коде сущность называется `watchlist`/`UserWatchlist`. Альтернатива
   — назвать поле `watchlist_limit_override` для консистentности с
   существующим `TierLimits.watchlist_limit`/`UserWatchlist`. Второй вариант
   более единообразен с остальной кодовой базой (везде в backend это
   `watchlist`, не `favorites`); первый — точнее соответствует исходной
   формулировке задачи и видимому в UI слову «Избранное». **Нужно выбрать
   одно из двух названий до начала `backend-dev`** (это меняет имя поля
   модели, миграции, Pydantic-схем и фронтенд-интерфейсов — после выбора
   переименовать дорого, лучше зафиксировать сразу).
