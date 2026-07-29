# ТЗ: Адаптивная десктоп/мобильная версия фронтенда

## Контекст

Десктоп-портал `frontend/src` свёрстан под широкий экран (сайдбары 272px, широкие
таблицы, лента-оверлей поверх контента, `min-width`-раскладки). На телефоне формы
«плывут», таблицы уходят за край, появляется горизонтальный скролл. Пользователь
утвердил **отдельный мобильный дизайн** — автономный HTML/CSS/JS-прототип
`design/mobile/` (13 экранов, тот же функционал, переложенный на мобильную
раскладку по лучшим практикам: верхний минибар, нижний таб-бар, bottom-sheet'ы,
карточки-из-строк `.dcard`, мастер-деталь). Прототип — эталон раскладки.

Задача: перенести мобильную раскладку в живое React-приложение так, чтобы при
заходе с узкого экрана (телефон) показывалась мобильная версия, с широкого —
текущая десктопная (нетронутая), плюс ручной переключатель «Полная / Мобильная
версия», перебивающий авто-детекцию и сохраняемый в `localStorage`.

Ключевые уже принятые пользователем решения (заложены в ТЗ):
1. Детекция по ширине (`useMediaQuery`, брейкпоинт мобайл `<900px`) + ручной
   override (localStorage), override перебивает авто-ширину.
2. Десктоп не трогаем — существующие `pages/*`, `Layout.tsx` остаются как есть для
   широких экранов. Мобильная версия — отдельная ветка рендера.
3. Функционал не меняется — переносим ровно те же экраны/действия, что есть
   сейчас. Никаких новых фич. Никакого изменения частоты опроса Stalcraft API.

Прототип переиспользует токены `design/v5/assets/tokens.css`, которые в React уже
портированы 1:1 в `frontend/src/theme.ts` (`tokens` / `fs` / `QUALITY_COLORS`).
Мобильная имплементация ДОЛЖНА использовать те же токены. **Хекс/rgba вне
`theme.ts` = дефект.**

---

## Архитектурное решение

### Вариант (a) vs (b)

- **(a) Отдельный `MobileLayout` + отдельные мобильные страницы-компоненты**,
  десктоп нетронут, общий дата-слой (Zustand-сторы + `api/client` + утилиты + хуки).
- (b) Адаптив внутри каждой существующей страницы через брейкпоинты (`sx: { xs, md }`).

**Рекомендация — (a).** Обоснование:
- **Разные раскладки, не разные размеры.** Мобильный дизайн — не «сжатый десктоп»,
  а другая структура навигации (нижний таб-бар вместо верхнего навбара, master-detail
  вместо сайдбара, bottom-sheet вместо `Dialog`, `.dcard` вместо таблиц). Втискивать
  обе структуры в один компонент через брейкпоинты → лапша из условий, дорогая
  поддержка, высокий риск регрессий десктопа.
- **Десктоп-код не трогаем.** Ветка рендера выбирается на уровне роутинга; страницы
  `pages/*.tsx` и `Layout.tsx` остаются как есть (единственное согласованное
  исключение — добавление переключателя в футер `SysBar`, см. ниже).
- **Общий дата-слой = единственный источник правды.** Мобильные компоненты
  импортируют ТЕ ЖЕ сторы (`feedStore`, `authStore`, `emissionStore`), тот же
  `api/client`, те же утилиты (`utils/format`, `utils/i18n`) и (после точечной
  экстракции, см. §«Общие хуки») те же расчётные хуки. Отличается только презентация.
- **Независимый деплой по фазам.** Инфраструктура → эталон → остальные экраны можно
  катить частями; десктоп продолжает работать на каждом шаге.

Компромиссы, которые принимаем:
- Дублирование части page-level оркестрации (локальный стейт фильтров, диалогов).
  Снимаем это, вынося чистую расчётную/сетевую логику в общие хуки/утилиты (§ниже),
  а презентацию оставляя раздельной. Дублируем только раскладочный «клей».
- Небольшой рост бандла (мобильные компоненты). Приемлемо; можно лениво грузить
  мобильную ветку (`React.lazy`) — опционально, не обязательно в MVP.

Что НЕ делаем и почему:
- Не делаем SSR/гидратацию (проект — Vite SPA). Первый рендер синхронно читает
  `window.matchMedia` + `localStorage` → без «мигания» дольше одного кадра.
- Не вводим отдельный CSS-файл `mobile.css`. Весь стиль — через `sx`/`tokens`
  (правило «хекс вне theme.ts = дефект»). Словарь `.dcard`/`.msheet`/`.statusgrid`
  из прототипа переносим как React-компоненты со `sx`, читающими `tokens`/`fs`.
- Не меняем API, эндпоинты, частоту опроса, БД.

### Механизм выбора раскладки

Три части:

1. **`store/layoutStore.ts`** (Zustand, по образцу существующих сторов) — хранит
   ручной override, персист в `localStorage` (ключ `sc_layout_mode`).
   ```
   type LayoutOverride = 'auto' | 'desktop' | 'mobile'
   interface LayoutState {
     override: LayoutOverride
     setOverride: (o: LayoutOverride) => void   // пишет в localStorage
   }
   ```
   Инициализация `override` — синхронно из `localStorage` (fallback `'auto'`).

2. **`hooks/useLayoutMode.ts`** — комбинирует медиа-запрос и override:
   ```
   export function useLayoutMode(): {
     mode: 'mobile' | 'desktop'          // эффективный режим
     override: LayoutOverride
     setOverride: (o: LayoutOverride) => void
   }
   // внутри:
   //   const theme = useTheme()
   //   const isNarrow = useMediaQuery(theme.breakpoints.down('md')) // md=900 → max-width 899.95px
   //   const { override, setOverride } = useLayoutStore()
   //   const mode = override === 'auto' ? (isNarrow ? 'mobile' : 'desktop') : override
   ```
   Брейкпоинт `md` в MUI по умолчанию = 900px — совпадает с требованием `<900px`.
   Отдельную настройку брейкпоинтов в `theme.ts` не добавляем (дефолт подходит).

3. **`components/ModeSwitch.tsx`** — крошечный хелпер выбора элемента по режиму:
   ```
   export default function ModeSwitch({ desktop, mobile }: {
     desktop: React.ReactNode; mobile: React.ReactNode
   }) {
     const { mode } = useLayoutMode()
     return <>{mode === 'mobile' ? mobile : desktop}</>
   }
   ```

**Точка переключения — в `App.tsx`:**
- Родитель `/app` выбирает оболочку: `<ModeSwitch desktop={<Layout/>} mobile={<MobileLayout/>}/>`.
  Обе оболочки рендерят `<Outlet/>`, поэтому дочерние маршруты общие.
- Каждый дочерний маршрут выбирает страницу:
  `element={<ModeSwitch desktop={<MonitoringPage/>} mobile={<MobileFavoritesPage/>}/>}`.
- Публичные маршруты (`/`, `/login`, `/register`, `/faq`) — так же через `ModeSwitch`.

При смене override стор обновляется → `App` перерисовывается → оболочка и страницы
переключаются без перезагрузки. `ProtectedRoute`/`PublicOnlyRoute`/`AdminRoute`
остаются как есть (гейты по токену/роли не зависят от раскладки).

### Общие хуки (экстракция дата-слоя — обязательна для «функционал не меняется»)

Чтобы мобильные экраны считали прибыль/сигналы ТОЙ ЖЕ логикой, что десктоп
(единый источник формул), выносим сетевую+расчётную часть из презентационных
компонентов в хуки. Презентация (desktop vs mobile) остаётся раздельной.

1. **`hooks/useLotStats.ts`** — извлечь из `components/LotStatCard.tsx` весь
   `useEffect`-фетч (`/monitoring/item`, `/lots`, `/monitoring/signals`, интервал
   30с) и производные `useMemo` (`sellPrices`, `profitableLots`, `totalFilteredLots`,
   `statusMetrics`-сырьё, risk). Хук возвращает готовые данные; `LotStatCard`
   (десктоп) рефакторится на его потребление **с идентичным поведением на выходе**,
   `MobileLotStatCard` потребляет тот же хук. Комиссия `COMMISSION=0.05`,
   `MAX_PROFITABLE_LOTS`, формулы прибыли/маржи — единый источник в хуке.
   *Трейд-офф:* это единственный «инвазивный» рефактор десктопа; он оправдан —
   иначе формулы прибыли задвоятся и разъедутся. Проверять построчной эквивалентностью
   вывода (QA: сверить карточку Избранного до/после на десктопе).

2. **`hooks/useFeedPolling.ts`** — извлечь из `components/GlobalFeed.tsx` три
   `useEffect` c интервалами (stats каждые 5 мин, лоты каждые 30с, быстрый опрос
   непроверенных). `GlobalFeed` (десктоп) рефакторится на потребление хука;
   `MobileSignals` (мобайл) использует тот же хук. **Частота опроса не меняется** —
   интервалы переносятся дословно. За раз смонтирована только одна оболочка
   (десктоп ИЛИ мобайл), поэтому суммарная нагрузка на Stalcraft API не растёт.

3. **`utils` уже переиспользуемы** — `sortLots` из `LotsPage.tsx` вынести в
   `utils/lots.ts` (экспорт чистой функции) для переиспользования в `MobileLotsPage`.
   Прочие page-level стейты (фильтры, пагинация) допустимо дублировать —
   это раскладочный клей, не бизнес-логика.

*Если пользователь предпочтёт минимальный риск для десктопа* — п.1 и п.2 можно
заменить дублированием логики в мобильных компонентах (быстрее, но формулы
задвоятся). Рекомендация — экстракция. **Требует подтверждения подхода к экстракции
`useLotStats`/`useFeedPolling` перед началом Фазы 2.**

### Bottom-sheet

Мобильные модалки, фильтры, добавление, дерево категорий, шит «Ещё» — через один
переиспользуемый компонент **`components/mobile/BottomSheet.tsx`**.

**Решение: обёртка над MUI `Drawer anchor="bottom"`** (не самописный оверлей).
Обоснование: из коробки получаем focus-trap, портал, backdrop (тема уже задаёт
`MuiBackdrop → OVERLAY_HI`), закрытие по ESC/бэкдропу, блокировку скролла — не
изобретаем управление фокусом. Стилизуем `paper` под `.msheet`:
`border-top: 2px solid tokens.gold`, скругление только верхних углов (`radiusLg`=4),
`max-height: 88vh`, `overflow-y: auto`, `padding-bottom: calc(12px + safe-area-b)`,
sticky-шапка с заголовком и кнопкой закрытия, «грабилка» (grab-handle) сверху.
API: `open`, `onClose`, `title`, `children`, опц. `footer`.
`SwipeableDrawer` (свайп-закрытие) — опционально, можно добавить позже; в MVP
достаточно `Drawer`.

На мобиле все текущие `Dialog` заменяются на `BottomSheet` (см. маппинг). Исключение
— удаление строк: по инварианту «Терминала» это двухшаговый `armConfirm`
(`ArmDeleteButton`), а не диалог; в мобильном Избранном удаление — inline
armConfirm (как в прототипе `favorites.html`, кнопка `.dbtn`), не `Dialog`.

---

## Затронутые файлы

### Создаём

Инфраструктура:
- `frontend/src/store/layoutStore.ts`
- `frontend/src/hooks/useLayoutMode.ts`
- `frontend/src/components/ModeSwitch.tsx`
- `frontend/src/hooks/useLotStats.ts` (экстракция из LotStatCard)
- `frontend/src/hooks/useFeedPolling.ts` (экстракция из GlobalFeed)
- `frontend/src/utils/lots.ts` (экстракция `sortLots`)

Мобильная оболочка (`components/mobile/`):
- `MobileLayout.tsx` — минибар + лента сигналов + `<Outlet/>` + таб-бар + шит «Ещё» + sysbar
- `MobileTopBar.tsx` — верхний минибар (бренд, бейдж тарифа, индикатор выброса, Настройки, Выход)
- `MobileTabBar.tsx` — нижний таб-бар (5 слотов, замки, «Ещё»)
- `MoreSheet.tsx` — шит «Ещё» (Лента/Новости/Радар/Настройки/Помощь/Админ/Выход + переключатель раскладки)
- `MobileSignals.tsx` — лента сигналов (использует `useFeedPolling` + `feedStore`)
- `MobileSysBar.tsx` — футер-строка (или переиспользовать `SysBar` со `sx`)
- `MobileEmission.tsx` — индикатор выброса в минибаре (использует `emissionStore`)
- `BottomSheet.tsx` — переиспользуемый sheet
- `LayoutSwitchControl.tsx` — контрол «Авто / Полная / Мобильная»

Переиспользуемые мобильные UI-примитивы (`components/mobile/ui/`):
- `DCard.tsx` — карточка-из-строки (`.dcard`: иконка + имя/подпись + правое значение + опц. kv-строки/чипы/футер)
- `StatusGrid.tsx` — статус-сетка 2/3 колонки (`.statusgrid`)
- `Sheet primitives` по мере надобности (SheetNavItem, SegBar) — минимально, через `sx`

Мобильные страницы (`pages/mobile/`):
- `MobileFavoritesPage.tsx` + `MobileLotStatCard.tsx`
- `MobileCatalogPage.tsx`
- `MobileLotsPage.tsx`
- `MobileBuySniperPage.tsx`
- `MobileNewsPage.tsx`
- `MobileMarketRadarPage.tsx`
- `MobileSettingsPage.tsx`
- `MobileAdminPage.tsx`
- `MobileLandingPage.tsx`
- `MobileLoginPage.tsx`
- `MobileRegisterPage.tsx`
- `MobileFaqPage.tsx`
- `FeedPage` — переиспользуем как есть (заглушка центрирована, работает на мобиле).

### Изменяем (минимально, только точки переключения)

- `frontend/src/App.tsx` — обернуть маршруты в `ModeSwitch`.
- `frontend/src/components/GlobalFeed.tsx` — рефактор на `useFeedPolling` (поведение
  идентично).
- `frontend/src/components/LotStatCard.tsx` — рефактор на `useLotStats` (поведение
  идентично).
- `frontend/src/pages/LotsPage.tsx` — импорт `sortLots` из `utils/lots` (перенос
  без изменения логики).
- `frontend/src/components/ui/SysBar.tsx` — добавить `LayoutSwitchControl`
  (единственная согласованная правка десктопной оболочки — точка переключения в
  футере).

### НЕ трогаем

Все прочие `pages/*.tsx`, `Layout.tsx`, `theme.ts` (кроме чтения токенов),
`api/client.ts`, сторы (кроме нового `layoutStore`), бэкенд.

---

## Мобильная оболочка (по образцу `mshell.js`)

`MobileLayout` рендерит (геометрия — из `mobile.css`, значения через `tokens`/`sx`):

- **Верхний минибар** (`fixed`, top, `z` выше контента, высота ~52px +
  `env(safe-area-inset-top)`): бренд (`DiamondLogo` + «SC TRADING»), справа —
  `MobileEmission` (индикатор выброса из `emissionStore`), бейдж тарифа
  (`TIER_LABELS[user.tier]`), иконка Настройки (→ `/app/settings`), иконка Выход
  (`authStore.logout` → `/`). Иконки stroke=currentColor, тач-цель ≥44px.
- **Лента сигналов** (`MobileSignals`, скроллится с контентом, не fixed):
  горизонтальный трек карточек сигналов из `feedStore.feedItems` (иконка, имя,
  «обн. HH:MM», бейдж `+N`). Клик по сигналу → навигация
  `/app/monitoring` c `state={{ scrollTo: entry.id }}` (как `GlobalFeed.handleClick`);
  на самой странице Избранного — выбор карточки без навигации. Пусто/скелетон —
  как в `GlobalFeed`. Данные и интервалы — через `useFeedPolling` (та же частота).
- **`<Outlet/>`** в `.mmain`-контейнере: одна колонка, боковые поля `--pad`(12px),
  `max-width` центрирован (планшет), `padding-top`/`padding-bottom` под fixed-бары
  + safe-area, `overflow-x: hidden` на body.
- **Нижний таб-бар** (`MobileTabBar`, `fixed` bottom, высота ~58px +
  `env(safe-area-inset-bottom)`, `grid` 5×1fr): слоты
  **Избранное** (`/app/monitoring`) · **Каталог** (`/app/catalog`) ·
  **Лоты** (`/app/lots`, gate `auction_access`) ·
  **Закупки** (`/app/buy-sniper`, gate `buy_sniper`) · **Ещё** (открывает `MoreSheet`).
  Активный слот — золотой с верхним 2px-подчёркиванием (`.mtab a[aria-current]`).
  Замок на недоступном слоте → клик показывает `Toast` (тултип тарифа), не навигация.
- **Шит «Ещё»** (`MoreSheet`, на базе `BottomSheet`): пункты
  **Лента** (`/app/feed`) · **Новости** (`/app/news`) ·
  **Радар рынка** (`/app/market-radar`, gate addon `market_radar`) ·
  **Настройки** (`/app/settings`) · **Помощь / FAQ** (`/faq`) ·
  **Админ** (`/app/admin`, только `user.is_admin`) · разделитель ·
  **Выход** (danger). Плюс блок **«Версия интерфейса»** с `LayoutSwitchControl`.
  Активный пункт подсвечен по `location.pathname`. Замки → `Toast`.
- **Sysbar** (`MobileSysBar` или `SysBar`): «SC TRADING TERMINAL · mobile · срез
  HH:MM · регион RU · тариф N (+ Радар)». Срез — `feedStore.lastLotRefresh`.

**Гейтинг** — та же логика, что в десктопном `AppNav` и на страницах:
`user.is_admin` обходит всё; иначе `auction_access === false` (Лоты),
`buy_sniper_access === false` (Закупки), `!has_market_radar_addon` (Радар).
При прямом заходе по URL на закрытый раздел — страница сама рендерит `PageLock`
(мобильные Lots/Radar/BuySniper повторяют этот гейт, как десктопные).

**Переключатель раскладки** (`LayoutSwitchControl`) — читает/пишет `layoutStore`:
- В мобиле — в `MoreSheet` («Версия интерфейса»): сегмент `Авто · Полная`
  (выбор `mobile→auto` / `desktop`). Выбор «Полная» ставит `override='desktop'` и
  открывает десктоп-раскладку на этом же экране.
- В десктопе — в футере `SysBar`: компактная ссылка «Мобильная версия»
  (`override='mobile'`); когда пользователь на широком экране принудительно в
  мобиле — «Полная версия» (`override='desktop'` / сброс в `auto`).
- Дать возможность вернуться в `auto` (пункт «Авто (по ширине экрана)»).

---

## Маппинг «прототип-экран → React-компонент»

Приёмы адаптации (из `mobile.css`): широкие таблицы → `.dcard`-стопки; сайдбары
272px → master-detail или `BottomSheet` c контентом сайдбара; `StatusLine` 6 кол →
`StatusGrid` 2–3 кол; 2×2 grid → вертикальная стопка `.mstack`; `Dialog` →
`BottomSheet`; фильтры/дерево категорий → `BottomSheet`.

| # | Прототип | Роут | Новый мобильный компонент | Данные / хуки / стор (переиспользуем) | Десктоп-UI как есть | Нужен мобильный вариант |
|---|----------|------|---------------------------|----------------------------------------|---------------------|--------------------------|
| 1 | `index.html` | `/` | `MobileLandingPage` | статические данные, `format`, `QUALITY_COLORS` | `DiamondLogo`, `Kick` | вся раскладка (hero-стопка, карточки фич, тарифы в одну колонку), без shell |
| 2 | `login.html` | `/login` | `MobileLoginPage` | `authStore.login` | `DiamondLogo` | форма в одну колонку, инпуты 16px, без shell |
| 3 | `register.html` | `/register` | `MobileRegisterPage` | `authStore.register` | `DiamondLogo` | форма в одну колонку, без shell |
| 4 | `faq.html` | `/faq` | `MobileFaqPage` | статический контент FAQ + таблица тарифов | MUI `Accordion` (или `.acc`-стопка) | таблица тарифов в `.scroll-x`, без shell |
| 5 | `favorites.html` | `/app/monitoring` | `MobileFavoritesPage` + `MobileLotStatCard` | `feedStore` (watchlist, feedItems, minProfitMargin), `useLotStats`, `api /watchlist DELETE`, `authStore` (лимиты/окна) | `ItemIcon`, `QualityChip`, `Kick`, `SalesHistoryCharts`, `LockIcon` | master-detail (`.dlist` DCards ⇄ карточка `.c-med`/`StatusGrid c3`/`.mstack`); удаление — inline armConfirm (не Dialog) |
| 6 | `catalog.html` | `/app/catalog` | `MobileCatalogPage` | `api /items`, `api /watchlist POST`, `feedStore.watchlist` | `ItemIcon`, `QualityChip`, `RegionSelect`, `Pager`, `Kick`, `Toast` | таблица → `.dlist` DCards; `CategoryTree` → `BottomSheet`; добавление (Dialog) → `BottomSheet`; `StatusLine` → `StatusGrid` |
| 7 | `lots.html` | `/app/lots` | `MobileLotsPage` | `api /items`, `api /lots`, `api /lots/{id}`, `api /watchlist POST`, `authStore` (gate), `sortLots` (utils), history (localStorage) | `PageLock`, `ItemIcon`, `QualityChip`, `RegionSelect`, `Kick`, `SortHeader`(→ мобильная сортировка), `Toast` | автодополнение → `.search` + список/шит; `CategoryTree` → `BottomSheet`; фильтры качество/заточка → `BottomSheet`; таблица → `.dcard`; гейт `auction_access` через `PageLock` |
| 8 | `buy-sniper.html` | `/app/buy-sniper` | `MobileBuySniperPage` | `api /buy-sniper` (GET/POST/PUT/DELETE), `/buy-sniper/price-window`, `/watchlist`, `/telegram/status` | `ItemIcon`, `ArmDeleteButton`, `Kick`, `Toast` | таблица алертов → `.dcard` (подсветка «горит»); добавление/редактирование (Dialog) → `BottomSheet`; `StatusLine` → `StatusGrid c2` |
| 9 | `feed.html` | `/app/feed` | переиспользуем `FeedPage` | — | весь `FeedPage` (заглушка центрирована) | — (работает на мобиле как есть) |
| 10 | `news.html` | `/app/news` | `MobileNewsPage` | `api /news` (GET/POST/PUT/DELETE), `authStore.is_admin` | теги/чипы | карточки новостей в стопку; форма админа (Dialog) → `BottomSheet`; черновики |
| 11 | `radar.html` | `/app/market-radar` | `MobileMarketRadarPage` | `api /market-radar`, `authStore.has_market_radar_addon`, `format` | `ItemIcon`, `QualityChip`, `PageLock`, `Panel` | рейтинг-строки → `.dcard` c метриками (`StatusGrid`/kv); действия Лоты/Карточка → кнопки (навигация с `state`); гейт addon → `PageLock` |
| 12 | `settings.html` | `/app/settings` | `MobileSettingsPage` | `api /settings`, `/telegram/*`, `lib/push`, `authStore` | `Panel`, `Kick`, `Toast`, `TumblerSwitch`(вынести/повторить) | панели в одну колонку (уже `setcols md`); тумблеры/критерий/Telegram/тариф без изменений логики |
| 13 | `admin.html` | `/app/admin` | `MobileAdminPage` | `api /admin/*` (users/settings/stats/tier/...) | `Kick`, `StatusLine`→`StatusGrid`, `Panel`, `Toast` | таблица пользователей → `.dcard` c раскрывающимися контролами (тариф/срок/лимит/аддон/approve); статистика → `StatusGrid` |

Примечания:
- Публичные экраны (1–4) рендерятся **без** мобильной оболочки (`MobileLayout`) —
  они вне `/app`. Кнопки «Войти»/«Регистрация»/«Помощь» ведут на соответствующие
  роуты; после логина — `/app/monitoring` (мобильная оболочка подхватится по роуту).
- Экран 9 (Лента) — заглушка и в проде; отдельный мобильный компонент не нужен.
- `MobileLotStatCard` и `LotStatCard` делят `useLotStats` (§Общие хуки) —
  расчёт прибыли/сигналов/риска идентичен.

---

## Фазы внедрения (независимый деплой каждой)

### Фаза 1 — Инфраструктура
Файлы: `layoutStore.ts`, `useLayoutMode.ts`, `ModeSwitch.tsx`, `BottomSheet.tsx`,
`MobileLayout.tsx`, `MobileTopBar.tsx`, `MobileTabBar.tsx`, `MoreSheet.tsx`,
`MobileSignals.tsx`, `MobileSysBar.tsx`, `MobileEmission.tsx`,
`LayoutSwitchControl.tsx`, `useFeedPolling.ts` (+ рефактор `GlobalFeed.tsx`),
`components/mobile/ui/DCard.tsx`, `StatusGrid.tsx`, правки `App.tsx`, `SysBar.tsx`.
Мобильные страницы на этой фазе — временные заглушки/минимальный рендер, чтобы
проверить оболочку и навигацию.
Критерии готовности:
- На `<900px` показывается мобильная оболочка (минибар + таб-бар + лента + sysbar),
  на `≥900px` — прежняя десктопная (без изменений).
- Таб-бар навигирует между роутами; «Ещё» открывает шит; замки → тост.
- Переключатель раскладки в шите «Ещё» и в футере `SysBar` работает в обе стороны,
  выбор сохраняется в `localStorage`, `auto` восстанавливается.
- Частота опроса Stalcraft API не изменилась (интервалы `useFeedPolling` = прежние).
- `npm run build` (tsc + vite) проходит; десктоп визуально не изменился.

### Фаза 2 — Эталон «Избранное»
Файлы: `useLotStats.ts` (+ рефактор `LotStatCard.tsx`), `MobileFavoritesPage.tsx`,
`MobileLotStatCard.tsx`, довести `MobileSignals` (клик по сигналу → выбор карточки).
Критерии:
- Master-detail: список `.dcard` ⇄ карточка (медиана `.c-med`, `StatusGrid c3`,
  стопка «Выгодные лоты» / «Динамика цен» (`SalesHistoryCharts`) / «Варианты
  продажи» / «Пачки»). Данные совпадают с десктопом (тот же `useLotStats`).
- Клик по строке выгодного лота пересчитывает «Варианты продажи» (как десктоп).
- Гейты окон графика (7д/30д) по `stats_windows` — как в десктопе.
- Удаление — двухшаговый inline armConfirm (не Dialog), обновляет `feedStore`.
- Десктопная карточка Избранного после рефактора `useLotStats` идентична прежней
  (сверка QA).

### Фаза 3 — Остальные app-экраны
Файлы: `MobileCatalogPage.tsx`, `MobileLotsPage.tsx` (+ `utils/lots.ts`),
`MobileBuySniperPage.tsx`, `MobileMarketRadarPage.tsx`, `MobileNewsPage.tsx`,
`MobileSettingsPage.tsx`; подключить `FeedPage` в мобильную ветку.
Критерии:
- Каждый экран — одна колонка, без горизонтального скролла на 360–430px.
- Диалоги/фильтры/дерево категорий → `BottomSheet`; таблицы → `.dcard`.
- Гейты тарифов (Лоты/Закупки/Радар) повторяют десктоп (`PageLock` при прямом заходе).
- Действия (добавить/удалить/редактировать/порог/привязать TG/push/сохранить)
  вызывают те же эндпоинты и дают те же тосты.

### Фаза 4 — Публичные экраны
Файлы: `MobileLandingPage.tsx`, `MobileLoginPage.tsx`, `MobileRegisterPage.tsx`,
`MobileFaqPage.tsx`.
Критерии:
- Лендинг/логин/регистрация/FAQ — одна колонка, формы не «плывут», инпуты 16px
  (анти-зум iOS), без shell.
- Логин ведёт в `/app/monitoring` (мобильная оболочка подхватывается).
- FAQ: аккордеоны + таблица тарифов в горизонтально-скроллируемом контейнере.

### Фаза 5 — Админ
Файл: `MobileAdminPage.tsx`.
Критерии:
- Пользователи — `.dcard` c раскрывающимися контролами (approve/revoke, тариф,
  срок/продление, лимит избранного, аддон Радар). Статистика — `StatusGrid`.
- Все админ-действия вызывают те же `/admin/*` эндпоинты.

Карта зависимостей: Ф1 → (Ф2, Ф3, Ф4, Ф5 независимы между собой, но все после Ф1).
Ф2 зависит от `useLotStats`; Ф1 зависит от `useFeedPolling`.

---

## Инварианты и ограничения

- **Цвет — только `theme.ts`** (`tokens`/`fs`/`QUALITY_COLORS`). Хекс/rgba в
  компонентах = дефект. Мобильные `sx` читают токены.
- **«Терминал»**: радиусы ≤4px (`tokens.radiusLg`=4, база 2); без теней-глубины
  (допустим только token-glow `goldGlow` как text-shadow пиков); золото — единственный
  акцент, один «пик» `goldHighlight` на экран; статусные цвета — только статусы,
  `QUALITY_COLORS` — только качество; Rajdhani — заголовки/киккеры, JetBrains Mono
  (`.mono`, tabular, right-align) — цифры/данные, Inter — проза.
- **Тач-цели ≥44px** (таб-бар, кнопки, пункты шита, иконки минибара).
- **Инпуты `font-size: 16px`** на мобиле (анти-зум iOS) — MUI TextField по умолчанию
  меньше; для мобильных полей задать 16px явно.
- **Safe-area**: fixed-бары учитывают `env(safe-area-inset-top/bottom)`;
  `<meta viewport>` в `index.html` должен содержать `viewport-fit=cover` (проверить/
  добавить — единственная возможная правка `frontend/index.html`).
- **Двухшаговое удаление** (`ArmDeleteButton`/inline armConfirm), без `confirm()`.
- **`prefers-reduced-motion`** — уважать (тема уже гасит анимации глобально; sheet-
  анимации через MUI подчинятся).
- **Десктоп-поведение не меняется** — единственные правки десктопа: `App.tsx`
  (обёртки `ModeSwitch`), `GlobalFeed.tsx`/`LotStatCard.tsx` (рефактор на общие
  хуки, вывод идентичен), `SysBar.tsx` (контрол переключения), `LotsPage.tsx`
  (импорт `sortLots`).
- **Частота опроса Stalcraft API не меняется.** Мобильная лента использует те же
  интервалы (`useFeedPolling`: лоты 30с, stats 5мин), `emissionStore` — свой прежний
  поллинг. Одновременно смонтирована одна оболочка → суммарная нагрузка не растёт.
  **Не требует подтверждения по rate limit** (изменений частоты нет).

---

## Верификация (end-to-end)

- **DevTools device mode (F12)** + **реальный телефон** (та же Wi-Fi,
  `docker compose up -d` → `http://<IP>:3000`, либо `npm run dev`).
- Ширины **360 / 390 / 430px**: все 13 экранов **без горизонтального скролла**.
- **Переключатель**: авто→полная→мобильная в обе стороны, из мобилы и из десктопа;
  выбор сохраняется после перезагрузки; сброс в «Авто» реагирует на ширину.
- **Порог 900px**: пересечение брейкпоинта авто-переключает раскладку (при `auto`).
- **Гейты тарифов**: под `base` (нет Лотов/Закупок/уведомлений), `advanced`,
  `advanced_plus`, `advanced_max`, с/без аддона Радар, под `is_admin` — замки на
  таб-баре/шите и `PageLock` при прямом URL совпадают с десктопом.
- **Данные совпадают с десктопом**: Избранное (прибыль/сигналы/риск/графики),
  Лоты, Закупки, Радар, Настройки, Админ — одинаковые значения в обеих раскладках.
- **Sheets**: открытие/закрытие по бэкдропу/ESC/кнопке, focus-trap, скролл внутри,
  safe-area снизу.
- **Формы**: инпуты не зумят на iOS (16px); логин/регистрация проходят.
- **Регресс десктопа**: карточка Избранного и лента до/после рефактора хуков —
  идентичны; `npm run build` зелёный.
- Предложить прогон через `qa-tester` (браузерное QA — не выполнять в основном потоке).

---

## Документация для обновления (через `tech-writer`, после реализации)

- `docs/NOTES.md`: добавить задачу «Адаптивная мобильная версия фронтенда»
  со ссылкой на это ТЗ и статусами фаз (`[ ]`→`[x]` по мере внедрения).
- `docs/CHANGELOG.md`: запись о мобильной раскладке, `useLayoutMode`,
  `MobileLayout`, `BottomSheet`, экстракции `useLotStats`/`useFeedPolling`.
- `CLAUDE.md` (Блок 4, «Структура»): отметить `frontend/src/components/mobile/` и
  `pages/mobile/`, механизм `useLayoutMode` (брейкпоинт 900px + localStorage
  `sc_layout_mode`), ссылку на `design/mobile/` как эталон.
- БД/SERVICES/DATABASE — **не затрагиваются** (бэкенд не меняется).

---

## Маршрутизация по агентам

- **`researcher`** — выполнено (это ТЗ).
- **`frontend-dev`** — реализация, вход: `docs/tasks/mobile-adaptive-frontend.md`.
  Порядок: Фаза 1 → (подтверждение подхода к экстракции `useLotStats`/`useFeedPolling`)
  → Фаза 2 → Фаза 3 → Фаза 4 → Фаза 5. Каждая фаза — отдельный деплоируемый инкремент,
  после каждой — подтверждение перед коммитом.
- **`designer`** — не требуется (эталон раскладки — прототип `design/mobile/`;
  визуальные решения уже приняты). Привлекать только при отклонениях от прототипа.
- **`tech-writer`** — после реализации, обновление docs (см. выше).
- **`qa-tester`** — предложить после Фазы 2 и после Фазы 5 (браузерное QA).
- **`deploy`** — предложить после QA (пересборка фронта; миграций/бэкенд-изменений нет).

## Открытые вопросы / требует подтверждения

- **Подход к экстракции `useLotStats` / `useFeedPolling`** (рефактор десктопных
  `LotStatCard`/`GlobalFeed` ради единого дата-слоя) vs дублирование логики в
  мобильных компонентах. **Рекомендация — экстракция.** Подтвердить перед Фазой 2.
- **Поведение сброса переключателя**: оставлять третье состояние «Авто» явным
  пунктом или только бинарный тумблер «Полная/Мобильная» (тогда возврат к авто —
  очистка `localStorage`). Рекомендация — явный «Авто».
- **Ленивая загрузка мобильной ветки** (`React.lazy` для `pages/mobile/*`) —
  опционально, для экономии бандла. Не блокирует MVP.
- Частоту опроса Stalcraft API задача **не меняет** — подтверждения по rate limit
  не требуется.
