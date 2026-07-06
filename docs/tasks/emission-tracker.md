# ТЗ: Emission-трекер

## Контекст

Stalcraft API предоставляет эндпоинт `GET /{region}/emission`, который возвращает данные
о радиационных выбросах — событиях раз в 4–6 часов, длительностью ~15 мин. Во время
выброса активность на аукционе падает (игроки прячутся), что меняет условия торговли.

Метод `StalcraftClient.get_emission()` (cost=1 токен) уже реализован в клиенте, но
нигде не вызывается. Задача — построить полный pipeline: Celery-задача → хранение →
API-эндпоинты → фронт-виджет → Telegram-уведомления.

NOTES.md (раздел «Незадействованные возможности API») подтверждает: задача включена в
очередь. Дополнительных противопоказаний не обнаружено.

## Архитектурное решение

**Ключевой выбор:** периодичность опроса — 2 минуты вместо предложенных в NOTES.md 5 минут.

Обоснование: выброс длится ~15 минут. При опросе раз в 5 мин задержка уведомления
составит до 5 мин (33% от длительности события). При 2 мин — до 2 мин (13%). Стоимость:
1 запрос каждые 2 мин = 0.5 запросов/мин. При текущей нагрузке 54.5 запросов/мин это
добавляет 0.5/400 = 0.1% от лимита — пренебрежимо мало.

**Требует подтверждения пользователя:** добавляется новая Celery-задача с интервалом
120 секунд (timedelta(seconds=120)).

**Детектирование start/end:** API возвращает `currentStart` (ISO timestamp, если выброс
идёт прямо сейчас) и `previousStart` / `previousEnd`. Детектируем активный выброс через
`currentStart != null`. Переход `None → timestamp` = начало нового выброса (уведомить).
Переход `timestamp → None` = конец выброса (уведомить). Дедупликация через Redis-ключ
с fingerprint текущего события.

**Хранение:** одна таблица `emission_events` (ряд на событие-выброс), не одна запись
на каждый опрос. Размер: ~4–6 событий/сутки × 365 дней = ~1500–2200 записей/год.
Отдельная таблица правильнее, чем добавлять флаг в `collected_data` — emission глобален
(region-level), не привязан к предметам.

**Telegram:** уведомляем всех пользователей у кого `telegram_chat_id IS NOT NULL`
(без гейтинга тарифом — emit-события не предмет тарифной матрицы). Рассылку делаем
в фоне через отдельный async-цикл внутри задачи (не через `NotificationQueue` — она
предназначена для поштучных рекомендаций, а здесь broadcast).

## Затронутые файлы

### Backend
- `backend/app/models/models.py` — добавить модель `EmissionEvent`
- `backend/app/tasks/collectors.py` — добавить `collect_emission()`
- `backend/app/tasks/celery_app.py` — зарегистрировать задачу в `beat_schedule`
- `backend/app/api/v1/endpoints/emission.py` — новый файл, два эндпоинта
- `backend/app/main.py` — подключить `emission_router`
- `backend/alembic/versions/0031_emission_events.py` — новая миграция

### Frontend
- `frontend/src/components/EmissionWidget.tsx` — новый компонент
- `frontend/src/store/emissionStore.ts` — Zustand-стор (polling)
- `frontend/src/components/Layout.tsx` — встроить виджет в `AppNav()`

### Design
Не требуется. Виджет визуально простой (текст + цвет статуса), дизайн-спека встроена
в ТЗ.

---

## Изменения по слоям

### Backend

#### 1. Модель `EmissionEvent` (models/models.py)

Добавить в конец файла после класса `News`:

```python
# ─── Выбросы (emission events) ───────────────────────────────────────────────

class EmissionEvent(Base):
    """Зафиксированный выброс (emission). Одна строка на событие."""
    __tablename__ = "emission_events"

    id          = Column(Integer, primary_key=True)
    region      = Column(String(10), nullable=False)          # "RU", "EU" и т.д.
    started_at  = Column(DateTime(timezone=True), nullable=False)   # currentStart из API
    ended_at    = Column(DateTime(timezone=True), nullable=True)    # NULL пока идёт
    detected_at = Column(DateTime(timezone=True), nullable=False,   # момент обнаружения
                         server_default=func.now())
    notified    = Column(Boolean, nullable=False, default=False)    # Telegram отправлен

    __table_args__ = (
        Index("ix_emission_region_started", "region", "started_at"),
        Index("ix_emission_active", "region", "ended_at"),          # WHERE ended_at IS NULL
    )
```

Поля:
| Поле | Тип | Описание |
|---|---|---|
| `id` | integer PK | Автоинкремент |
| `region` | varchar(10) NOT NULL | Регион: "RU" (основной) |
| `started_at` | timestamptz NOT NULL | `currentStart` из API — время начала выброса |
| `ended_at` | timestamptz NULL | Заполняется когда `currentStart` пропадает из ответа |
| `detected_at` | timestamptz NOT NULL | Когда наша задача зафиксировала событие |
| `notified` | boolean NOT NULL default false | Флаг: Telegram-рассылка выполнена |

Индексы:
- `ix_emission_region_started` (region, started_at) — запросы истории по региону
- `ix_emission_active` (region, ended_at) — быстрый поиск текущего активного события

#### 2. Celery-задача `collect_emission` (tasks/collectors.py)

Добавить в конец файла. Константа вверху файла рядом с остальными:

```python
EMISSION_REDIS_KEY = "emission:current_fingerprint"  # fingerprint текущего выброса
```

Структура задачи:

```python
@celery_app.task(name="app.tasks.collectors.collect_emission", bind=True, max_retries=3)
def collect_emission(self):
    """
    Опрашивает Stalcraft API /emission каждые 2 минуты.
    Детектирует начало/конец выброса, сохраняет в emission_events,
    рассылает Telegram-уведомления.
    """
    run_async(_collect_emission_async())
```

Логика `_collect_emission_async()`:

```python
async def _collect_emission_async():
    from app.db.session import get_celery_db_session as get_db_session
    from app.models.models import EmissionEvent, User
    from app.services.collector.client import stalcraft_client
    from app.services.telegram_sender import send_telegram_message
    from app.core.config import settings
    import redis.asyncio as aioredis

    region = settings.stalcraft_region  # "RU"

    # 1. Получаем данные от API
    data = await stalcraft_client.get_emission(region=region)
    # Ответ: {"currentStart": "2026-07-02T14:00:00Z" | null,
    #          "previousStart": "...", "previousEnd": "..."}
    current_start_raw = data.get("currentStart")  # None если выброса нет

    # 2. Читаем fingerprint предыдущего состояния из Redis
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        prev_fingerprint = await r.get(EMISSION_REDIS_KEY)  # None | ISO-строка

        async with get_db_session() as db:

            if current_start_raw and current_start_raw != prev_fingerprint:
                # --- НАЧАЛО НОВОГО ВЫБРОСА ---
                # Создаём запись в БД
                event = EmissionEvent(
                    region=region,
                    started_at=datetime.fromisoformat(current_start_raw.replace("Z", "+00:00")),
                    ended_at=None,
                    notified=False,
                )
                db.add(event)
                await db.flush()  # получаем event.id

                # Рассылаем Telegram
                await _notify_emission_start(db, event, send_telegram_message)
                event.notified = True
                await db.commit()

                # Обновляем fingerprint
                await r.set(EMISSION_REDIS_KEY, current_start_raw, ex=7200)  # TTL 2ч

            elif not current_start_raw and prev_fingerprint:
                # --- КОНЕЦ ВЫБРОСА ---
                # Находим открытое событие в БД
                from sqlalchemy import select
                result = await db.execute(
                    select(EmissionEvent)
                    .where(EmissionEvent.region == region)
                    .where(EmissionEvent.ended_at.is_(None))
                    .order_by(EmissionEvent.started_at.desc())
                    .limit(1)
                )
                active_event = result.scalar_one_or_none()
                if active_event:
                    active_event.ended_at = datetime.now(timezone.utc)
                    await db.commit()
                    await _notify_emission_end(db, active_event, send_telegram_message)

                # Сбрасываем fingerprint
                await r.delete(EMISSION_REDIS_KEY)

            # else: состояние не изменилось — ничего не делаем
    finally:
        await r.aclose()
```

Вспомогательные функции:

```python
async def _notify_emission_start(db, event: EmissionEvent, send_fn) -> None:
    """Рассылает Telegram всем пользователям с chat_id."""
    from app.models.models import User
    from sqlalchemy import select
    users = (await db.execute(
        select(User.telegram_chat_id)
        .where(User.telegram_chat_id.isnot(None))
        .where(User.is_active == True)
        .where(User.is_approved == True)
    )).scalars().all()

    # Локальное время (UTC+3)
    local_time = event.started_at.astimezone(timezone(timedelta(hours=3)))
    time_str = local_time.strftime("%H:%M")

    text = (
        f"<b>Выброс начался</b>\n"
        f"Время: {time_str} МСК\n"
        f"Аукционная активность снижена (~15 мин)"
    )
    for chat_id in users:
        await send_fn(chat_id, text)


async def _notify_emission_end(db, event: EmissionEvent, send_fn) -> None:
    """Рассылает Telegram о завершении выброса."""
    from app.models.models import User
    from sqlalchemy import select
    users = (await db.execute(
        select(User.telegram_chat_id)
        .where(User.telegram_chat_id.isnot(None))
        .where(User.is_active == True)
        .where(User.is_approved == True)
    )).scalars().all()

    duration_min = None
    if event.ended_at and event.started_at:
        delta = event.ended_at - event.started_at
        duration_min = round(delta.total_seconds() / 60)

    dur_str = f" (длился {duration_min} мин)" if duration_min else ""
    text = (
        f"<b>Выброс завершён</b>{dur_str}\n"
        f"Аукцион возвращается к норме"
    )
    for chat_id in users:
        await send_fn(chat_id, text)
```

#### 3. Beat-расписание (tasks/celery_app.py)

В `beat_schedule` добавить:

```python
"collect-emission": {
    "task": "app.tasks.collectors.collect_emission",
    "schedule": timedelta(seconds=120),  # каждые 2 минуты
},
```

В `include` добавлять ничего не нужно — задача живёт в уже включённом `app.tasks.collectors`.

#### 4. Эндпоинты (api/v1/endpoints/emission.py)

Новый файл:

```python
"""Данные о выбросах (emission events)."""
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.models import EmissionEvent

router = APIRouter(prefix="/emission", tags=["Emission"])


class EmissionCurrentResponse(BaseModel):
    is_active: bool
    started_at: datetime | None      # UTC
    duration_min: int | None         # минут идёт (None если не активен)
    previous_start: datetime | None  # UTC, предыдущее событие
    previous_end: datetime | None    # UTC
    previous_duration_min: int | None
    seconds_since_last: int | None   # секунд с конца последнего (None если сейчас активен)


class EmissionHistoryItem(BaseModel):
    id: int
    started_at: datetime
    ended_at: datetime | None
    duration_min: int | None
    detected_at: datetime


@router.get("/current", response_model=EmissionCurrentResponse)
async def get_emission_current(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Текущий статус выброса и данные о последнем завершённом.
    Не требует особого тарифа — доступно всем подтверждённым пользователям.
    """
    now = datetime.now(timezone.utc)

    # Два последних события
    rows = (await db.execute(
        select(EmissionEvent)
        .where(EmissionEvent.region == "RU")
        .order_by(desc(EmissionEvent.started_at))
        .limit(2)
    )).scalars().all()

    active = next((e for e in rows if e.ended_at is None), None)
    last_ended = next((e for e in rows if e.ended_at is not None), None)

    def duration(e: EmissionEvent) -> int | None:
        if e and e.ended_at:
            return round((e.ended_at - e.started_at).total_seconds() / 60)
        if e and not e.ended_at:
            return round((now - e.started_at).total_seconds() / 60)
        return None

    return EmissionCurrentResponse(
        is_active=active is not None,
        started_at=active.started_at if active else None,
        duration_min=duration(active) if active else None,
        previous_start=last_ended.started_at if last_ended else None,
        previous_end=last_ended.ended_at if last_ended else None,
        previous_duration_min=duration(last_ended) if last_ended else None,
        seconds_since_last=(
            round((now - last_ended.ended_at).total_seconds()) if last_ended else None
        ),
    )


@router.get("/history", response_model=list[EmissionHistoryItem])
async def get_emission_history(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
):
    """
    История последних N выбросов (по умолчанию 50).
    """
    rows = (await db.execute(
        select(EmissionEvent)
        .where(EmissionEvent.region == "RU")
        .order_by(desc(EmissionEvent.started_at))
        .limit(limit)
    )).scalars().all()

    return [
        EmissionHistoryItem(
            id=e.id,
            started_at=e.started_at,
            ended_at=e.ended_at,
            duration_min=(
                round((e.ended_at - e.started_at).total_seconds() / 60)
                if e.ended_at else None
            ),
            detected_at=e.detected_at,
        )
        for e in rows
    ]
```

#### 5. Регистрация роутера (main.py)

```python
from app.api.v1.endpoints.emission import router as emission_router
# ...
app.include_router(emission_router, prefix="/api/v1")
```

#### 6. Alembic миграция (0031_emission_events.py)

```python
"""add emission_events table

Revision ID: 0031
Revises: 0030
Create Date: 2026-07-02
"""
from alembic import op
import sqlalchemy as sa

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "emission_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("notified", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.create_index("ix_emission_region_started", "emission_events",
                    ["region", "started_at"])
    op.create_index("ix_emission_active", "emission_events",
                    ["region", "ended_at"])


def downgrade():
    op.drop_index("ix_emission_active", table_name="emission_events")
    op.drop_index("ix_emission_region_started", table_name="emission_events")
    op.drop_table("emission_events")
```

---

### Frontend

#### 7. Zustand-стор (store/emissionStore.ts)

```typescript
import { create } from 'zustand'
import api from '../api/axios'  // существующий axios instance

interface EmissionState {
  isActive: boolean
  startedAt: string | null       // ISO UTC
  durationMin: number | null
  secondsSinceLast: number | null
  loading: boolean
  fetch: () => Promise<void>
}

export const useEmissionStore = create<EmissionState>((set) => ({
  isActive: false,
  startedAt: null,
  durationMin: null,
  secondsSinceLast: null,
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const { data } = await api.get('/api/v1/emission/current')
      set({
        isActive: data.is_active,
        startedAt: data.started_at,
        durationMin: data.duration_min,
        secondsSinceLast: data.seconds_since_last,
        loading: false,
      })
    } catch {
      set({ loading: false })
    }
  },
}))
```

#### 8. Компонент EmissionWidget (components/EmissionWidget.tsx)

Место в Layout: в `AppNav()`, под блоком с навигационными ссылками, над кнопками иконок
(Settings/Help/Logout). Виджет — горизонтальная плашка шириной боковой панели.

Визуальная логика:
- **Выброс активен:** фон `rgba(220, 38, 38, 0.15)` (красный), левая граница
  `2px solid #DC2626`, текст "Выброс идёт X мин"
- **Выброса нет:** фон `rgba(217, 175, 55, 0.08)` (золотой), текст "Последний: X мин
  назад" (форматируется через хелпер — часы/минуты)
- **Нет данных (loading или пустая БД):** текст "Выброс: нет данных", тусклый

Polling: раз в 30 секунд через `setInterval` в `useEffect`. При активном выбросе — раз
в 15 секунд (частый апдейт счётчика длительности).

```typescript
import { useEffect, useState } from 'react'
import { useEmissionStore } from '../store/emissionStore'
import { tokens } from '../theme'

const { gold: G2, text2: T2 } = tokens

function formatTimeSince(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} сек назад`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} мин назад`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}ч ${rem}мин назад` : `${hrs}ч назад`
}

export function EmissionWidget() {
  const { isActive, durationMin, secondsSinceLast, loading, fetch } = useEmissionStore()
  const [tick, setTick] = useState(0)  // для обновления live-счётчика

  useEffect(() => {
    fetch()
    const interval = setInterval(() => {
      fetch()
      setTick(t => t + 1)
    }, isActive ? 15_000 : 30_000)
    return () => clearInterval(interval)
  }, [isActive])

  const isActiveStyle = {
    background: 'rgba(220, 38, 38, 0.15)',
    borderLeft: '2px solid #DC2626',
  }
  const idleStyle = {
    background: 'rgba(217, 175, 55, 0.08)',
    borderLeft: `2px solid ${G2}`,
  }

  return (
    <div style={{
      margin: '8px 8px 4px',
      padding: '6px 10px',
      borderRadius: 4,
      ...(isActive ? isActiveStyle : idleStyle),
      fontSize: 11,
      lineHeight: 1.4,
      color: T2,
    }}>
      {loading && !isActive ? (
        <span style={{ opacity: 0.5 }}>Выброс: нет данных</span>
      ) : isActive ? (
        <>
          <span style={{ color: '#EF4444', fontWeight: 600 }}>Выброс идёт</span>
          {durationMin !== null && (
            <span style={{ marginLeft: 4, opacity: 0.8 }}>{durationMin} мин</span>
          )}
        </>
      ) : (
        <>
          <span style={{ color: G2, opacity: 0.7 }}>Последний выброс: </span>
          <span>{formatTimeSince(secondsSinceLast)}</span>
        </>
      )}
    </div>
  )
}
```

#### 9. Интеграция в Layout.tsx

В `AppNav()` добавить импорт и вставить `<EmissionWidget />` между блоком `NAV_ITEMS`
и блоком иконок-кнопок (Settings/Help/Logout). Точное место — перед `<div style={{flex: 1}}>`
разделителем или аналогичным spacer-элементом, если он есть.

```tsx
import { EmissionWidget } from './EmissionWidget'
// ...
// внутри AppNav(), после рендера nav-items:
<EmissionWidget />
```

---

## Telegram-уведомления — шаблоны

**Начало выброса:**
```
<b>Выброс начался</b>
Время: 14:23 МСК
Аукционная активность снижена (~15 мин)
```

**Конец выброса:**
```
<b>Выброс завершён</b> (длился 14 мин)
Аукцион возвращается к норме
```

Формат HTML (parse_mode="HTML"), соответствует существующему `send_telegram_message()`.
Гейтинг по тарифу отсутствует — рассылка всем пользователям с `telegram_chat_id IS NOT NULL`.

---

## Нагрузка на Rate Limit

| Задача | Запросов | Cost/запрос | Запросов/мин |
|---|---|---|---|
| `collect_emission` (каждые 2 мин) | 1 | 1 | 0.5 |
| Текущая нагрузка | — | — | 54.5 |
| **Итого** | — | — | **55.0** |

Нагрузка увеличивается на **0.1%** от лимита (с 13.6% до 13.75%). Безопасно.

---

## Документация для обновления

- **docs/NOTES.md:** `[ ]` Emission-фича → `[x]` (после реализации)
- **docs/SERVICES.md:** добавить строку `collect_emission` в таблицу Celery-задач
- **docs/DATABASE.md:** добавить раздел `emission_events`

---

## Открытые вопросы / требует подтверждения

1. **Периодичность опроса: 2 мин или другая?** NOTES.md упоминал 5 мин. ТЗ предлагает
   2 мин — нагрузка при обоих вариантах пренебрежимо мала, но задержка уведомления
   существенно меньше при 2 мин. **Требует подтверждения.**

2. **Telegram-рассылка без гейтинга тарифа:** emission — системное событие, не рекомендация
   по лотам. Привязка Telegram доступна всем тарифам (§17 BUSINESS_LOGIC.md), поэтому
   рассылаем всем у кого `telegram_chat_id IS NOT NULL AND is_active AND is_approved`.
   Тариф не проверяем. **Подтверждено пользователем 2026-07-02.**

3. **Регион:** текущая реализация опрашивает только `settings.stalcraft_region` ("RU").
   Если в будущем добавится мультирегион — потребуется цикл по регионам. Пока явно
   не нужно.

4. **Формат ответа `get_emission()`:** метод уже есть в клиенте, но фактическая форма
   JSON-ответа ("currentStart", "previousStart", "previousEnd") не верифицирована против
   живого API. Backend-разработчик должен сделать тестовый вызов перед реализацией и
   уточнить имена полей (используем snake_case, API может отдавать camelCase).

---

## Агенты и порядок вызова

1. **`backend-dev`** — реализует по этому ТЗ (модель → миграция → задача → эндпоинты)
2. **`frontend-dev`** — реализует стор и виджет (зависит от того, что backend-dev задеплоил
   эндпоинт `/emission/current`)
3. **`tech-writer`** — обновляет NOTES.md, SERVICES.md, DATABASE.md
