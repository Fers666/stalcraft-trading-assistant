# SC Trading · design v5 · Направление A «Терминал» — контракт

Победитель этапа A. Все следующие страницы прототипа (`design/v5/app/*.html`) собираются
на этой системе. Эталон: `design/v5/app/favorites.html`.
Инварианты из `design/v5/AUDIT.md` (раздел «Выводы») обязательны.

---

## 1. Палитра — только токены из `assets/tokens.css`

**Правило ревью: хекс или rgba-литерал вне tokens.css = дефект.** В страничном CSS/JS —
только `var(--…)`. В `charts.js` цвета читаются из токенов через `getComputedStyle`.

| Токен | Назначение |
|---|---|
| `--s0` | фон страницы |
| `--s1` | панель (`.panel`, `.cell`, навбар, sysbar) |
| `--s2` | приподнятая ячейка: thead, инпуты, статус-строка, фон графика, hover |
| `--s3` | верхний слой: тултип, тост, active-состояния |
| `--line` / `--line-hi` | базовая / акцентная граница; `--line` — ещё и цвет 1px-щелей сеток |
| `--grid`, `--tick` | сетка и риски осей графиков |
| `--gold-1 → --gold → --gold-2 → --gold-hi` | шкала золота: от тёмного (градиенты, скроллбар) к пику (ключевая цифра, глоу, активное подчёркивание) |
| `--gold-dim`, `--gold-glow`, `--gold-line`, `--gold-line-soft` | золотые подложка / глоу / границы |
| `--text`, `--mut`, `--faint` | текст: основной / вторичный / лейблы-киккеры (оба ≥4.5:1 на `--s3`) |
| `--green(-dim/-line)` | профит, «ниже медианы», live-индикатор |
| `--red(-dim/-line)` | убыток, опасное действие (удаление) |
| `--amber(-dim/-line)` | предупреждение, «истекает», выброс |
| `--overlay`, `--overlay-hi` | подложка гейта / модалки |
| `--q-*` | ЕДИНАЯ шкала качества предметов (ключ = `color` из БД). Другие словари цветов качества запрещены |

Иерархия акцента: на экране один «пик» `--gold-hi` с глоу (ключевая цифра экрана —
как медиана в Избранном). Остальное золото — уровнем ниже. Глоу (`text-shadow`/`box-shadow`
с `--gold-glow`) — только активным/ключевым элементам, не декору.

## 2. Типографика

- **Rajdhani (`--head`)** — ТОЛЬКО заголовки, киккеры, навигация, имена кнопок. Никогда — данные.
- **JetBrains Mono (`--mono`)** — ВСЕ цифры и данные: цены, количества, время, id, регионы.
  Всегда с `font-variant-numeric: tabular-nums` (класс `.mono` или в компоненте).
- **Inter (`--ui`)** — прочий UI-текст (body 13px).
- Цифры в таблицах и колонках — **выравнивание по правому краю**. Формат цен: `1 234 567 ₽`
  (`SC_APP.fmtP/fmtN/fmtCompact`), не изобретать свой.
- Шкала размеров — токены `--fs-10 … --fs-28`. Пол: киккеры ≥10px (только Rajdhani-display),
  вспомогательный mono ≥10.5px, текст ≥12px. Новые промежуточные кегли не вводить.
- Киккеры: Rajdhani 600–700, uppercase, letter-spacing .13–.24em (класс `.kick`).

## 3. Геометрия

- База spacing — 4px (`--sp`): отступы 4/8/12/16/20/24. Внешние поля страницы — 16px.
- Радиусы: `--r` = 2px везде; максимум `--r-lg` = 4px. **Скругления >4px запрещены.**
- **Без box-shadow-теней.** Глубина — слоями фона (`--s0…--s3`) и границами.
  Допустимые box-shadow: inset-акценты выбранного (`inset 2px 0 0 var(--gold-hi)`) и глоу точек-индикаторов.
- Сетки панелей — **1px-щели**: контейнер `background: var(--line); gap: 1px`, ячейки
  непрозрачные (`.grid-2` + `.cell`, `.statusline` + `.st`, `.sellgrid`).
- Навбар — обычный `<div class="topbar">` fixed, высота `--nav-h` (48px). НЕ MUI AppBar.
- Сайдбар — `.side`: sticky `top: calc(var(--nav-h) + 12px)`, колонка 272px (256px <1360px).
  Одна ширина на всех страницах.
- Desktop-инструмент: `min-width: 1240px` у body, мобильная адаптация вне охвата.

## 4. Словарь компонентов (`assets/base.css`)

Одно действие = один паттерн на всех экранах.

| Класс | Что это |
|---|---|
| `.topbar` `.brand` `.nav` `.tb-*` `.emis` `.demo` | навбар (рендерит shell.js — руками не собирать) |
| `.signals` `.sig*` | лента сигналов (рендерит shell.js) |
| `.panel` | базовая панель |
| `.grid-2` + `.cell` + `.sec-h` | компартменты с 1px-щелями + заголовок секции |
| `.statusline` + `.st` | полоса метрик (киккер + mono-значение; `.v.g`/`.v.a` — цветные) |
| `table` + `.thb` + `.si` | таблица данных: сортируемые заголовки-кнопки, right-align, `td.pos/.neg/.dim`, `.texp/.tdead`, `.t-empty` |
| `.gbtn` | primary-кнопка (золотая) — CTA, гейты |
| `.qbtn` | ghost-кнопка (нейтральная вторичная) |
| `.dbtn` (+`.armed`) | опасная кнопка; удаление строк — ТОЛЬКО двухшаговое `SC_APP.armConfirm` («Точно?», 3 с). `confirm()` запрещён |
| `.ibtn` | иконка-кнопка 30×30 |
| `.chip` / `.chip.q` / `.chip.mono` | чип: нейтральный / качества (через `--qc`) / mono-данные (регион, заточка) |
| `.risk.lo/.md/.hi` | статус-чип уровня (риск и т.п.) |
| `.kick` | киккер-лейбл |
| `.search` / `.input` / `select.input` | поиск в панели / инпут / селект. Регион — всегда select, не текстфилд |
| `.tabs` + `[role="tab"]` | табы (активный — золотая заливка, текст `--s0`) |
| `.c-meta` + `.sw.g/.gd/.band/.line` | мета-строка и легенда графика |
| `.chart-wrap` + `.gate` + `.chart-empty` | контейнер графика; гейт тарифа = blur+оверлей+замок+тариф+CTA — единственный вид locked-состояния |
| `[data-tip]` | тултип на CSS |
| `.modal-ov` + `.modal(-h/-b/-f)` | модалка (`SC_APP.openModal`) — только для операций с потерей невосстановимых данных |
| `.toast-stack` + `.toast` | тост (`SC_APP.toast`) — единственный канал «успех/инфо» |
| `.skel` | скелетон загрузки (форма контента, не спиннер) |
| `.sysbar` | системная строка-футер (рендерит shell.js) |
| `.fb` | фолбэк-глиф иконки предмета (через `SC_APP.iconHtml`) |

## 5. Гейтинг тарифов

Состояние — демо-переключатель в навбаре (`localStorage: sc_demo_tier`, `sc_demo_radar`).

| Тариф | Окна графиков | «Лоты» в навбаре |
|---|---|---|
| `base` БАЗОВАЯ | 24ч, 48ч | замок |
| `advanced` ПРОДВИНУТАЯ | + 7д | замок |
| `advanced_plus` ПРОДВИНУТАЯ+ (по умолчанию) | + 30д | открыто |
| `advanced_max` ПРОДВИНУТАЯ МАКС | + 30д | открыто |

«Радар рынка» — отдельный аддон (чекбокс «радар»).

- Хелперы: `SC_SHELL.getTier()`, `hasRadar()`, `tierAllows("24"|"48"|"7d"|"30d")`,
  `requiredTier(win)`, `tierName()`.
- Замок = иконка `SC_SHELL.lockSvg(w,h,strokeWidth)` + тултип/`title` с именем нужного тарифа.
- Смена тарифа диспатчит `window`-событие **`sc:tier`** — страница слушает и перерисовывает
  замки/гейты без перезагрузки.
- Locked всегда даёт CTA («Смотреть тарифы»), а не молчаливый тупик.

## 6. Motion

- Токены: `--fast` 150ms (hover/цвета), `--mid` 220ms (ширины баров, появление тоста),
  easing `--ease` (ease-out expo-подобный). Без bounce/elastic.
- `transition` — только перечисленные свойства (`color, background-color, border-color, transform`).
  **`transition: all` запрещён.**
- Декоративная анимация — только брендовые живые элементы: пульс live-точек (`pulse`),
  шиммер скелетона. Никакой оркестровки при загрузке.
- `prefers-reduced-motion: reduce` глушит всё (уже в base.css — не переопределять).

## 7. Запреты

1. Хекс/rgba вне `tokens.css` (страничный CSS, inline-стили, JS-строки).
2. `box-shadow`-тени глубины; скругления >4px.
3. Rajdhani в данных; цифры без tabular-nums; цены по левому краю.
4. Акцентные цвета вне золотой шкалы (зелёный/красный/янтарь — только статусы; `--q-*` — только качество предметов).
5. `confirm()`/`alert()`; спиннеры (только `.skel`); locked без CTA.
6. Кликабельные `div` без клавиатуры: интерактив = `button`/`a` (+ `tabindex`/`keydown` для строк таблиц), focus-стиль — глобальное золотое кольцо `:focus-visible`.
7. MUI AppBar-подобный навбар; второй словарь цветов качества; свой формат цен.
8. `fetch`/ES-modules/`import` — прототип живёт на `file://`.

## 8. Как собрать страницу

Скелет `design/v5/app/<page>.html`:

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SC Trading — <Страница></title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../assets/tokens.css">
  <link rel="stylesheet" href="../assets/base.css">
  <style>/* только страничное, только var(--…) */</style>
</head>
<body>
  <div id="shell"></div>                <!-- навбар + лента сигналов; футер shell.js добавит сам -->
  <main class="layout"> … </main>       <!-- или своя раскладка на .panel/.grid-2 -->

  <script src="../assets/data.js"></script>
  <script src="../assets/app.js"></script>
  <script src="../assets/charts.js"></script>
  <script src="../assets/shell.js"></script>
  <script>
  (function(){
  "use strict";
  var D = window.SC_DATA, A = window.SC_APP, S = window.SC_SHELL, C = window.SC_CHARTS;
  S.render("<pageId>");   // favorites | catalog | lots | feed | inventory | radar | settings
  /* страничный код */
  })();
  </script>
</body>
</html>
```

Порядок скриптов обязателен: `data.js → app.js → charts.js → shell.js → страничный код`.

### Шпаргалка API

**SC_APP** (`assets/app.js`): `NOW` (виртуальные часы из данных), словари `RANK/QNAME/DAY/CONF`,
форматтеры `fmtN/fmtP/fmtCompact/fmtTick/fmtHM/fmtDM/fmtLeft/agoMin/esc`,
домен `rankOf/favById/lotsOf/goodCount/riskOf/iconHtml(f, cls)`,
интерактив `sortTable(headRow, sort, defaults, onChange)` + `markSort(headRow, sort)`,
`tabs(el, cb)`, `armConfirm(btn, cb)`, `openModal({title, body, actions})`/`closeModal()`, `toast(msg)`.

**SC_SHELL** (`assets/shell.js`): `render(activePage)`, тарифы (см. §5),
`onSignal(fn)` — перехват клика по ленте сигналов (без него карточка ведёт на
`favorites.html?item=<id>`), `setSignal(id)`, `refreshSignals(selectedId)`.

**SC_CHARTS** (`assets/charts.js`): `scatter(el, pts, {from, to, median, stepH, emptyText})`
→ `{count,min,max,avg}|null`; `band(el, rows, {median, emptyText})` → `{days,sales}|null`.
Лог-шкала, тики 1-2-5, медиана-пунктир, зелёные точки ниже медианы — внутри.

### Голос

Продукт — «SC Trading», площадка — «аукцион STALZONE». Обращение — «ты».
EN-киккеры — только декоративные, смысл всегда по-русски.
