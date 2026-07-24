# ТЗ: Статистика карточки избранного игнорирует фильтр качества/заточки (qlt/ptn)

> **Статус: РЕАЛИЗОВАНО (вариант buy-side B1) ← 2026-07-24, коммит `0367a96`.**
> sell-side timing / `avg_sell_time_hours` / `batch_stats` + buy-side считаются per-request
> из отфильтрованного `SalesHistory`; хелперы `derive_sell_timing`/`derive_buy_timing`.
> Пред-существующее ограничение ценовых окон под фильтром вынесено в бэклог `docs/NOTES.md`.

## Контекст

Карточка предмета в «Избранном» (`LotStatCard` / `MobileLotStatCard` через хук `useLotStats`)
запрашивает `/monitoring/item/{id}` с параметрами `region + quality_filter + enchant_filter`.
Фронт передаёт `0` корректно (falsy-0 бага нет). Проблема на бэкенде: в ветке «с фильтрами»
эндпоинта `get_item_stats` (`backend/app/api/v1/endpoints/monitoring.py`, ~строки 212–297)
под фильтр пересчитываются только ценовые окна (`median_price_7d`, `sales_volume_7d/30d`,
`price_volatility_7d/30d`, `sell_options`), а поля «времени» и «пачек» берутся как есть из
**агрегата** `MarketStatistics` (одна запись на `item_id+region`, посчитанная по ВСЕМ qlt и ВСЕМ ptn):

- `best_sell_hour` / `best_sell_day`, `sell_hours_by_day`
- `best_buy_hour` / `best_buy_day`, `buy_hours_by_day`
- `weekend_bonus_percent`
- `avg_sell_time_hours`
- `batch_stats`

На карточке это блоки «Продавать / Покупать», «Ср. время продажи» и «Пачки · распределение» —
они показывают цифры по всему предмету, игнорируя выбранную заточку/качество.

Пользователь выбрал направление **«Полный пересчёт из SalesHistory»** (не заглушки, не скрытие).
Это подтверждено координирующим потоком (валидно по CLAUDE.md Блок 3).

**Rate limit не затрагивается** — вся задача про чтение БД (SalesHistory / MarketStatistics),
никаких обращений к Stalcraft API и изменения частоты опроса.

---

## Диагностика: откуда берётся каждое поле (углублено)

Разбор по источнику данных — это ключ к решению, потому что источники **не однородны**:

### Группа A — производные от SalesHistory (можно честно пересчитать под фильтр)

Все считаются из списка строк `sales_30d` в `calculate_market_stats`
(`backend/app/services/analytics/market_stats.py`):

| Поле | Функция / место расчёта | Нужные колонки SalesHistory |
|---|---|---|
| `best_sell_hour`, `best_sell_day` | inline `weighted_score(by_hour/by_day)` (~146–178) | `sale_time`, `price_per_unit` |
| `sell_hours_by_day` | inline `weighted_score` по `by_day_hour` (~182–193) | `sale_time`, `price_per_unit` |
| `weekend_bonus_percent` | inline (~195–207) | `sale_time`, `price_per_unit` |
| `avg_sell_time_hours` | `_avg_sell_time_from_buyouts(sales)` (~456) | `sale_time`, `additional_info.lot_start` |
| `batch_stats` | `_calculate_batch_stats(sales)` (~336) | `amount`, `price_per_unit` |

`_calculate_batch_stats` и `_avg_sell_time_from_buyouts` уже **чистые** (принимают список
объектов с атрибутами `.amount/.price_per_unit/.sale_time/.additional_info`). Блок «лучшее
время продажи» (best_sell_*/sell_hours_by_day/weekend_bonus) сейчас **инлайн** внутри
`calculate_market_stats` и использует closure `weighted_score` — его нужно вынести в чистый хелпер.

### Группа B — производные от снэпшотов CollectedData (НЕ из SalesHistory)

`best_buy_hour` / `best_buy_day` / `buy_hours_by_day` считаются из
`snapshots_30d` (`CollectedData.collect_time`, `CollectedData.best_liquid_price_per_unit`,
~строки 209–261). `best_liquid_price_per_unit` — это **агрегат по предмету целиком** (минимум
ликвидных лотов среди всех qlt/ptn в снэпшоте), в нём нет разбивки по combo. Разбивка есть
только в `CollectedData.raw_lots` (JSONB, до ~200 лотов на снэпшот). Пересчитать buy-side
под фильтр = распарсить raw_lots по десяткам тысяч снэпшотов на запрос — **дорого и вне
мандата «пересчёт из SalesHistory»**. Это выносим в открытый вопрос (см. ниже).

### Семантика NULL и артефактов (подтверждено)

- Фильтр строится в `_build_sales_filter` (`services/analytics/pricing.py:49`):
  `ptn=0` → `ptn IS NULL OR ptn='0'`; `qlt=0` → `qlt IS NULL OR qlt='0'`.
- Для артефактов API `/history` обычно опускает `ptn` у +0 → в `additional_info` ключа нет
  (NULL), поэтому «NULL = не точёный» рабочая семантика.
- Фильтр заточки применяется **только для артефактов**: подтверждено на фронте —
  `CatalogPage.tsx:157` `if (isArtefact(dialogItem.category)) payload.enchant_filter = enchantFilter`,
  `isArtefact` = `category.startsWith('artefact')`. Для не-артефактов `enchant_filter` всегда
  `null` → условие ptn не добавляется, фильтруется только по `quality_filter`.
- Покрытие combo в `additional_info` зависит от матчинга снэпшот↔история, поэтому под фильтром
  выборка бывает заметно меньше агрегата (много combo без данных). Это нормально и должно
  давать честное «нет данных», а не цифры «по всему предмету».

---

## Архитектурные решения

### Решение 1 — что пересчитываем и из чего

Пересчитываем под фильтр **всю группу A** из отфильтрованного набора SalesHistory:
`best_sell_hour`, `best_sell_day`, `sell_hours_by_day`, `weekend_bonus_percent`,
`avg_sell_time_hours`, `batch_stats`. Источник — один запрос строк SalesHistory за 30 дней
с условиями `_build_sales_filter(quality_filter, enchant_filter)`.

### Решение 2 — per-request (на лету в эндпоинте), НЕ предвычисление per-combo

**Рекомендация: считать на лету в эндпоинте.**

Почему:
- Комбинаций много (qlt 0–5 × ptn 0–25 ⇒ до ~150 combo на предмет), большинство никто не
  открывает. Предвычисление всех = кратный рост строк `MarketStatistics` + миграция схемы +
  новая/тяжёлая Celery-задача ради данных, которые в основном не смотрят.
- Per-request считает лениво ровно то, что открыто. Reuse существующего паттерна: ветка «без
  фильтров» уже пересчитывает `sell_options` на каждый запрос — то есть per-request расчёт в
  этом эндпоинте уже норма.
- Ноль изменений схемы БД, ноль миграций, ноль новых периодических задач → rate limit и частота
  опроса не затрагиваются.

Стоимость при polling 30с на каждую открытую карточку: один SELECT строк SalesHistory за 30д
по `(item_id, region, sale_time>=cutoff, qlt/ptn)` + питон-группировка. Это заменяет текущие
**два** scalar-запроса (7d/30d) на **один** запрос строк — по числу round-trip'ов даже дешевле.

Trade-off / что НЕ делаем:
- Не кэшируем результат (простота прежде всего). Если замер покажет тяжесть на популярных
  предметах — опционально добавить Redis TTL-кэш (ключ `item+region+qlt+ptn`, TTL ~60с). В
  первой итерации не делаем.
- Не трогаем `calculate_market_stats` по поведению — агрегатная запись остаётся как есть для
  ветки «без фильтров».

### Решение 3 — buy-side (best_buy_*) под фильтром — ОТКРЫТЫЙ ВОПРОС

Buy-side (группа B) из SalesHistory честно не получить (это данные предложений/снэпшотов, а не
продаж). Три варианта — нужен выбор пользователя:

- **(B1) Рекомендуемый — SalesHistory-прокси.** Определить «лучший час/день покупки» как
  час/день с **наименьшей средней ценой продажи** в отфильтрованном наборе (зеркало
  weighted_score, но минимизируем цену). Плюсы: combo-специфично, дёшево, укладывается в
  «пересчёт из SalesHistory», без заглушек. Минус: меняется семантика источника buy-side
  (было «когда предложения дешевле всего» из снэпшотов → станет «когда исторически продавали
  дешевле»), из-за чего ветка «с фильтром» и «без фильтра» будут считать best_buy по-разному.
- **(B2) Оставить buy-side агрегатным** и пометить в UI (мелкая сноска «по предмету целиком»).
  Минус: это частичное скрытие/оговорка, чего пользователь просил избежать.
- **(B3) NULL под фильтром** (не показывать buy-side при активном фильтре). Минус: скрытие,
  противоречит выбранному направлению.

**Моя рекомендация — B1** (единственный вариант, соблюдающий «пересчёт из SalesHistory» и
«без заглушек»), но семантический сдвиг buy-side требует явного «ок» пользователя перед
реализацией. Реализовать функцию-зеркало в том же хелпере группы A.

### Решение 4 — рефакторинг для переиспользования (минимальный)

Вынести inline-блок «лучшее время продажи» из `calculate_market_stats` в чистый хелпер, напр.:

```
def derive_sell_timing(sales: list) -> dict:   # best_sell_hour/day, sell_hours_by_day, weekend_bonus
```

- `weighted_score` поднять на уровень модуля (сейчас closure).
- `calculate_market_stats` начинает вызывать этот хелпер — **поведение не меняется** (тот же
  вход `sales_30d`, тот же выход).
- Эндпоинт вызывает `derive_sell_timing(filtered_rows)` + существующие
  `_calculate_batch_stats(filtered_rows)` + `_avg_sell_time_from_buyouts(filtered_rows)`.
- Если выбран B1 — добавить в хелпер (или рядом) `derive_buy_timing(sales)` (минимизация цены).

Совместимость строк: в эндпоинте фетчим `select(SalesHistory.sale_time,
SalesHistory.price_per_unit, SalesHistory.amount, SalesHistory.additional_info)`. Возвращаемые
`Row` дают атрибутный доступ (`s.sale_time`, `s.amount`, ...), совместимый со всеми хелперами
группы A. НЕ грузим ORM-сущность целиком.

Граница разумного: не выносим весь `calculate_market_stats`, не строим общий «engine». Выносим
только один inline-блок + поднимаем один closure. Batch/avg_sell_time уже переиспользуемы.

### (Опционально, не обязательно) улучшение sell_options под фильтром

Раз уж в эндпоинте будут полные строки, можно передать `time_price_pairs`
(из `additional_info.lot_start`) в `make_sell_options` → `confidence="medium"` вместо текущего
`"low"`. Это не часть бага; делать только если тривиально. По умолчанию — оставляем как есть.

---

## Затронутые файлы

- `backend/app/services/analytics/market_stats.py` — вынести `derive_sell_timing` (+ поднять
  `weighted_score`); опц. `derive_buy_timing` для B1. Поведение `calculate_market_stats` без изменений.
- `backend/app/api/v1/endpoints/monitoring.py` — ветка «с фильтрами» (~212–297): фетч строк
  SalesHistory за 30д, вызвать хелперы, заполнить `best_sell_*`, `sell_hours_by_day`,
  `weekend_bonus_percent`, `avg_sell_time_hours`, `batch_stats` из отфильтрованного набора;
  buy-side — по выбранному варианту (B1/B2/B3).
- `backend/app/services/analytics/pricing.py` — без изменений (фильтр `_build_sales_filter` готов).
- `frontend/src/components/LotStatCard.tsx` и `frontend/src/components/mobile/…` — **только если**
  выбран B2 (сноска про buy-side). При B1/B3 фронт не трогаем — контракт ответа тот же.
- `frontend/src/hooks/useLotStats.ts` — без изменений (типы уже включают все поля).

## Изменения по слоям

### Backend
1. `market_stats.py`: поднять `weighted_score` на уровень модуля; вынести inline-блок best_sell
   в `derive_sell_timing(sales) -> dict`; `calculate_market_stats` вызывает его (регрессий нет).
   При B1 — добавить `derive_buy_timing(sales) -> dict` (min средней цены по часу/дню).
2. `monitoring.py` (ветка с фильтрами): заменить два scalar-запроса на один фетч нужных колонок
   строк за 30д; вывести `prices_7d/prices_30d` в питоне (как в `calculate_market_stats`);
   сохранить текущий расчёт median/volume/volatility/sell_options; добавить заполнение полей
   группы A из хелперов; buy-side по выбранному варианту.
3. Пороги оставить прежними (`MIN_SALES_FOR_STATS=3`, `MAX_LOT_LIFETIME_HOURS=48`,
   снэпшотный минимум ≥6 к B-варианту не относится). Пустая выборка → поля `None`.

### Frontend
- Действий не требуется при B1/B3. При B2 — мелкая сноска у блока «Покупать».

### Design
- Нет.

## Edge-кейсы (обязательно покрыть)

- **Нет продаж под фильтром** → `prices` пусто → все поля группы A = `None`/`batch_stats=None`
  → карточка показывает «нет данных» (честно, не заглушка).
- **Мало данных (<3 продаж)** → best_sell_* = `None` (сохранить существующий порог).
- **avg_sell_time**: требует `additional_info.lot_start`; если под фильтром таких нет → `None`.
- **NULL-семантика qlt/ptn**: как в `_build_sales_filter`; +0 артефакта = отсутствие ptn.
- **Не-артефакт**: `enchant_filter` всегда `null` (гейт `isArtefact` на фронте) → фильтруем
  только по качеству.
- **Разреженное покрытие combo**: выборка под фильтром меньше агрегата — ожидаемо больше «нет
  данных», это корректное поведение, а не регресс.

## Критерии приёмки (verifiable)

- [ ] Для предмета-артефакта с фильтром `enchant=0` блок «Продавать» показывает час/день,
      посчитанные ТОЛЬКО по продажам с `ptn IS NULL OR ptn='0'` (проверяемо SQL-сверкой).
- [ ] Смена `enchant_filter` (напр. 0 → +5) на одной карточке меняет `best_sell_hour/day`,
      `sell_hours_by_day`, `avg_sell_time_hours`, `batch_stats` (если данные под combo различаются).
- [ ] `batch_stats.total_analyzed` под фильтром ≤ агрегатного и равен числу отфильтрованных
      продаж за 30д.
- [ ] `avg_sell_time_hours` под фильтром считается только по отфильтрованным продажам с `lot_start`.
- [ ] При отсутствии продаж под фильтром все перечисленные поля = `null`, карточка не падает и
      показывает «нет данных».
- [ ] Ветка «без фильтров» (`quality_filter=None, enchant_filter=None`) возвращает те же значения,
      что и до изменений (регрессий в агрегате нет).
- [ ] `calculate_market_stats` после выноса `derive_sell_timing` даёт идентичный результат на том
      же входе (сверка best_sell_*/sell_hours_by_day/weekend_bonus до/после).
- [ ] Buy-side ведёт себя по согласованному варианту (B1: combo-специфичные best_buy_* из
      отфильтрованных продаж; B2/B3 — по договорённости).
- [ ] Число SQL-запросов в ветке с фильтром не выросло (один фетч строк вместо двух scalar).

## Документация для обновления

- `docs/NOTES.md`: отметить задачу (баг фильтра qlt/ptn в статистике карточки) как выполненную.
- `docs/BUSINESS_LOGIC.md`: описать, что при активном фильтре качества/заточки поля времени/пачек
  считаются per-request из отфильтрованного SalesHistory; отметить источник и семантику buy-side
  (по выбранному варианту).
- `docs/SERVICES.md`: упомянуть вынесенный хелпер `derive_sell_timing` (и `derive_buy_timing`
  при B1) в `market_stats.py` и его переиспользование эндпоинтом `/monitoring/item`.

## Открытые вопросы / требует подтверждения

- **Buy-side (best_buy_*) под фильтром** — выбрать B1 / B2 / B3 (рекомендация: **B1**,
  SalesHistory-прокси по минимальной цене). Это единственная содержательная развилка, влияющая
  на объём (нужен ли фронт) и на семантику. **Требует подтверждения пользователя.**
- Нужен ли опциональный апгрейд `sell_options` до `confidence="medium"` под фильтром
  (time_price_pairs) — по умолчанию НЕ делаем.
- Redis TTL-кэш per-combo — только если замер покажет тяжесть; в первой итерации не делаем.

## Маршрутизация по агентам

1. **backend-dev** ← этот ТЗ (`docs/tasks/fix-favorite-card-stats-qlt-ptn.md`). Основная работа:
   рефакторинг хелпера + ветка эндпоинта. Стартует после выбора варианта buy-side.
2. **frontend-dev** — только если выбран B2 (сноска у buy-side). Иначе пропустить.
3. **tech-writer** — после реализации: обновить `docs/NOTES.md`, `BUSINESS_LOGIC.md`, `SERVICES.md`.
4. (опц.) **qa-tester** — сверка эндпоинта с SQL по нескольким combo (предложить, не запускать сам).
