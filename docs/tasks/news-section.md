# ТЗ: Раздел новостей

## Контекст

Пользователь запросил реализацию пункта роадмапа подписок «Раздел новостей» (см. `docs/NOTES.md`, блок «Роадмап подписок — оставшиеся фазы»). Задача ещё не начата, нет ни таблицы в БД, ни роутов, ни фронтенд-страницы.

Раздел новостей — инструмент для администраторов, позволяющий публиковать анонсы, обновления платформы и информацию о тарифах. Пользователи видят ленту новостей на странице `/app/news`. Доступность не гейтируется тарифом — все подтверждённые пользователи видят новости одинаково.

---

## Затронутые файлы

### Backend
- `backend/app/models/models.py` — добавить модель `News`
- `backend/app/api/v1/endpoints/news.py` — новый файл, CRUD-роуты
- `backend/app/main.py` — подключить `news_router`
- `backend/alembic/versions/0030_news_table.py` — новая миграция

### Frontend
- `frontend/src/pages/NewsPage.tsx` — новая страница
- `frontend/src/App.tsx` — добавить роут `/app/news`
- `frontend/src/components/Layout.tsx` — добавить ссылку «Новости» в `NAV_ITEMS`

### Документация
- `docs/DATABASE.md` — добавить таблицу `news`
- `docs/SERVICES.md` — добавить эндпоинты `/news`
- `docs/NOTES.md` — отметить задачу `[x]`

---

## Исследование — что уже есть

**Модели БД** (`backend/app/models/models.py`): таблицы `news` нет. Последняя миграция — `0029_favorites_limit_override.py`.

**Аутентификация и роль администратора:**
- Поле `users.is_admin: bool` (колонка в БД, в модели `User`)
- Dependency `get_current_admin` (`backend/app/core/dependencies.py`, L55) — проверяет `is_admin`, бросает 403 иначе. Именно его используют все текущие admin-роуты (`/admin/users`, `/admin/stats`, `/admin/settings/registration` и др.)
- Dependency `get_current_user` — любой подтверждённый пользователь

**Admin-роуты** (`backend/app/api/v1/endpoints/admin.py`): только управление пользователями, статистикой и тарифами. Роутов для контент-менеджмента нет.

**Фронтенд:**
- Навбар — plain `<div>` в `Layout.tsx`, список ссылок в константе `NAV_ITEMS` (массив объектов `{ label, to, svg }`)
- Роутинг — `App.tsx`, защищённые роуты под `/app/*` оборачиваются в `<ProtectedRoute>`; `<AdminRoute>` используется только для `/app/admin`
- `AdminPage.tsx` — редактирование пользователей/тарифов. Новостей нет
- `FaqPage.tsx` и `MarketRadarPage.tsx` — примеры недавних страниц, можно взять за образец стиля

---

## Архитектурное решение

### Расположение роутов: отдельный файл vs расширение admin.py

Рекомендую **отдельный файл** `backend/app/api/v1/endpoints/news.py` с двумя группами эндпоинтов:
- Публичные (для пользователей) — `GET /news/` и `GET /news/{id}` → `Depends(get_current_user)`
- Admin-CRUD — `POST /news/`, `PUT /news/{id}`, `DELETE /news/{id}` → `Depends(get_current_admin)`

Обоснование: `admin.py` — управление пользователями и тарифами (операционные данные). Новости — отдельный домен с публичным чтением. Смешивать нет смысла. Pattern соответствует `market_radar.py` (отдельный файл, своя зона ответственности).

### Видимость новостей: для всех vs гейтинг тарифом

Рекомендую: **все подтверждённые пользователи видят все новости** (`get_current_user`). Новости — коммуникационный инструмент администратора, не часть тарифной матрицы. Добавление гейтинга усложнит логику без бизнес-выгоды.

### Формат тела новости: Text vs Markdown

Рекомендую: **поле `content` хранить как обычный `Text`** (без специализации). На фронте рендерить как-есть в `<Typography>` с `white-space: pre-wrap`. Это даёт минимальный объём кода. Полноценный Markdown-рендеринг (через `react-markdown`) — сознательно откладываем: добавляет зависимость, сложность и невидим в первой итерации. Можно добавить позже отдельной задачей.

### Хранение тегов: ARRAY vs отдельная таблица

Рекомендую: **`tags` как `ARRAY(String)` в PostgreSQL**. Теги справочные (тип объявления: «обновление», «акция», «тариф»), количество невелико, JOIN не нужен. `ARRAY` — стандартный подход в этой кодовой базе (`tracked_batch_sizes` в `UserWatchlist`).

---

## Изменения по слоям

### Backend

#### 1. Модель `News` (`backend/app/models/models.py`)

Добавить в конец файла после `NotificationQueue`:

```python
# ─── Новости / Анонсы ────────────────────────────────────────────────────────

class News(Base):
    __tablename__ = "news"

    id          = Column(Integer, primary_key=True)
    author_id   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title       = Column(String(300), nullable=False)
    content     = Column(Text, nullable=False)
    tags        = Column(ARRAY(String), nullable=False, default=list)
    is_pinned   = Column(Boolean, nullable=False, default=False, server_default="false")
    is_published = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), onupdate=func.now())

    author = relationship("User", foreign_keys=[author_id])

    __table_args__ = (
        Index("ix_news_published_pinned", "is_published", "is_pinned", "created_at"),
    )
```

**Объяснение полей:**
- `author_id` — `SET NULL` при удалении пользователя (не каскадное удаление новостей)
- `is_pinned` — закреплённые новости показываются первыми
- `is_published` — черновик/публикация (администратор может создать черновик и опубликовать позже)
- `tags` — массив строк, например `["обновление", "тарифы"]`, без foreign key

**Индекс:** `(is_published, is_pinned, created_at)` покрывает единственный запрос пользователей — выборку опубликованных новостей с сортировкой.

#### 2. Эндпоинты (`backend/app/api/v1/endpoints/news.py`)

Новый файл. Схема Pydantic-моделей и роутов:

**Pydantic-схемы:**

```python
class NewsCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    content: str = Field(..., min_length=1)
    tags: list[str] = []
    is_pinned: bool = False
    is_published: bool = True

class NewsUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    content: str | None = None
    tags: list[str] | None = None
    is_pinned: bool | None = None
    is_published: bool | None = None

class NewsResponse(BaseModel):
    id: int
    author_id: int | None
    author_username: str | None
    title: str
    content: str
    tags: list[str]
    is_pinned: bool
    is_published: bool
    created_at: datetime
    updated_at: datetime | None

    class Config:
        from_attributes = True
```

**Роуты:**

| Метод | URL | Auth | Описание |
|-------|-----|------|----------|
| `GET` | `/news/` | `get_current_user` | Список опубликованных новостей. Query params: `skip=0`, `limit=20`. Сортировка: закреплённые вверху, затем по `created_at DESC` |
| `GET` | `/news/{news_id}` | `get_current_user` | Одна новость (только `is_published=True`) |
| `POST` | `/news/` | `get_current_admin` | Создать новость. `author_id` = `current_user.id` |
| `PUT` | `/news/{news_id}` | `get_current_admin` | Обновить любые поля |
| `DELETE` | `/news/{news_id}` | `get_current_admin` | Удалить новость |
| `GET` | `/news/admin/all` | `get_current_admin` | Все новости включая черновики (`is_published=False`). Query: `skip`, `limit` |

Сортировка для `GET /news/`: `ORDER BY is_pinned DESC, created_at DESC`. Закреплённые идут первыми независимо от даты.

#### 3. Регистрация роутера (`backend/app/main.py`)

Добавить:
```python
from app.api.v1.endpoints.news import router as news_router
# ...
app.include_router(news_router, prefix="/api/v1")
```

Роутер объявляется с `prefix="/news", tags=["News"]`.

#### 4. Миграция (`backend/alembic/versions/0030_news_table.py`)

```python
"""add news table

Revision ID: 0030
Revises: 0029
Create Date: 2026-07-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "news",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("author_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("tags", postgresql.ARRAY(sa.String()), nullable=False,
                  server_default="{}"),
        sa.Column("is_pinned", sa.Boolean(), nullable=False,
                  server_default="false"),
        sa.Column("is_published", sa.Boolean(), nullable=False,
                  server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_news_published_pinned",
        "news",
        ["is_published", "is_pinned", "created_at"],
    )


def downgrade():
    op.drop_index("ix_news_published_pinned", table_name="news")
    op.drop_table("news")
```

---

### Frontend

#### 5. Страница новостей (`frontend/src/pages/NewsPage.tsx`)

Новый файл. Страница доступна всем авторизованным пользователям.

**Структура компонента:**

```
NewsPage
├── Заголовок (НОВОСТИ / ANNOUNCEMENTS)
├── [Только для is_admin] Форма создания новости (коллапсируемая / по кнопке)
├── Список NewsCard
│   └── NewsCard (title, date, tags, content, [ADMIN] кнопки редактирования/удаления)
└── Состояния: loading (CircularProgress), empty ("Новостей пока нет"), error
```

**Цветовая схема** (соответствует AdminPage и MarketRadarPage):
```
G1 = '#B78A2A'
G2 = '#D9AF37'   // gold accent
G3 = '#F2C94C'
BG1 = '#11151A'
BG2 = '#1A1F26'
T0 = '#F5F5F5'   // primary text
T1 = '#B8B8B8'
T2 = '#7C7C7C'   // muted text
BORDER = 'rgba(255,255,255,0.08)'
```

**NewsCard** — карточка новости:
- Золотой верхний бордер (`2px gradient`) для закреплённых новостей
- Обычный тонкий бордер для остальных
- Тег `ЗАКРЕПЛЕНО` (Chip, цвет G2) для `is_pinned=true`
- Теги новости (массив `tags`) — Chip серого цвета
- Заголовок: Rajdhani, 700, 1.1rem
- Контент: `white-space: pre-wrap`, fontSize 0.88rem, color T1
- Дата: правый нижний угол, fontSize 0.72rem, color T2
- [Только для `user.is_admin`] кнопки «Редактировать» и «Удалить» в правом верхнем углу карточки

**Форма создания/редактирования** (только для `is_admin`):
- Поля: `title` (TextField), `content` (TextField multiline, rows=5), `tags` (TextField, через запятую), `is_pinned` (Switch), `is_published` (Switch)
- Кнопки: «Опубликовать» (основная, цвет G2) и «Отмена»
- Inline-режим: форма показывается/скрывается кнопкой, не модалка. Логика аналогична блоку настроек авто-подтверждения в AdminPage

**Пагинация:** простая кнопка «Загрузить ещё» (load more), не страничная. Загружает следующие 20 записей, добавляет в хвост списка.

#### 6. Роутинг (`frontend/src/App.tsx`)

Добавить:
```tsx
import NewsPage from './pages/NewsPage'
// ...
<Route path="news" element={<NewsPage />} />
```

Роут защищён родительским `<ProtectedRoute>` через layout `/app/*`. Отдельная `<AdminRoute>` НЕ нужна — страница доступна всем, admin-функционал гейтируется внутри компонента по `user.is_admin`.

#### 7. Навбар (`frontend/src/components/Layout.tsx`)

Добавить в массив `NAV_ITEMS` новый пункт «Новости»:

```tsx
{
  label: 'Новости', to: '/app/news',
  svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ width: 14, height: 14 }}>
    <path d="M4 4h16v12H4z"/><path d="M4 8h16M8 12h4"/>
  </svg>,
},
```

Позиция в массиве: после «Склад» (перед «Радар рынка»), чтобы коммуникационный раздел не соседствовал с торговыми инструментами в начале.

Ссылка не гейтирована (`gated: false`), видна всем авторизованным пользователям.

---

## Детали реализации — corner cases

1. **Удаление автора:** `author_id` — `SET NULL`, не каскадное удаление. После удаления пользователя-автора `author_username` в ответе будет `null`, фронт отображает «Администратор» или «—».

2. **Черновики:** `GET /news/` возвращает только `is_published=True`. Администратор видит черновики только через `GET /news/admin/all`. На фронте в режиме admin — ссылка/кнопка переключения вида «Включить черновики» (query param или toggle).

3. **`updated_at`:** обновляется автоматически через `onupdate=func.now()` в SQLAlchemy. На фронте: если `updated_at != null` и отличается от `created_at` > 1 мин — показывать «(ред. DD.MM.YYYY)».

4. **Теги на фронте:** при создании пользователь вводит теги через запятую (`"обновление, тарифы"`), фронт парсит в массив строк (`split(',').map(s => s.trim()).filter(Boolean)`) перед отправкой.

5. **Пустое состояние:** если новостей нет — `<Box>` с текстом «Новостей пока нет» и иконкой. Для `is_admin` — подсказка «Создайте первую новость» с кнопкой создания.

---

## Критерии готовности

### Backend
- [ ] Таблица `news` создана через миграцию `0030`, проверено `alembic upgrade head`
- [ ] `GET /api/v1/news/` возвращает только `is_published=True`, сортировка: закреплённые первыми, затем по дате
- [ ] `POST /api/v1/news/` доступен только `is_admin=True`, 403 для обычного пользователя
- [ ] `PUT /api/v1/news/{id}` обновляет поля частично (переданные поля), не затронутые поля не меняются
- [ ] `DELETE /api/v1/news/{id}` — 404 при несуществующем id, 403 для не-admin
- [ ] `GET /api/v1/news/admin/all` возвращает ВСЕ новости (включая `is_published=False`)
- [ ] Удаление пользователя-автора не удаляет новости (`SET NULL`)
- [ ] Pydantic-валидация: `title` непустой и не длиннее 300 символов

### Frontend
- [ ] Страница `/app/news` открывается для авторизованного пользователя
- [ ] Ссылка «Новости» есть в навбаре
- [ ] Список новостей загружается из API при монтировании
- [ ] Закреплённые новости (`is_pinned=True`) визуально выделены (золотой бордер + чип)
- [ ] Кнопка «Загрузить ещё» подгружает следующую страницу
- [ ] Для `is_admin`: видна форма создания новости, в карточках — кнопки «Редактировать» / «Удалить»
- [ ] Редактирование открывает форму с заполненными текущими значениями
- [ ] Удаление с подтверждением (inline `confirm` или кнопка-переключатель «Точно удалить?»)
- [ ] Черновики (`is_published=False`) не видны обычному пользователю, видны admin в отдельном виде
- [ ] Теги отображаются как Chip-компоненты
- [ ] Дата публикации и дата редактирования (если есть) отображаются
- [ ] Состояние загрузки (CircularProgress), ошибки (Alert), пустого списка
- [ ] `npm run build` — без ошибок TypeScript

---

## Документация для обновления

- `docs/NOTES.md`: отметить `[ ] Раздел новостей` → `[x]`, добавить дату и ссылку на ТЗ
- `docs/DATABASE.md`: добавить секцию `### news` с описанием полей и индекса
- `docs/SERVICES.md`: добавить секцию с эндпоинтами `/news/*`

---

## Открытые вопросы / требует подтверждения

1. **Позиция «Новости» в навбаре**: предложено «после Склад, перед Радар рынка». Если навбар переполняется на узких экранах — рассмотреть перенос в правую часть рядом с иконкой FAQ.

2. **Теги: фиксированные категории** (подтверждено 2026-07-02): допустимые значения — `обновление`, `тарифы`, `техработы`, `важно`. Backend валидирует каждый тег через `Literal` или `Enum`. Frontend отображает мультиселект (Checkbox + Select или группа ToggleButton) вместо свободного текстового поля.

3. **Уведомления о новых новостях**: не входит в данное ТЗ. Если нужны Telegram-уведомления при публикации новости — отдельная задача.

4. **Rich text / Markdown**: текущее решение — plain text с `white-space: pre-wrap`. Если нужно форматирование (жирный, ссылки) — отдельная задача на `react-markdown`.

---

## Маршрутизация по агентам

1. **`backend-dev`** (`docs/tasks/news-section.md`) — создать `News`-модель, миграцию `0030`, файл `news.py` с роутами, подключить в `main.py`
2. **`frontend-dev`** (`docs/tasks/news-section.md`) — создать `NewsPage.tsx`, добавить роут в `App.tsx`, добавить пункт в навбар `Layout.tsx`
3. **`tech-writer`** — обновить `docs/DATABASE.md`, `docs/SERVICES.md`, `docs/NOTES.md`

Backend идёт первым, frontend — после (зависит от API-контракта). tech-writer — после обоих.
