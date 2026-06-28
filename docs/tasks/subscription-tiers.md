# ТЗ: Система тарифов (Phase 0) — фундамент для всего роадмапа

## Контекст

Согласован роадмап из 8 фаз (тарифы/подписки, админ-статистика, новости, форма
обращений, кросс-юзерная агрегация watchlist, FAQ-онбординг). Phase 0 — самая
фундаментальная: вводит 5 уровней доступа (`base` / `advanced` /
`advanced_plus` / `advanced_max` / admin), от которых зависят лимиты карточек
watchlist, доступ к Telegram-уведомлениям, доступ к разделу «Лоты» (поиск
аукциона) и набор окон статистики продаж (24ч/48ч/7д/30д). Параллельно вводятся
настройки авто-подтверждения регистрации (сейчас одобрение только вручную) и
закрывается попутный баг авторизации (`get_current_user` не проверяет
`is_approved`/`is_active`).

Это ТЗ покрывает backend (модели, миграции, эндпоинты, Celery, бот) и frontend
(админка, авторизация, watchlist, навигация). Архитектура согласована с
пользователем заранее — переосмысливать подход не требуется, только зафиксировать
точные сигнатуры/пути под текущий код.

## Текущий код — зафиксированные факты (важно для backend-dev/frontend-dev)

- Alembic head на момент исследования: **`0025_dedup_sales_history.py`** →
  новые миграции начинаются с `0026`.
- `User` (`backend/app/models/models.py:14-31`): `id, username, email,
  password_hash, telegram_username, telegram_chat_id, is_active, is_admin,
  is_approved, created_at, updated_at`. Нет `tier`, `last_seen` и т.п.
- `MarketStatistics` (`backend/app/models/models.py:165-200`): уже есть
  `avg_price_24h/min_price_24h/max_price_24h/sales_volume_24h` (24ч) и
  `*_7d`/`*_30d` поля. **48ч полей нет вообще.**
- `get_current_user` (`backend/app/core/dependencies.py:13-26`) фильтрует
  только `User.is_active == True` — **подтверждён баг**: пользователь с
  `is_approved=False` (или отозванный админом через `/admin/users/{id}/revoke`,
  который трогает только `is_approved`, не `is_active`) проходит аутентификацию
  и может пользоваться API. Это существующий баг, чиним попутно (см. раздел Backend, п.0).
- `register()` (`backend/app/api/v1/endpoints/auth.py:48-67`) сейчас всегда
  создаёт `is_approved=False`, ждёт ручного `approve_user`.
- `approve_user` (`backend/app/api/v1/endpoints/admin.py:38-49`) сейчас только
  `user.is_approved = True`, без выставления тарифа.
- `add_to_watchlist` (`backend/app/api/v1/endpoints/watchlist.py:89-138`) не
  имеет лимита по количеству записей.
- `get_category_lots` / `get_item_lots` (`backend/app/api/v1/endpoints/lots.py:154-285`)
  гейтятся только `Depends(get_current_user)`, без проверки тарифа.
- `get_item_stats` (`backend/app/api/v1/endpoints/monitoring.py:78-…`) отдаёт
  все окна статистики без проверки тарифа на фронте/бэке.
- `notify_profitable_lots` (`telegram_bot/bot.py:147-184`) — отдельный процесс
  (polling), отбирает пользователей условием (строки 156-169):
  ```python
  rows = (await db.execute(
      select(User, UserSettings)
      .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
      .where(User.telegram_chat_id.isnot(None), User.is_active == True)
  )).all()
  users_to_notify = [(user, us) for user, us in rows if us is None or us.notify_telegram]
  ```
  Нужно добавить третье условие (тариф разрешает уведомления ИЛИ admin).
  Привязка Telegram (`/telegram/link-code`, `/telegram/webhook`,
  `backend/app/api/v1/endpoints/telegram.py`) НЕ трогается — одинакова для всех тарифов.
- Расчёт статистики — `calculate_market_stats()` в
  `backend/app/services/analytics/market_stats.py:54-…`. Паттерн для каждого
  окна: `cutoff_Xh/d`, фильтрация `prices_X`, `safe_stats()`, присвоение в
  `existing.*` (строки 285-296). 24ч-блок — точная модель для добавления 48ч.
  Вызывается из `calculate_stats_single` (одна пара item/region, по требованию)
  и `calculate_all_market_stats` (раз в час, beat `crontab(minute="5")`,
  `backend/app/tasks/analyzers.py:20-70`, `backend/app/tasks/celery_app.py:43-46`).
- `beat_schedule` (`backend/app/tasks/celery_app.py:25-54`): сбор лотов каждые
  20с, история раз в час, очистка БД `crontab(hour=3, minute=0)`, статистика
  `crontab(minute="5")`, сверка прогнозов `crontab(hour=4, minute=30)`. Новая
  sweep-задача тарифов **не обращается к Stalcraft API** → не влияет на rate
  limit, подтверждение пользователя на неё не требуется.
- Frontend: `User` интерфейс в `frontend/src/store/authStore.ts:5-12` —
  `id, username, email, telegram_username, is_admin, is_approved`. Нет `tier`.
- `AdminPage.tsx` (`frontend/src/pages/AdminPage.tsx`) — таблица из 5 колонок
  (`Пользователь, Email, Статус, Зарегистрирован, Действие`), без тарифов.
  `AdminUser` interface — строки 28-37.
- `Layout.tsx` → `NAV_ITEMS` (`frontend/src/components/Layout.tsx:12-33`) —
  пункт «Лоты» (`to: '/app/lots'`) рендерится для всех без проверки тарифа.
  Роут `/app/lots` зарегистрирован в `App.tsx:58` без серверного гейта на фронте
  (бэкенд должен быть финальной защитой, фронт — UX-уровень).
- `MonitoringPage.tsx` строка 196: заголовок `ИЗБРАННОЕ · {watchlist.length}` —
  естественное место для индикатора лимита `X/Y карточек`.

## Затронутые файлы

### Backend
- `backend/app/models/models.py` — User (новые поля), MarketStatistics (48ч поля), новая таблица `RegistrationSettings`.
- `backend/alembic/versions/0026_*.py`, `0027_*.py`, `0028_*.py` (см. план миграций ниже).
- `backend/app/core/tiers.py` — **новый файл**, центральная точка истины по лимитам тарифов.
- `backend/app/core/dependencies.py` — `get_current_user` (фикс бага + `last_seen` throttled update), новая зависимость для гейтинга тарифа.
- `backend/app/api/v1/endpoints/auth.py` — `register()`, `UserResponse`.
- `backend/app/api/v1/endpoints/admin.py` — `list_users`, `approve_user`, новые эндпоинты тарифов и registration_settings.
- `backend/app/api/v1/endpoints/watchlist.py` — `add_to_watchlist` (лимит по тарифу).
- `backend/app/api/v1/endpoints/lots.py` — `get_category_lots`, `get_item_lots` (гейт по тарифу).
- `backend/app/api/v1/endpoints/monitoring.py` — `get_item_stats` (фильтр окон по тарифу).
- `backend/app/services/analytics/market_stats.py` — `calculate_market_stats()` (48ч блок).
- `backend/app/tasks/analyzers.py` — без изменения сигнатур (48ч считается внутри `calculate_market_stats`).
- `backend/app/tasks/celery_app.py` — новая beat-задача sweep понижения тарифов.
- `backend/app/tasks/cleanup.py` (или новый `backend/app/tasks/tiers.py` — см. открытый вопрос) — Celery task sweep.
- `telegram_bot/bot.py` — `notify_profitable_lots` (~строка 147-184), третье условие гейтинга.

### Frontend
- `frontend/src/store/authStore.ts` — `User` interface (+`tier`, `tier_expires_at`).
- `frontend/src/pages/AdminPage.tsx` — новые колонки, UI смены тарифа, карточка настроек авто-подтверждения.
- `frontend/src/pages/MonitoringPage.tsx` — индикатор `X/Y карточек` у заголовка «Избранное».
- `frontend/src/components/Layout.tsx` — скрытие/disabled пункта «Лоты» для тарифов без доступа к аукциону.

## Изменения по слоям

### Backend

**0. Фикс существующего бага в `get_current_user`**

Сейчас (`backend/app/core/dependencies.py:13-26`) проверяется только
`is_active`. Добавить проверку `is_approved == True` (кроме `is_admin`, на
случай если у админа исторически `is_approved=False`, хотя по факту админы
всегда approved — для безопасности admin тоже должен требовать
`is_active`). Точная логика:

```python
user = (await db.execute(
    select(User).where(User.id == user_id, User.is_active == True)
)).scalar_one_or_none()
if not user:
    raise HTTPException(status_code=401, detail="User not found")
if not user.is_approved and not user.is_admin:
    raise HTTPException(status_code=403, detail="Account not approved")
```

Здесь же добавить throttled обновление `last_seen` (см. п.6).

**1. Модуль `backend/app/core/tiers.py` — центральная точка истины**

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class TierLimits:
    watchlist_limit: int | None       # None = без лимита (admin)
    telegram_notifications: bool
    stats_windows: tuple[str, ...]    # подмножество ("24h","48h","7d","30d")
    auction_access: bool

TIERS: dict[str, TierLimits] = {
    "base":          TierLimits(watchlist_limit=6,  telegram_notifications=False, stats_windows=("24h",),                    auction_access=False),
    "advanced":      TierLimits(watchlist_limit=10, telegram_notifications=True,  stats_windows=("24h","48h"),                auction_access=False),
    "advanced_plus": TierLimits(watchlist_limit=20, telegram_notifications=True,  stats_windows=("24h","48h","7d"),           auction_access=True),
    "advanced_max":  TierLimits(watchlist_limit=25, telegram_notifications=True,  stats_windows=("24h","48h","7d","30d"),     auction_access=True),
}

DEFAULT_TIER = "base"

def get_tier_limits(user) -> TierLimits:
    """is_admin обходит все лимиты целиком, независимо от user.tier."""
    if user.is_admin:
        return TierLimits(watchlist_limit=None, telegram_notifications=True,
                           stats_windows=("24h","48h","7d","30d"), auction_access=True)
    return TIERS.get(user.tier, TIERS[DEFAULT_TIER])
```

Дополнительно — функция `effective_tier(user) -> str`, которая лениво
применяет понижение (см. п.2), и используется везде, где нужен текущий тариф
пользователя (не читать `user.tier` напрямую в эндпоинтах).

**2. Ленивое понижение тарифа при истечении**

В `get_current_user` (после фикса бага из п.0) или в отдельной shared-функции
`apply_tier_expiry(user, db) -> None`, вызываемой из `get_current_user`:

```python
if (user.tier != "base" and not user.is_admin
        and user.tier_expires_at is not None
        and user.tier_expires_at < datetime.now(timezone.utc)):
    user.tier = "base"
    user.tier_expires_at = None
    await deactivate_excess_watchlist(user.id, TIERS["base"].watchlist_limit, db)  # см. открытый вопрос №5 — решено
    await db.commit()
```

Это не на каждый запрос лишняя нагрузка — `tier_expires_at` не NULL только для
платных тарифов с установленным сроком, проверка — дешёвое сравнение в памяти,
commit только при реальном переходе.

**3. Ежесуточная Celery beat задача sweep**

Новый файл `backend/app/tasks/tiers.py` (выбран отдельный файл, не
`cleanup.py` — логически другая зона ответственности, не про удаление данных,
а про целостность тарифов; `tech-writer` зафиксирует в SERVICES.md):

```python
@celery_app.task(name="app.tasks.tiers.sweep_expired_tiers")
def sweep_expired_tiers():
    """Понижает до base всех пользователей с истёкшим tier_expires_at.
    Дополняет ленивое понижение — гарантирует, что админка не показывает
    устаревший тариф у давно неактивных пользователей."""
    async def _run():
        from app.db.session import get_celery_db_session
        from app.models.models import User
        from sqlalchemy import select, update
        from datetime import datetime, timezone
        async with get_celery_db_session() as db:
            expired_ids = (await db.execute(
                select(User.id).where(
                    User.tier != "base", User.is_admin == False,
                    User.tier_expires_at.isnot(None),
                    User.tier_expires_at < datetime.now(timezone.utc),
                )
            )).scalars().all()
            for user_id in expired_ids:
                await deactivate_excess_watchlist(user_id, TIERS["base"].watchlist_limit, db)
            await db.execute(
                update(User)
                .where(User.id.in_(expired_ids))
                .values(tier="base", tier_expires_at=None)
            )
            await db.commit()
    run_async(_run())
```
(деактивация лишних карточек — решённый открытый вопрос №5, см. ниже; вызывается по каждому затронутому `user_id` до коммита смены тарифа)

Регистрация в `celery_app.py`: добавить `"app.tasks.tiers"` в `include=[...]`
и в `beat_schedule`:
```python
"sweep-expired-tiers": {
    "task": "app.tasks.tiers.sweep_expired_tiers",
    "schedule": crontab(hour=3, minute=30),  # между cleanup (3:00) и stats (минута 5 каждого часа)
},
```
Не дёргает Stalcraft API — не требует подтверждения по rate limit.

**4. Миграции** (план — 3 файла, без лишних ALTER TABLE на одной таблице)

`backend/alembic/versions/0026_user_tiers.py`:
```python
revision = "0026"
down_revision = "0025"

def upgrade():
    op.add_column("users", sa.Column("tier", sa.String(20), nullable=False, server_default="base"))
    op.add_column("users", sa.Column("tier_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("has_market_radar_addon", sa.Boolean(), nullable=False, server_default="false"))
    # Существующие is_admin=True — тариф не важен (обходят гейты), но выставим
    # advanced_max для консистентности отображения в админке:
    op.execute("UPDATE users SET tier = 'advanced_max' WHERE is_admin = true")
```
(один файл — все 4 новых поля `users` за раз, как просил пользователь — не плодить ALTER TABLE).

`backend/alembic/versions/0027_market_stats_48h.py`:
```python
revision = "0027"
down_revision = "0026"

def upgrade():
    op.add_column("market_statistics", sa.Column("avg_price_48h", sa.Numeric(12, 2), nullable=True))
    op.add_column("market_statistics", sa.Column("min_price_48h", sa.BigInteger(), nullable=True))
    op.add_column("market_statistics", sa.Column("max_price_48h", sa.BigInteger(), nullable=True))
    op.add_column("market_statistics", sa.Column("sales_volume_48h", sa.Integer(), nullable=True))
```

`backend/alembic/versions/0028_registration_settings.py`:
```python
revision = "0028"
down_revision = "0027"

def upgrade():
    op.create_table(
        "registration_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("auto_approve_enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("default_tier", sa.String(20), nullable=False, server_default="base"),
        sa.Column("default_tier_duration_days", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )
    op.execute("INSERT INTO registration_settings (id, auto_approve_enabled, default_tier) VALUES (1, false, 'base')")
```

**5. Модели — добавить в `backend/app/models/models.py`**

В класс `User` (после `is_approved`):
```python
tier                   = Column(String(20), nullable=False, server_default="base")
tier_expires_at        = Column(DateTime(timezone=True), nullable=True)
last_seen              = Column(DateTime(timezone=True), nullable=True)
has_market_radar_addon = Column(Boolean, nullable=False, default=False, server_default="false")
```

В `MarketStatistics` (после `sales_volume_24h`):
```python
avg_price_48h    = Column(Numeric(12, 2))
min_price_48h    = Column(BigInteger)
max_price_48h    = Column(BigInteger)
sales_volume_48h = Column(Integer)
```

Новая модель (синглтон):
```python
class RegistrationSettings(Base):
    __tablename__ = "registration_settings"
    id                         = Column(Integer, primary_key=True)
    auto_approve_enabled       = Column(Boolean, default=False, server_default="false")
    default_tier               = Column(String(20), default="base", server_default="base")
    default_tier_duration_days = Column(Integer, nullable=True)
    updated_at                 = Column(DateTime(timezone=True), onupdate=func.now())
```

**6. `last_seen` — throttled update в `get_current_user`**

Обновлять не чаще раза в 60 сек на пользователя. Рекомендуемый подход — Redis
SETNX/TTL (так же, как `manual_refresh` throttle в `watchlist.py:204-216`),
чтобы не делать SELECT на каждый запрос для проверки "обновлялось ли только что":
```python
import redis.asyncio as aioredis
from app.core.config import settings

r = await aioredis.from_url(settings.redis_url, decode_responses=True)
throttle_key = f"last_seen:{user.id}"
if not await r.exists(throttle_key):
    await r.setex(throttle_key, 60, "1")
    user.last_seen = datetime.now(timezone.utc)
    await db.commit()
await r.aclose()
```
"Онлайн" в админке — вычисляется на чтении: `last_seen >= now() - 5 минут`
(не хранится отдельным полем).

**7. Гейтинг watchlist (`backend/app/api/v1/endpoints/watchlist.py`)**

В `add_to_watchlist`, после проверки на дубликат (строка ~113), перед
созданием `entry`:
```python
from app.core.tiers import get_tier_limits

limits = get_tier_limits(current_user)
if limits.watchlist_limit is not None:
    count = (await db.execute(
        select(func.count()).select_from(UserWatchlist).where(
            UserWatchlist.user_id == current_user.id,
            UserWatchlist.is_active == True,
        )
    )).scalar_one()
    if count >= limits.watchlist_limit:
        raise HTTPException(status_code=403, detail=f"Лимит карточек watchlist для вашего тарифа: {limits.watchlist_limit}")
```
(нужно добавить импорт `func` из `sqlalchemy` — уже импортирован `select,
delete`, добавить `func`).

**8. Гейтинг аукциона (`backend/app/api/v1/endpoints/lots.py`)**

В обоих эндпоинтах (`get_category_lots`, `get_item_lots`) заменить
`_: User = Depends(get_current_user)` на явную проверку:
```python
current_user: User = Depends(get_current_user),
...
from app.core.tiers import get_tier_limits
if not get_tier_limits(current_user).auction_access:
    raise HTTPException(status_code=403, detail="Доступ к поиску лотов недоступен на вашем тарифе")
```

**9. Гейтинг окон статистики (`backend/app/api/v1/endpoints/monitoring.py`)**

`get_item_stats` — добавить `current_user: User = Depends(get_current_user)`
(уже есть параметром), получить `limits = get_tier_limits(current_user)` и
обнулить в ответе поля окон, не разрешённых тарифом, перед возвратом
`MonitoringItemResponse` (например, если `"30d" not in limits.stats_windows` —
`sales_volume_30d=None, price_volatility_30d=None` и т.п.; для 48ч —
добавить новые поля в `MonitoringItemResponse`, см. ниже). Подход: не
прятать данные на уровне SQL-запроса (статистика всё равно глобальная и
общая для всех), а маскировать в Pydantic-ответе по тарифу — проще и
не дублирует логику расчёта.

Добавить в `MonitoringItemResponse` новые поля:
```python
avg_price_48h: float | None
min_price_48h: int | None
max_price_48h: int | None
sales_volume_48h: int | None
```
и заполнять их из `stats.avg_price_48h` и т.д. (по аналогии с `_24h`, которых
сейчас нет в ответе вообще — **важно**: текущий response не отдаёт 24h-поля
никак, только 7d/30d. Решение: добавить и `avg_price_24h`/`sales_volume_24h`
в ответ заодно с 48h, раз уже трогаем этот response — иначе 24h-окно тарифа
`base` не будет видно на фронте никаким образом).

**10. 48-часовое окно в `calculate_market_stats`**

В `backend/app/services/analytics/market_stats.py`, рядом с `cutoff_24h`
(строка 67):
```python
cutoff_48h = now - timedelta(hours=48)
...
prices_48h = [s.price_per_unit for s in sales_30d if s.sale_time >= cutoff_48h]
...
s48 = safe_stats(prices_48h)
...
existing.avg_price_48h    = s48.get("avg")
existing.min_price_48h    = s48.get("min")
existing.max_price_48h    = s48.get("max")
existing.sales_volume_48h = s48.get("count", 0)
```
(добавляется в том же месте, где `s24`/присвоение `existing.avg_price_24h`
и т.д., строки 83-98 и 285-288 — точечная вставка, не переписывание функции).

**Бэкафилл 48ч из `sales_history`**: `sales_history` хранит 120 дней — данных
достаточно для пересчёта 48ч окна сразу после релиза без ожидания. Рекомендация:
**да, сделать разовый бэкафилл** — после деплоя миграций вызвать
`calculate_all_market_stats.delay()` вручную (или дождаться обычного часового
прогона `crontab(minute="5")` — он пересчитает все активные пары и заполнит
48ч поля автоматически в течение часа). Дополнительный скрипт миграции данных
не нужен: обычный пересчёт уже покроет все активные watchlist-пары. Item'ы,
которые не в watchlist ни у кого, не имеют записи в `market_statistics`
независимо от окна — не отличается от текущего поведения 24h/7d/30d.

**11. Гейтинг Telegram-уведомлений (`telegram_bot/bot.py`)**

В `notify_profitable_lots` (строка ~156-169), запрос нужно расширить выборкой
`User.tier` (он уже есть в объекте `User` через ORM, дополнительный SELECT не
нужен) и третьим условием в list comprehension:
```python
from app.core.tiers import get_tier_limits  # импорт наверху файла

users_to_notify = [
    (user, us) for user, us in rows
    if (us is None or us.notify_telegram)
    and (user.is_admin or get_tier_limits(user).telegram_notifications)
]
```
Замечание: `telegram_bot/bot.py` работает в отдельном контейнере, импортирует
`app.models.models` и `app.services.profitable_lots` напрямую (строка 34-35) —
`app.core.tiers` доступен тем же путём (`sys.path.insert(0, "/app")`, строка 33),
без дополнительных изменений Dockerfile/volume.
**Не трогать**: ленивое понижение тарифа здесь НЕ применяется (бот не делает
commit пользователей) — устаревший `user.tier` в худшем случае на час
(до следующего sweep в 3:30) даст лишнее уведомление платному-но-уже-base
пользователю; не критично, чинится sweep'ом и при следующем логине пользователя.

**12. Admin-эндпоинты (`backend/app/api/v1/endpoints/admin.py`)**

`UserAdminResponse` — добавить поля:
```python
tier: str
tier_expires_at: datetime | None
last_seen: datetime | None
is_online: bool          # вычисляемое, не из модели
watchlist_count: int      # подзапрос
```

`list_users` — расширить запрос подзапросом подсчёта watchlist и вычислением
`is_online`:
```python
@router.get("/users", response_model=list[UserAdminResponse])
async def list_users(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_admin)):
    from datetime import datetime, timezone, timedelta
    wl_counts_subq = (
        select(UserWatchlist.user_id, func.count().label("cnt"))
        .where(UserWatchlist.is_active == True)
        .group_by(UserWatchlist.user_id)
        .subquery()
    )
    rows = (await db.execute(
        select(User, func.coalesce(wl_counts_subq.c.cnt, 0))
        .outerjoin(wl_counts_subq, wl_counts_subq.c.user_id == User.id)
        .order_by(User.created_at.desc())
    )).all()

    online_threshold = datetime.now(timezone.utc) - timedelta(minutes=5)
    return [
        UserAdminResponse(
            **{c.name: getattr(user, c.name) for c in User.__table__.columns},
            is_online=bool(user.last_seen and user.last_seen >= online_threshold),
            watchlist_count=count,
        )
        for user, count in rows
    ]
```
(точная реализация — на откуп backend-dev; суть — один подзапрос, без N+1).

Новые эндпоинты:
```python
class TierUpdateRequest(BaseModel):
    tier: str                       # base | advanced | advanced_plus | advanced_max
    expires_at: datetime | None = None

@router.post("/users/{user_id}/tier")
async def set_user_tier(user_id: int, payload: TierUpdateRequest, db=..., current_admin=...):
    """Ручная установка тарифа + даты окончания."""
    # валидация payload.tier in TIERS, 404 если user не найден
    new_limit = TIERS[payload.tier].watchlist_limit
    if new_limit is not None:
        await deactivate_excess_watchlist(user_id, new_limit, db)  # решённый открытый вопрос №5
    user.tier = payload.tier
    user.tier_expires_at = payload.expires_at
    await db.commit()
    return {"ok": True}


class TierExtendRequest(BaseModel):
    delta: Literal["1d", "1w", "1m"]

@router.post("/users/{user_id}/tier/extend")
async def extend_user_tier(user_id: int, payload: TierExtendRequest, db=..., current_admin=...):
    """Продление от max(текущий tier_expires_at или now(), now()) + delta."""
    delta_map = {"1d": timedelta(days=1), "1w": timedelta(weeks=1), "1m": timedelta(days=30)}
    now = datetime.now(timezone.utc)
    base_time = max(user.tier_expires_at or now, now)
    user.tier_expires_at = base_time + delta_map[payload.delta]
    await db.commit()
    return {"ok": True, "tier_expires_at": user.tier_expires_at}
```

`approve_user` — добавить явный `user.tier = "base"`:
```python
user.is_approved = True
user.tier = "base"
await db.commit()
```

Registration settings эндпоинты:
```python
class RegistrationSettingsResponse(BaseModel):
    auto_approve_enabled: bool
    default_tier: str
    default_tier_duration_days: int | None

class RegistrationSettingsUpdate(BaseModel):
    auto_approve_enabled: bool
    default_tier: str
    default_tier_duration_days: int | None

@router.get("/settings/registration", response_model=RegistrationSettingsResponse)
async def get_registration_settings(db=..., _: User = Depends(get_current_admin)):
    settings_row = (await db.execute(select(RegistrationSettings).where(RegistrationSettings.id == 1))).scalar_one()
    return settings_row

@router.put("/settings/registration", response_model=RegistrationSettingsResponse)
async def update_registration_settings(payload: RegistrationSettingsUpdate, db=..., _: User = Depends(get_current_admin)):
    settings_row = (await db.execute(select(RegistrationSettings).where(RegistrationSettings.id == 1))).scalar_one()
    settings_row.auto_approve_enabled = payload.auto_approve_enabled
    settings_row.default_tier = payload.default_tier
    settings_row.default_tier_duration_days = payload.default_tier_duration_days
    await db.commit()
    return settings_row
```

**13. `register()` в `backend/app/api/v1/endpoints/auth.py`**

```python
from app.models.models import RegistrationSettings
from datetime import datetime, timezone, timedelta

@router.post("/register", response_model=RegisterResponse, status_code=201)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = ...  # без изменений

    reg_settings = (await db.execute(select(RegistrationSettings).where(RegistrationSettings.id == 1))).scalar_one_or_none()
    auto_approve = reg_settings.auto_approve_enabled if reg_settings else False

    user = User(
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        is_approved=auto_approve,
        tier=(reg_settings.default_tier if auto_approve and reg_settings else "base"),
        tier_expires_at=(
            datetime.now(timezone.utc) + timedelta(days=reg_settings.default_tier_duration_days)
            if auto_approve and reg_settings and reg_settings.default_tier_duration_days
            else None
        ),
    )
    db.add(user)
    await db.flush()
    db.add(UserSettings(user_id=user.id))
    await db.commit()

    msg = "Регистрация успешна." if auto_approve else "Регистрация успешна. Ожидайте подтверждения администратора."
    return RegisterResponse(message=msg)
```
**Явно НЕ входит**: привязка Telegram при регистрации — не упоминается и не
реализуется, тема отложена в отдельную (более позднюю) фазу роадмапа.

`UserResponse` (auth.py) и `me()` — добавить `tier`, `tier_expires_at` в ответ
(фронту нужно знать свой тариф для UI-гейтинга навигации/лимитов).

### Frontend

**`frontend/src/store/authStore.ts`**
```typescript
interface User {
  id: number
  username: string
  email: string
  telegram_username: string | null
  is_admin: boolean
  is_approved: boolean
  tier: string
  tier_expires_at: string | null
}
```

**`frontend/src/pages/AdminPage.tsx`**
- `AdminUser` interface — добавить `tier, tier_expires_at, last_seen, is_online, watchlist_count`.
- Таблица — новые колонки: «Тариф» (Chip с цветом по уровню), «До» (дата
  окончания или «—» для безлимитного), «Был онлайн» (relative time +
  зелёная/серая точка для is_online), «Карточек» (`watchlist_count`).
- UI смены тарифа в ячейке/попапе на строку: dropdown (5 опций тарифов, без
  admin как выбираемой опции — admin ставится отдельно через `is_admin`, не
  через `tier`), кнопки `+1д` / `+1нед` / `+1мес` (зовут `POST
  /admin/users/{id}/tier/extend`), календарь (MUI `DatePicker` или native
  `<input type="date">`, если `@mui/x-date-pickers` ещё не используется в
  проекте — проверить перед добавлением новой зависимости) для точной даты
  через `POST /admin/users/{id}/tier`.
- Новая карточка «Настройки авто-подтверждения» (над таблицей пользователей,
  стиль как существующий блок Stats/Tasks): тумблер `auto_approve_enabled`,
  dropdown `default_tier`, текстовое поле "дней" (`default_tier_duration_days`,
  пустое = без срока), кнопка «Сохранить» → `PUT /admin/settings/registration`.
  Загрузка текущих значений при маунте через `GET /admin/settings/registration`.

**`frontend/src/pages/MonitoringPage.tsx`**
- У заголовка «ИЗБРАННОЕ · {watchlist.length}» (строка 196) добавить лимит из
  `user.tier` через локальную копию `TIERS` лимитов на фронте (см. открытый
  вопрос про дублирование констант) — например «ИЗБРАННОЕ · 6/6» с подсветкой
  (gold/danger), когда `watchlist.length >= limit`. Кнопка добавления в
  watchlist — disabled state + тултип «Лимит карточек для вашего тарифа» при
  достижении лимита (опционально, backend всё равно вернёт 403 — фронт только
  UX-подсказка, не единственная защита).

**`frontend/src/components/Layout.tsx`**
- `NAV_ITEMS` — пункт «Лоты» рендерить как disabled/скрытый (выбрать один
  подход — рекомендация: показывать, но с серой иконкой замка и
  `onClick`-перехватом + тултип «Доступно на тарифах Продвинутая Плюс/Макс»,
  не скрывать полностью — UX-подсказка о возможности апгрейда тарифа лучше
  конвертит, чем полное скрытие пункта меню). Условие — `user.tier` в
  `['advanced_plus', 'advanced_max']` или `user.is_admin`.

## Документация для обновления

- `docs/NOTES.md`: closed-задача после реализации; до этого — можно добавить
  пункт в очередь, ссылающийся на это ТЗ.
- `docs/DATABASE.md`: новые поля `users` (tier, tier_expires_at, last_seen,
  has_market_radar_addon), новые поля `market_statistics` (`*_48h`), новая
  таблица `registration_settings`, обновить таблицу миграций (0026-0028).
- `docs/BUSINESS_LOGIC.md`: описание тарифной матрицы (таблица из 5 тарифов),
  ссылка на `backend/app/core/tiers.py` как источник истины.
- `docs/SERVICES.md`: новая Celery-задача `sweep_expired_tiers`
  (`backend/app/tasks/tiers.py`), обновление beat_schedule, изменение
  `calculate_market_stats` (48ч блок).

## Открытые вопросы / требует подтверждения

1. **Дублирование констант лимитов на фронте.** Backend — `tiers.py`,
   single source of truth. Фронту нужны те же лимиты (watchlist_limit,
   auction_access) для UX (показ "X/Y", блокировка пункта навигации) без
   лишнего round-trip на каждую проверку. Два варианта:
   - (a) Захардкодить зеркальную копию констант в
     `frontend/src/constants/tiers.ts` — риск разъехаться с бэкендом при
     будущих изменениях лимитов, но просто и быстро;
   - (b) Отдавать лимиты текущего пользователя в `/auth/me` response
     (`watchlist_limit`, `auction_access`, `telegram_notifications`,
     `stats_windows` как вычисляемые поля) — единый источник, без
     дублирования, чуть больше работы на backend (вызов `get_tier_limits` в
     `me()`).
   Рекомендация: **(b)** — это не усложнение, а устранение дублирования;
   server остаётся единственным источником истины, фронт просто читает
   готовый объект из `/auth/me`. Прошу подтвердить перед реализацией
   backend-dev, чтобы сразу заложить в `UserResponse`.

2. **`@mui/x-date-pickers` для календаря даты окончания тарифа.** Нужно
   проверить, установлен ли пакет в `frontend/package.json` — если нет,
   потребуется `npm install @mui/x-date-pickers` (плюс date adapter, напр.
   `date-fns`). Альтернатива без новой зависимости — native `<input
   type="date">` в стиле проекта (минимальный риск, никаких новых
   зависимостей). Рекомендация: начать с native input — соответствует
   принципу Simplicity First, апгрейд на красивый picker можно сделать позже
   при наличии запроса от пользователя.

3. **Время sweep-задачи `3:30`** выбрано между `cleanup-old-data` (3:00) и
   часовым пересчётом статистики, чтобы не накладываться — не влияет на
   Stalcraft API, но финальное время на откуп пользователя/backend-dev, если
   есть предпочтение.

4. **РЕШЕНО пользователем:** `tier='advanced_max'` для `is_admin=True` в
   миграции `0026` — оставить как есть (чисто косметика, не влияет на
   лимиты).

5. **РЕШЕНО пользователем:** при понижении тарифа (как авто по истечению,
   так и ручное через `POST /admin/users/{id}/tier` на более низкий тариф)
   лишние карточки watchlist сверх нового лимита **автоматически
   деактивируются** (`is_active=False`), а не остаются висеть. Оставляем
   активными САМЫЕ СТАРЫЕ по `created_at` (первые N по дате добавления, где
   N = новый лимит), деактивируем остальные. Данные не удаляются — только
   `is_active=False`, история/настройки фильтров сохраняются, пользователь
   может вручную реактивировать после возврата на старший тариф (если
   `add_to_watchlist`/реактивация уже учитывает `is_active` при подсчёте
   лимита, что она и делает по п.7 backend-раздела).

   **Реализация:** новая shared-функция, например
   `backend/app/core/tiers.py::deactivate_excess_watchlist(user_id: int,
   new_limit: int, db: AsyncSession) -> None`:
   ```python
   async def deactivate_excess_watchlist(user_id: int, new_limit: int, db: AsyncSession) -> None:
       rows = (await db.execute(
           select(UserWatchlist.id)
           .where(UserWatchlist.user_id == user_id, UserWatchlist.is_active == True)
           .order_by(UserWatchlist.created_at.asc())
           .offset(new_limit)
       )).scalars().all()
       if rows:
           await db.execute(
               update(UserWatchlist).where(UserWatchlist.id.in_(rows)).values(is_active=False)
           )
   ```
   Вызывается из трёх мест после установки `tier='base'` (или любого более
   низкого тарифа) с лимитом меньше текущего:
   - Ленивое понижение в `get_current_user`/`apply_tier_expiry` (п.2) — после
     `user.tier = "base"`, перед `await db.commit()`.
   - Sweep-задача `sweep_expired_tiers` (п.3) — для каждого затронутого
     `user_id` (придётся пройти по строкам, не одним `UPDATE ... WHERE`, так
     как нужен `user_id` для вызова деактивации — либо сделать деактивацию
     одним SQL-запросом с подзапросом per-user через `ROW_NUMBER() OVER
     (PARTITION BY user_id ORDER BY created_at)`, решение на откуп
     backend-dev, что проще поддерживать).
   - `set_user_tier` (п.12, ручная смена админом) — если
     `TIERS[payload.tier].watchlist_limit < текущее кол-во активных карточек`,
     вызвать деактивацию с новым лимитом ПЕРЕД/ПОСЛЕ установки `user.tier`
     (порядок не важен, в одной транзакции).

## Порядок реализации (зависимости)

1. **backend-dev** — весь backend-раздел этого ТЗ (модели → миграции →
   tiers.py → dependencies.py фикс → эндпоинты → Celery → telegram_bot).
   Внутри backend порядок: миграции и модели первыми (всё остальное на них
   опирается), затем `core/tiers.py`, затем `dependencies.py`, затем
   эндпоинты parallel (auth/admin/watchlist/lots/monitoring независимы друг
   от друга), затем `market_stats.py` + `celery_app.py` + `telegram_bot/bot.py`
   в любом порядке.
2. **frontend-dev** — после того как backend-dev задеплоит/подтвердит формат
   ответов `/auth/me`, `/admin/users`, `/admin/settings/registration` (нужны
   точные поля, особенно по открытому вопросу №1 про лимиты в `/auth/me`).
3. **tech-writer** — после подтверждения реализации обоими агентами,
   обновление `docs/DATABASE.md`, `docs/BUSINESS_LOGIC.md`, `docs/SERVICES.md`,
   `docs/NOTES.md`.

Это ТЗ единое (не декомпозировано на отдельные backend/frontend файлы),
так как объём каждого раздела умеренный и оба агента читают один и тот же
контекст согласованной тарифной матрицы — расхождения в трактовке менее
вероятны при общем документе.
