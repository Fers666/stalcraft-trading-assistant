# ТЗ: Редизайн страницы «Избранное» (MonitoringPage) по HTML-референсу

## Контекст

Пользователь хочет привести внешний вид страницы `/app/monitoring` в точное соответствие
с HTML-референсом `design/favorites-page.html`. Страница уже работает функционально —
данные, логика фильтрации, сортировка лотов, сигналы — всё реализовано. Нужно только
изменить визуальный слой: убрать лишнее, перестроить компоновку, поправить CSS-детали.

Backend, API, хранилище данных (feedStore, MarketStats, SignalsData) не трогаем.
Все нужные данные уже доступны в существующих store и API-ответах.

---

## Затронутые файлы

| Файл | Что менять |
|---|---|
| `frontend/src/components/Layout.tsx` | Navbar: убрать MUI-иконки из nav-ссылок, убрать иконку из кнопки «Админ», добавить `.nav-link` SVG-иконки inline. Кнопка «Админ» — badge без иконки MUI |
| `frontend/src/components/GlobalFeed.tsx` | Незначительные: ширина `.feed-cards` gap 10px вместо 1.25 (MUI gap) |
| `frontend/src/pages/MonitoringPage.tsx` | Главный файл страницы: layout, сайдбар, заголовок |
| `frontend/src/components/LotStatCard.tsx` | Карточка: header-layout, inline статы, секция «Выгодные лоты», «Варианты продажи», «Пачки» |
| `frontend/src/components/SalesHistoryCharts.tsx` | Переключить на сетку 2×2 вместо одного графика |
| `frontend/src/theme.ts` | Добавить CSS-переменные (не обязательно — уже есть tokens) |

---

## Доступные данные (что уже есть в store/API)

### feedStore (`useFeedStore`)
- `watchlist: FeedWatchlistEntry[]` — список избранного: `id, item_id, name_ru, name_en, icon_path, region, quality_filter, enchant_filter, tracked_batch_sizes`
- `profitableItemIds: number[]` — ID выгодных позиций
- `feedItems: FeedItem[]` — для ленты сигналов: `entry, count, latest_lot_time`
- `minProfitMarginPercent: number`

### API `/monitoring/item/{itemId}` → `MarketStats`
Все нужные поля уже есть:
- `median_price_7d`, `sales_volume_7d`, `price_volatility_7d`, `price_volatility_30d`
- `sell_options: SellOption[]` (fast/normal/premium с `price_per_unit`, `net_price_per_unit`, `estimated_hours_display`)
- `batch_stats` (by_size, median_amount, bulk_discount_pct, batch_ratio_pct, most_popular_bucket)
- `best_sell_hour`, `best_buy_hour`, `sell_hours_by_day`, `buy_hours_by_day`

### API `/monitoring/signals/{itemId}` → `SignalsData`
- `lots: SignalLot[]` — лоты для таблицы «Выгодные лоты»
- `sell_options`, `volume_7d`, `volatility_7d`, `computed_at`

### API `/lots/{itemId}` → массив `LotItem[]`
Используется как fallback, уже реализован.

### API `/monitoring/sales-chart/{itemId}`
Режим `scatter` (24ч/48ч) и `daily` (7д/30д). Используется в `PriceChart`.

---

## Что отсутствует в данных (нельзя показать без изменения backend)

Ничего критичного — всё нужное уже есть. Единственное расхождение:

- В HTML-референсе в секции «Варианты продажи» есть строка **«Купи до»** (максимальная цена
  покупки, при которой сделка ещё прибыльна). Это производное поле: `net_price_per_unit - 1`.
  Можно вычислять на фронте из уже имеющихся `sell_options[i].net_price_per_unit`.
  Добавление строки — только UI, backend не нужен.

---

## Изменения по слоям

### 1. Navbar (`frontend/src/components/Layout.tsx` → функция `AppNav`)

**Текущее состояние:** nav-ссылки отображаются через `NavLink` с иконками MUI (`MonitorHeartIcon`, `MenuBookIcon` и т.д.) в `Icon style={{ fontSize: 14 }}`. Кнопка «Админ» содержит `AdminPanelSettingsIcon`.

**Нужно по референсу:** Nav-ссылки без иконок MUI — только inline SVG из HTML-референса. Кнопка «Админ» — текстовый badge-стиль без иконки.

**Изменения:**

1. Убрать все импорты MUI-иконок (`MonitorHeartIcon`, `SearchIcon`, `MenuBookIcon`, `LocalOfferIcon`, `InventoryIcon`, `AdminPanelSettingsIcon`) из `Layout.tsx`.

2. Обновить массив `NAV_ITEMS` — добавить поле `svgPath` (или вставить `icon` как ReactNode с inline SVG):
```tsx
const NAV_ITEMS = [
  {
    label: 'Избранное', to: '/app/monitoring',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 12h3l2 4 4-8 2 4h2"/></svg>
  },
  {
    label: 'Каталог', to: '/app/catalog',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><path d="M4 4h7v16H4z"/><path d="M13 4h7v16h-7z"/></svg>
  },
  {
    label: 'Лоты', to: '/app/lots',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
  },
  {
    label: 'Лента', to: '/app/feed',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><path d="M5 9l4 4-4 4M5 5h2l9 14h3"/></svg>
  },
  {
    label: 'Склад', to: '/app/inventory',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><rect x="3" y="7" width="18" height="13" rx="1"/><path d="M3 7l2-3h14l2 3"/></svg>
  },
]
```

3. В рендере `NavLink` заменить `<Icon style=.../>` на `{item.svg}`.

4. Кнопка «Админ» для `user?.is_admin`:
   - Убрать `AdminPanelSettingsIcon`
   - Стиль badge: золотой текст «Админ», border `1px solid rgba(217,175,55,0.3)`, без SVG-иконки внутри

Импорт `AdminPanelSettingsIcon` из `Layout.tsx` убрать. Файл `Navbar.tsx` (старый, не используется в продакшне, задублирован) — не трогать, он не рендерится.

---

### 2. GlobalFeed (`frontend/src/components/GlobalFeed.tsx`)

Текущий код уже очень близок к HTML-референсу. Минимальные правки:

- `gap` в `.feed-cards` контейнере: сейчас `gap: 1.25` (MUI единицы = 10px), в HTML — `gap: 10px`. Совпадают — ничего не менять.
- Карточки сигналов используют иконку через `Avatar src={iconUrl(...)}`, в HTML-референсе — просто `div.feed-card-icon` без изображения. Текущая реализация с аватаром богаче, оставить как есть.

**Вывод: GlobalFeed не требует изменений.**

---

### 3. MonitoringPage (`frontend/src/pages/MonitoringPage.tsx`)

**Текущее состояние:** layout `display:flex gap:2`, контент слева, сайдбар справа 260px.

**Нужно по референсу:** тот же layout. Разница только в деталях сайдбара и отсутствии лишних элементов.

**Изменения:**

#### 3.1 Заголовок страницы

Текущий код правильный, оставить.

#### 3.2 Сайдбар «Избранное» (правая колонка)

Текущее: `ListItemAvatar` с `Avatar src={iconUrl(...)}` — отображает иконку предмета 28×28.
Референс: `div.watch-avatar` — квадрат 28×28 с **первой буквой** имени предмета (без загрузки иконки).

Нужно заменить `Avatar src={...}` на аватар, отображающий только инициал. Иконки из CDN в сайдбаре убрать:

```tsx
// Было:
<Avatar
  src={iconUrl(entry.icon_path) ?? undefined}
  variant="rounded"
  sx={{ width: 28, height: 28, borderRadius: '5px', bgcolor: 'rgba(255,255,255,0.04)' }}
>
  {!entry.icon_path && (entry.name_ru?.[0] ?? '?')}
</Avatar>

// Стало (всегда буква, без иконки):
<Avatar
  variant="rounded"
  sx={{
    width: 28, height: 28, borderRadius: '5px',
    bgcolor: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    fontSize: '0.7rem', color: '#7C7C7C',
    fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
  }}
>
  {(entry.name_ru ?? entry.name_en ?? entry.item_id)?.[0]?.toUpperCase() ?? '?'}
</Avatar>
```

#### 3.3 Сайдбар — ширина

Сейчас: `width: 260`. Референс: `width: 268px` (по `design/favorites-page.html` — `width: 260px` в `.sidebar`). Оставить 260px — совпадает.

#### 3.4 Сайдбар — sticky top

Сейчас: `top: 16`. Если лента сигналов видна, контент начинается с `mt: 140px` (56 navbar + 84 feed). Сайдбар должен прилипать к верху видимой области, а не к верху страницы.

Изменить:
```tsx
// Было:
position: 'sticky', top: 16

// Стало (учитывает navbar + feed):
position: 'sticky', top: `${topOffset + 16}px`  // topOffset из Layout через контекст
```

Однако `topOffset` в Layout не передаётся в MonitoringPage. Проще использовать фиксированное значение или CSS:
```tsx
top: 'calc(56px + 84px + 16px)'  // 156px — с лентой
// Или динамически через CSS var, если feedShown:
top: feedShown ? 'calc(56px + 84px + 16px)' : 'calc(56px + 16px)'
```

Для этого `feedShown` нужно определить локально в MonitoringPage из `useFeedStore`:
```tsx
const { feedItems, lastLotRefresh } = useFeedStore()
const feedShown = initialized && watchlist.length > 0 && (lastLotRefresh === null || feedItems.length > 0)
const sidebarTop = feedShown ? 'calc(56px + 84px + 16px)' : 'calc(56px + 16px)'
```

---

### 4. LotStatCard (`frontend/src/components/LotStatCard.tsx`)

Это самый большой компонент. Рассматриваем по секциям.

#### 4.1 Шапка карточки (card header)

**Текущее:** `display:flex gap:1.5 alignItems:flex-start`. Аватар 64×64, info-блок flex:1, правый блок (кнопки + lastUpdated).

**Референс:** Аналогичная структура. Единственное отличие — в референсе `median_price` вынесен в отдельный блок справа от info и слева от кнопок:

```
[аватар] [info: name + meta + риски] [МЕДИАНА 7Д / значение] [кнопки]
```

**Сейчас** inline-статы (Медиана 7д, Продаж 7д, Лучшая прибыль) расположены **под** мета-строкой — внутри info-блока. В референсе «МЕДИАНА 7Д» вынесена как отдельный блок между info и кнопками (`div.median-price`), а «ПРОДАЖ 7Д» и «ЛУЧШАЯ ПРИБЫЛЬ» показаны в status-bar ниже.

Изменения в header:
1. Вынести `median_price_7d` из info-блока в отдельный `<Box sx={{ textAlign:'right', flexShrink:0 }}>`.
2. `sales_volume_7d` и `bestProfit` перенести в status-bar (строку с ToggleButton Сегодня/Неделя).
3. Status-bar: добавить `sales_volume_7d` слева от toggle-группы.

Структура header после изменений:
```tsx
<Box sx={{ display:'flex', gap:1.5, alignItems:'flex-start' }}>
  {/* Аватар 64×64 */}
  <Avatar ... />

  {/* Info: name + enchant + meta-chips + риски */}
  <Box sx={{ flex:1, minWidth:0 }}>
    <Typography ... /> {/* name */}
    <Box ... > {/* chips: itemId, region, quality, risk-tags */} </Box>
  </Box>

  {/* Медиана 7д — отдельный блок */}
  {stats?.median_price_7d != null && (
    <Box sx={{ textAlign:'right', flexShrink:0 }}>
      <Typography sx={{ fontSize:'0.55rem', color:'text.disabled', letterSpacing:'0.08em' }}>
        МЕДИАНА 7Д
      </Typography>
      <Typography sx={{ fontSize:'1.05rem', fontWeight:700, whiteSpace:'nowrap' }}>
        {formatPrice(stats.median_price_7d)}
      </Typography>
    </Box>
  )}

  {/* Кнопки + lastUpdated */}
  <Box sx={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:0.75, flexShrink:0 }}>
    ...
  </Box>
</Box>
```

#### 4.2 Status-bar

**Текущее:** ToggleButton Сегодня/Неделя + чипы часов продажи/покупки.

**Референс:** ToggleButton + чипы + блок «ПРОДАЖ 7Д» + «ЛУЧШАЯ ПРИБЫЛЬ» + «обновлено ... мин назад».

Добавить в status-bar слева от toggle-группы:
```tsx
{stats?.sales_volume_7d != null && (
  <Box sx={{ mr:1 }}>
    <Typography sx={{ fontSize:'0.55rem', color:'text.disabled', letterSpacing:'0.08em' }}>ПРОДАЖ 7Д</Typography>
    <Typography sx={{ fontSize:'0.82rem', fontWeight:700 }}>{stats.sales_volume_7d}</Typography>
  </Box>
)}
```

«Лучшую прибыль» можно тоже добавить сюда или оставить убранной из хедера — по референсу её в status-bar нет. Убрать из обоих мест (она видна из таблицы лотов).

Блок «обновлено» (`lastUpdated`) перенести из правой колонки хедера в конец status-bar (после чипов), с иконкой часов:
```tsx
<Box sx={{ ml:'auto', display:'flex', alignItems:'center', gap:0.5 }}>
  {/* SVG clock icon 10×10 */}
  <Typography sx={{ fontSize:'0.55rem', color:'text.disabled', whiteSpace:'nowrap' }}>
    обновлено {formatLastUpdate(lastUpdated)}
  </Typography>
</Box>
```

#### 4.3 Таблица «Выгодные лоты»

**Текущее:** Сетка `gridTemplateColumns: lotGridCols`, header с сортируемыми колонками, строки лотов.

**Референс:** Совпадает. Единственная разница:

- В header источник лотов (чип «источник: рынок · сейчас») — убрать, оставить только ToggleButton Сейчас/Неделя.
- Подпись «прибыль = чистыми...» — убрать (она есть сейчас между toggle и таблицей).
- Hint «↳ Кликните лот» — оставить.

Выделение выбранной строки уже работает: `borderLeft:'3px solid', borderLeftColor: isSelected ? tokens.gold : 'transparent'` — совпадает с референсом.

#### 4.4 Секция «Варианты продажи» — добавить строку «Купи до»

В текущей сетке есть строки: «Выставить за», «Получишь (−5%)», «Прибыль», «Срок».

Добавить строку **«Купи до»** между «Получишь» и «Прибыль»:
```tsx
<Typography sx={{ fontSize:'0.65rem', color:'text.disabled' }}>Купи до</Typography>
{stats.sell_options.map(opt => (
  <Typography key={opt.label} sx={{ fontSize:'0.72rem', fontWeight:600, textAlign:'right', color:'text.secondary' }}>
    {formatPrice(opt.net_price_per_unit - 1)}
  </Typography>
))}
```

Порядок строк в сетке после изменений: Выставить за → Получишь → Купи до → Прибыль → Срок.

#### 4.5 Пачки (batch_stats)

Текущий код совпадает с референсом. Менять не нужно.

#### 4.6 Gold top-bar карточки

Текущее: `height:3, background:'linear-gradient(90deg, #D9AF37 0%, #F5B74F 100%)'`. Референс: `height:3, background:linear-gradient(90deg, var(--gold) 0%, var(--warning) 100%)`. Совпадает.

---

### 5. SalesHistoryCharts (`frontend/src/components/SalesHistoryCharts.tsx`)

**Текущее состояние:** один `PriceChart` с переключателем периода 24ч/48ч/7д/30д.

**Референс:** сетка 2×2 из четырёх карточек — по одной на каждый период (24ч, 48ч, 7д, 30д).

**Изменения:**

Заменить текущий код на сетку из 4 независимых `PriceChart`:

```tsx
const PERIODS = [
  { label: '24 часа',   value: 24  },
  { label: '48 часов',  value: 48  },
  { label: '7 дней',    value: 168 },
  { label: '30 дней',   value: 720 },
]

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter }: Props) {
  return (
    <Box>
      <Typography sx={{ fontSize:'0.65rem', color:'text.disabled', fontWeight:600, letterSpacing:'0.1em', mb:1.5, textTransform:'uppercase' }}>
        История продаж
      </Typography>
      <Box sx={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:2 }}>
        {PERIODS.map(p => (
          <Box
            key={p.value}
            sx={{
              border:'1px solid rgba(255,255,255,0.08)',
              borderRadius:'12px',
              p:1.5,
              bgcolor:'rgba(255,255,255,0.02)',
            }}
          >
            <Typography sx={{ fontSize:'0.6rem', fontWeight:700, letterSpacing:'0.1em', color:'text.disabled', mb:1, textTransform:'uppercase' }}>
              {p.label}
            </Typography>
            <PriceChart
              key={`${itemId}-${p.value}`}
              itemId={itemId}
              region={region}
              qualityFilter={qualityFilter}
              enchantFilter={enchantFilter}
              defaultHours={p.value}
              hideControls
            />
          </Box>
        ))}
      </Box>
    </Box>
  )
}
```

Это делает 4 независимых HTTP-запроса к `/monitoring/sales-chart/{itemId}` с разными `hours`. `PriceChart` уже имеет IntersectionObserver — графики загружаются лениво при попадании в viewport. Нагрузка на API не возрастает критически (4 запроса вместо 1 при смене товара), поскольку они дешёвые SELECT-запросы, уже кешируемые на уровне БД.

---

### 6. PriceChart (`frontend/src/components/PriceChart.tsx`)

Изменений не требует. Компонент уже работает корректно в режиме `hideControls=true`.

---

## CSS / Тема

Все нужные цветовые токены уже определены в `frontend/src/theme.ts` и экспортируются как `tokens`:

| CSS-переменная в референсе | Токен в theme.ts |
|---|---|
| `--gold` (#D9AF37) | `tokens.gold` |
| `--gold-accent` (#F2C94C) | `tokens.goldAccent` |
| `--gold-soft` (#B78A2A) | `tokens.goldSoft` |
| `--bg2` (#1A1F26) | `tokens.bg2` |
| `--success` (#3ED598) | `tokens.success` |
| `--warning` (#F5B74F) | `tokens.warning` |
| `--danger` (#FF5A5A) | `tokens.danger` |
| `--info` (#53B7FF) | `tokens.info` |
| `--border` | `tokens.border` |

Добавлять CSS-переменные в тему не нужно — все токены есть.

Шрифт `Inter` для числовых данных уже является дефолтным в теме. `Rajdhani` используется для заголовков. Соответствует референсу.

Скроллбар сайдбара — gold-стиль уже реализован в текущем коде и совпадает с желаемым результатом.

---

## Navbar — итоговые изменения

Файл `frontend/src/components/Layout.tsx`, функция `AppNav`:

**Убрать:**
- Импорты `MonitorHeartIcon`, `SearchIcon`, `InventoryIcon`, `MenuBookIcon`, `LocalOfferIcon`, `AdminPanelSettingsIcon`

**Изменить:**
- Массив `NAV_ITEMS` — добавить поле `svg: ReactNode` вместо `Icon: ComponentType`
- В рендере `NavLink` — `{item.svg}` вместо `<Icon .../>`
- Кнопка «Админ» — убрать `<AdminPanelSettingsIcon .../>`, оставить только текст

**Не убирать:**
- Иконки в правом блоке (`SettingsIcon`, `LogoutIcon`) — они используются для кнопок настроек и выхода, в референсе тоже присутствуют как SVG

---

## Signals Strip (GlobalFeed) — сравнение с референсом

HTML-референс описывает ту же `feed-bar` что уже реализована. Отличий нет. `GlobalFeed.tsx` менять не нужно.

---

## Sidebar «Избранное» — итог

| Элемент | Текущее | Нужно |
|---|---|---|
| Аватар | `Avatar src={iconUrl(...)}` — CDN-иконка | Только буква, без изображения |
| Ширина | 260px | 260px (совпадает) |
| Поиск | TextField с SearchIcon/ClearIcon | Без изменений |
| Элементы списка | ListItemButton с Divider | Без изменений |
| Gold-скроллбар | Реализован | Без изменений |
| Chip-ы региона/качества | Реализованы | Без изменений |
| dot profitable | Box 6×6 green dot | Без изменений |
| sticky top | `top:16` | Исправить на `top: sidebarTop` (динамический) |

---

## Не трогать

- Backend (`backend/`) — полностью вне scope.
- API-endpoints и их параметры.
- feedStore — логика загрузки, сигналов, watchlist.
- `PriceChart.tsx` — компонент рабочий, изменений не требует.
- `theme.ts` — токены достаточны, изменения не нужны.
- Страницы `CatalogPage`, `LotsPage`, `FeedPage`, `InventoryPage`, `SettingsPage`, `AdminPage`.
- `LandingPage`, `LoginPage`, `RegisterPage`.
- Docker, Celery, PostgreSQL, Redis.

---

## Документация для обновления

После выполнения задачи:
- `docs/NOTES.md` — не требует изменений (это задача чисто UI, не входит в бэклог).

---

## Решения по открытым вопросам (подтверждено пользователем)

1. **Сетка графиков 2×2** — 4 запроса допустимы. Rate Limit (400 req/min) применяется к Stalcraft API, не к внутренним запросам БД. Реализовывать.

2. **Sticky top сайдбара** — захардкодить `top: '156px'` (56px navbar + 84px feed + 16px отступ). Динамику не делать.

3. **Строка «Купи до»** — убрать из «Вариантов продажи» полностью. В сетке остаётся: Выставить за → Получишь (−5%) → Прибыль → Срок.
