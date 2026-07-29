# Опорная цена по свежести сделок вместо плоской медианы 7д

## Контекст

На карточке «Юла +15» система предложила лот за 5 950 000 ₽ как выгодный (БЫСТРО +316 200, НОРМАЛЬНО +510 000, ВЫГОДНО +833 000), хотя все сделки за последние 24ч шли в коридоре 6.0–6.6 млн — ниже медианы 7д (6.8 млн).

Проверка кода подтвердила: все три числа выведены из `median_price_7d` и больше ни из чего (арифметика сходится до рубля). Безубыточность лота = `5 950 000 / 0.95 = 6 263 158` — середина реального суточного коридора. Обещанная цена тира «БЫСТРО» (6 596 000) выше почти всего, по чему предмет фактически торгуется: тир, который должен означать «поставлю дешевле рынка, купят первым», ставит цену на верхней границе рынка.

**Корневая причина.** Плоская невзвешенная медиана за 7 дней на трендовом рынке отражает цену ~3.5-дневной давности. Защита от этого в коде есть — но:

| # | Место | Формула ref | Trend-guard |
|---|---|---|---|
| 1 | `market_stats.py:600` | `current_min_liquid or median_7d` | нет |
| 2 | `monitoring.py:177` (без фильтров) | `current_min or median_7d` + glitch-check | нет |
| 3 | `monitoring.py:258` (**с фильтрами — этот кейс**) | голая `median(prices_7d)` | нет |
| 4 | `pricing.compute_reference` | `median_7d` | есть, но порог 25% |
| 5 | `market_radar.py:340,353` | `avg_price_24h` / `median(prices_7d)` | нет |

Пять формул. Единственная с trend-guard срабатывает при падении >25% (здесь −6%) и сравнивает с медианой **активных лотов** (аски), а не совершённых сделок. В `MarketStatistics` нет `median_price_24h` — краткосрочного ориентира в системе не существует вовсе.

**Итог:** система работает как запрограммирована, но её вывод на падающем рынке недостоверен.

## Решение

**Взвешенная по свежести медиана как опорная цена, при сохранении `median_price_7d` как отдельного отображаемого числа.**

- `median_price_7d` не трогаем — это честная описательная статистика, подпись «МЕДИАНА 7Д» и линия на графике остаются правдой.
- Новая `ref` = медиана продаж за 7д, взвешенная `вес = 0.5 ** (age_hours / 48)`. Она идёт в `make_sell_options`.
- Почему не `min(median_7d, median_24h)`: обрыв на малой выборке — 2–3 случайные сделки за сутки уводят ref куда угодно. Почему не мягкий порог trend-guard 0.93: в этом кейсе `ratio = 0.941` — не сработал бы. Взвешенная медиана использует всю 7-дневную выборку, просто переоценивает свежие сделки → реагирует плавно, без порогов, деградирует мягко.
- Ожидаемый эффект: ref ≈ 6.55–6.6 млн → БЫСТРО ≈ **+86k вместо +316k**. Лот остаётся виден, но честно «на грани», плюс бейдж «−6% за 24ч».

Объём подтверждён полный: backend-формула + индикация тренда в UI + починка СЕЙЧАС/НЕДЕЛЯ + фронт использует оценку бэкенда.

---

## Backend

### B0. Тесты первыми — `backend/tests/` (каталога нет, `pytest` в `pyproject.toml` уже объявлен)

`__init__.py`, `conftest.py`, `test_pricing.py`. Функции чистые, БД не нужна:
- `test_weighted_median_uniform_age` — все сделки одного возраста ⇒ равно плоской медиане
- `test_weighted_median_recency_bias` — старые дорогие / свежие дешёвые ⇒ ближе к свежим
- **`test_yula_case`** (опорный): ~40 сделок, 24ч-кластер 6.0–6.6M, остальные дни 6.8–7.0M, плоская медиана ≈ 6.8M. Ассерты: `ref ∈ [6_400_000, 6_700_000]`, `trend == "falling"`, `evaluate_lot_profit(5_950_000, 1, ...)["profit"] < 150_000`
- приоритет источников, glitch-check, пустая выборка

Запуск: `docker compose exec backend python -m pytest tests/ -v`

### B1. `backend/app/services/analytics/pricing.py` — ядро

Константы рядом с `COMMISSION` (:25): `REF_HALF_LIFE_HOURS = 48.0`, `MIN_REF_SAMPLES = 3`, `TREND_SOFT_RATIO = 0.95`. `TREND_DROP_RATIO = 0.75` оставить — но только для метки тренда по аскам, убрать из формулы ref.

Две новые чистые функции:
- `weighted_median(pairs: list[tuple[float, float]]) -> float | None` — сортировка по значению, кумулятивный вес, точка `cum >= total/2`; при точном равенстве линейная интерполяция с соседом (иначе прыжки на чётных выборках)
- `weighted_reference(samples, now, half_life_hours) -> dict | None` → `{"ref", "samples", "confidence"}`

Краевые случаи:
- пустая выборка → `None`, вызывающий уходит на fallback `median_7d` → `current_min`
- `samples < MIN_REF_SAMPLES` → **считаем, но `confidence="low"`**. Жёстко резать нельзя: у редких фильтрованных предметов (тот самый `qlt=3/ptn=15`) это выключило бы сигналы совсем и сломало Telegram-бота
- **не** обрезать `ref` по `current_min` — минимальный аск часто и есть оцениваемый лот, получится циркулярность `ref = цена_лота` ⇒ прибыль всегда отрицательная
- `price <= 0` отбрасывать; будущее `sale_time` → вес 1

`compute_reference()` (замена :139-174) — **keyword-only сигнатура** (`*`), чтобы три позиционных вызова в `profitable_lots.py` сломались на импорте и были переписаны явно, а не привязались молча:
```
compute_reference(*, weighted_hist, median_hist, sample_count, median_24h, median_now, current_min)
→ {"ref", "source", "trend", "trend_pct", "confidence", "samples", "median_7d"}
```
- glitch-check переезжает **внутрь** (сейчас продублирован в `monitoring.py:174-176` и отсутствует в фильтрованной ветке)
- `ref` = `weighted_hist` → `median_hist` → `current_min` → `None`
- `trend` по `median_24h/median_hist` с порогом `TREND_SOFT_RATIO`; при отсутствии `median_24h` — fallback на `median_now` (аски) как **метка**, без правки ref
- `median_now` сохраняем: при нуле сделок за 24ч это единственный сигнал обвала. Строку `ref = max(median_now, median_hist * TREND_DROP_RATIO)` удалить

`evaluate_lot_profit()` (:240-300) — добавить в возврат `"breakeven_per_unit": int(buyout_per_unit / (1 - COMMISSION))` и `"ref_used"`. Единственное место расчёта безубытка → ключ растекается через `**evaluated` (`profitable_lots.py:248`) в Redis → API → фронт → push. Считать на фронте = завести шестую копию формулы.

### B2. `market_stats.py` — место №1

`_calculate_sell_options` (:541-641): `sales_30d` уже в памяти (:215-228) — отфильтровать 7д, собрать `(sale_time, price)`, вызвать `weighted_reference` + `compute_reference`, заменить `ref = int(current_min_liquid or median_7d)` (:600). Вернуть кортеж `(sell_options, ref_info)`.

`calculate_market_stats` (:328-390): записать `median_price_24h` — **оно уже считается в `safe_stats` (:242) и просто выбрасывается** — и `reference_price`. Комментарий :594-604 переписать, «все три варианта относительно текущего минимума» больше не верно.

### B3. `monitoring.py` — места №2 и №3 (главный фикс)

**Без фильтров (:159-214):** удалить локальный glitch-check, звать `compute_reference` с `weighted_hist=stats.reference_price` (читаем из БД, не пересчитываем: свежесть ≤1ч, а полураспад 48ч делает последний час несущественным — пересчёт стоил бы тяжёлого запроса на каждый поллинг раз в 30с). Дополнительно отдать `sell_options_now` от `current_min` — это и есть реальный режим «СЕЙЧАС».

**С фильтрами (:216-313):** `rows` за 30д уже загружены с `sale_time` (:227-239) — новых запросов не нужно. Посчитать `samples_7d`, `filtered_median_24h`, `weighted_reference`, `compute_reference`; `make_sell_options(ref_info["ref"], ...)` вместо `_make_sell_options(filtered_median, ...)` (:258). `median_price_7d` в ответе остаётся плоской `filtered_median`. Снапшот (`latest_snap`) загрузить **до** разветвления, чтобы фильтрованная ветка тоже получила `current_min` и `sell_options_now`.

**Устранение дублей:** `profitable_lots.py:156-180` — инлайн-копия `_build_sales_filter`, заменить на реюз (и добавить `sale_time` в селект — без него взвешивание невозможно). Логика «минимальная цена ликвидного лота по фильтру» есть в `profitable_lots.cheapest_matching_lot` (:58-103) — вынести в `pricing.py` вариант, принимающий `(raw_lots, master, quality_filter, enchant_filter, now)`, иначе в `monitoring.py` появится шестая копия перебора `raw_lots`.

**Схемы** (`app/schemas/` не существует, модели инлайн в эндпоинте): `MonitoringItemResponse` (:24) += `median_price_24h`, `reference_price`, `reference_source`, `reference_confidence`, `reference_samples`, `trend`, `trend_pct`, `current_min_price`, `sell_options_now` — все `| None = None`. `SignalLot` (:453) += `breakeven_per_unit`, `ref_used`. `SignalsResponse` (:467) += `ref_confidence`, `ref_samples`, `trend_pct`, `median_7d`, `median_24h`.

**`_mask_stats_windows` (:66-87) обязательно дополнить** — иначе новые поля утекут на младшие тарифы. Под `"7d" not in allowed` обнулять всё производное от 7д (`reference_*`, `trend*`, `sell_options_now`). `median_price_24h` и `current_min_price` **не** маскировать — окно 24ч доступно всем (ср. `SalesHistoryCharts.tsx:23`).

### B4. Хранение — две колонки

`market_statistics` += `median_price_24h Numeric(12,2)`, `reference_price BigInteger`. Миграция `backend/alembic/versions/0037_market_stats_reference_price.py` (`down_revision="0036"`) по образцу `0027_market_stats_48h.py`: два `add_column`, nullable, без бэкфилла — часовой пересчёт заполнит.

- `trend`/`trend_pct` **не хранить** — выводятся из двух медиан одной строкой, строковая колонка-статус протухает между часовыми пересчётами
- в `sell_options` JSONB **не класть** — это `list`, не `dict`; сломает `telegram_bot/bot.py:128` и `push_service/consumer.py:97`
- фильтрованная ветка — **всегда per-request**, комбинаций (item × qlt × ptn) слишком много для материализации

Отразить в `models.py:193-232` и `docs/DATABASE.md`.

### B5. `profitable_lots.py` — место №4 (сигналы для бота и API)

`compute_signals_for_entry` (:106-270): обе ветки на новый `compute_reference` с keyword-аргументами; в фильтрованной — реюз `_build_sales_filter`, `sale_time` в селекте, `weighted_reference` + медиана 24ч из тех же строк. Прокинуть `ref_confidence`, `ref_samples`, `trend_pct`, `median_7d`, `median_24h` (попадут в Redis-JSON и `SignalsResponse` автоматически). Докстринг :111-121 описывает старую схему — обновить.

### B6. `market_radar.py` — место №5

`_get_full_aggregate` (:344-356), фильтрованный бакет: `sale_time` в селект, `median(prices)` → `weighted_reference` + `compute_reference`. Нефильтрованный (:340) оставить на `avg_price_24h` — это уже 24-часовой якорь, ранжирование грубое по назначению.

Без этого `profitable_offers_count` в Радаре будет систематически выше, чем «N / M выгодных» в карточке того же предмета — пользователь это увидит. Шаг маленький, делать в том же заходе.

---

## Frontend

### F1. `frontend/src/hooks/useLotStats.ts` — дата-слой (общий для десктопа и мобайла)

**Типы:** расширить `MarketStats`, `SignalsData` и особенно `SignalLot` (:82-89) — интерфейс сейчас намеренно не описывает `profit`/`profit_pct`/`tier_used`, поэтому TS и не даёт их использовать. `ProfitableLot` += `profit`, `profitPct`, `tierUsed`, `breakeven`, `fromBackend`.

**Починка СЕЙЧАС/НЕДЕЛЯ + расхождение 1.03/1.05.** Заменить `sellPrices` (:191-203) новым производным `sellOptions`:
```
lotMode === 'current' → stats.sell_options_now ?? stats.sell_options
lotMode === 'median'  → stats.sell_options
```
`sellPrices` — тонкая проекция для колонок таблицы. **Все три ручные формулы `m*0.97 / m*1.00 / m*1.03` удаляются**; расхождение premium 1.03 vs 1.05 исчезает вместе с ними, потому что фронт вообще перестаёт считать цены. Экспортировать `sellOptionsAreCurrent`, чтобы UI не врал «Сейчас», когда снапшота нет.

**`profitableLots` (:205-269) — доверять бэкенду.** В ветке `signals`:
- брать `profit`, `profit_pct`, `tier_used`, `breakeven_per_unit` как есть
- **удалить фильтр** `normalProfit > 0` + `minProfitMarginPercent` (:221-229): бэкенд уже отсёк по `min_profit_margin_pct × RISK_MARGIN_MULT[risk]` от тира `fast` (`collectors.py:498` → `evaluate_lot_profit`), то есть строго жёстче — фронтовый вариант без риск-множителя и по тиру `normal` не отсекает ничего. `minProfitMarginPercent` (из `feedStore.ts:60-64`) остаётся параметром хука и применяется **только в fallback-ветке** по `/lots`, где бэкенд-оценки нет
- **исправить порядок slice/sort** (:230-231): сейчас сортировка по `buyPerUnit` asc идёт до `slice(0,10)`, а бэкенд отдаёт лоты по `profit_per_hour` desc — при >10 лотах самые прибыльные выбрасываются. Сначала `slice`, потом сортировка для отображения
- `profits[]` (3 what-if колонки) оставить клиентским от новых `sellPrices`. Отрицательные значения в режиме «Сейчас» — не баг, а искомая индикация; `LotStatCard.tsx:346` уже красит их в `tokens.danger`

**Единый `trend`** в результате хука: `{pct, direction, tone}` из `signals?.trend_pct ?? stats?.trend_pct` (signals свежее: ~20с против часа). Обе карточки берут готовый объект.

### F2. `LotStatCard.tsx`

- **:394-445 «Варианты продажи»** → на `sellOptions` из хука. Сейчас блок игнорирует `lotMode` и всегда берёт `stats.sell_options` — это вторая половина сломанного переключателя
- **:232-239 бейдж тренда** рядом с «МЕДИАНА 7Д»: `рынок −6% за 24ч`. Стиль — копия чипа риска (:177-187), токены `tokens.danger/dangerDim/dangerLine` и `success*` уже есть (`theme.ts:584-586`), паттерн — `RISK_TONE` (:25-29). Никаких хексов. Tooltip: `медиана 24ч … · 7д …`
- **Безубыточность** — под-строка `безубыток {fmtP(lot.breakeven)}` в ячейке цены (:329-336) паттерном строки `выкуп` (`tokens.text2`, `fs.f11`). **Не** седьмая колонка — таблица уже 6-колоночная при ширине 520px
- **:371-376** — `median24h={stats.median_price_24h ?? undefined}` в `SalesHistoryCharts`
- при `reference_confidence === 'low'` — приписка `мало сделок (N)` в подзаголовке «Вариантов продажи» (`tokens.warning`)
- **:85-87** — `setSelectedLotIdx(0)` срабатывает каждые 30с, т.к. `profitableLots` новый массив на каждом поллинге; завязать на стабильный ключ (`length` / `computed_at`). Соседний дефект, но он усилится, когда состав списка начнёт меняться

### F3. `PriceChart.tsx` + `SalesHistoryCharts.tsx`

Новый проп `median24h` (`SalesHistoryCharts.tsx:11-18` → `PriceChart.tsx:86-95`), **без** fallback на медиану окна (в отличие от `med`, :143-147) — нет данных, нет линии.

Вторая `ReferenceLine` рядом с существующей (:176-191): `stroke={tokens.text1}`, `strokeDasharray="2 4"`, label на `insideBottomRight` (золотая 7д на `insideTopRight`), текст `24ч …`. Добавить `med24` в `logDomain` (:75-80), иначе линия уедет за пределы лог-домена.

Перекрасить точки (`Cell`, :271) и цвет в тултипе (:258) относительно `med24 ?? med`: сейчас на падающем рынке почти все точки зелёные («ниже медианы 7д»), что визуально усиливает ложное «дёшево». Легенду (:162-165) синхронизировать → `ниже текущего рынка` / `выше`.

### F4. `mobile/MobileLotStatCard.tsx`

Тот же хук, правки зеркальные: :244-286 «Варианты продажи» → `sellOptions`; :135-142 бейдж тренда в блок медианы; :198 `· безубыток …` в `sub` карточки `DCard`; :222-228 `median24h`; :191 крупный показатель переключить на бэкендовый `lot.profit`, подпись уточнить до «прибыль / шт (быстро)» — бэкенд считает от тира `fast`; :65 тот же сброс `selectedLotIdx`.

---

## Порядок работ

**Backend:** B0 тесты (провальный `test_yula_case`) → B1 `pricing.py` (тесты зелёные) → B4 модель+миграция → B2 `market_stats.py` → B5 `profitable_lots.py` → B3 `monitoring.py` (последним из основных: зависит и от колонок, и от сигналов) → B6 `market_radar.py`

**Frontend** (после того как API отдаёт новые поля): F1 `useLotStats.ts` → F3 график → F2 десктоп → F4 мобайл → `npm run build`

**Документация** (шаг 4 алгоритма CLAUDE.md): `docs/BUSINESS_LOGIC.md`, `docs/SERVICES.md:128-147,254`, `docs/DATABASE.md`, `docs/CHANGELOG.md`, `docs/NOTES.md`.

---

## Риски

| Риск | Митигация |
|---|---|
| **Сигналов станет меньше** — это цель, но масштаб надо измерить | Готовый инструмент уже есть: `collectors.py:616-633` пишет в `signal_outcomes` (`ref_price`, `predicted_profit_pct`, `trend`) для всех комбинаций с `margin=0` — чистая метрика, не зависящая от настроек пользователя. Снять `SELECT date_trunc('hour',created_at), count(*) FROM signal_outcomes GROUP BY 1 ORDER BY 1 DESC LIMIT 48` до и после |
| Telegram-бот (`bot.py:246,261`), push (`consumer.py:93-104`) | Структура `sell_options` не меняется (список из 3 dict, те же ключи); лишние ключи в `lots[]` игнорируются. Уровень пушей снизится вместе с сигналами |
| Stale Redis-ключи после деплоя (TTL 300с) без новых полей | Все новые поля `| None = None`; фронт обязан переживать `undefined` |
| Новые колонки `NULL` до первого пересчёта (дифф-пропуск `analyzers.py:99-129`) | Все потребители обязаны иметь fallback на `median_price_7d` |
| `signal_outcomes.ref_price` NOT NULL | Убедиться, что `compute_reference` не возвращает `ref=None` при непустом результате. `trend String(10)` — значения ≤7 символов, OK |
| Подпись «МЕДИАНА 7Д» должна остаться правдой | Явно проверить в диффе, что `median_price_7d` нигде не переопределяется — ни `market_stats.py:372`, ни `monitoring.py:292` |

---

## Верификация

**Юнит (главное):** `docker compose exec backend python -m pytest tests/ -v` — `test_yula_case` даёт ответ «работает / нет» без стенда.

**Стенд:** `docker compose up -d` → http://localhost:3000; `docker compose exec backend alembic upgrade head`. Форсировать пересчёт статистики для предмета (иначе ждать слот `crontab(minute="12-59/5")`).

**Кейс «Юла +15»:**
1. Независимая проверка самой гипотезы по БД:
```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_unit) AS med, count(*)
FROM sales_history
WHERE item_id='<id>' AND region='RU'
  AND additional_info->>'qlt'='3' AND additional_info->>'ptn'='15'
  AND sale_time >= now() - interval '24 hours';   -- и то же на '7 days'
```
Ожидание: 24ч ≈ 6.4M, 7д ≈ 6.8M, ratio ≈ 0.94.
2. `GET /api/v1/monitoring/item/<id>?region=RU&quality_filter=3&enchant_filter=15` → `median_price_7d ≈ 6_800_000` (**не изменилась**), `median_price_24h ≈ 6_400_000`, `reference_price ≈ 6.55–6.6M`, `trend="falling"`, `trend_pct ≈ -6`, `sell_options[fast] ≈ 6_353_000`
3. Арифметика БЫСТРО для лота 5 950 000: `6_353_500 × 0.95 − 5_950_000 ≈ +85 800` (было +316 200); безубыток 6 263 158 показан в строке лота
4. `GET /monitoring/signals/<id>` → `ref`, `trend`, `ref_confidence`, лоты с `breakeven_per_unit`
5. UI: бейдж «−6% за 24ч»; две пунктирные линии на графике 24Ч (золотая 7д ≈6.8M выше серой 24ч ≈6.4M); СЕЙЧАС/НЕДЕЛЯ меняет и таблицу, и блок «Варианты продажи»; premium в обоих режимах по одной формуле
6. Мобильная версия (≤600px) — те же пункты
7. `cd frontend; npm run build` — `tsc` поймает несоответствия интерфейсов

**Регресс:** предмет без фильтров · предмет с 1–2 сделками за 7д (`confidence="low"`, карточка не падает) · предмет без истории (`current_fallback`) · тариф без окна 7д (новые поля `null`) · Радар не сломан.

Тестирование живого приложения — через `qa-tester` (CLAUDE.md Блок 2), не в основном потоке.
