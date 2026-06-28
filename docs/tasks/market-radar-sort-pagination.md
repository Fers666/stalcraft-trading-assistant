# ТЗ: сортировка по выгодным лотам + полная пагинация в «Радаре рынка»

## Контекст

Сейчас `GET /market-radar/` возвращает **топ-20 строк**, отсортированных по
`watchers_count` (число подписчиков), а `profitable_offers_count` (число
выгодных лотов в текущем снэпшоте) — побочная метрика, выводимая в отдельной
колонке без влияния на порядок и без возможности увидеть строки за пределами
топ-20.

Пользователь просит:
1. Сортировать результат по `profitable_offers_count` по убыванию (а не по
   `watchers_count`).
2. Показывать **все** бакеты, не только 20, с пагинацией по 20 на страницу.

Это меняет порядок вычислений в сервисе: сейчас `profitable_offers_count`
считается **после** того, как SQL уже выбрал и обрезал топ-20 по
`watchers_count` (`.order_by(...watchers_count...desc()).limit(TOP_LIMIT)` —
`backend/app/services/analytics/market_radar.py:191-192`). Чтобы сортировать
по `profitable_offers_count`, нужно сначала посчитать эту метрику для **всех**
бакетов, потом сортировать и пагинировать — то есть `LIMIT` должен сдвинуться
с самого первого SQL-запроса до последнего шага сборки ответа.

Хорошая новость по масштабу (проверено на текущей БД,
`docker compose exec postgres psql`): сейчас всего **18 уникальных бакетов**
`(item_id, quality_filter, enchant_filter)` в активном `user_watchlist` (19
активных строк, 11 уникальных `item_id`), снэпшоты `CollectedData.raw_lots`
до ~200 лотов на регион, регион пока только RU. Полный пересчёт всех бакетов
вместо топ-20 почти не меняет стоимость cache-miss **сейчас**, но при росте
числа watcher'ов это будет расти линейно (один проход по `raw_lots` каждого
региона на бакет) — нужен safety-cap, см. «Открытые вопросы».

## Затронутые файлы

- `backend/app/services/analytics/market_radar.py` — `_calculate_market_radar_aggregate()`, `get_market_radar_aggregate()`, `TOP_LIMIT`
- `backend/app/api/v1/endpoints/market_radar.py` — `MarketRadarResponse`, `MarketRadarItem`, `get_market_radar()`
- `frontend/src/pages/MarketRadarPage.tsx` — запрос данных, рендер списка
- `docs/BUSINESS_LOGIC.md` §17 (подраздел «Радар рынка») — формула агрегации
- `docs/SERVICES.md` — описание `get_market_radar_aggregate`

## Изменения по слоям

### Backend

**1. `market_radar.py` (service) — снять лимит до этапа сортировки по `profitable_offers_count`**

Текущий код (`_calculate_market_radar_aggregate`, строки 179–193):
```python
rows = (await db.execute(
    select(
        UserWatchlist.item_id, UserWatchlist.quality_filter, UserWatchlist.enchant_filter,
        func.count(func.distinct(UserWatchlist.user_id)).label("watchers_count"),
        func.count(func.distinct(UserWatchlist.user_id)).filter(
            UserWatchlist.created_at >= cutoff_24h
        ).label("new_watchers_24h"),
    )
    .where(UserWatchlist.is_active == True)
    .group_by(UserWatchlist.item_id, UserWatchlist.quality_filter, UserWatchlist.enchant_filter)
    .order_by(func.count(func.distinct(UserWatchlist.user_id)).desc())
    .limit(TOP_LIMIT)
)).all()
```

Изменить:
- Убрать `.limit(TOP_LIMIT)` из этого запроса (или заменить на высокий
  safety-cap, см. открытые вопросы — например `.limit(500)`, far above
  текущих 18 бакетов, просто страховка от деградации при аномальном росте
  watchlist).
- Убрать `.order_by(...watchers_count...)` здесь — порядок по
  `watchers_count` больше не финальный, сортировка переносится в конец
  (после вычисления `profitable_offers_count` для каждой строки).
- Цикл построения `top_items` (строки 217–265) остаётся как есть по сути —
  каждая строка из (теперь не обрезанного) набора bucket'ов всё равно
  получает `avg_price`, `sales_volume`, `profitable_offers_count`.
- После цикла (после строки 265, перед блоком «4. Сводная метрика») —
  добавить финальную сортировку и **не** резать список здесь:
  ```python
  top_items.sort(
      key=lambda x: (x["profitable_offers_count"] or 0),
      reverse=True,
  )
  ```
  Это сортирует строки с `profitable_offers_count = None` («нет данных») в
  конец списка (как 0) — открытый вопрос ниже про точное место `None` в
  порядке.
- `_calculate_market_radar_aggregate()` теперь возвращает **весь**
  отсортированный список в `top_items` (переименовать поле смысла ради
  обсудить с фронтом/документацией — не обязательно технически, но
  `top_items` уже не «топ-20», а «все бакеты по убыванию выгодных лотов»;
  можно оставить имя поля для совместимости, просто учесть в
  docs/BUSINESS_LOGIC.md, что оно больше не урезано на 20).
- `TOP_LIMIT = 20` (текущая константа, строка 60) — переименовать смысл:
  использовать её только как `PAGE_SIZE` для пагинации на следующем шаге
  (п.2), а не как лимит SQL-запроса. Либо завести отдельную константу
  `PAGE_SIZE = 20`, оставив `TOP_LIMIT` как safety-cap количества бакетов
  (название уточнить при реализации — рекомендация: одна константа
  `PAGE_SIZE = 20` для пагинации, отдельная `MAX_BUCKETS = 500` как
  safety-cap основного запроса).

**2. Кэширование — пересчитываем и кэшируем ВЕСЬ отсортированный список, режем на странице запроса**

`get_market_radar_aggregate(db)` (строки 143–169) сейчас кэширует в Redis
готовый dict с топ-20. Рекомендуемый подход: кэшировать **весь** отсортированный
список (полный результат `_calculate_market_radar_aggregate`), а резать на
страницы — на уровне эндпоинта/обёртки, **после** чтения из кэша. Так
TTL=60с продолжает защищать от дорогого пересчёта `profitable_offers_count`
независимо от того, какую страницу запрашивает клиент (иначе пришлось бы
либо кэшировать каждую страницу отдельным ключом — больше записей в Redis и
сложнее инвалидация, либо пересчитывать на каждый запрос страницы — съедает
выгоду от кэша).

Сигнатура меняется:
```python
async def get_market_radar_aggregate(db: AsyncSession, page: int = 1, page_size: int = 20) -> dict:
    ...
    full = <закэшированный полный результат, как раньше, но без обрезки>
    total_count = len(full["top_items"])
    start = (page - 1) * page_size
    end = start + page_size
    page_items = full["top_items"][start:end]
    return {
        **full,
        "top_items": page_items,
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
    }
```
Это держит дорогую часть (расчёт `profitable_offers_count` для всех бакетов)
за кэшем TTL=60с, а пагинация — это просто срез уже готового списка в памяти
(не SQL — список целиком уже посчитан и хранится как JSON в Redis). Это и
есть ответ на вопрос «нужен ли `COUNT(*) OVER()`»: **не нужен**, потому что
метрика, по которой сортируем (`profitable_offers_count`), не существует в
БД как колонка — она вычисляется построчно через Python-проход по
`CollectedData.raw_lots` (JSON), что в принципе нельзя выразить как SQL
`ORDER BY` + window function без денормализации этой метрики в таблицу.
Window-функция `COUNT(*) OVER()` имела бы смысл только если бы пагинация
шла по полю, уже вычисляемому в SQL (например по `watchers_count` — старое
поведение) — тогда можно было бы пагинировать сам исходный SQL-запрос
(`LIMIT/OFFSET` в SQL) и одним `COUNT(*) OVER()` получить `total_count` без
отдельного `SELECT COUNT(*)`. При сортировке по `profitable_offers_count`
эта оптимизация недоступна: full scan в памяти неизбежен **до** пагинации,
SQL-уровня пагинация невозможна.

**3. Эндпоинт `market_radar.py` (api) — добавить query-параметры `page`/`page_size`**

```python
@router.get("/", response_model=MarketRadarResponse)
async def get_market_radar(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_market_radar_access),
):
    aggregate = await get_market_radar_aggregate(db, page=page, page_size=page_size)
    return MarketRadarResponse(**aggregate)
```
(нужен импорт `Query` из `fastapi`, которого сейчас нет в файле — сейчас
только `APIRouter, Depends`).

**4. Pydantic-схема ответа — добавить поля пагинации**

`MarketRadarResponse` (строки 34–38) сейчас:
```python
class MarketRadarResponse(BaseModel):
    top_items: list[MarketRadarItem]
    total_active_watchers: int
    unique_items_tracked: int
    calculated_at: str
```
Добавить:
```python
    total_count: int       # сколько всего бакетов (для расчёта числа страниц на фронте)
    page: int
    page_size: int
```
`MarketRadarItem` (строки 18–31) не меняется по полям — меняется только то,
какие строки в него попадают и в каком порядке.

**5. Уточнить поведение `None` в сортировке**

`profitable_offers_count` может быть `None` («нет данных» — нет ориентира
цены). Текущее предложение — трактовать `None` как `0` при сортировке
(`x["profitable_offers_count"] or 0"`), то есть строки без данных уезжают в
конец списка вместе с реальными нулями. Альтернатива — держать `None`
отдельно в самом конце (после нулей), если для пользователя «нет данных» и
«точно 0 выгодных лотов» должны визуально различаться по позиции. Решение
нужно подтвердить — см. «Открытые вопросы».

### Frontend

**1. `MarketRadarPage.tsx` — добавить пагинацию по образцу `LotsPage.tsx`**

Проект уже использует `TablePagination` (MUI) с клиентским срезом в
`LotsPage.tsx` (`frontend/src/pages/LotsPage.tsx:188-189, 920-929` — стейты
`page`/`rowsPerPage`, компонент `TablePagination` с `labelRowsPerPage="Строк:"`
и `labelDisplayedRows={({from,to,count}) => \`${from}–${to} из ${count}\`}`).
Для консистентности стиля с остальным проектом — **переиспользовать тот же
текстовый паттерн** меток, но не клиентский срез: т.к. backend теперь сам
пагинирует (см. выше), `MarketRadarPage` должен делать **серверную**
пагинацию — перезапрашивать `/market-radar/?page=N&page_size=20` при смене
страницы, а не резать массив на клиенте.

Текущий код (строки 37–55):
```tsx
export default function MarketRadarPage() {
  const [data, setData]       = useState<MarketRadarResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied]   = useState(false)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get('/market-radar/')
      .then(({ data }) => { if (!cancelled) setData(data) })
      ...
  }, [])
```

Изменить:
- Добавить стейт `page` (0-based для MUI `TablePagination`, конвертировать
  в 1-based при запросе: `page: page + 1`).
- `useEffect` зависит от `[page]`, запрос — `api.get('/market-radar/', { params: { page: page + 1, page_size: 20 } })`.
- При смене страницы — показывать индикатор загрузки только в области
  списка (не полноэкранный `CircularProgress`, чтобы не дёргать заголовок и
  счётчики `total_active_watchers`/`unique_items_tracked`, которые не
  меняются между страницами одного и того же расчёта в пределах TTL=60с).
- После списка карточек (после строки 249, `</Box>` закрывающего список) —
  добавить `TablePagination` с `count={data.total_count}`,
  `page={page}`, `onPageChange`, `rowsPerPage={20}` фиксированным (без
  `rowsPerPageOptions` — пользователь просил именно «по 20», не выбор
  размера страницы; либо обсудить опционально, см. открытые вопросы).
- Убрать любой клиентский слайс/лимит, если он есть — **в текущем коде его
  нет**: `MarketRadarPage.tsx` просто рендерит `data.top_items.map(...)`
  без `.slice()` (строка 122). Тот факт, что показываются только 20 строк —
  целиком следствие backend-лимита `TOP_LIMIT = 20`, а не клиентской
  обрезки. Это важно: на фронте ничего резать не нужно, только добавить UI
  пагинации и перепривязать его к серверным параметрам.

**2. Авто-сортировка**

Так как backend теперь сам возвращает список, отсортированный по
`profitable_offers_count` (убыв.), фронту **не нужно** сортировать на
клиенте — достаточно рендерить `data.top_items` в полученном порядке (как
сейчас, строка 122 `data.top_items.map(...)`, без изменений логики рендера
порядка).

**3. Обновить интерфейс `MarketRadarResponse` (TS)**

Строки 30–35:
```ts
interface MarketRadarResponse {
  top_items: MarketRadarItem[]
  total_active_watchers: number
  unique_items_tracked: number
  calculated_at: string
}
```
Добавить:
```ts
  total_count: number
  page: number
  page_size: number
```

### Design

Без новых макетов — переиспользуется существующий компонент `TablePagination`
из MUI theme (уже стилизован под gold-тему в `LotsPage.tsx`, тот же `sx`
паттерн при необходимости перенять).

## Документация для обновления

- `docs/BUSINESS_LOGIC.md` §17 (подраздел «Радар рынка»): обновить описание
  сортировки (была по `watchers_count`, теперь по `profitable_offers_count`
  убыв.), убрать упоминание «топ-20» как финального среза (топ-20 теперь
  только default `page_size` пагинации, не лимит на размер агрегата), описать
  поведение `None` в сортировке после решения открытого вопроса.
- `docs/SERVICES.md` (`get_market_radar_aggregate`): обновить сигнатуру
  (`page`, `page_size`), описать, что кэшируется полный отсортированный
  список, а не срез; уточнить стоимость cache-miss растёт с числом бакетов,
  не зафиксирована на 20.
- `docs/NOTES.md`: отметить доработку «Радара рынка» (сортировка +
  пагинация) в соответствующем пункте бэклога (раздел уже содержит `[x]`
  «Радар рынка» — добавить отдельную строку-ревизию, не переоткрывать
  пункт).

## Решения по открытым вопросам (подтверждено пользователем 2026-06-29)

1. **Место `None` в сортировке** — `None` трактуется как `0`
   (`x["profitable_offers_count"] or 0`), без отдельной третьей группы.
2. **Safety-cap на число бакетов** (`MAX_BUCKETS`) — добавить как страховку
   (например `.limit(500)` на исходном SQL-запросе бакетов вместо полного
   снятия лимита), не блокирует реализацию, технический потолок на порядок
   выше текущих 18 бакетов.
3. **`page_size`** — зафиксирован `page_size=20`, без `rowsPerPageOptions`
   на фронте (выбор размера страницы пользователем не нужен).
4. TTL кэша (60с) не меняется в рамках этой задачи.
5. Изменение НЕ затрагивает обращения к Stalcraft API (агрегация целиком
   над собственной БД) — не требует отдельного подтверждения по rate limit.

## Маршрутизация по агентам

1. `backend-dev` — пункты Backend 1–5 выше (сервис, эндпоинт, схема).
   Вход: этот файл.
2. `frontend-dev` — пункты Frontend 1–3 (после того как backend-dev
   зафиксирует итоговую форму ответа `MarketRadarResponse`, особенно
   `total_count`/`page`/`page_size` — порядок важен, чтобы фронт писал TS
   интерфейс под реальный контракт, а не предположение). Вход: этот файл +
   финальная сигнатура ответа от backend-dev.
3. `tech-writer` — после реализации обоих слоёв: обновить
   `docs/BUSINESS_LOGIC.md` §17, `docs/SERVICES.md`, `docs/NOTES.md`.
