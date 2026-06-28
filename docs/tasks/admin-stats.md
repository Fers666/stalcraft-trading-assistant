# ТЗ: Админ-статистика (следующая фаза роадмапа подписок)

## Контекст

Phase 0 «Тарифы» реализована и закоммичена (см. `docs/tasks/subscription-tiers.md`,
`docs/CHANGELOG.md`, `docs/BUSINESS_LOGIC.md` §17). В `docs/NOTES.md` следующим
пунктом роадмапа подписок зафиксирована «статистика в админке за пределами уже
сделанного (rate-limit consumption, уникальные карточки по всем пользователям)».

Черновой план этой фазы обсуждался в чате, но не был зафиксирован структурно —
это ТЗ восстанавливает скоуп с нуля по факту текущего кода. Скоуп — минимальный
(Simplicity First): две конкретные метрики, названные в NOTES.md, плюс
несколько дополняющих метрик «здоровья системы» того же характера, что уже
есть в админке (общие количества), без новых фич сверх названного.

**Важно:** Phase 0 уже добавила в `AdminPage.tsx` блок «Stats» (3 карточки:
Всего пользователей / Ожидают одобрения / Одобрены) и блок «Tasks» (кнопка
«Пересобрать историю»). Это и есть упомянутый в `docs/tasks/subscription-tiers.md`
«существующий блок Stats/Tasks» — новая статистика добавляется туда же, без
дублирования структуры.

## Текущий код — зафиксированные факты

- **Блок Stats** (`frontend/src/pages/AdminPage.tsx:296-318`): 3 карточки
  (`Всего пользователей`, `Ожидают одобрения`, `Одобрены`), посчитаны на
  клиенте из уже загруженного `/admin/users` (без отдельного backend-эндпоинта
  статистики). Стиль карточки — `Box` с `px:2.5, py:1.5, background: BG2,
  border, borderRadius:'10px', minWidth:140`, число `1.6rem/700`, подпись
  `0.68rem` uppercase серым (`T2`).
- **Блок Tasks** (`frontend/src/pages/AdminPage.tsx:320-343`): один `Button`
  «Пересобрать историю (артефакты)» → `POST /admin/tasks/force-refresh-history`
  (`backend/app/api/v1/endpoints/admin.py:92-105`).
- **`AdminPage.tsx`** структура сверху вниз: заголовок (273-294) → Stats
  (296-318) → Tasks (320-343) → карточка настроек авто-подтверждения
  (345-434, добавлена в Phase 0) → фильтр/таблица пользователей (436-720).
  Новый блок статистики логично вставить после Stats/Tasks, перед карточкой
  настроек регистрации (между строками 343 и 345) — тот же визуальный паттерн
  «карточка в стиле BG2/border/borderRadius».
- **`backend/app/api/v1/endpoints/admin.py`** — текущие эндпоинты:
  `GET /admin/users` (`list_users`, строка 39), `POST /admin/users/{id}/approve`
  (строка 77), `POST /admin/tasks/force-refresh-history` (строка 92),
  `POST /admin/users/{id}/revoke` (строка 108), `POST /admin/users/{id}/tier`
  (строка 133), `POST /admin/users/{id}/tier/extend` (строка 162),
  `GET/PUT /admin/settings/registration` (строки 199-227). Нет ни одного
  эндпоинта статистики/метрик — весь раздел "Stats" сейчас считается на
  фронте из списка пользователей.
- **`backend/app/core/rate_limiter.py`** — `TokenBucketRateLimiter`
  (класс, строка 80), синглтон `rate_limiter` (строка 179). Ключевые факты:
  - `CAPACITY = 400`, `REFILL_RATE = 400/60.0`, `BUCKET_KEY = "stalcraft:rate_limit"`
    (строки 87-89).
  - `acquire(cost, max_wait)` (строка 96) — атомарно списывает токены через
    Lua-скрипт `_LUA_ACQUIRE` (строка 51), хранит `tokens`/`last_refill` в
    Redis-хэше с `EXPIRE 120` сек (строка 71). **Не считает количество
    запросов** — только текущий остаток токенов в bucket.
  - `get_status()` (строка 155) — единственный метод для чтения состояния:
    возвращает `{tokens_available, capacity, refill_rate_per_min, source}`.
    Это **снэпшот остатка**, НЕ "сколько запросов потрачено за минуту/час".
  - **Единственный текущий потребитель `get_status()`** —
    `backend/app/main.py:81-85`, эндпоинт `GET /health` (`{"status": "ok",
    "rate_limiter": rl_status}`), используется Docker healthcheck'ом, не
    админкой. В админке (frontend) нет ни единого упоминания "rate" — grep по
    `AdminPage.tsx`/`MonitoringPage.tsx` ничего не находит.
  - Запросы выполняются из `backend/app/services/collector/client.py`
    (`StalcraftClient._request`, строка 20) → `rate_limiter.acquire(cost=cost)`
    (строка 21) при каждом HTTP-вызове к Stalcraft API. `TokenCost`: `LOTS=2,
    HISTORY=2, EMISSION=1` (`rate_limiter.py:38-41`).
  - **Нет TTL-счётчика количества запросов** — ни в текущем коде, ни в схеме
    БД. Только остаток токенов с TTL 120 сек (переживает между минутными
    окнами ровно настолько, чтобы Lua-скрипт мог досчитать refill, но это не
    исторический ряд, это просто состояние корзины).
- **Дедупликация запросов к API** (`backend/app/tasks/collectors.py`):
  `collect_all_active_lots` (строка 31) и `force_refresh_all_history`
  (строка ~150) оба дедуплицируют по `(item_id, region)` **без учёта
  `user_id`** — комментарий в коде (строки 39-40): «Дедупликация по
  (item_id, region): 100 пользователей следят за одним товаром → 1 API
  запрос». Источник watchlist — `select(UserWatchlist).where(UserWatchlist.is_active
  == True)` (`collectors.py:53-57`), затем `due_pairs = {}` по ключу
  `(entry.item_id, entry.region)` (строка 60-62). Это **точный прообраз**
  SQL-запроса для метрики "уникальных карточек по всем пользователям" —
  должен совпадать по семантике (`is_active=True`, ключ `(item_id, region)`,
  БЕЗ `quality_filter`/`enchant_filter` — те влияют только на фильтрацию
  лотов в ответе API, не на то, какая пара требует отдельного запроса к
  Stalcraft).
- **`UserWatchlist`** (`backend/app/models/models.py:88-112`): `id, user_id,
  item_id, region, quality_filter, enchant_filter, tracked_batch_sizes,
  is_active, last_successful_check, error_status, created_at, updated_at`.
  Уникальность на уровне приложения (не БД) —
  `(user_id, item_id, region, quality_filter, enchant_filter)`
  (`docs/DATABASE.md:108`). Для агрегатной метрики нужна **отдельная**
  дедупликация — только по `(item_id, region)`, не по полному ключу
  уникальности записи пользователя (иначе три пользователя с разными
  фильтрами на один и тот же товар посчитались бы как 3 "уникальные карточки",
  хотя реально это 1 API-запрос).
  SQL:
  ```sql
  SELECT COUNT(DISTINCT (item_id, region)) FROM user_watchlist WHERE is_active = true;
  ```
  В SQLAlchemy: `select(func.count(func.distinct(tuple_(UserWatchlist.item_id, UserWatchlist.region)))).where(UserWatchlist.is_active == True)`
  — либо проще и переносимее между диалектами: подзапрос с `.distinct()` на
  `(item_id, region)` + внешний `count()`:
  ```python
  unique_pairs_subq = (
      select(UserWatchlist.item_id, UserWatchlist.region)
      .where(UserWatchlist.is_active == True)
      .distinct()
      .subquery()
  )
  total_unique = (await db.execute(select(func.count()).select_from(unique_pairs_subq))).scalar_one()
  ```
- **Alembic head на момент исследования:** `0028_registration_settings.py` →
  новая миграция (если потребуется) начинается с `0029`. Обе метрики из
  NOTES.md (rate-limit consumption, уникальные карточки) считаются на чтении
  без хранения — новой таблицы/миграции **не требуется** при выбранном ниже
  подходе (см. "Открытые вопросы" про историю потребления).
- **Тарифы по `is_admin`/доступ** — все admin-эндпоинты гейтятся
  `Depends(get_current_admin)` (`backend/app/core/dependencies.py`) — новый
  эндпоинт статистики использует тот же паттерн, никаких новых проверок прав
  не требуется.

## Затронутые файлы

### Backend
- `backend/app/api/v1/endpoints/admin.py` — новый эндпоинт
  `GET /admin/stats` (или расширение существующего паттерна — см. ниже),
  использующий `get_tier_limits`/`TIERS` (уже импортированы) для разбивки по
  тарифам.
- `backend/app/core/rate_limiter.py` — **опционально**, только если будет
  принято решение хранить историю потребления (см. открытый вопрос №1):
  новый метод `get_consumption_stats()` или счётчик в Redis с TTL.

### Frontend
- `frontend/src/pages/AdminPage.tsx` — новый блок карточек статистики между
  существующим блоком Tasks (строка 343) и карточкой настроек регистрации
  (строка 345), плюс периодическое обновление (опрос) для rate-limit метрики,
  если она должна быть "живой".

### Документация
- `docs/NOTES.md`, `docs/SERVICES.md`, `docs/DATABASE.md` (если появится
  Redis-структура для истории) — см. секцию ниже.

## Изменения по слоям

### Backend

**1. Новый эндпоинт `GET /admin/stats`**

Единый эндпоинт, отдающий все агрегатные метрики разом (одним round-trip,
без нескольких отдельных запросов с фронта — соответствует существующему
паттерну `/admin/users`, который тоже отдаёт всё разом).

```python
class AdminStatsResponse(BaseModel):
    users_by_tier: dict[str, int]          # {"base": 12, "advanced": 3, ...}
    users_online_now: int                  # is_online по тому же порогу 5 минут
    unique_watchlist_pairs: int            # DISTINCT (item_id, region) WHERE is_active
    total_watchlist_entries: int           # для контекста — общее число активных записей (сумма по пользователям)
    rate_limit: dict                       # см. п.2 — снэпшот или окно потребления


@router.get("/stats", response_model=AdminStatsResponse)
async def get_admin_stats(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    ...
```

`users_by_tier` — один `GROUP BY`:
```python
tier_counts = (await db.execute(
    select(User.tier, func.count()).group_by(User.tier)
)).all()
users_by_tier = {tier: count for tier, count in tier_counts}
```

`users_online_now` — тот же порог, что уже используется в `list_users`
(`ONLINE_THRESHOLD_MINUTES = 5`, строка 36 admin.py) — переиспользовать
константу, не дублировать магическое число:
```python
online_threshold = datetime.now(timezone.utc) - timedelta(minutes=ONLINE_THRESHOLD_MINUTES)
users_online_now = (await db.execute(
    select(func.count()).select_from(User).where(User.last_seen >= online_threshold)
)).scalar_one()
```

`unique_watchlist_pairs` / `total_watchlist_entries` — см. SQL выше +
```python
total_watchlist_entries = (await db.execute(
    select(func.count()).select_from(UserWatchlist).where(UserWatchlist.is_active == True)
)).scalar_one()
```

**2. Rate-limit метрика — РЕШЕНИЕ АРХИТЕКТУРЫ ТРЕБУЕТСЯ (см. открытый вопрос №1)**

Два варианта, отличающиеся объёмом работы и полезностью:

**Вариант A — снэпшот текущего остатка (минимальный скоуп).**
Переиспользовать существующий `rate_limiter.get_status()` без изменений.
```python
rl_status = await rate_limiter.get_status()
# {"tokens_available": 387.4, "capacity": 400, "refill_rate_per_min": 400, "source": "redis"}
consumption_estimate = rl_status["capacity"] - rl_status["tokens_available"]
```
Плюсы: zero new code в `rate_limiter.py`, эндпоинт `/admin/stats` просто
вызывает уже существующий метод. Минусы: это остаток "прямо сейчас" — если
админ открыл страницу в момент, когда бакет почти полон (между циклами
сборщика), метрика покажет низкое потребление, не отражая реальную среднюю
нагрузку. Нет понятия "запросов за последнюю минуту/час" — только "сколько
токенов сейчас не использовано из 400".

**Вариант B — счётчик фактически выполненных запросов с окном (TTL в Redis).**
Добавить в `TokenBucketRateLimiter.acquire()` (после успешного списания,
строка ~118-119) инкремент отдельного Redis-ключа с скользящим окном, например
`INCR stalcraft:requests:{minute_bucket}` + `EXPIRE` на 1 час, либо проще —
`ZADD stalcraft:requests:log {timestamp} {cost}` (sorted set) и при чтении
`ZCOUNT` за последние 60/3600 сек, с периодической `ZREMRANGEBYSCORE` для
очистки старых записей. Новый метод `get_consumption_stats()`:
```python
async def get_consumption_stats(self) -> dict:
    """Запросов (в токенах) за последние 60 сек и за последний час."""
    now = time.time()
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await r.zremrangebyscore("stalcraft:requests:log", 0, now - 3600)
        last_60s = await r.zcount("stalcraft:requests:log", now - 60, now)
        last_hour = await r.zcount("stalcraft:requests:log", now - 3600, now)
        return {"requests_last_60s": last_60s, "requests_last_hour": last_hour}
    finally:
        await r.aclose()
```
Плюсы: реальная метрика "сколько запросов/мин тратится прямо сейчас",
сопоставимая с цифрой "54.5 запросов/мин (13.6%)" из CLAUDE.md — это то, что
пользователь, скорее всего, ожидает увидеть в админке буквально. Минусы:
новая запись в Redis на каждый `acquire()` (дополнительная операция, хотя
дешёвая — не запрос к Stalcraft, не влияет на rate limit самого API), нужно
чистить старые записи (защита от утечки памяти Redis при долгой работе без
явного TTL на весь sorted set — `EXPIRE` на ключ целиком плюс `ZREMRANGEBYSCORE`
при каждом чтении).

**Рекомендация: Вариант B**, но в упрощённом виде — не sorted set с
индивидуальными timestamp'ами (точность до секунды избыточна для админки), а
два простых счётчика-INCR с TTL, по аналогии с уже существующим throttle-паттерном
`last_seen` в Phase 0 (`SETEX`, `dependencies.py`, see `subscription-tiers.md`
п.6): ключ `stalcraft:requests:minute:{unix_minute}` с `EXPIRE 120`, инкремент
на `cost` при каждом `acquire()`. Чтение — текущий минутный ключ +
предыдущий (на случай погранного момента) для приближённого "за последние 60
сек". Для "за час" — 60 ключей не читать поштучно, это негодно; если нужна
именно часовая агрегация, проще считать только минутное окно и показывать
его — час избыточен для UI ("живой" rate limit интереснее в моменте, не за
час). **Упрощаю рекомендацию до: показывать только текущую минуту**
(`stalcraft:requests:minute:{unix_minute}`, `INCRBY cost`, `EXPIRE 120`) —
этого достаточно чтобы ответить на вопрос "не упираемся ли в лимит прямо
сейчас", не усложняя дополнительной агрегацией по часу. Финальное решение —
на подтверждение пользователя (открытый вопрос №1), т.к. это плюс одна
Redis-операция на каждый API-запрос (затрагивает горячий путь `acquire()`,
хоть и не сам Stalcraft rate limit).

**Не делать:** хранение истории потребления в PostgreSQL (отдельная
таблица/миграция) — избыточно для "текущей картины здоровья системы", о
которой просит NOTES.md; если в будущем понадобятся графики потребления за
дни/недели — это отдельная, более крупная фича (time-series), не входит в
минимальный скоуп этой фазы.

**3. Никаких новых миграций** при выборе Варианта B (Redis ключи с TTL,
не таблица БД) или Варианта A (вообще без новых данных). Alembic head
остаётся `0028`.

### Frontend

**`frontend/src/pages/AdminPage.tsx`**

Новый блок карточек статистики между Tasks (строка 343) и карточкой настроек
регистрации (строка 345), в том же визуальном паттерне, что существующий
блок Stats (строки 296-318: `Box` с `px:2.5, py:1.5, background:BG2,
border, borderRadius:'10px'`):

- Карточка «Уникальных товаров в отслеживании» — `unique_watchlist_pairs` /
  `total_watchlist_entries` (например "47 / 132 карточек" — уникальных пар
  против суммарных записей по всем пользователям, наглядно показывает
  эффект дедупликации, упомянутый в `docs/ARCHITECTURE.md`).
- Карточка «Онлайн сейчас» — `users_online_now`.
- Карточка/мини-блок «Тарифы» — `users_by_tier` как набор Chip (переиспользовать
  `TIER_LABELS`/`TIER_COLORS`, уже определены в файле строки 34-46), без
  отдельной таблицы — компактный ряд цветных Chip с числами.
- Карточка «Rate limit Stalcraft API» — в зависимости от выбранного варианта
  (А/Б, открытый вопрос №1): либо `tokens_available/capacity` (Вариант A) с
  прогресс-баром, либо `requests_last_60s/400` (Вариант B) с тем же
  прогресс-баром, плюс цветовая индикация (зелёный <50%, жёлтый 50-80%,
  красный >80%, по аналогии с порогами в CLAUDE.md: текущее 13.6% = безопасно).
  Если показывается "живая" метрика — обновлять опросом (`setInterval`,
  например раз в 10-15 сек, по аналогии с поллингом 30 сек в
  `MonitoringPage`/`GlobalFeed`, упомянутым в `docs/ARCHITECTURE.md:94`), не
  загружать вместе с `/admin/users` единоразово.

`loadStats()` — новая функция, аналогичная `loadUsers()`/`loadRegistrationSettings()`
(строки 113-137), дёргает `GET /admin/stats`. Если метрика rate-limit "живая" —
отдельный `useEffect` с `setInterval` только для неё (не перезагружать весь
`/admin/stats`, если остальные метрики статичны и не требуют частого обновления
— или же просто перезагружать весь объект целиком раз в 10-15 сек, если
backend-нагрузка от этого пренебрежимо мала — на откуп backend-dev/frontend-dev,
не принципиально для UX).

## Документация для обновления

- `docs/NOTES.md`: после реализации — отметить эту подзадачу роадмапа
  подписок как закрытую (роадмап остаётся открытым пунктом, эта фаза — одна
  из его частей).
- `docs/SERVICES.md`: если выбран Вариант B — описать новую Redis-структуру
  `stalcraft:requests:minute:{unix_minute}` рядом с существующим описанием
  `TokenBucketRateLimiter` (строки 367-385), и новый метод
  `get_consumption_stats()`.
- `docs/DATABASE.md`: без изменений, если не появится новая таблица (текущая
  рекомендация — без таблицы).
- `docs/BUSINESS_LOGIC.md`: не затрагивается — эта фаза не вводит новых
  формул расчёта прибыли.

## Порядок реализации (зависимости)

1. **backend-dev** — эндпоинт `GET /admin/stats` в `admin.py`
   (`AdminStatsResponse`), плюс (после подтверждения варианта A/B) изменения
   в `rate_limiter.py`.
2. **frontend-dev** — после того как backend-dev подтвердит точную форму
   JSON-ответа `/admin/stats` — новый блок карточек в `AdminPage.tsx`.
3. **tech-writer** — обновление `docs/SERVICES.md` (если Вариант B) и
   `docs/NOTES.md`.

Декомпозиция на отдельные backend/frontend ТЗ-файлы не требуется — скоуп
небольшой (один новый эндпоинт + один новый блок UI), оба агента читают один
документ.

## Открытые вопросы / требует подтверждения

1. **Вариант A vs B для rate-limit метрики (АРХИТЕКТУРНОЕ РЕШЕНИЕ, нужно
   подтверждение пользователя).**
   - **Вариант A** (снэпшот остатка через существующий `get_status()`) — zero
     новый код в hot path `acquire()`, но показывает "сейчас в корзине X из
     400 токенов", не "запросов в минуту тратится". Менее информативно, но
     абсолютно без риска для rate limit/производительности.
   - **Вариант B** (новый счётчик `INCRBY` с TTL на каждый `acquire()`) —
     показывает интуитивно понятную метрику "запросов/мин сейчас", совпадающую
     по смыслу с цифрой "54.5/мин (13.6%)" из CLAUDE.md/README, но добавляет
     одну Redis-операцию на каждый вызов `acquire()` (затрагивает код, который
     дёргается на каждый HTTP-запрос к Stalcraft — то есть **меняет горячий
     путь, связанный с rate limit**, хотя сам лимит Stalcraft API не
     затрагивается, это доп. нагрузка только на Redis).
   Рекомендация исследователя — **Вариант B упрощённый** (один минутный
   INCR-ключ, без sorted set и без часовой агрегации), как баланс между
   полезностью метрики и минимальностью изменений. Но раз это касается кода
   на пути взаимодействия с rate limiter — явно прошу подтверждения перед
   тем, как поручать backend-dev (по правилу CLAUDE.md: изменения, влияющие
   на частоту/механику опроса rate limit, требуют подтверждения пользователя).

2. **Семантика "уникальных карточек".** Зафиксировано как `DISTINCT
   (item_id, region) WHERE is_active=true` — то есть ровно те пары, что
   реально дедуплицируются коллектором при обращении к Stalcraft API (см.
   `collectors.py:59-62`). Альтернатива — считать по полному ключу
   уникальности watchlist-записи (включая `quality_filter`/`enchant_filter`)
   дала бы другое (большее) число, но оно не отражает реальную нагрузку на
   API — текущая рекомендация (без фильтров) кажется однозначно правильной
   по факту архитектуры, но фиксирую как явное решение на случай, если
   пользователь имел в виду другую метрику.

3. **Нужна ли "живая" автообновляемая rate-limit карточка (поллинг) или
   достаточно снэпшота на момент открытия страницы админки** — влияет на то,
   добавлять ли `setInterval` на фронте. Минимальный скоуп — без поллинга
   (обновляется при заходе на страницу/ручном рефреше), это меньше нагрузки
   и кода. Рекомендация — начать без поллинга (Simplicity First), добавить
   позже при запросе.

4. **Состав метрик "здоровья системы" сверх двух названных в NOTES.md.**
   Предложены: `users_by_tier`, `users_online_now`, `total_watchlist_entries`
   (для контраста с уникальными парами). Это минимальные производные той же
   природы, что уже выведена в блоке Stats (количества), не новые фичи.
   Если пользователь хочет более узкий скоуп (только 2 метрики из NOTES.md,
   без тарифной разбивки/онлайна) — это сокращение тривиально перед началом
   реализации.
