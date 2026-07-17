# ТЗ: внедрение дизайн-системы «Терминал» (design/v5) в frontend/src

Статус: прототип завершён, QA пройден, план одобрен пользователем.
Исполнитель: `frontend-dev`. Автор спеки: `designer`.

---

## 1. Контекст и источники правды

`design/v5/` — автономный HTML/CSS/JS-прототип нового интерфейса (направление A «Терминал»),
работает по file://. Это **эталон визуала и поведения**, не эталон кода: переносим систему,
а не копипастим разметку. Иерархия источников правды:

1. `design/v5/DIRECTION.md` — контракт системы: палитра, типографика, геометрия, словарь
   компонентов, гейтинг, motion, запреты. **При любом конфликте побеждает он.**
2. `design/v5/assets/tokens.css` — единственный источник цветов/размеров (§2 этой спеки).
3. `design/v5/assets/base.css` — словарь компонентов (§3).
4. `design/v5/app/*.html` — эталоны страниц (таблица ниже).
5. `design/v5/AUDIT.md` — находки по текущему `frontend/src`, закрываемые внедрением (§6).

| Файл прототипа | Эталон для (frontend/src) |
|---|---|
| `app/favorites.html` | `pages/MonitoringPage.tsx` + `components/LotStatCard.tsx` + `components/SalesHistoryCharts.tsx` + `components/PriceChart.tsx` — **эталон всей системы** |
| `app/catalog.html` | `pages/CatalogPage.tsx` |
| `app/lots.html` | `pages/LotsPage.tsx` |
| `app/radar.html` | `pages/MarketRadarPage.tsx` |
| `app/inventory.html` | `pages/InventoryPage.tsx` |
| `app/settings.html` | `pages/SettingsPage.tsx` |
| `app/feed.html` | `pages/FeedPage.tsx` — **новая фича**, см. §5.7 (нужно бэкенд-обсуждение) |
| `app/index.html` | `pages/LandingPage.tsx` |
| `app/login.html` | `pages/LoginPage.tsx` |
| `assets/shell.js` | `components/Layout.tsx` (навбар + лента + sysbar), см. §4 |
| `assets/charts.js` | стилевой контракт для recharts-графиков, см. §3.3 |

Вне охвата (не переделываем в этом цикле): `RegisterPage.tsx`, `NewsPage.tsx` (кроме
паттерна удаления — §6 DEL-01), `FaqPage.tsx`, `AdminPage.tsx`. Они автоматически получат
новую тему (Фаза 1) — этого достаточно.

---

## 2. Токены: tokens.css → theme.ts

Правило ревью (переносится в код): **хекс/rgba вне `frontend/src/theme.ts` = дефект.**
Все страничные `sx`/styled — только через `tokens.*` или `theme.palette.*`.

### 2.1 Таблица соответствий (каждая переменная tokens.css)

| CSS-переменная (значение) | Ключ в `tokens` (theme.ts) | MUI palette path |
|---|---|---|
| `--s0` `#080808` | `bg0` (без изменений) | `palette.background.default` |
| `--s1` `#0D1014` | `bg1` (**новое значение**, было `#11151A`) | `palette.background.paper` (**сменить с BG2**) |
| `--s2` `#12161C` | `bg2` (**новое значение**, было `#1A1F26`) | — (прямое использование: thead, инпуты, hover) |
| `--s3` `#1A1F26` | `bg3` (**новое значение**, было `#202633`) | — (тултип, тост, active). Старый `#202633` удалить |
| `--line` `rgba(255,255,255,.08)` | `border` (без изменений) | `palette.divider` |
| `--line-hi` `rgba(255,255,255,.15)` | `borderHi` (**добавить**) | — |
| `--grid` `rgba(255,255,255,.06)` | `grid` (**добавить**) | — (сетка графиков) |
| `--tick` `rgba(255,255,255,.2)` | `tick` (**добавить**) | — (риски осей) |
| `--gold-line` `rgba(217,175,55,.4)` | `goldLine` (**добавить**) | — |
| `--gold-line-soft` `rgba(217,175,55,.3)` | `goldLineSoft` (**добавить**) | — |
| `--gold-1` `#B78A2A` | `goldSoft` (есть) | `palette.primary.dark` |
| `--gold` `#D9AF37` | `gold` (есть) | `palette.primary.main` |
| `--gold-2` `#F2C94C` | `goldAccent` (есть) | `palette.primary.light` |
| `--gold-hi` `#FFB800` | `goldHighlight` (есть) | — (пик иерархии: одна ключевая цифра на экран) |
| `--gold-dim` `rgba(217,175,55,.12)` | `goldDim` (**добавить**; заменяет разбросанные `alpha(G2,0.12)` и rgba-литералы) | — |
| `--gold-glow` `rgba(255,184,0,.22)` | `goldGlow` (**заменяет** `glow`) | — |
| `--text` `#F2F4F6` | `text0` (**новое значение**, было `#F5F5F5`) | `palette.text.primary` |
| `--mut` `#B6BDC4` | `text1` (**новое значение**, было `#B8B8B8`) | `palette.text.secondary` |
| `--faint` `#8A939C` | `text2` (**новое значение**, было `#7C7C7C` — контраст-фикс A11Y-02) | `palette.text.disabled` |
| `--green` `#3ED598` | `success` (без изменений) | `palette.success.main` / `secondary.main` |
| `--green-dim` `rgba(62,213,152,.12)` | `successDim` (**добавить**) | — |
| `--green-line` `rgba(62,213,152,.35)` | `successLine` (**добавить**) | — |
| `--red` `#FF5A5A` | `danger` (без изменений) | `palette.error.main` |
| `--red-dim` `rgba(255,90,90,.12)` | `dangerDim` (**добавить**) | — |
| `--red-line` `rgba(255,90,90,.4)` | `dangerLine` (**добавить**) | — |
| `--amber` `#F5B74F` | `warning` (без изменений) | `palette.warning.main` |
| `--amber-dim` `rgba(245,183,79,.12)` | `warningDim` (**добавить**) | — |
| `--amber-line` `rgba(245,183,79,.4)` | `warningLine` (**добавить**) | — |
| `--overlay` `rgba(8,8,8,.55)` | `overlay` (**добавить**) | — (гейт графика) |
| `--overlay-hi` `rgba(8,8,8,.78)` | `overlayHi` (**добавить**) | — (подложка модалки) |
| `--q-default` `#9BA3AB` | `quality.default` (**добавить**, см. 2.2) | — |
| `--q-newbie` `#3ED598` | `quality.newbie` | — |
| `--q-stalker` `#53B7FF` | `quality.stalker` | — |
| `--q-veteran` `#B57BFF` | `quality.veteran` | — |
| `--q-master` `#FF5A5A` | `quality.master` | — |
| `--q-legend` `#FFB800` | `quality.legend` | — |
| `--head` Rajdhani | `fontHead` (**добавить**) | `typography.h1…h6.fontFamily` (уже так) |
| `--mono` JetBrains Mono | `fontMono` (**добавить**, см. 2.4) | — |
| `--ui` Inter | `fontUi` (**добавить**) | `typography.fontFamily` (уже так) |
| `--fs-10 … --fs-28` | `fs` (**добавить**, см. 2.3) | — |
| `--sp` 4px | — (комментарий в theme.ts; MUI `spacing` НЕ трогаем, см. 2.5) | — |
| `--nav-h` 48px | `navH: 48` (**добавить**; Layout и sticky-элементы читают отсюда) | — |
| `--r` 2px | — | `shape.borderRadius: 2` (**сменить с 12**) |
| `--r-lg` 4px | `radiusLg: 4` (**добавить**; максимум, >4px запрещены) | — |
| `--fast` 150ms | `motion.fast: 150` (**добавить**) | `transitions.duration.shorter: 150` |
| `--mid` 220ms | `motion.mid: 220` (**добавить**) | `transitions.duration.standard: 220` |
| `--ease` `cubic-bezier(.19,1,.22,1)` | `motion.ease` (**добавить**) | `transitions.easing.easeOut` |

`palette.info` (`#53B7FF`) оставить для MUI Alert severity="info"; в новом коде info-синий
как акцент запрещён — `#53B7FF` живёт только как `quality.stalker`.

`palette.primary.contrastText` — **остаётся `#F5F5F5`, не менять** (закреплено дизайн-системой).
Тёмный текст на золоте (`.gbtn:hover`, активный таб) задаётся явным `color: tokens.bg0`
в оверрайдах компонентов, а не через contrastText.

### 2.2 Единая шкала качества (закрывает COL-01, P0)

Добавить в `theme.ts`:

```ts
// ключ = поле `color` предмета из БД (как в CatalogPage: quality_color)
export const QUALITY_COLORS: Record<string, string> = {
  default: '#9BA3AB', newbie: '#3ED598', stalker: '#53B7FF',
  veteran: '#B57BFF', master: '#FF5A5A', legend: '#FFB800',
}
```

Удалить три локальных словаря: цветовую часть `utils/i18n.ts:74-81`, `QUALITY_CHIP_COLOR`
в `pages/CatalogPage.tsx:51-69` и `pages/LotsPage.tsx:98-105`. Ключи — только `color` из БД
(не русские имена). Отображение через `ui/QualityChip.tsx` (§3.2).

### 2.3 Размерная шкала

```ts
export const fs = {
  f10: '10px',   // киккеры (только Rajdhani-display)
  f105: '10.5px',// микро-моно: sysbar, заголовки таблиц
  f11: '11px',   // лейблы, чипы, оси графиков
  f115: '11.5px',// гистограммы, gbtn
  f12: '12px',   // вторичный текст, тултипы
  f125: '12.5px',// данные таблиц, инпуты, навссылки
  f13: '13px',   // body
  f14: '14px',   // значения статус-строки, заголовок модалки
  f15: '15px',   // бренд
  f16: '16px',   // заголовок гейта
  f26: '26px',   // h1 карточки предмета
  f28: '28px',   // медиана-цена (пик)
}
```

Пол жёсткий: текст ≥12, вспомогательный mono ≥10.5, киккеры ≥10. Все ad-hoc `0.5rem…0.72rem`
на переделываемых страницах заменяются значениями из шкалы (закрывает TYPE-02).

### 2.4 Что удалить из theme.ts

- `purple, purpleBright, purpleSoft, purpleDark` из `tokens` (theme.ts:450) — перед удалением
  grep по `tokens.purple` и замена на золотые ключи (аудит TOK-01/COL-05).
- `GLOW`/`tokens.glow` → `goldGlow`.
- `BG3 = '#202633'` (в v5 нет такой поверхности).
- Оверрайды `MuiAppBar` (theme.ts:104-120) — вместе с мёртвым `Navbar.tsx` (§4).

### 2.5 Что сознательно НЕ меняем

- `theme.spacing` остаётся 8 (дефолт MUI): смена базы на 4 молча пересчитала бы отступы
  немигрированных страниц. В новых компонентах — точные px из 4-шкалы (4/8/12/16/20/24).
- `primary.contrastText: '#F5F5F5'`.

### 2.6 Шрифты

1. `frontend/index.html` — в существующий Google Fonts `<link>` добавить
   `family=JetBrains+Mono:wght@400;500;700`; убедиться, что Inter имеет 400/500/600,
   Rajdhani 500/600/700 (как в `design/v5/DIRECTION.md` §8).
2. `frontend/index.html:14-31` — синхронизировать дублирующие CSS-переменные с новыми
   значениями токенов (или удалить дубли и оставить один источник — theme.ts; предпочтительно
   второе, если ничего вне React их не читает — проверить grep'ом).
3. В `theme.ts` → `MuiCssBaseline.styleOverrides` добавить глобальный класс:

```ts
'.mono': {
  fontFamily: tokens.fontMono,
  fontVariantNumeric: 'tabular-nums',
}
```

Применение: **все цифры и данные** (цены, количества, время, id, регионы) — `className="mono"`
либо `sx={{ fontFamily: tokens.fontMono, fontVariantNumeric: 'tabular-nums' }}`.
Цифры в таблицах/колонках — по правому краю. Rajdhani в данных запрещён (TYPE-01).
Generic `fontFamily: 'monospace'` (LotStatCard.tsx:357,729; InventoryPage.tsx:125;
MarketRadarPage.tsx:190) заменить на `tokens.fontMono`.

Туда же в `MuiCssBaseline`: глобальный фокус
`':focus-visible': { outline: '2px solid <gold>', outlineOffset: 1 }` (A11Y-01)
и `@media (prefers-reduced-motion: reduce)` — гашение transition/animation (MOT-01).

### 2.7 Общий форматтер (QA-находка прототипа)

Создать `frontend/src/utils/format.ts`:

```ts
export const fmtN = (n: number) => Math.round(n).toLocaleString('ru-RU')
export const fmtP = (n: number) => `${fmtN(n)} ₽`   // NBSP перед ₽ — не обычный пробел
export const fmtCompact = (n: number) => ...              // 1.2 млн / 340 тыс — портировать из design/v5/assets/app.js:39
```

Важно: `toLocaleString('ru-RU')` в разных движках даёт U+00A0 или U+202F как разделитель
разрядов — это ок; но пробел перед `₽` фиксируем явно как ` `, чтобы цена не рвалась
переносом. Все страницы используют только эти форматтеры (запрет «своего формата цен»,
DIRECTION §2). Существующие inline `toLocaleString('ru-RU')` (PriceChart, LotStatCard,
i18n.ts) перевести на util.

---

## 3. Компоненты

### 3.1 Оверрайды в theme.ts (`components`)

Правка существующих оверрайдов под контракт «Терминала» (без теней глубины, радиус 2,
максимум 4; `transition` — только перечисленные свойства, `transition: all` запрещён):

| MUI-компонент | Что меняется (эталон — блок base.css) |
|---|---|
| `MuiCard` / `MuiPaper` | фон `bg1`, граница `border`, радиус 2, **boxShadow: 'none'**, убрать hover-подсветку рамки по умолчанию (`.panel`) |
| `MuiButton` | радиус 2; `containedPrimary` = `.gbtn`: фон `goldDim`, граница `goldLine`, текст `goldAccent`, Rajdhani 700 uppercase letter-spacing .1em, hover — фон `gold` + цвет `bg0`; убрать градиент/translateY/`!important`; `outlined` = `.qbtn`: фон `bg2`, граница `border`, текст `text1` |
| `MuiIconButton` | `.ibtn`: 30×30, радиус 2, hover — цвет `goldAccent` + фон `bg2` |
| `MuiChip` | `.chip`: радиус 2, кегль `fs.f11`, граница `borderHi`; цветные варианты — пары `*Dim`/`*Line` |
| `MuiTableCell` | head: фон `bg2`, низ `borderHi`, Rajdhani 600 `fs.f105` uppercase `text2`; body: **mono + tabular-nums, right-align**, `fs.f125`, паддинг 6/10 |
| `MuiTableRow` | hover `bg2`, active `bg3`; selected: фон `goldDim` + `boxShadow: inset 2px 0 0 <goldHighlight>` (допустимый inset-акцент) |
| `MuiTextField` / `MuiSelect` | `.input`: высота 30 (36 в тулбарах), радиус 2, фон `bg2`, граница `border` → hover `borderHi` → focus `gold` |
| `MuiToggleButton` | `.tabs`: радиус 2, active — **заливка `gold`, текст `bg0`**, Rajdhani 600 `fs.f11` |
| `MuiSwitch` | `.switch`: прямоугольный трек 30×16 радиус 2, checked — `goldDim`/`goldLine`, ползунок `goldAccent` |
| `MuiDialog` | `.modal`: радиус 2, граница `borderHi`, **border-top 2px `gold`**, boxShadow none, подложка `overlayHi`; ширина 440 |
| `MuiTooltip` | `[data-tip]`: фон `bg3`, граница `borderHi`, радиус 2, текст `text0`, `fs.f12` |
| `MuiAlert` | радиус 2, пары `*Dim`/`*Line` |
| `MuiSkeleton` | `.skel`: фон `bg2`, радиус 2 (sweep-анимация опциональна) |
| `MuiMenu`/`MuiMenuItem` | фон `bg3`, радиус 2, selected `goldDim`+`goldAccent` |
| `MuiAppBar` | **удалить оверрайд целиком** |

### 3.2 Новые общие компоненты `src/components/ui/`

Один паттерн = один компонент, используется всеми страницами:

| Компонент | Эталон (base.css) | Контракт |
|---|---|---|
| `ui/Kick.tsx` | `.kick` | киккер: Rajdhani 600, `fs.f10`, uppercase, ls .16em, `text2` |
| `ui/Panel.tsx` | `.panel`, `.sec-h` | панель + опц. заголовок секции (h2 Rajdhani `fs.f12` ls .14em) |
| `ui/CompartmentGrid.tsx` | `.grid-2` + `.cell` | сетка с 1px-щелями: контейнер `background: tokens.border; gap: 1px`, ячейки непрозрачные `bg1` |
| `ui/StatusLine.tsx` | `.statusline` + `.st` | полоса метрик: киккер + mono-значение, варианты цвета g/a/gold/r |
| `ui/SortHeader.tsx` | `.thb` + `.si` | заголовок-«кнопка» колонки: `<button>` внутри `<th aria-sort>`, один индикатор ▲/▼ `fs` 9px золотой (закрывает SORT-01 + A11Y-01) |
| `ui/ArmDeleteButton.tsx` | `.dbtn` + `SC_APP.armConfirm` (app.js) | двухшаговое удаление: клик 1 → armed-состояние «Точно?» (red-dim) на 3 с, клик 2 → onConfirm; `confirm()` запрещён (DEL-01) |
| `ui/QualityChip.tsx` | `.chip.q` | чип качества: цвет из `QUALITY_COLORS[color]`, точка `.qd` currentColor, граница ~45% прозрачности цвета (через `alpha()`) |
| `ui/RiskChip.tsx` | `.risk.lo/.md/.hi` | статус-чип уровня |
| `ui/RegionSelect.tsx` | `select.input` | Select региона из общих констант `REGIONS` (вынести в `src/constants/regions.ts` из CatalogPage/LotsPage) — регион никогда не TextField (FORM-01) |
| `ui/ItemIcon.tsx` | `.t-ico` + `.fb` (`SC_APP.iconHtml`) | иконка предмета: img c `alt={name}` + фолбэк-буква на цвете качества (A11Y-03) |
| `ui/TierGate.tsx` | `.chart-wrap.gated` + `.gate` | гейт поверх графика: blur(6px) контента + `overlay` + замок + «Доступно на тарифе N» + CTA `.gbtn` — **единственный** вид locked-состояния блока (LOCK-01) |
| `ui/PageLock.tsx` | `.pagelock` | полностраничный гейт (Лоты без auction_access, Радар без аддона), тот же словарь + CTA |
| `ui/LockIcon.tsx` | `SC_SHELL.lockSvg` | один stroke-замок вместо трёх копий (LotStatCard.tsx:14, SalesHistoryCharts.tsx:28, Layout.tsx:27) |
| `ui/SysBar.tsx` | `.sysbar` | футер-строка: mono `fs.f105`, срез данных / регион / тариф; рендерит Layout |
| `ui/CategoryTree.tsx` | `.cattree` + `.ct-item` | дерево категорий для Каталога и Лотов — один компонент, одна ширина 272px (256 <1360px); словари из `utils/categories.ts`/`utils/i18n.ts` (в прототипе они продублированы в двух html — в продукте дубль запрещён, QA-находка) |
| `ui/Pager.tsx` | `.pager`, `.tfoot-line` | пагинация: кнопки 26px mono, активная — заливка `gold` текст `bg0` |
| `ui/Toast.tsx` (+хук `useToast`) | `.toast-stack` + `.toast` | единственный канал «успех/инфо»: правый нижний угол, фон `bg3`, граница `goldLine`, mono `fs.f12`; заменяет Alert-сверху (Catalog) и Snackbar (Lots) |
| `ui/Skeleton`-паттерны | `.skel` | скелетоны формы контента на каждой странице вместо CircularProgress (LOAD-01); эталон уже есть — `GlobalFeed.tsx:99-116` |

Правило: MUI as-is (без обёртки) — `Dialog`, `Alert`, `Collapse`, `Snackbar`-механика внутри
`ui/Toast`, `Pagination`-логика. Всё видимое — через оверрайды §3.1.

### 3.3 Графики: recharts под контракт charts.js

Библиотеку **не меняем** (recharts остаётся). Меняем стилевой контракт в
`components/PriceChart.tsx` (и обёртку `SalesHistoryCharts.tsx`):

1. **Обёртка `ui/ChartFrame.tsx`** (`.chart-wrap` + `.c-meta` + `.chart-empty`):
   рамка `border`, фон `bg2`, min-height 236px; строка меты сверху (mono `fs.f11`:
   `сделок N · мин X · сред Y` + легенда-свотчи `.sw`); empty-текст по центру;
   слот под `ui/TierGate`.
2. **Лог-шкала цены**: `<YAxis scale="log" domain={[lo, hi]} ticks={logTicks(lo, hi)} />`.
   Утилиту `logTicks` (тики 1-2-5 по декадам) портировать из
   `design/v5/assets/charts.js:31-44` в `src/utils/chartTicks.ts`.
3. **Палитра только из tokens** (закрывает CHART-01): grid → `tokens.grid`
   (сейчас `rgba(255,255,255,0.05)` хардкод, PriceChart.tsx:168), tick fill → `tokens.text2`
   + `fontFamily: tokens.fontMono` (сейчас `#7C7C7C`, :175,181), точки scatter → `tokens.gold`,
   тултип → стили `bg3`/`border` из tokens (сейчас хардкоды :193-196,222).
4. **Медиана-пунктир**: `<ReferenceLine y={median} stroke={tokens.goldAccent}
   strokeDasharray="4 3" strokeOpacity={0.8} />` в обоих режимах (scatter и daily).
5. **Зелёные точки ниже медианы** (scatter): раскраска по точке —
   `<Scatter>{data.map(d => <Cell fill={d.y < median ? tokens.success : tokens.gold} />)}</Scatter>`.
6. **Band-режим (7д/30д)**: Area коридора — stroke `tokens.goldLineSoft`, fill `tokens.goldDim`
   (вместо `tokens.info` — синий в графике цены запрещён); Line средней — `tokens.goldAccent`.
7. Loading — скелетон размеров графика вместо CircularProgress (PriceChart.tsx:151-155).

### 3.4 Motion

- Все transition — только `color, background-color, border-color, transform`,
  длительности из `tokens.motion` (150/220ms), easing `cubic-bezier(.19,1,.22,1)`.
- Декоративная анимация — только пульс live-точек (`pulse`) и шиммер скелетона.
- `prefers-reduced-motion: reduce` глушит всё (глобально в MuiCssBaseline, §2.6).
- `scrollTo({behavior:'smooth'})` / `scrollIntoView` — оборачивать проверкой
  `matchMedia('(prefers-reduced-motion: reduce)')` → `behavior:'auto'` (QA-находка прототипа;
  касается MonitoringPage scroll-к-предмету и будущих «наверх» в Каталоге/Радаре).

---

## 4. Шелл (Layout)

Эталон: `design/v5/assets/shell.js` + блоки `.topbar/.signals/.sysbar` в base.css.

1. **Один навбар.** `components/Layout.tsx` остаётся каноном: обычный `<div>` fixed,
   **НЕ MUI AppBar**. Высота меняется 56 → `tokens.navH` (48px). Стили переводятся
   с inline-`style={}` с хардкодами (`#F5F5F5`, `#7C7C7C`, `#B8B8B8` — Layout.tsx:99,103,152)
   на `sx` + tokens (STY-01). Структура по `.topbar`: бренд (ромб-SVG stroke `gold`) →
   nav-ссылки (Rajdhani 600 `fs.f125` uppercase, активная — `goldAccent` +
   **золотое подчёркивание 2px `goldHighlight`** + text-shadow `goldGlow`; НЕ pill-фон) →
   справа: EmissionWidget → username (mono) → бейдж тарифа `.tb-plan` → иконки
   Помощь/Настройки/Выход (`.ibtn`; активная шестерёнка на /app/settings — `goldDim`-подложка).
2. **Удалить мёртвый код** (NAV-01): `components/Navbar.tsx` (нигде не импортируется,
   ссылается на несуществующий роут `/app/sales-history`) и оверрайды `MuiAppBar`
   в theme.ts:104-120.
3. **Демо-переключателя тарифа в проде НЕТ.** `.demo`, `localStorage sc_demo_tier/sc_demo_radar`,
   событие `sc:tier` — прототипные инструменты, не переносятся. Гейтинг — из реальных полей
   `user` (`store/authStore.ts`): `auction_access` → пункт «Лоты» (замок `ui/LockIcon` + тултип
   «Доступно на тарифе Продвинутая+»), `has_market_radar_addon` → «Радар рынка»,
   `stats_windows: string[]` → доступные окна графиков 24ч/48ч/7д/30д (замки на табах +
   `ui/TierGate` на графике), `is_admin` — обходит гейты (текущая логика Layout.tsx:115-119
   сохраняется). Имена тарифов — из `constants/tiers.ts` (TIER_LABELS), не дублировать.
4. **Лента сигналов** — `components/GlobalFeed.tsx` рестайлится по `.signals`: панель
   `bg1` в 12px от навбара, слева блок «СИГНАЛЫ» + live-точка с «срез HH:MM», карточки
   с 1px-щелями (`.sig`), выбранная — inset-подчёркивание `goldHighlight`. Карточки —
   `<a>`/`<button>` с клавиатурой (A11Y-01). Данные — как сейчас (`store/feedStore.ts`,
   `/monitoring/signals/<item_id>`).
5. **SysBar** — новый `ui/SysBar.tsx` в конце `<main>`: «SC TRADING TERMINAL · срез данных …
   · регион RU · тариф N». Срез — из реального времени последнего обновления фида/статистики.
6. **Sticky-offset** (LAY-01): Layout публикует CSS-переменную
   `--sc-top-offset: calc(navH + высота ленты)` на контейнере (см. текущий расчёт
   `topOffset`, Layout.tsx:253) — страницы используют её в sticky-сайдбарах вместо
   магических `156px`/`16px`.
7. Пункт «Новости» остаётся в навбаре (страница вне охвата редизайна). «Лента» ведёт
   на новый FeedPage (§5.7); до Фазы 7 — текущая заглушка, но с CTA «Пока смотри Избранное».

---

## 5. Постраничный план

Общее для всех страниц: раскладка `.layout` (grid `1fr 272px` или `.rev` — сайдбар слева),
внешние поля 16px, спиннеры → скелетоны, все интерактивы — настоящие button/a,
все цифры — `.mono` right-align, весь цвет — tokens.

### 5.1 MonitoringPage (Избранное) — эталон, `app/favorites.html`

- Структура сохраняется: карточка предмета + графики || правый сайдбар-список.
- `LotStatCard.tsx`: шапка по `.pg-h` (киккер «ИЗБРАННОЕ · <категория>», h1 `fs.f26`,
  медиана — **единственный `goldHighlight` + глоу на экране**, `fs.f28` mono);
  статус-бар → `ui/StatusLine` (6 метрик с 1px-щелями); таблица выгодных лотов →
  оверрайды таблицы + `ui/SortHeader`, выбранная строка `aria-selected` (gold-dim +
  inset-полоса), клик по строке пересчитывает «Варианты продажи» (логика есть — сохранить);
  `#4caf50` → `tokens.success` (COL-02); колонки прибыли без фикс-86px (LotStatCard.tsx:303,659).
- `SalesHistoryCharts.tsx`: табы окон → MuiToggleButton-стиль `.tabs` (активный — заливка
  gold, текст bg0; замок на недоступных окнах из `user.stats_windows`); графики → §3.3;
  гейт → `ui/TierGate` с CTA.
- Сайдбар: `.side` sticky от `--sc-top-offset`, ширина 272px; поиск **фильтрует** список
  (а не скроллит к найденному — аудит §3.3); сортировка «выгодные наверх» не перетасовывает
  список под рукой при 30-сек обновлении (пересортировка только при явном действии);
  удаление из избранного — модалка остаётся (потеря истории наблюдения = невосстановимые
  данные, по контракту это единственный случай модалки), но в тексте имя качества,
  а не «кач. 2» (MonitoringPage.tsx:367).
- Реальные данные/поллинг/лимиты — без изменений.

### 5.2 CatalogPage — `app/catalog.html`

- Раскладка `.layout.rev`: `ui/CategoryTree` слева (272px), контент — панель с `.pg-h`
  (киккер + h1 «Каталог предметов» + `ui/StatusLine` со счётчиками), тулбар `.toolrow`
  (поиск + кнопка «Найти»), таблица.
- Кнопка «В избранное» в строке — **иконка-закладка `.ibtn`** (как в Лотах), не 50 outlined-кнопок;
  уже добавленный — `.ibtn.ok` (золотая, без hover-действия).
- Качество — `ui/QualityChip` (COL-01).
- Пагинация — **реальная** (текущая MUI Pagination-логика остаётся), рестайл под `ui/Pager`;
  в прототипе пагинация визуальная — не копировать её поведение.
- Модалка добавления: MuiDialog-оверрайд; регион — `ui/RegionSelect`; прогрессивное
  раскрытие качества/заточки для артефактов — сохранить.
- Успех добавления — `ui/Toast` (вместо Alert сверху).
- «2 236+ ENTRIES» — заменить реальным счётчиком из API.

### 5.3 LotsPage — `app/lots.html`

- Та же раскладка `.rev`, общий `ui/CategoryTree`.
- Полностраничный гейт `ui/PageLock` при `auction_access === false` (сейчас страница просто
  закрыта в навбаре — гейт нужен и на прямой заход по URL).
- Live-подсказки поиска, история запросов, чип «из кэша/свежие», сохранение фильтров —
  сохранить (сильные места по аудиту); `FiltersBar` вынести из тела компонента
  (LotsPage.tsx:432 — ремаунт).
- Таблица: `ui/SortHeader` с `aria-sort`; подсветка «лучшая цена» — у значения минимальной
  цены (не у первой строки первой страницы, LotsPage.tsx:873).
- Пагинация — реальная TablePagination, рестайл `.tfoot-line`.
- Качество — `ui/QualityChip`; регион — `ui/RegionSelect`; успех — `ui/Toast`.

### 5.4 MarketRadarPage — `app/radar.html`

- Гейт аддона → `ui/PageLock` (реальное поле `has_market_radar_addon`; состояния
  denied/error сохранить).
- Список — карточки-строки на 1px-щелях; ранг топ-3 золотой (сохранить); строка становится
  **кликабельной**: действия «Лоты» / «Карточка» (переход с выбранным предметом) + hover.
- Пустые метрики — «—» с одним тултипом вместо «нет данных» ×3.
- Пагинация реальная, без rowsPerPageOptions-обмана (фикс 20).
- Rajdhani в ранге — допустимая витрина; в данных — mono.

### 5.5 InventoryPage (Склад) — `app/inventory.html`

- Колонка «Товар» — имя + `ui/ItemIcon` (не сырой `item_id`).
- **P&L**: колонки «медиана сейчас» и «нереализованная прибыль» (`(медиана − цена закупки)
  × кол-во`, данные — те же item-stats, что у Избранного/Радара) + `ui/StatusLine` сводки
  по складу — прототип показывает состав; если стоимость запроса медиан по произвольным
  предметам спорна — обсудить с backend-dev, но UI закладывается сейчас.
- Удаление — `ui/ArmDeleteButton` (вместо `confirm()`, DEL-01b).
- Регион в модалке — `ui/RegionSelect` (FORM-01).
- Empty-state с CTA «Добавить товар».

### 5.6 SettingsPage — `app/settings.html`

- Одноколоночная `.pagecol` (maxWidth как в прототипе), панели: «Критерий выгодности»
  (живой пересчёт подсказки), «Уведомления» (тумблеры `.switch`; недоступны до привязки
  Telegram — с объяснением), «Telegram», «Тариф» (панель тарифа: имя, окна статистики
  из `stats_windows`, срок `tier_expires_at`).
- **Код привязки Telegram — реальный** (текущая логика: получение кода, таймер TTL,
  копирование, поллинг статуса — сохранить, только рестайл). «(демо) Симулировать привязку»
  из прототипа не переносится.
- Сохранение: либо автосохранение тумблеров, либо явный dirty-индикатор у кнопки
  «Сохранить» (аудит §3.8) — на усмотрение реализации, но свитч не должен выглядеть мгновенным.
- Telegram-синий — именованный токен `tokens.brandTelegram = '#229ED9'` (единственное
  допустимое внеплановое исключение, фиксируется в theme.ts с комментарием).

### 5.7 FeedPage (Лента) — `app/feed.html` — НОВАЯ ФИЧА

Продуктовая логика (из прототипа, `feed.html:115-124` — все формулы считаются из **уже
существующих** данных item-статистики):

| Тип | Условие | Данные |
|---|---|---|
| `lot` — выгодный лот | лучший лот предмета: `profit > 0`, маржа `profit / median_price_7d ≥ 5%` | `/monitoring/signals/<item_id>` — уже предвычислено для ленты |
| `spike` — всплеск опта | `sales_volume_24h ≥ 4 × (sales_volume_7d / 7)` | market_statistics (есть) |
| `move` — движение цены | `abs(avg_price_24h − avg_price_7d) / avg_price_7d ≥ 20%`, показывать топ-6 по силе | market_statistics (есть) |
| `emis` — выброс | событие игры из emission-трекера | backend emission (есть, шлёт в Telegram) |

UI: sticky-панель фильтров `.fbar` (чипы-тумблеры типов со счётчиками, «Мин. профит»,
«Только избранное»), лента карточек-строк `.ev` с цветовой полосой типа
(green/amber/gold/red), временные разделители, спарклайн 7д (мини-SVG или recharts
LineChart 118×28 без осей: линия `goldSoft`, конечная точка `goldAccent`), действия
«Лоты»/«Карточка» → переход с выбранным предметом; сводка 24ч + «Лучший сигнал дня»
в сайдбаре; пустое состояние учит следующему шагу.

**Требует бэкенд-обсуждения перед реализацией** (вызвать `researcher`/`backend-dev`):
события spike/move сейчас нигде не материализуются — нужен либо агрегирующий эндпоинт
`/feed/events` (Celery-задача пишет события при пересчёте market_statistics), либо
вычисление на лету по watchlist на клиенте (хватает текущих полей, но нет истории
«когда сигнал появился» и добора вне избранного). Прототипный «добор вне избранного от
категорийных медиан» — концепт, в проде только при наличии данных. Live-добавка раз в 45 с —
прототипная симуляция; в проде — поллинг как у GlobalFeed.

### 5.8 LandingPage / LoginPage — `app/index.html`, `app/login.html`

- Публичный хедер `.pub-top` (плоский div 48px, НЕ AppBar) + фон `.pub-bg`
  (ромб-сетка + верхнее золотое свечение) + футер `.pub-foot` (сохранить «не аффилирован
  с EXBO Studio»).
- Лендинг: hero без gradient-text (BAN-01 — слоган сплошным цветом) и без numbered
  eyebrows (BAN-02); живой виджет сигнала в hero — на реальных данных публичного API либо
  статичный пример; секция фич — Радар рынка вместо «Раздел в разработке»; тарифы.
- Логин: без питч-абзаца (перенести на лендинг/регистрацию); демо-автозаполнение полей
  из прототипа не переносится; разделять сетевые ошибки и неверный пароль.
- Логотип: один компонент `ui/DiamondLogo.tsx` (сейчас 4+ инлайн-копии: Layout, LoginPage,
  LandingPage ×2, Navbar).

---

## 6. Технический долг из AUDIT.md — чеклист

| ID | P | Находка | Статус в этом ТЗ |
|---|---|---|---|
| COL-01 | P0 | 3 системы цветов качества | **Фаза 1** (QUALITY_COLORS, обязательна) |
| NAV-01 | P1 | мёртвый Navbar.tsx + MuiAppBar-оверрайды | Фаза 2 (удаление) |
| DEL-01 | P1 | 3 паттерна удаления | Фаза 1 (`ui/ArmDeleteButton`) + Фаза 5 (Склад) + правка NewsPage на общий компонент — единственное касание NewsPage |
| FORM-01 | P1 | регион-TextField на Складе | Фаза 1 (`ui/RegionSelect`) + Фаза 5 (применение) |
| COL-02 | P1 | #4caf50 в MonitoringPage | Фаза 3 |
| COL-03 | P1 | Tailwind-красные в EmissionWidget | Фаза 2 (рестайл виджета в навбаре) |
| TYPE-01 | P1 | нет tabular-nums | Фаза 1 (класс `.mono`) + применение в фазах 3–6 |
| TYPE-02 | P1 | микро-кегли 8–10px | Фаза 1 (шкала fs) + применение в фазах 3–6 |
| A11Y-01 | P1 | кликабельные div без клавиатуры | Фаза 1 (глобальный :focus-visible) + фазы 2–6 (button/a, SortHeader) |
| A11Y-02 | P1 | контраст #7C7C7C / #555 | Фаза 1 (text2 → #8A939C, чипы качества ≥4.5:1) |
| STY-01 | P2 | inline style с хардкодами | Фаза 2 (Layout) + фазы 3–6 |
| NAME-01 | P2 | SC TRADING / STALZONE / SZ Assistant | Частично: веб — фазы 2–6 («SC Trading», площадка «аукцион STALZONE», голос «ты»); бот/API-тайтл — **вне охвата** (backend) |
| TOK-01 | P2 | purple*-алиасы | Фаза 1 (удаление) |
| LAY-01 | P2 | сайдбары 260/230/210, sticky 156px | Фаза 2 (`--sc-top-offset`) + фазы 3–4 (272px везде) |
| ICO-01 | P2 | два языка иконок, LockIcon ×3 | Фаза 1 (`ui/LockIcon`) + фазы 3–6 (stroke-набор в переделываемых экранах; тотальная замена Material Icons вне переделанных страниц — по остаточному принципу) |
| LOAD-01 | P2 | спиннеры вместо скелетонов | Фазы 3–6 (по страницам) |
| LOCK-01 | P2 | 4 вида locked без CTA | Фаза 1 (`ui/TierGate`/`ui/PageLock`) + фазы 3–5 |
| COPY-01 | P2 | «ты»/«вы» | Фазы 3–6 (вычитка строк переделываемых страниц, «ты») |
| BAN-01/02 | P2 | gradient text, numbered eyebrows | Фаза 6 |
| MOT-01 | P3 | transition:all, нет reduced-motion | Фаза 1 (тема) + Фаза 2 (Layout) |
| CHART-01 | P3 | хардкоды в PriceChart | Фаза 3 (§3.3) |
| SORT-01 | P3 | три вида стрелок сортировки | Фаза 1 (`ui/SortHeader`) + фазы 3–4 |
| A11Y-03 | P3 | alt/aria-label | Фазы 2–6 (ItemIcon, ibtn c aria-label) |
| Z-01 | P3 | z-index россыпью | Фаза 1 (шкала в tokens: nav 40, tooltip 50, modal 60, toast 70 — как в прототипе) |

Из QA-отчёта прототипа: дубль `CAT_RU`/`TREE` → в проде только `utils/i18n.ts` +
`utils/categories.ts` (§3.2 CategoryTree); NBSP в `fmtP` (§2.7); smooth-scroll под
`prefers-reduced-motion` (§3.4).

---

## 7. Очерёдность внедрения

Каждая фаза деплоится независимо (после фазы приложение целиком рабочее). После каждой
фазы — предложить `qa-tester`.

**Фаза 1 — фундамент: токены + theme.ts + шрифты + шкала качества.**
Файлы: `theme.ts`, `index.html`, `utils/format.ts`, `utils/chartTicks.ts`,
`constants/regions.ts`, `components/ui/*` (Kick, Panel, CompartmentGrid, StatusLine,
SortHeader, ArmDeleteButton, QualityChip, RiskChip, RegionSelect, ItemIcon, TierGate,
PageLock, LockIcon, Toast, Pager, DiamondLogo).
Приёмка: сборка проходит (`npm run build`); все страницы работают на новой теме
(радиусы 2, поверхности s0–s3, без теней); grep `tokens.purple` — пусто;
grep `#4caf50|#f44336|#2196f3|#9c27b0` в pages — качество везде из QUALITY_COLORS;
JetBrains Mono грузится; `:focus-visible` — золотое кольцо на любом интерактиве.

**Фаза 2 — шелл: навбар + лента + sysbar.**
Файлы: `Layout.tsx`, `GlobalFeed.tsx`, `EmissionWidget.tsx`, `ui/SysBar.tsx`;
удаление `Navbar.tsx` + MuiAppBar-оверрайдов.
Приёмка: навбар 48px по `.topbar` (активный пункт — подчёркивание, не pill); гейты
«Лоты»/«Радар» из полей user с тултипами; карточки ленты доступны с клавиатуры;
sysbar внизу; `--sc-top-offset` публикуется; хардкодов цвета в Layout нет.

**Фаза 3 — Избранное (эталон).**
Файлы: `MonitoringPage.tsx`, `LotStatCard.tsx`, `SalesHistoryCharts.tsx`, `PriceChart.tsx`,
`ui/ChartFrame.tsx`.
Приёмка: соответствие `app/favorites.html` (лог-шкала, медиана-пунктир, зелёные точки ниже
медианы, гейты окон из `stats_windows` с CTA); один `goldHighlight`-пик на экране; поиск
фильтрует; скелетоны вместо спиннеров; сортировка таблицы с aria-sort.

**Фаза 4 — Каталог + Лоты.**
Файлы: `CatalogPage.tsx`, `LotsPage.tsx`, `ui/CategoryTree.tsx`.
Приёмка: общее дерево 272px; реальная пагинация в стиле `.pager`/`.tfoot-line`; закладка
вместо кнопок; PageLock на «Лотах» без доступа; FiltersBar не ремаунтится; тосты.

**Фаза 5 — Радар + Склад + Настройки.**
Файлы: `MarketRadarPage.tsx`, `InventoryPage.tsx`, `SettingsPage.tsx` (+ правка NewsPage
на ArmDeleteButton).
Приёмка: PageLock радара; кликабельные строки радара; Склад — имя+иконка, ArmDeleteButton,
RegionSelect, P&L-колонки (или явно отложено после бэкенд-обсуждения); Настройки — реальный
Telegram-код, панель тарифа.

**Фаза 6 — Лендинг + Логин.**
Файлы: `LandingPage.tsx`, `LoginPage.tsx`.
Приёмка: pub-хедер/фон/футер; без gradient-text и numbered eyebrows; DiamondLogo общий;
логин без питча.

**Фаза 7 — Лента (новая фича).** ⚠ Начинать только после бэкенд-обсуждения (§5.7):
формат событий, эндпоинт, материализация spike/move. Файлы: `FeedPage.tsx` + возможные
backend-задачи (отдельное ТЗ через `researcher`).
Приёмка: 4 типа сигналов с фильтрами по реальным данным; переходы «Лоты»/«Карточка»;
пустое состояние с CTA.

---

## 8. Не трогать

- **API-контракты и эндпоинты** (`services/api.ts`, форматы ответов backend).
- **Роуты** (`App.tsx`) — кроме удаления упоминаний мёртвого `/app/sales-history` вместе с Navbar.tsx.
- **Бизнес-логику расчётов**: профит, медианы, варианты продажи, риски, лимиты избранного —
  только рестайл представления.
- **Гейтинг-поля и их семантику**: `tier`, `auction_access`, `has_market_radar_addon`,
  `stats_windows`, `is_admin` — читаем как есть, никаких новых полей/сторов тарифов.
- **Celery/backend** целиком (исключение — отдельно согласованное ТЗ Фазы 7 и, возможно,
  медианы для P&L Склада).
- `primary.contrastText: '#F5F5F5'` — не менять на тёмный.
- Поллинг-интервалы и rate-limit-параметры.
