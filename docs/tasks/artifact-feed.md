# ТЗ: «Лента артефактов» — глобальный поиск выгодных лотов (тариф МАКС)

> Источник истины по решениям — утверждённый пользователем план
> (`~/.claude/plans/async-puzzling-pizza.md`). Это ТЗ переводит план в исполнимые
> шаги для `backend-dev` / `designer` / `frontend-dev` / `tech-writer`.
> Решения плана **не пересматриваются**; всё, что здесь добавлено сверх плана,
> помечено как «уточнение реализации» с обоснованием.
>
> **Статус:** Фаза 1 реализована (миграция `0038`, `models.py`, `core/tiers.py`,
> `tasks/feed_collector.py`, `scripts/backfill_artifact_history.py`, beat) — **не
> переоткрывать**. Пользователь добавил новые требования: см. раздел
> **«Ревизия 1: артефактные сигналы в ленте сигналов и тизер для не-МАКС»** — он
> расширяет Фазу 2 (два эндпоинта) и Фазу 4 (лента сигналов, подсветка лота,
> витрина вместо замка) и в двух местах **пересматривает** базовое ТЗ (§4.4).
>
> ⛔ **ЧИТАТЬ ВМЕСТЕ С «Ревизией 4» (2026-08-04).** Объём сужен пользователем: у ленты
> **нет уведомлений** и **нет трансляции в полосу сигналов** — раздел смотрят напрямую с
> портала. Отменены Фаза 5 целиком, `/feed/signals`, фильтр `lot_key` с закреплённой
> строкой, артефактные карточки полосы и три колонки `user_settings`. Затронутые места
> помечены ниже маркером `⛔ ОТМЕНЕНО Ревизией 4` — **не реализовывать и не восстанавливать**.
> Сводка отменённого — §Р4.1.

## Контекст

`/app/feed` — единственный пункт навигации, ведущий в заглушку (`FeedPage.tsx`).
Фичу «Лента» строили и удаляли дважды (2026-06-07 `global_item_scan` + `/monitoring/feed`;
2026-06-11 `feed_watchlist` + `feed_collector.py`), оба раза по одной причине
(`docs/CHANGELOG.md:562-587`): выгодность считали от `avg_price_24h` — средней цены
**выставленных** лотов, а не реальных сделок.

Третья попытка не изобретает метрику: она переиспользует ровно те формулы, что уже
питают карточку «Избранного» и Telegram-бота (`services/analytics/pricing.py`,
`services/profitable_lots.py:158-204`). Второе, что делает задачу решаемой — артефактов
в каталоге всего **103** (`category LIKE 'artefact%'`) против 2328 предметов целиком.

**Что получаем:** платный раздел (тариф МАКС), который мониторит все артефакты рынка и
показывает **только те лоты, которые реально выгодно купить и перепродать** — с учётом
комиссии аукциона 5 %, ликвидности, волатильности и падения рынка. Сравнение всегда в
рамках одинакового товара: **предмет × качество (`qlt`) × заточка (`ptn`)**.

### Решения, зафиксированные пользователем (не менять)

| Вопрос | Решение |
|---|---|
| Строка таблицы | **= один лот.** Три выгодных лота «Ломоть Мастер +15» → три строки |
| Сортировка по умолчанию | **`profit_total`** — прибыль в ₽ со всего лота, убыв. |
| Порог «выгоден» | `user_settings.min_profit_margin_percent` × `RISK_MARGIN_MULT[risk]`. Убыточные и пограничные лоты **не показываются вообще** |
| Гейтинг | Новый флаг `feed_access` в `TierLimits`, `True` только у `advanced_max` + `ADMIN_LIMITS`. **Ревизия 2:** заменён числовым `feed_rows_limit`; **Ревизия 4:** смысл `feed_access` сужен до «полная лента» |
| Уведомления | ⛔ **ОТМЕНЕНО Ревизией 4.** ~~Мгновенные, тип события `feed_lot` в существующий exchange `push.events`; отдельный порог `feed_min_profit_percent`; фидовые тумблеры поверх основного канала~~ — уведомлений у ленты нет |
| Раскладка | Таблица + боковая сводка, 25/50/100 + **серверная** пагинация; фильтры артефакт / качество / заточка / мин. профит |
| Карточка артефакта | Модалка по клику на строку (`components/ArtifactModal.tsx`), содержимое как в «Избранном» |
| Регион | Только RU (`settings.stalcraft_region`), колонка `region` в схеме есть |
| **Ревизия 1** | Артефактные сигналы в ленте сигналов (МАКС) + строка-витрина для остальных ролей — см. одноимённый раздел |

### Три ловушки — закрыть явно

1. **У артефактов вне чьего-то watchlist НЕТ истории продаж.** `sales_history` наполняется
   только по watchlist-парам. Без сделок нет `ref` → нет прибыли → лента снова будет считать
   выгодность от асков. **Сбор `/history` по всем 103 артефактам — обязательная часть, а не
   опция** (стоит 103 × 2 = 206 ед/час = **3.4 ед/мин**).
2. **`/lots` не сортирует по цене.** `collectors._collect_lots_for_item:413` делает
   `sorted(lots, key=lot_price_per_unit)[:200]` уже **после** получения — первая страница API
   это произвольные 200 лотов. У артефакта с 800 лотами обход одной страницы гарантированно
   пропустит лучшие предложения. **Требуется полная пагинация по `data["total"]`.**
3. **Тренд — только метка, не поправка к цене.** Падение рынка уже заложено в `ref` через вес
   `0.5 ** (age_h / 48)` (`docs/tasks/reference-price-recency-weighted.md`). Суточное и
   недельное падение показываем бейджами и учитываем в риске — **но не вычитаем повторно из
   ожидаемой цены продажи.**

### Что переиспользуем (НЕ форкать формулы)

| Нужно | Уже есть | Действие |
|---|---|---|
| Опорная цена, sell_options, прибыль, риск | `pricing.compute_reference` / `weighted_reference` / `make_sell_options` / `evaluate_lot_profit` / `classify_risk` / `COMMISSION` / `RISK_MARGIN_MULT` | Вызывать как есть. **Правок в `pricing.py` не требуется:** при `min_margin_pct=0.0` `evaluate_lot_profit` возвращает `None` только для убыточных лотов |
| Последовательность расчёта варианта | `profitable_lots.compute_signals_for_entry:158-204` (ветка с фильтрами) | Скопировать порядок вызовов: `_build_sales_filter` → `weighted_reference` → `compute_reference` → `make_sell_options` → `classify_risk` |
| Фильтр качества/заточки лота и SQL по продажам | `pricing._lot_quality_enchant`, `_is_artefact`, `_is_liquid`, `_build_sales_filter`, `matching_lot_prices` | Импортировать |
| HTTP + rate limiter | `StalcraftClient.get_auction_lots/get_auction_history` (лимитер внутри `_request`) | Вызывать как есть |
| Наблюдаемость расхода | `core/rate_limiter.get_consumption_stats()` + ключи `stalcraft:requests:minute:*` | Читать для предохранителя |
| Общий кэш лотов | `services/cache/api_cache.set_lots(region, item_id, data, redis_client=...)` | Писать после обхода предмета |
| Шина уведомлений | `services/push_broker.open_channel/publish_event/close_channel`, exchange `push.events`, routing key `push` | Новых очередей/обменников НЕ заводим |
| Паттерн резумируемого бюджетного сканера | `tasks/audit.py` | Копировать структуру (покоммитный прогресс, ретраи на предмет, self-throttle) |
| Паттерн пагинации истории + предварительной сметы | `scripts/backfill_sales_qlt.py` (`HISTORY_PAGE_LIMIT=200`, `BACKFILL_PAGE_DELAY=1.0`, `_estimate` через `limit=1`) | Копировать |
| Серверная пагинация / гейтинг | `endpoints/items.py::list_items`, `endpoints/buy_sniper.py::_require_access` | Копировать идиому |
| Негейтированная ручка без тяжёлого пересчёта | `market_radar.get_watchlist_suggestions` (cache-read-only) | Копировать принцип для `/feed/teaser` |
| Frontend-примитивы | `ui/Pager`, `ui/SortHeader`, `ui/StatusLine`, `ui/QualityChip`, `ui/ItemIcon`, `ui/RiskChip`, `ui/PageLock`, `ui/Panel`, `ui/Kick`, `utils/format.ts` | Использовать, новых примитивов не заводить |
| Лента сигналов | `components/GlobalFeed.tsx`, `components/mobile/MobileSignals.tsx`, `store/feedStore.ts`, `hooks/useFeedPolling.ts` | Расширить вторым источником (Ревизия 1) |
| Модалка | `components/LotStatCard.tsx` + `hooks/useLotStats.ts` (оба развязаны от watchlist), `components/mobile/BottomSheet.tsx` + `MobileLotStatCard` | Обернуть в `Dialog` / `BottomSheet` |

---

## Затронутые файлы

**Создать (backend)**
- `backend/alembic/versions/0038_artifact_feed.py` ✅ (Фаза 1 выполнена)
- `backend/alembic/versions/0039_feed_teaser_index.py` — **условно**, см. Ревизия 1 §Р1.1
- `backend/app/tasks/feed_collector.py` ✅ (Фаза 1 выполнена)
- `backend/app/services/analytics/variant_stats.py`
- `backend/app/api/v1/endpoints/feed.py`
- `backend/app/scripts/backfill_artifact_history.py` ✅ (Фаза 1 выполнена)
- `backend/tests/test_feed_scoring.py`, `backend/tests/test_feed_budget.py`,
  `backend/tests/test_feed_teaser.py`, `backend/tests/test_feed_signals.py`

**Изменить (backend)**
- `backend/app/core/tiers.py` — `feed_access` в `TierLimits` / `TIERS` / `ADMIN_LIMITS` ✅
- `backend/app/models/models.py` — `FeedLot`, `ArtifactVariantStats`, `SalesHistory.user_id` → nullable, 3 поля в `UserSettings` ✅
- `backend/app/tasks/celery_app.py` — `include` + 3 записи `beat_schedule` ✅
- `backend/app/main.py` — импорт и регистрация `feed_router`
- `backend/app/api/v1/endpoints/auth.py` — `feed_access` в `UserResponse`/`from_user` ✅
- `backend/app/api/v1/endpoints/settings.py` — 3 поля в `SettingsResponse`/`SettingsUpdate` ✅
- `backend/app/services/analytics/market_stats.py` — вынести хелпер `extract_time_price_pairs(sales)` (см. Фаза 2)
- ⛔ **ОТМЕНЕНО Ревизией 4:** ~~`push_service/consumer.py` — `render_feed_lot`, `handle_feed_lot`, `HANDLERS`, параметр в `_load_user_gate`~~
- ⛔ **ОТМЕНЕНО Ревизией 4:** ~~`telegram_bot/bot.py` — `build_feed_message`, `handle_feed_lot`, `HANDLERS`, параметр в `_load_user_gate`~~ (оба файла откачены к состоянию до фичи)

**Изменить/создать (frontend)**
- Создать: `frontend/src/pages/FeedPage.tsx` (переписать заглушку), `frontend/src/pages/mobile/MobileFeedPage.tsx`, `frontend/src/components/ArtifactModal.tsx`
- Изменить: `App.tsx`, `components/Layout.tsx`, `components/mobile/MobileTabBar.tsx`, `components/mobile/MoreSheet.tsx`, `store/authStore.ts`, `hooks/useLotStats.ts`, `components/LotStatCard.tsx`, `components/mobile/MobileLotStatCard.tsx`, `pages/SettingsPage.tsx`, `pages/mobile/MobileSettingsPage.tsx`, `pages/LandingPage.tsx`, `pages/FaqPage.tsx`
- **Ревизия 1 дополнительно:** `components/GlobalFeed.tsx`, `components/mobile/MobileSignals.tsx`, `store/feedStore.ts`, `hooks/useFeedPolling.ts`

**Design**
- `design/v5/app/feed.html` (переписать событийный прототип на табличный)
- `design/v5/DIRECTION.md` — поправка про read-only модалку; `design/v5/AUDIT.md` — сноска к DEL-01

---

## Карта фаз и порядок

| # | Что | Агент | Вход | Блокирует |
|---|---|---|---|---|
| 1 | ✅ Миграция `0038`, модели, `feed_access`, сбор лотов и истории, бэкфилл 30 д | `backend-dev` | §Фаза 1 | 2, 5 |
| 2 | `variant_stats`, скоринг, эндпоинты `/feed/*` (~~`/feed/signals` и `/feed/teaser`~~ ⛔ отменены Ревизиями 4 и 2; итоговый состав — §Р4.2) | `backend-dev` | §Фаза 2 | 3, 4 |
| — | **Калибровка после первого прогона** (снять метрики, подкрутить константы) | `backend-dev` + подтверждение пользователя | §Калибровка | — |
| 3 | Прототип `design/v5/app/feed.html` + поправка `DIRECTION.md` | `designer` | §Фаза 3 | 4 |
| 4 | `FeedPage` + `ArtifactModal` + `MobileFeedPage` + навигация + настройки **+ лента сигналов, подсветка лота, витрина (Ревизия 1 §Р1.2)** | `frontend-dev` | §Фаза 4 + §Р1.2 | 6 |
| ~~5~~ | ⛔ **ОТМЕНЕНО Ревизией 4** — ~~уведомления `feed_lot`: продюсер, оба консьюмера, троттлинг, дедуп~~ (реализовано и удалено) | — | §Р4.1 | — |
| 6 | Копирайт: лендинг, FAQ, тарифы, тексты гейта | `frontend-dev` | §Фаза 6 | — |
| 7 | Документация | `tech-writer` | §Документация | — |

**Фазы 1–2 закончить до 3–4: без данных верстать нечего.** QA (`qa-tester`) — после Фазы 4 и
после Фазы 5. `security` и `deploy` — по обычному порядку CLAUDE.md, Блок 2.

---

## Изменения по слоям

### Backend

#### Фаза 1. Данные, гейт, сбор — ✅ РЕАЛИЗОВАНО

> Раздел оставлен как справка по уже принятым решениям. Не переоткрывать; при расхождении
> кода и текста — прав код, расхождение фиксировать в отчёте.

##### 1.1 Миграция `backend/alembic/versions/0038_artifact_feed.py`

Актуальный head на момент написания — `0037_market_stats_reference_price.py`. Новая ревизия:
`revision = "0038"`, `down_revision = "0037"`.

**Таблица `feed_lots`** — живой отскоренный срез **только выгодных лотов**, переписывается
каждым циклом.

| Колонка | Тип | Null | Смысл |
|---|---|---|---|
| `id` | BIGSERIAL PK | — | |
| `item_id` | VARCHAR(50) FK→`master_items.item_id` | NOT NULL | |
| `region` | VARCHAR(10) | NOT NULL | RU в v1 |
| `lot_key` | ~~VARCHAR(64)~~ → **VARCHAR(128)** | NOT NULL | ~~`lot["startTime"]` как есть~~ → **составной `lot_identity_key`**: `startTime\|qlt\|ptn\|buyoutPrice\|amount`. Исправлено при фиксе блокера P1: у предмета висят разные лоты с одним `startTime`, дубль ключа в батче ронял весь цикл (`CardinalityViolationError`) |
| `qlt` | SMALLINT | NOT NULL | 0–5 |
| `ptn` | SMALLINT | NOT NULL | 0–15 |
| `amount` | INTEGER | NOT NULL | |
| `buyout_price` | BIGINT | NOT NULL | итого к оплате |
| `buyout_per_unit` | BIGINT | NOT NULL | `buyout_price // amount` |
| `start_time` | TIMESTAMPTZ | NULL | распарсенный `lot["startTime"]` — отдельным полем, т.к. `lot_key` стал составным |
| `end_time` | TIMESTAMPTZ | NULL | из `lot["endTime"]` |
| `ref_price` | BIGINT | NOT NULL | `artifact_variant_stats.ref_price` |
| `sell_price_used` | BIGINT | NOT NULL | `evaluate_lot_profit["sell_price_used"]` |
| `breakeven_per_unit` | BIGINT | NOT NULL | `evaluate_lot_profit["breakeven_per_unit"]` |
| `profit_per_unit` | BIGINT | NOT NULL | `evaluate_lot_profit["profit"]` (per unit!) |
| `profit_total` | BIGINT | NOT NULL | `profit_per_unit * amount` — колонка сортировки по умолчанию, материализована |
| `profit_pct` | NUMERIC(8,2) | NOT NULL | |
| `margin_adj_pct` | NUMERIC(8,2) | NOT NULL | `profit_pct / risk_mult` — **уточнение реализации**, см. ниже |
| `profit_per_hour` | NUMERIC(14,2) | NULL | ₽/час на единицу (как в карточке) |
| `est_sell_hours` | NUMERIC(8,2) | NULL | `estimated_hours` тира `fast` |
| `risk` | VARCHAR(10) | NOT NULL | low/medium/high |
| `risk_mult` | NUMERIC(3,2) | NOT NULL | 1.00 / 1.30 / 1.60 |
| `volatility_7d` | NUMERIC(6,2) | NULL | |
| `trend_24h` | VARCHAR(10) | NULL | falling/stable/rising/unknown |
| `trend_24h_pct` | NUMERIC(8,2) | NULL | |
| `trend_7d_pct` | NUMERIC(8,2) | NULL | |
| `sales_per_day` | NUMERIC(10,2) | NULL | `sales_volume_7d / 7` варианта |
| `supply_coverage_days` | NUMERIC(10,2) | NULL | Σ amount живых лотов варианта / `sales_per_day` |
| `stats_confidence` | VARCHAR(10) | NULL | `ref_confidence` варианта |
| `stats_samples` | INTEGER | NULL | `ref_samples` варианта |
| `first_seen_at` | TIMESTAMPTZ | NOT NULL | момент первого появления лота в ленте |
| `seen_at` | TIMESTAMPTZ | NOT NULL | момент последнего цикла, где лот подтверждён |

Ограничения и индексы:
```
UNIQUE (item_id, region, lot_key)              -- uq_feed_lots_lot
INDEX ix_feed_lots_profit_total   (profit_total DESC)
INDEX ix_feed_lots_profit_pct     (profit_pct DESC)
INDEX ix_feed_lots_margin_adj     (margin_adj_pct DESC)
INDEX ix_feed_lots_item           (item_id)
INDEX ix_feed_lots_variant        (qlt, ptn)
INDEX ix_feed_lots_end_time       (end_time)
INDEX ix_feed_lots_seen_at        (seen_at)
-- Ревизия 1: + ix_feed_lots_buyout_price (buyout_price) для /feed/teaser
```

> **Уточнение реализации — `margin_adj_pct`.** План описывает базовый фильтр как
> `profit_pct >= :user_min_margin * risk_mult`. Это выражение по двум колонкам не
> опирается на индекс. Математически эквивалентная форма `profit_pct / risk_mult >=
> :user_min_margin` материализуется одной колонкой и делает основной фильтр ленты
> sargable, а SQL — читаемым. `risk_mult` остаётся в таблице (нужен для UI/объяснения
> порога). Значения множителя берутся **только** из `pricing.RISK_MARGIN_MULT`.

**Таблица `artifact_variant_stats`** — статистика варианта «предмет × качество × заточка».

| Колонка | Тип | Смысл |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `item_id` | VARCHAR(50) FK→`master_items.item_id` NOT NULL | |
| `region` | VARCHAR(10) NOT NULL | |
| `qlt` | SMALLINT NOT NULL | |
| `ptn` | SMALLINT NOT NULL | |
| `ref_price` | BIGINT NULL | `compute_reference()["ref"]` |
| `ref_source` | VARCHAR(20) NULL | weighted_history / history / current_fallback |
| `ref_confidence` | VARCHAR(10) NULL | high / low |
| `ref_samples` | INTEGER NULL | |
| `median_24h` / `median_7d` / `median_30d` | NUMERIC(14,2) NULL | описательные медианы сделок |
| `sales_volume_24h` / `_7d` / `_30d` | INTEGER NULL | число сделок в окне |
| `sales_per_day` | NUMERIC(10,2) NULL | `sales_volume_7d / 7` |
| `volatility_7d` | NUMERIC(6,2) NULL | stdev/mean×100 при ≥5 сделках |
| `risk` | VARCHAR(10) NULL | `classify_risk(volatility_7d)` |
| `trend_24h` | VARCHAR(10) NULL | метка из `compute_reference` |
| `trend_24h_pct` | NUMERIC(8,2) NULL | `median_24h` vs `median_7d` |
| `trend_7d_pct` | NUMERIC(8,2) NULL | `(median_7d / median_30d − 1) × 100` |
| `sell_options` | JSONB NULL | результат `make_sell_options` |
| `batch_stats` | JSONB NULL | `market_stats._calculate_batch_stats(варианта)` |
| `avg_sell_time_hours` | NUMERIC(8,2) NULL | `market_stats._avg_sell_time_from_buyouts` |
| `calculated_at` | TIMESTAMPTZ NOT NULL | |

```
UNIQUE (item_id, region, qlt, ptn)   -- uq_artifact_variant
INDEX ix_avs_item (item_id, region)
```

> **Уточнение реализации — где живёт `supply_coverage_days`.** План перечисляет его среди
> полей `artifact_variant_stats`, но задача статистики не видит живых лотов (она читает
> только `sales_history`), а сбор лотов видит их целиком. Чтобы у каждой таблицы остался
> **один писатель**, `supply_coverage_days` (и его вход Σ amount) считается в
> `collect_artifact_lots` и материализуется в строках `feed_lots`. В UI поле показывается
> построчно — семантика не меняется. `sales_per_day` дублируется в обеих таблицах: в
> `artifact_variant_stats` как источник, в `feed_lots` как денормализованный снимок для
> сортировки без join.

**`sales_history.user_id` → nullable.**
```python
op.alter_column("sales_history", "user_id", existing_type=sa.Integer(), nullable=True)
```
Глобально собранные продажи артефактов пишутся с `user_id = NULL` — та же конвенция, что у
`collected_data.user_id` и `market_statistics.user_id`. Легаси-индекс `ix_sales_item_time`
(`user_id, item_id, sale_time`) из `0001_initial.py` **оставить**, ни один сервис по
`user_id` не фильтрует. Дедуп продолжает работать через уникальный индекс
`uq_sales_history_sale (item_id, region, sale_time, total_price, amount)` из `0025`.
Новых индексов для чтения истории не требуется — есть `ix_sales_item_region_time` (`0016`).

**`user_settings` — 3 колонки:** ⛔ **ОТМЕНЕНО Ревизией 4** — колонки убраны из миграции
`0038` (она на прод не применялась) вместе с уведомлениями ленты.
```
feed_notify_push        BOOLEAN NOT NULL DEFAULT false   (server_default="false")   ⛔
feed_notify_telegram    BOOLEAN NOT NULL DEFAULT false   (server_default="false")   ⛔
feed_min_profit_percent INTEGER NOT NULL DEFAULT 20      (server_default="20")      ⛔
```
Порог видимости в таблице берётся из существующего `min_profit_margin_percent` —
новой настройки не заводим (в силе; он же валидируется на сервере диапазоном `0..100`).

`downgrade()` — drop обеих таблиц, ~~drop трёх колонок~~, `sales_history.user_id` обратно в
`nullable=False` (с предварительным `DELETE FROM sales_history WHERE user_id IS NULL`,
иначе откат упадёт; вписать в тело `downgrade` с комментарием).

##### 1.2 Модели — `backend/app/models/models.py`

Классы `FeedLot` и `ArtifactVariantStats` (стиль соседних моделей: `Column(...)`,
`__table_args__` с `Index`). `SalesHistory.user_id` → `nullable=True`. ~~Три поля в
`UserSettings` с теми же дефолтами~~ — ⛔ **ОТМЕНЕНО Ревизией 4**.

##### 1.3 Гейт — `backend/app/core/tiers.py`

`feed_access: bool` в `TierLimits` по образцу `buy_sniper_access`:

| Тариф | `feed_access` |
|---|---|
| base / advanced / advanced_plus | ✗ |
| **advanced_max** | ✓ |
| ADMIN_LIMITS | ✓ |

Флаг снимается автоматически при истечении тарифа — `apply_tier_expiry` +
`sweep_expired_tiers` уже это делают. В `endpoints/auth.py` — `feed_access: bool` в
`UserResponse` и в `from_user()` (`limits.feed_access`).

##### 1.4 `backend/app/tasks/feed_collector.py` — константы

```python
FEED_BUDGET_UNITS_PER_MIN = 200   # жёсткий потолок расхода за один прогон (50% лимита)
FEED_RATE_GUARD_UNITS     = 340   # 85% от 400: суммарный расход системы выше -> цикл прерывается
FEED_LOTS_PAGE_LIMIT      = 200   # максимум, который принимает /lots
FEED_LOTS_REQUEST_COST    = 2     # = TokenCost.LOTS
FEED_MAX_PAGES_PER_ITEM   = 10    # потолок 2000 лотов на предмет (=20 ед, заведомо < бюджета)
FEED_REQUEST_DELAY        = 0.3   # секунд между страницами
FEED_COLD_EVERY_N_CYCLES  = 5     # холодные артефакты обходим каждый N-й цикл
FEED_HOT_SALES_PER_DAY    = 1.0   # горячий, если max(sales_per_day) по вариантам >= порога
FEED_HOT_MIN_LOTS_TOTAL   = 200   # ...или master_items.lots_total >= порога
FEED_MAX_PROFIT_PCT       = 1000.0  # выше -> глитч, лот не сохраняем (см. «+1671089 %»)
FEED_LOCK_KEY             = "feed:scan:lock"
FEED_LOCK_TTL             = 300
FEED_STALE_ROW_HOURS      = 1     # уборка осиротевших строк feed_lots
```

**Единица бюджета = запрос в терминах Token Bucket** (`/lots` = 2). 200 ед/мин = 100 вызовов
API в минуту. Ожидаемая суммарная нагрузка: 54.5 (текущая) + до 100 (лента) + 3.4 (история
артефактов) ≈ **158 запросов/мин ≈ 39.5 % лимита**. Резерв ~60 %.

##### 1.5 `collect_artifact_lots` — сбор и скоринг

Celery-задача `app.tasks.feed_collector.collect_artifact_lots`, beat **каждые 60 с**.

**Защита от наложения.** В начале — `SET FEED_LOCK_KEY NX EX FEED_LOCK_TTL`. Если ключ занят —
выйти с логом. Ключ снимать в `finally`. Без этого beat каждые 60 с при цикле в 2 мин запустит
параллельные обходы и удвоит расход.

**Набор предметов:**
```sql
SELECT * FROM master_items
WHERE category LIKE 'artefact%' AND on_auction IS NOT FALSE
```

**Курсор и два темпа — состояние в Redis** (уточнение реализации):
`feed:scan:last:{item_id}` (TTL 24 ч) и `feed:scan:cycle`. Причина: состояние операционное,
потеря безвредна, а UPDATE 103 строк каталога каждую минуту — лишняя запись в таблицу,
которую читают все разделы.

**Классификация горячий/холодный:** горячий при `max(sales_per_day) >= FEED_HOT_SALES_PER_DAY`
или `lots_total >= FEED_HOT_MIN_LOTS_TOTAL`. Холодные включаются только когда
`cycle % FEED_COLD_EVERY_N_CYCLES == 0`.

**Порядок обхода:** по `feed:scan:last` ASC, NULL первыми.

**Планировщик бюджета — чистая функция:**
```python
def plan_run(items: list[ItemPlan], budget_units: int) -> tuple[list[ItemPlan], int]:
    """Предмет берётся ЦЕЛИКОМ или не берётся вовсе: частичная пагинация даёт
    неполный срез и воспроизводит ловушку 2."""
```

**Предохранитель по фактическому расходу.** Перед каждым предметом
`units = max(текущая минута, предыдущая полная минута)`; `units > FEED_RATE_GUARD_UNITS` →
`break`. `get_consumption_stats()` отдаёт счётчик **неполной** текущей минуты, поэтому
дополнительно читается ключ `stalcraft:requests:minute:{m-1}` (жив, `EXPIRE 120`).
Ядро `rate_limiter.py` не трогаем.

**Пагинация предмета** — до `offset >= total` либо `FEED_MAX_PAGES_PER_ITEM`; ретраи на
уровне предмета по образцу `audit.py`.

**Общий кэш.** После обхода — `api_cache.set_lots(region, item_id, {"total": …, "lots":
sorted(lots, key=ppu)[:200]})`: `GET /lots/{item_id}` по артефакту не порождает своего запроса.

**Скоринг:** `_is_liquid` → `_lot_quality_enchant` → вариант из `artifact_variant_stats`
(без `ref_price`/`sell_options` — пропуск) → `evaluate_lot_profit(..., min_margin_pct=0.0,
batch_stats=variant.batch_stats)` → `None` пропускаем → `profit_pct > FEED_MAX_PROFIT_PCT`
пропускаем с `warning` → `supply_coverage_days` по Σ amount **всех** живых лотов варианта →
`margin_adj_pct`, `profit_total`.

**Запись:** upsert по `(item_id, region, lot_key)` с `RETURNING (xmax = 0) AS inserted`
(источник «новых лотов» для уведомлений), `first_seen_at` только при вставке; после предмета
— `DELETE … WHERE seen_at < :cycle_started_at`; коммит после каждого предмета; после полного
круга — уборка строк старше `FEED_STALE_ROW_HOURS`.

**Лог цикла (обязателен для калибровки):**
```
feed cycle #<n>: items_planned=A items_done=B pages=P units=U elapsed=Xs
                 deferred=D guard_trips=G rows_upserted=R rows_deleted=S
feed sweep: полный круг за Yс (циклов: Z)
```

##### 1.6 `collect_artifact_history` — история по всем артефактам

Beat **раз в час на :15** (окно :00–:11 занято `collect_all_history`). Постраничный
`/history` до первой известной продажи либо `HISTORY_BACKSTOP_PAGES = 3`; запись с
**`user_id = NULL`**; `additional_info` приоритетно из `record["additional"]`;
`on_conflict_do_nothing` по `uq_sales_history_sale`. Снэпшот-матчинг `lot_start` **не
делаем** (у артефактов вне watchlist нет `collected_data`) — следствие отражается в
`stats_confidence`. Стоимость ≈ 3.4 ед/мин.

##### 1.7 Разовый бэкфилл 30 дней — `backend/app/scripts/backfill_artifact_history.py`

По образцу `backfill_sales_qlt.py`: `HISTORY_PAGE_LIMIT=200`, `BACKFILL_PAGE_DELAY=1.0`,
`BACKFILL_MAX_PAGE_RETRIES=5`, смета через `limit=1` + подтверждение (`--yes`).
Запуск: `docker compose exec backend python -m app.scripts.backfill_artifact_history --days 30`.

**Без бэкфилла в первый день у ленты не будет ни `ref`, ни волатильности — т.е. не будет ни
одной строки.** Запуск на проде — только после подтверждения пользователя.

##### 1.8 Расписание — `backend/app/tasks/celery_app.py`

```python
"collect-artifact-lots": {"task": "…collect_artifact_lots", "schedule": timedelta(seconds=60)},
"collect-artifact-history": {"task": "…collect_artifact_history", "schedule": crontab(minute="15")},
"calculate-artifact-variant-stats": {"task": "…calculate_artifact_variant_stats",
                                     "schedule": crontab(minute="14,24,34,44,54")},
```
Минуты `:14,:24,:34,:44,:54` — равномерный шаг 10 мин вне окна `collect_all_history` (:00–:11)
и вне слотов `calculate_market_stats_batch` (:12,:17,…,:57), чтобы не воспроизвести
`docs/tasks/cpu-spikes-recurring-2026-07-06.md`.

##### Критерии приёмки Фазы 1
- [x] `alembic upgrade head` → `0038`; `alembic downgrade -1` откатывается чисто.
- [x] `sales_history.user_id` принимает NULL; существующие запросы не сломаны.
- [x] `feed_access=True` только у `advanced_max`/админа; поле приходит в `/auth/me`.
- [ ] `collect_artifact_lots` за прогон не превышает `FEED_BUDGET_UNITS_PER_MIN`, пишет лог цикла, повторный запуск при живом локе не стартует.
- [ ] Для 3 артефактов с наибольшим `lots_total` число обработанных лотов совпадает с `total` из прямого запроса `/lots`.
- [ ] `collect_artifact_history` наполняет `sales_history` строками с `user_id IS NULL`, дублей нет.
- [ ] `GET /lots/{item_id}` по артефакту отдаёт `_from_cache: true` после цикла ленты.
- [ ] Суммарный расход по `GET /admin/stats` за час ≤ 340 ед/мин.

---

#### Фаза 2. Статистика вариантов, скоринг, API

> **Ревизия 1 добавляет в эту фазу два эндпоинта и один фильтр** — см. §Р1.1. Делать вместе
> с тремя базовыми ручками, отдельного захода не нужно.

##### 2.1 `backend/app/services/analytics/variant_stats.py`

```python
async def calculate_artifact_variant_stats(db, region: str, now: datetime | None = None) -> dict:
    """Пересчитывает artifact_variant_stats по всем вариантам всех артефактов.
    Возвращает {"variants": N, "items": M, "elapsed_sec": X}."""
```
Плюс тонкая Celery-обёртка `app.tasks.feed_collector.calculate_artifact_variant_stats`.

**Алгоритм.**
1. Один запрос — продажи всех артефактов за 30 д:
   ```sql
   SELECT sh.item_id, sh.region, sh.sale_time, sh.price_per_unit, sh.amount,
          sh.total_price, sh.additional_info
   FROM sales_history sh
   JOIN master_items mi ON mi.item_id = sh.item_id
   WHERE mi.category LIKE 'artefact%' AND sh.region = :region
     AND sh.sale_time >= now() - interval '30 days'
   ```
2. Группировка по `(item_id, region, qlt, ptn)` **в Python**:
   `qlt = int(additional_info.get("qlt") or 0)`, `ptn = int(additional_info.get("ptn") or 0)`
   — та же трактовка, что `_lot_quality_enchant` для артефактов. Вариант без сделок за 30 д
   не создаётся.
3. На вариант — **та же последовательность, что в `compute_signals_for_entry:158-204`**:
   ```python
   median_7d   = statistics.median(prices_7d)
   wr          = weighted_reference([(t, p) for t, p in sales_7d], now)
   ref_info    = compute_reference(
                     weighted_hist=wr["ref"] if wr else None,
                     median_hist=median_7d,
                     sample_count=len(prices_7d),
                     median_24h=statistics.median(prices_24h) if prices_24h else None,
                     sample_count_24h=len(prices_24h),
                 )   # median_now/current_min НЕ передаём: живых лотов здесь нет
   volatility   = round(stdev/mean*100, 2) if len(prices_7d) >= 5 else None
   risk         = classify_risk(volatility)
   sell_options = make_sell_options(ref_info["ref"], len(prices_7d), time_price_pairs)
   batch_stats  = _calculate_batch_stats(sales_30d_варианта)
   avg_sell_time_hours = _avg_sell_time_from_buyouts(sales_30d_варианта)
   ```
   `ref_info is None` → вариант пишется с `ref_price = NULL` (в скоринге пропускается).
4. `trend_24h`/`trend_24h_pct` — из `ref_info`; `trend_7d_pct = (median_7d / median_30d − 1) × 100`
   при `median_30d > 0`; `sales_per_day = sales_volume_7d / 7`.
5. Апсерт по `(item_id, region, qlt, ptn)`; варианты без сделок за 30 д удаляются.
6. Numeric-поля — через `market_stats._clamp_pct`.

**Мелкий рефактор (обязателен, чтобы не форкать формулу):** в `market_stats.py` вынести
извлечение пар «часы на рынке → цена» из `_calculate_sell_options` (строки ~576–590):
```python
def extract_time_price_pairs(sales: list) -> list[tuple[float, int]]:
    """Пары (часы_на_рынке, цена) из продаж с восстановленным lot_start.
    Отсекает 0 < hours <= MAX_LOT_LIFETIME_HOURS (лот живёт максимум 48 ч)."""
```
`_calculate_sell_options` начинает вызывать её же — поведение не меняется. Правило передачи в
`make_sell_options` то же: пары только при `coverage >= 0.10 and matched >= 3`, иначе `None`.

##### 2.2 API — `backend/app/api/v1/endpoints/feed.py`

Префикс `/feed`, tag `Feed`. Базовые ручки за гейтом (идиома `buy_sniper._require_access`):
```python
def _require_access(user: User) -> None:
    if not get_tier_limits(user).feed_access:
        raise HTTPException(403, detail="Лента артефактов доступна на тарифе «Макс»")
```
**Исключения (итоговые, после Ревизий 2–4): `GET /feed/lots` и `GET /feed/variant/{item_id}`
идут без гейта** — первая ветвится по `feed_rows_limit`. `_require_access` остаётся только у
`/feed/summary` и `/feed/filters`. ~~`GET /feed/teaser`~~ — отменён Ревизией 2.
Регистрация в `main.py` (`app.include_router(feed_router, prefix="/api/v1")`).

Персональный порог читается из `user_settings` при каждом запросе:
```python
user_min = float(settings.min_profit_margin_percent or 0)
base_filter = FeedLot.margin_adj_pct >= user_min          # == profit_pct >= user_min * risk_mult
```

**`GET /feed/lots`**

| Параметр | Тип | Дефолт | Примечание |
|---|---|---|---|
| `page` | int ≥ 1 | 1 | |
| `page_size` | int ∈ {25, 50, 100} | 25 | валидировать перечислением |
| `item_id` | list[str] | — | множественный |
| `qlt` | list[int] | — | 0–5 |
| `ptn` | list[int] | — | 0–15 |
| `min_profit_pct` | float | — | **поверх** персонального порога, ниже него опустить нельзя |
| `max_buyout` | int | — | по `buyout_price` |
| `min_amount` | int | — | |
| `risk` | list[str] | — | low/medium/high |
| ~~`lot_key`~~ | str | — | ⛔ **ОТМЕНЕНО Ревизией 4** (~~Ревизия 1: точечная выборка строки для закреплённой~~) — параметра нет, вместе с ним снята поверхность дефекта H1 |
| `sort` | enum | `profit_total` | `profit_total`, `profit_pct`, `profit_per_hour` (→ колонка `profit_per_hour_total`, §Р3.2), `buyout_per_unit`, `time_left`(=`end_time`), `volatility`(=`volatility_7d`), `sales_per_day` |
| `order` | enum | `desc` | asc/desc; вторичный ключ всегда `id` (стабильность страниц) |

Чистый SQL: `feed_lots ⋈ master_items` — `artifact_variant_stats` подключать не нужно, все
витринные поля денормализованы. `total` — через `select(func.count()).select_from(query.subquery())`,
паттерн `endpoints/items.py:117`.

```python
class FeedLotOut(BaseModel):
    id: int
    item_id: str
    name_ru: str | None
    name_en: str | None
    icon_path: str | None
    category: str | None
    region: str
    lot_key: str
    qlt: int
    ptn: int
    quality_name: str | None          # _QLT_NAMES[qlt]
    amount: int
    buyout_price: int
    buyout_per_unit: int
    end_time: datetime | None
    hours_remaining: float | None     # computed_field от end_time
    first_seen_at: datetime
    seen_at: datetime
    ref_price: int
    sell_price_used: int
    breakeven_per_unit: int
    profit_per_unit: int
    profit_total: int
    profit_pct: float
    profit_per_hour: float | None
    est_sell_hours: float | None
    risk: str
    risk_mult: float
    volatility_7d: float | None
    trend_24h: str | None
    trend_24h_pct: float | None
    trend_7d_pct: float | None
    sales_per_day: float | None
    supply_coverage_days: float | None
    stats_confidence: str | None
    stats_samples: int | None

class FeedLotsResponse(BaseModel):
    lots: list[FeedLotOut]
    total_count: int
    page: int
    page_size: int
    snapshot_at: datetime | None      # max(seen_at) по всей выборке
    min_profit_pct_applied: float     # эффективный порог = max(user_min, min_profit_pct)
```

**`GET /feed/summary`** — сводка 24 ч + лучший лот. Redis-кэш TTL 60 с по образцу
`market_radar:aggregate` (`services/analytics/market_radar.py:157-191`); ключ **обязательно**
включает порог пользователя: `feed:summary:{region}:{int(effective_min)}`.

```python
class FeedSummaryResponse(BaseModel):
    profitable_lots: int              # строк в срезе с учётом порога пользователя
    avg_profit_pct: float | None
    total_profit: int                 # Σ profit_total
    sales_24h: int                    # сделок по артефактам за 24ч (sales_history)
    items_tracked: int                # число артефактов в наборе (≈103)
    best_lot: FeedLotOut | None       # max(profit_total)
    snapshot_at: datetime | None
    cached: bool
```

**`GET /feed/filters`** — артефакты и счётчики выгодных лотов для чипов.
```python
class FeedFilterItem(BaseModel):
    item_id: str; name_ru: str | None; name_en: str | None
    icon_path: str | None; category: str | None; lots_count: int

class FeedFilterBucket(BaseModel):
    value: int | str; label: str; count: int

class FeedFiltersResponse(BaseModel):
    items: list[FeedFilterItem]          # только те, у кого есть выгодные лоты, по убыв. lots_count
    qualities: list[FeedFilterBucket]    # qlt 0-5 + русское название
    enchants: list[FeedFilterBucket]     # ptn 0-15
    categories: list[FeedFilterBucket]   # био / грав / терм / электро / прочие
    total_count: int
```
Все счётчики — с учётом персонального порога (тот же `base_filter`), иначе чипы обещают
строки, которых пользователь не увидит.

⛔ ~~**Плюс две ручки Ревизии 1** — `GET /feed/signals` и `GET /feed/teaser`~~ — обе
отменены (teaser — Ревизией 2, signals — Ревизией 4). **Четвёртая ручка сейчас другая** —
`GET /feed/variant/{item_id}` (§Р3.1), без гейта.

##### Критерии приёмки Фазы 2
- [ ] `calculate_artifact_variant_stats` заполняет варианты; `SELECT count(*) FROM artifact_variant_stats WHERE ref_price IS NOT NULL` > 0.
- [ ] Прогон задачи не создаёт CPU-плато, пересекающееся со слотами `calculate_market_stats_batch`.
- [ ] `GET /feed/lots` без фильтров: сортировка по `profit_total` убыв., `total_count` совпадает с `SELECT count(*)` по тому же фильтру.
- [ ] Ни одной строки с `profit_pct <= 0` ни при каком пороге; ни одной с `profit_pct > 1000`.
- [ ] Поднятие `min_profit_margin_percent` с 10 до 30 заметно сокращает выдачу; для строки с `risk=high` реальный порог = 30 × 1.6 = 48 %.
- [ ] Для верхних 10 строк `ref_price` / `breakeven_per_unit` / `profit_pct` совпадают с карточкой «Избранного» при том же качестве и заточке **для лотов `amount = 1`** (см. «Известные расхождения»).
- [ ] ⛔ ~~Не-МАКС получает 403 на `/feed/lots`, `/feed/summary`, `/feed/filters`, `/feed/signals` — и 200 на `/feed/teaser`.~~ — **отменено**: с Ревизии 2 `/feed/lots` отвечает 200 всем и урезает выдачу; 403 остаётся только у `/feed/summary` и `/feed/filters`; `/feed/variant` — без гейта.
- [ ] Пагинация: страницы не перекрываются и не теряют строк (вторичный ключ сортировки `id`).
- [ ] Критерии приёмки Ревизии 1 (Backend) — §Р1.4.

> **Известное легитимное расхождение с карточкой.** Лента корректирует ожидаемую цену продажи
> по `batch_stats` **варианта**, а `compute_signals_for_entry` — по `batch_stats` всего предмета
> (`MarketStatistics.batch_stats`). Для лотов `amount > 1` цифры могут отличаться; это не форк
> формулы, а более узкая (и более честная) выборка. Сверку паритета в QA делать на `amount = 1`.

---

#### Фаза 5. Уведомления `feed_lot`

> ⛔ **ОТМЕНЕНО Ревизией 4 целиком (2026-08-04).** Фаза была реализована и **удалена из
> кода** по решению пользователя: «Лента должна быть отдельным разделом, мониторинг за
> которым надо производить напрямую с портала». Весь текст ниже — историческая справка,
> **не реализовывать заново**. Что именно удалено — §Р4.1. Трансляция «Избранного» в
> сигналы и уведомления `profitable_lot` / `buy_alert` / `emission` — не тронуты.

##### 5.1 Продюсер — в конце цикла `collect_artifact_lots`

1. Собрать список **новых** строк цикла (`inserted = true` из `RETURNING`).
2. Получателей выбрать одним запросом: `users ⋈ user_settings`, где
   `is_active AND (is_approved OR is_admin)` И `get_tier_limits(user).feed_access` И
   (`feed_notify_push` ИЛИ `feed_notify_telegram`).
   **Пользователи без `feed_access` (в т.ч. `advanced_plus`) в выборку не попадают никогда** —
   витрина-тизер (Ревизия 1) даёт им только UI, но не уведомления.
3. Для пользователя отобрать лоты по **двум** условиям:
   ```
   profit_pct     >= feed_min_profit_percent           (персональный порог уведомлений)
   margin_adj_pct >= min_profit_margin_percent          (тот же порог, что у таблицы)
   ```
   > Второе условие — уточнение реализации: без него возможен пуш о лоте, которого нет в
   > ленте этого пользователя. Уведомление должно всегда вести на видимую строку.
4. **Троттлинг: не более `FEED_NOTIFY_MAX_PER_CYCLE = 5` событий на пользователя за цикл**,
   по убыванию `profit_total` (ср. `docs/NOTES.md:353`).
5. Публикация в существующий DIRECT exchange `push.events`, routing key `push`
   (`open_channel` на цикл → `publish_event` → `close_channel` в `finally`).
   **Новых очередей и обменников не заводим.**

**Payload:**
```json
{
  "type": "feed_lot",
  "user_id": 12, "item_id": "y8h4", "item_name": "Ломоть",
  "region": "RU", "qlt": 4, "ptn": 15, "quality_name": "Мастер",
  "buyout_per_unit": 142000, "amount": 3,
  "profit": 82440,            // profit_total, ₽ со всего лота
  "profit_per_unit": 27480,
  "profit_pct": 19.3,
  "lot_key": "2026-08-03T11:22:33Z"
}
```

##### 5.2 Консьюмеры

Расширить `_load_user_gate` в `push_service/consumer.py:197` и `telegram_bot/bot.py:213`:
```python
async def _load_user_gate(db, user_id: int, gate_attr: str,
                          setting_attr: str | None = None) -> Optional[User]:
    ...
    if setting_attr is not None and not (us is not None and getattr(us, setting_attr, False)):
        return None
```
Правило «только поверх основного» получается автоматически: базовая проверка
`notify_browser_push` / `notify_telegram` остаётся, фидовый тумблер добавляется поверх.
**Проверяется на бэкенде, а не только в UI.**

- `push_service/consumer.py`: `render_feed_lot(event) -> dict` («Лента: выгодный лот» /
  «Ломоть · Мастер +15 — 142 000 ₽/шт ×3 · прибыль +82 440 ₽ (+19.3 %)», `url: "/app/feed"`),
  `handle_feed_lot` с `_load_user_gate(db, event["user_id"], "feed_access", "feed_notify_push")`,
  дедуп `feed_push_sent:{user}:{item_id}:{lot_key}`, TTL `NOTIF_DEDUP_TTL` (48 ч);
  запись в `HANDLERS["feed_lot"]`.
- `telegram_bot/bot.py`: `build_feed_message(...)` (HTML, стиль `build_lot_message`),
  `handle_feed_lot` с `_load_user_gate(..., "feed_access", "feed_notify_telegram")`,
  дедуп `feed_tg_sent:{user}:{item_id}:{lot_key}`, запись в `HANDLERS`.
  **Все подставляемые текстовые поля — через `html.escape`** (`item_name`, `quality_name`):
  закрываем открытый пункт техдолга `docs/NOTES.md:360` сразу.

**Deep-link (задел).** `url` push-уведомления можно сразу делать адресным:
`/app/feed?lot={lot_key}` — `FeedPage` уже умеет читать `?lot=` (Ревизия 1 §Р1.2). Это
дешёвое частичное закрытие открытого пункта `docs/NOTES.md:166`; если делать — только для
`feed_lot`, остальные типы событий не трогать.

##### Критерии приёмки Фазы 5
- [ ] Порог 50 % → не более 5 сообщений на пользователя за цикл.
- [ ] Повтор по тому же `lot_key` не приходит (дедуп 48 ч), новый лот того же варианта — приходит.
- [ ] При выключенном основном канале (`notify_browser_push=false`) фидовые события не доставляются, даже если `feed_notify_push=true`.
- [ ] **Пользователь `advanced_plus` с включёнными фидовыми тумблерами не получает ни push, ни Telegram** (проверяется и на продюсере, и на консьюмере).
- [ ] Уведомление не приходит про лот, которого нет в ленте пользователя при его пороге.
- [ ] Имя предмета с `&`/`<` не ломает Telegram-сообщение.

---

### Frontend

#### Фаза 3 (designer). Прототип и поправка дизайн-направления

**Файл `design/v5/app/feed.html`** — переписать событийный прототип на **табличный**, на
токенах `design/v5/assets/tokens.css`, в шелле `shell.js` как у `lots.html`/`radar.html`.
Точное соответствие прототипу — требование проекта (`feedback_design_v5_fidelity`).

```
┌─ NAVBAR ─────────────────────────────────────────────────────────────────────┐
├─ Блок 1 · Шапка ─────────────────────────────────────────────┬─ Блок 5 ──────┤
│ ЛЕНТА АРТЕФАКТОВ // ARTEFACT FEED                            │ Сводка 24ч    │
│ Что выгодно купить прямо сейчас                              │ ┌────┬─────┐  │
│ ● обновлено 40 с назад · срез 14:32 · 103 предмета           │ │выгод│ ср.%│ │
├─ Блок 2 · Фильтры (sticky) ──────────────────────────────────┤ ├────┼─────┤  │
│ [Артефакт ▾][Качество ▾][Заточка ▾] │ Мин. профит [10 % ▾]   │ │Σ ₽ │сделок│ │
│ Био 12 · Грав 8 · Терм 5 · Электро 3 · Прочие 9              │ └────┴─────┘  │
├─ Блок 3 · Таблица (строка = лот) ────────────────────────────┤               │
│ ПРЕДМЕТ           ЛОТ       ОПОРА   ПРИБЫЛЬ↓ РЫНОК  ЛИКВ ВРЕМЯ│ Лучший сейчас │
│ ◈ Ломоть Мастер+15 142 000 ×3  178 400 +82 440  vol 12% 4.2/дн│ ◈ Кристалл    │
│                    426 000 итог безуб. +19.3%  риск lo 1.4 дн │   +38 900     │
├─ Блок 4 · Подвал ────────────────────────────────────────────┤ Блок 6        │
│ Показывать [25|50|100]   ‹ 1 2 3 … 47 ›   1 246 выгодных лотов│ Уведомления   │
└──────────────────────────────────────────────────────────────┴───────────────┘
       ↓ клик по строке
┌─ Блок 7 · Модалка «Карточка артефакта» (Ломоть · Мастер +15) ─────────────┐
│  Метрики · Выгодные лоты варианта · Графики продаж · Варианты продажи ·   │
│  Пачки                                        [Смотреть лоты]  [Закрыть]  │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Блок 1 · Шапка** — `.panel` + `.kick`; пульсирующая `.livehint` + время среза (`snapshot_at`).
- **Блок 2 · Фильтры (sticky)** — артефакт (поиск по 103 предметам), качество (0–5, цвета
  `QUALITY_COLORS`), заточка (0–15), «Мин. профит» (**поднимает** порог поверх персонального).
  Переключателя «только прибыльные» нет: невыгодных лотов в ленте не бывает по построению.
  Чипы-счётчики по подкатегориям (`.fchip` + `.fc-n`). Липнет через `--sc-top-offset`.
- **Блок 3 · Таблица** — одна строка = один выгодный лот; заголовки сортируемые:

  | Колонка | Содержимое | Зачем |
  |---|---|---|
  | Предмет | иконка + название + чип качества + чип заточки | «Мастер +15» и «Мастер +10» — разные товары |
  | Лот | цена за штуку · × количество · итого к оплате | сколько платить сейчас |
  | Опора | `ref_price` · безубыток | честная база: медиана **сделок** 7 д, взвешенная по свежести |
  | **Прибыль ↓** | **₽ со всего лота** · % · ₽/час | сортировка по умолчанию; уже за вычетом комиссии 5 % |
  | Рынок | волатильность 7 д · чип риска · тренд 24 ч и 7 д | тренд — **метка**, не поправка к цене (ловушка 3) |
  | Ликвидность | сделок в день · покрытие предложения в днях | ответ на «а продастся ли» |
  | Время | осталось до конца лота · когда замечен | лот живёт максимум 48 ч |

  Клик по строке → модалка. Отдельная кнопка «Лоты» → `/app/lots?item=…`. Свежие лоты — `.fresh`.
- **Блок 4 · Подвал** — 25/50/100 + пагинатор + строка среза.
- **Блок 5 · Сводка 24 ч** (сайдбар 272 px, sticky) — 4 ячейки статус-линии + «Лучший лот
  сейчас» с **единственным золотым свечением на экране** (`.bestv`).
- **Блок 6 · Уведомления раздела** — карточка с текущим порогом и ссылкой в настройки.
- **Блок 7 · Модалка** — широкий вариант `.modal` (сейчас `min(440px,100%)`).
- **Пустое состояние** — обучающее: «Выгодных лотов по текущим фильтрам нет…».
- **Ревизия 1 — два новых состояния в прототипе (обязательны):**
  1. **Закреплённая строка** над таблицей (приход из ленты сигналов): та же вёрстка строки +
     рамка `--gold-line` + кикер «из ленты сигналов» + крестик «открепить»; плюс состояние
     «лот уже выкуплен».
  2. **Витрина для не-МАКС**: одна полная строка + `.gate`-блок с CTA под ней (вместо
     сплошного замка на всю страницу). Строка **не размыта**.
  3. В прототипе ленты сигналов (`shell.js` / `base.css` `.signals`) показать артефактную
     карточку с обводкой и кикером «ЛЕНТА» рядом с обычной «ИЗБРАННОЕ».

**Поправка `design/v5/DIRECTION.md`** (строка ~84, таблица компонентов): формулировка
«`.modal-ov` + `.modal(-h/-b/-f)` — модалка … только для операций с потерей невосстановимых
данных» дополняется исключением:

> Исключение: **read-only карточка-обозреватель** (карточка артефакта в Ленте) — модалка
> допустима, когда она показывает детализацию строки списка, не имеет деструктивных действий
> и закрывается по ESC/клику вне. Требования: широкий вариант `.modal.wide`
> (`min(1080px, 94vw)`), фокус-трап, восстановление фокуса на строку-источник.

Аналогичную сноску — к `AUDIT.md` DEL-01. Без правки следующее дизайн-ревью пометит карточку
как дефект.

**Критерии приёмки Фазы 3:** прототип открывается в шелле v5; нет ни одного хекса вне
`tokens.css`; раскладка соответствует схеме; присутствуют оба состояния Ревизии 1;
`DIRECTION.md` содержит поправку.

#### Фаза 4 (frontend-dev). Реализация

**Правило проекта:** хекс/rgba вне `frontend/src/theme.ts` = дефект. Все примитивы —
существующие (`ui/*`), новых не заводить.
**Ревизия 1 добавляет в эту фазу ленту сигналов, подсветку лота и витрину — см. §Р1.2.**

**4.1 `pages/FeedPage.tsx`** (переписать заглушку) — точное соответствие прототипу.
- Гейт: `feed_access === false && !is_admin` → **строка-витрина + `PageLock`** (Ревизия 1
  §Р1.2, заменяет прежнее «сплошной `PageLock`»).
- Данные: `GET /feed/lots` (серверная пагинация, как `CatalogPage`/`MarketRadarPage`, **не**
  клиентская нарезка `LotsPage`), `GET /feed/summary`, `GET /feed/filters`. Поллинг списка —
  30 с (частоту опроса **внешнего API** это не меняет).
- Состояние фильтров/сортировки/страницы — в URL (`useSearchParams`); там же живёт
  `?lot=` для закреплённой строки (Ревизия 1).
- Заголовки — `ui/SortHeader`; подвал — `ui/Pager` (1-based) + переключатель 25/50/100;
  сводка — `ui/StatusLine`; чипы — `ui/QualityChip`, `ui/RiskChip`; иконки — `ui/ItemIcon`;
  форматирование — `utils/format.ts`.
- Пустое состояние — обучающее, не «нет данных».

**4.2 `components/ArtifactModal.tsx`** (новый)
```tsx
interface ArtifactModalProps {
  open: boolean
  onClose: () => void
  itemId: string
  region: string
  qlt: number
  ptn: number
  itemName: string
  iconPath?: string | null
}
```
Хост — MUI `Dialog maxWidth="lg" fullWidth scroll="body"` (сейчас все три диалога в проекте
`maxWidth="xs"`). Внутри — `LotStatCard` с `kicker="Лента · {region}"`, `qualityFilter={qlt}`,
`enchantFilter={ptn}`, без `onDelete`, с `onViewLots` → `/app/lots?item=…` (закрыв модалку).

Что доделать в существующих компонентах:
1. **`components/LotStatCard.tsx`** — необязательный проп `kicker?: string`; строка ~166
   `<Kick>Избранное · {region}</Kick>` → `<Kick>{kicker ?? \`Избранное · ${region}\`}</Kick>`.
   То же в `MobileLotStatCard.tsx`, если там есть аналогичный киккер.
2. **`hooks/useLotStats.ts`** — необязательный параметр `signalsSource?: 'watchlist' | 'feed'`
   (по умолчанию `'watchlist'`, поведение не меняется). При `'feed'` вместо
   `GET /monitoring/signals/{id}` вызывается
   `GET /feed/lots?item_id={id}&qlt={q}&ptn={p}&page_size=25&sort=profit_total`, ответ
   маппится в существующую форму `SignalsData`:

   | `SignalsData` | Источник из `/feed/lots` |
   |---|---|
   | `lots[].start_time` | `lot_key` |
   | `lots[].buyout_per_unit` / `buyout_price` / `amount` | одноимённые |
   | `lots[].quality_name` / `enchant` | `quality_name` / `ptn` |
   | `lots[].profit` | **`profit_per_unit`** (в `SignalLot` прибыль — на единицу!) |
   | `lots[].profit_pct` / `profit_per_hour` / `sell_price_used` / `breakeven_per_unit` | одноимённые |
   | `lots[].tier_used` | `'fast'` |
   | `ref` / `volatility_7d` / `trend` / `trend_pct` / `risk` | из первой строки ответа |
   | `computed_at` | `snapshot_at` |
   | `sell_options` | остаётся из `/monitoring/item` (не переопределяем) |

   **Почему так:** `GET /monitoring/signals/{id}` для неотслеживаемого предмета **всегда
   пуст** — ключ Redis содержит `user_id` и пишется только по активным watchlist-записям
   (`collectors.py:533`). Он падает мягко, но `useLotStats` уходит в деградированный
   клиентский фоллбек по `/lots`, и цифры в модалке разойдутся с таблицей.
3. **`TierGate` внутри `SalesHistoryCharts`** делает `navigate('/app/settings')` из-под
   модалки. На МАКС гейт не показывается, но обработать: закрывать модалку при смене
   `location.pathname`, снимать скролл-лок `body`, не оставлять «осиротевший» оверлей.
4. `GET /monitoring/item/{id}` и `GET /monitoring/sales-chart/{id}` **не требуют записи в
   «Избранном»** и принимают `quality_filter`/`enchant_filter` — отдельного бэкенда для
   модалки не нужно.

**4.3 Мобильная версия** — `pages/mobile/MobileFeedPage.tsx` (карточки вместо таблицы,
фильтры в шите, карточка артефакта в `BottomSheet` + `MobileLotStatCard`). В `App.tsx`:
```tsx
<Route path="feed" element={<ModeSwitch desktop={<FeedPage />} mobile={<MobileFeedPage />} />} />
```

**4.4 Навигация и гейт — ПЕРЕСМОТРЕНО Ревизией 1**

~~Добавить `gateKey: 'feed'` и замок в навбаре/шите.~~ **Отменено:** с появлением
строки-витрины замок в навбаре прячет как раз ту страницу, которая должна конвертировать.
Актуальное поведение — §Р1.2 «Навбар: пункт „Лента“ перестаёт быть заблокированным»:
- `Layout.tsx` — пункт «Лента» **без `gateKey`**, `GateKey`/`GATE_TOOLTIP` не расширяем;
- `MoreSheet.tsx` — строка `feed` **без `locked`/`lockTip`**;
- `MobileTabBar.tsx` — без изменений (`/app/feed` остаётся в `SHEET_PATHS`);
- `store/authStore.ts` — `feed_access: boolean` в типе `User` **нужен** (по нему страница,
  стор и настройки выбирают режим).

**4.5 Настройки** — `pages/SettingsPage.tsx` (и `MobileSettingsPage.tsx`):

> ⛔ **ОТМЕНЕНО Ревизией 4** — всё, кроме строки «Лента артефактов — Да / Нет» в панели
> «Тариф». Подраздел с фидовыми тумблерами и порогом уведомлений реализован и **удалён**
> вместе с колонками `user_settings`; типы `SettingsResponse`/`update()` откачены.

- В панель «Уведомления» — подраздел **«Лента артефактов»**: два `TumblerSwitch`
  (`feed_notify_push`, `feed_notify_telegram`) + числовое поле `feed_min_profit_percent`
  (0–100, подпись «Порог прибыли для уведомлений, %»).
- Тумблеры `disabled`, пока не включён соответствующий основной канал, с подсказкой в стиле
  `SettingsPage.tsx:548`: «Сначала включите Browser Push» / «Сначала включите уведомления
  в Telegram».
- Весь подраздел `disabled` при `feed_access === false` с пояснением «Доступно на тарифе Макс».
- В панель «Тариф» — строка **`Лента артефактов — Да / Нет`**.
- Типы `SettingsResponse`/`update()` — дополнить тремя полями.

##### Критерии приёмки Фазы 4
- [ ] `cd frontend; npm run build` (tsc + vite) без ошибок.
- [ ] Соответствие прототипу `design/v5/app/feed.html`: раскладка блоков, порядок колонок, sticky-фильтры, единственное золотое свечение на экране.
- [ ] Ни одного хекса/rgba вне `theme.ts`.
- [ ] Выдача `advanced_max` через админку → полная лента появляется без релогина (`fetchMe`).
- [ ] Сортировка по умолчанию — прибыль ₽ со всего лота, убыв.; переключение 25/50/100 перезапрашивает сервер.
- [ ] Артефакт с ≥2 выгодными лотами одного качества и заточки показан **несколькими строками** с разными ценами.
- [ ] Модалка на предмете, которого **нет в «Избранном»**: метрики и графики заполнены, окна 24Ч/48Ч/7Д/30Д доступны на МАКС, «Выгодные лоты» показывают те же цифры, что строка таблицы; закрытие по ESC и клику вне; на мобильном — `BottomSheet`.
- [ ] ⛔ ~~Настройки: фидовые тумблеры недоступны при выключенном основном канале; порог переживает перезагрузку.~~ — **ОТМЕНЕНО Ревизией 4**.
- [ ] Критерии приёмки Ревизии 1 (Frontend) — §Р1.4 (читать вместе с §Р4.1: половина отменена).

#### Фаза 6 (frontend-dev). Копирайт

**Тултип/`PageLock`** (используется и в витрине для не-МАКС):
> **Лента артефактов — тариф «Макс»**
> Мы мониторим все 103 артефакта рынка целиком и показываем только те лоты, которые реально
> выгодно купить и перепродать — с вычетом комиссии аукциона, с оценкой ликвидности и риска.
> Каждое качество и каждая заточка сравниваются отдельно. «Избранное» показывает предметы,
> которые вы выбрали сами; Лента — те, о которых вы ещё не знаете.

**Подпись под витриной (не-МАКС, Ревизия 1):**
> Показан 1 из {total_profitable} выгодных лотов, найденных прямо сейчас — самый доступный по
> цене. Остальные и уведомления о новых — на тарифе «Макс».

**Лендинг `pages/LandingPage.tsx`** — карточка в секции «Фичи» + строка в тарифах (`PLANS`:
✗ base/advanced/advanced_plus, ✓ advanced_max):
> **Лента артефактов** — весь рынок артефактов в одном списке выгодных сделок. Прибыль,
> ликвидность и риск по каждому лоту. Уведомления в Telegram и push.

**FAQ `pages/FaqPage.tsx`** — новая группа «Лента артефактов» + строка в `TierTable`:
> **Чем Лента отличается от «Избранного»?** «Избранное» следит за предметами, которые вы
> добавили — до 25 карточек. Лента ничего добавлять не требует: она постоянно обходит **все
> артефакты рынка** и показывает лоты, на которых можно заработать, отсортированные по прибыли.
> **Почему один и тот же артефакт встречается несколько раз?** Потому что это разные товары и
> разные лоты. «Мастер +15» и «Мастер +10» продаются по разным ценам, поэтому сравниваются
> раздельно; а если выгодных лотов «Мастер +15» на рынке три — вы увидите все три и сможете
> взять любой.
> **Откуда берётся прибыль?** Из реальных сделок, а не из цен выставленных лотов. Опорная
> цена — медиана продаж за 7 дней, взвешенная по свежести: вчерашняя сделка весит вдвое
> больше позавчерашней. Из выручки вычитается комиссия маркета 5 %.
> **Что такое ликвидность и покрытие?** Сколько таких артефактов того же качества и заточки
> продаётся в день и за сколько дней рынок переварит нынешнее предложение. Прибыль 30 % на
> товаре, который продаётся раз в неделю, — это не 30 % в неделю.
> **Почему лотов в ленте мало?** Показываются только по-настоящему выгодные: порог берётся из
> вашего «Критерия выгодности» и повышается для волатильных товаров. Убыточные и пограничные
> лоты скрыты намеренно.
> **Почему я вижу только один лот?** (Ревизия 1) На тарифах ниже «Макс» лента показывает один
> — самый доступный по цене — выгодный лот целиком, без сокрытия цифр, чтобы вы видели, как
> она работает. Полный список и уведомления открываются на «Макс».

**Новость для портала** (публикует админ через `/app/news`, тег «обновление») — текст
согласовать с пользователем перед публикацией.

---

## Ревизия 1: артефактные сигналы в ленте сигналов и тизер для не-МАКС

> ⛔ **ЧИТАТЬ ВМЕСТЕ С «Ревизией 2».** Модель доступа изменена пользователем ещё раз: бинарный
> `feed_access` заменён числовым лимитом строк по тарифам (1 / 10 / 20 / без ограничений), а
> правило отбора «самый дешёвый лот» отменено. Все места Ревизии 1, где говорится про
> `feed_access` как про булев доступ, про «тизер из одного лота» и про «самый дешёвый по
> `buyout_price`», помечены ниже маркером `⛔ ОТМЕНЕНО Ревизией 2`. Остальное (лента сигналов,
> обводка, переход с подсветкой, отсутствие пушей у не-МАКС) — в силе.
>
> Добавлено пользователем после реализации Фазы 1 (миграция `0038`, `feed_collector.py`,
> модели, `feed_access` — **не переоткрывать**). Требования подтверждены целиком, включая три
> уточнения ниже. Ревизия **не отменяет** решений базового ТЗ, а расширяет Фазу 2 (два
> эндпоинта) и Фазу 4 (лента сигналов, подсветка лота, витрина вместо замка).

**Дословно от пользователя:** «Добавь еще эти предложения в ленту сигналов, также только по
подписке макс + пуши по ним, отображение в ленте для этого раздела сделай с обводкой, чтобы
отличать, что из избранного летит, что так летит. И переход из ленты на страницу с этим лотом
+ выделение этого лота. Для остальных ролей добавь отображение только 1-го выгодного лота,
который самый дешёвый из списка.»

«Лента сигналов» = существующая липкая полоса под навбаром: `components/GlobalFeed.tsx`
(десктоп) и `components/mobile/MobileSignals.tsx` (мобайл), общий дата-слой
`store/feedStore.ts` + `hooks/useFeedPolling.ts` (сейчас фанится по
`/monitoring/signals/{item_id}` на каждую watchlist-запись).

**Подтверждённые уточнения:**
1. Клик по артефактному сигналу ведёт на `/app/feed` **с подсветкой строки**.
2. Тизер для не-МАКС показывается **и в ленте сигналов, и на `/app/feed`** (одна
   строка-витрина вместо глухого замка; остальное закрыто `PageLock` с CTA на МАКС).
3. Тизер — **полная строка, как у МАКС**: предмет, качество, заточка, цена, прибыль в ₽ и %,
   ликвидность. **Не размывать**, не прятать цифры.

### Р1.1 Backend — два эндпоинта (входят в Фазу 2)

#### `GET /feed/signals?limit=N` — топ артефактных лотов для ленты сигналов (только МАКС)

> ⛔ **ОТМЕНЕНО Ревизией 4.** Ручка реализована и **удалена** вместе со схемой
> `FeedSignalsResponse`, кэшем `feed:signals:*` и хелпером `showcase_signals_limit`: лента
> в полосу сигналов больше не транслируется. Текст ниже — историческая справка.

**Решение: отдельный лёгкий эндпоинт, а не `/feed/lots` с малым `page_size`.**
Обоснование: `/feed/lots` на каждый вызов считает `total_count` через `func.count()`-подзапрос
и несёт весь набор фильтров/сортировок — это нормально для страницы, которую открывают руками,
но лента сигналов опрашивается **каждым залогиненным пользователем раз в 30 с постоянно, на
всех страницах приложения**. Отдельная ручка убирает `count(*)` и позволяет кэшировать ответ
целиком.

- Гейт `_require_access` (`feed_access`), как у остальных `/feed/*`.
- `limit`: int, 1..10, default **5**.
- Выборка: `feed_lots ⋈ master_items`, базовый фильтр `margin_adj_pct >= user_min`,
  `ORDER BY profit_total DESC, id`, `LIMIT :limit`. Без `count(*)`.
- **Redis-кэш TTL 30 с**, ключ `feed:signals:{region}:{int(user_min)}:{limit}` — общий для
  пользователей с одинаковым порогом (идиома `feed:summary:*` / `market_radar:aggregate`).
- Схема ответа переиспользует `FeedLotOut` (§2.2) — вторую форму строки не заводим:
```python
class FeedSignalsResponse(BaseModel):
    lots: list[FeedLotOut]
    snapshot_at: datetime | None
    min_profit_pct_applied: float
```

**Интервалы поллинга не меняются** (`docs/tasks/design-v5-implementation.md` §8): новый вызов
встраивается в существующий 30-секундный тик `useFeedPolling`, дополнительных таймеров не
заводим. Внешний Stalcraft API эта ручка не трогает вообще — только своя БД и Redis.

#### `GET /feed/teaser` — одна строка-витрина (БЕЗ гейта, все роли)

> ⛔ **ОТМЕНЕНО Ревизией 2 частично.** Идея негейтированной ручки и все требования
> cache-read-only **остаются в силе** — но ручка больше не отдаёт «одну самую дешёвую строку».
> Вместо неё лимитированные тарифы получают витрину из `feed_rows_limit` строк, отобранных по
> медианной ценовой полосе. См. §Р2.2. Правило `ORDER BY buyout_price ASC LIMIT 1` ниже
> **не реализовывать**.

- Зависимость только от `get_current_user`; `_require_access` **не вызывается**. Это
  единственная ручка `/feed/*` без тарифного гейта.
- Возвращает **ровно один лот: самый дешёвый по полной сумме к оплате** —
  `ORDER BY buyout_price ASC, id LIMIT 1` — среди лотов, выгодных **по порогу этого
  пользователя** (`margin_adj_pct >= min_profit_margin_percent`).
  ⚠ Именно `buyout_price` (итог к оплате), **не** `buyout_per_unit`: это разные лоты, а
  требование пользователя — «самый дешёвый из списка», т.е. самый доступный по деньгам.
- **Cache-read-only / дешёвый SQL — требование безопасности, не оптимизация.** Прямой урок
  проекта: `get_watchlist_suggestions` (`docs/BUSINESS_LOGIC.md` §17, «Подсказки пустого
  Избранного») сознательно сделан cache-read-only — негейтированный эндпоинт, способный
  запустить тяжёлый пересчёт, это DoS-вектор (замечание security-ревью). Здесь:
  - читаем **только готовую таблицу `feed_lots`** + join `master_items`, `LIMIT 1`;
  - **никаких** вызовов `stalcraft_client`, `variant_stats`, `market_stats`,
    `api_cache.get_or_fetch_*`;
  - на промахе/пустой таблице — `lot: null`, **никакого** расчёта не запускаем;
  - ответ кэшируется в Redis **TTL 30 с**, ключ `feed:teaser:{region}:{int(user_min)}` —
    N пользователей с одинаковым порогом дают один запрос в БД за 30 с.
- Ответ:
```python
class FeedTeaserResponse(BaseModel):
    lot: FeedLotOut | None          # полная строка — все поля, как у МАКС (уточнение 3)
    total_profitable: int           # сколько всего выгодных лотов сейчас при пороге пользователя
    snapshot_at: datetime | None
    has_access: bool                # get_tier_limits(user).feed_access — фронт решает, что рисовать
    min_profit_pct_applied: float
```
  `total_profitable` — крючок для CTA («ещё N выгодных лотов — на тарифе Макс»); считается тем
  же кэшированным запросом.

**Индекс.** Для `ORDER BY buyout_price ASC LIMIT 1` — `ix_feed_lots_buyout_price`
(`buyout_price`). Таблица маленькая (сотни–тысячи строк), но ручка негейтирована: индекс тут
страховка.
*Если `0038` ещё не применена ни локально, ни на проде — дописать индекс в неё. Если уже
применена где-либо — отдельная миграция `0039_feed_teaser_index.py` (`down_revision = "0038"`);
переписывать применённую ревизию нельзя.*

#### Фильтр `lot_key` в `GET /feed/lots`

> ⛔ **ОТМЕНЕНО Ревизией 4.** Параметр реализован (после security-ревью — с обязательным
> `item_id` и порогом) и **удалён** вместе с закреплённой строкой: приходить в ленту
> «по ссылке из уведомления» больше неоткуда. Заодно снята поверхность дефекта H1.

Для закреплённой строки (Р1.2) — необязательный параметр `lot_key: str | None`: точечная
выборка одной строки в пределах текущего среза, по существующему индексу `uq_feed_lots_lot`.
Персональный порог к нему **не применяется**: лот пришёл из сигналов этого же пользователя,
порог уже соблюдён при публикации; повторная фильтрация давала бы пустую подсветку на
пограничных значениях.

#### Уведомления для не-МАКС — не шлём

> ⛔ **ОТМЕНЕНО Ревизией 4** (вопрос снят целиком): уведомлений по ленте нет **ни у кого**,
> включая МАКС. Требование «витрина конвертирует, а не спамит» осталось в силе в более
> сильной форме.

Тизер живёт **только в UI**. Push и Telegram по артефактным лотам получают исключительно
пользователи с `feed_access` — это обеспечено дважды и менять нельзя: продюсер (Фаза 5)
отбирает получателей по `feed_access`, оба консьюмера вызывают
`_load_user_gate(..., "feed_access", ...)`. Не-МАКС видит витрину, когда сам зашёл в
приложение, и не получает пушей — витрина конвертирует, а не спамит.

### Р1.2 Frontend — лента сигналов, переход и витрина (входит в Фазу 4)

> ⛔ **ОТМЕНЕНО Ревизией 4, кроме витрины.** Всё, что касается **полосы сигналов** —
> артефактные карточки, второй источник в `feedStore`/`useFeedPolling`, обводка и кикер
> «ЛЕНТА»/«ИЗБРАННОЕ», расширенное условие показа полосы (`FEED_PANEL_H` 54 → 62), переход
> `/app/feed?lot=…` с закреплённой строкой и состоянием «лот уже выкуплен» — **реализовано
> и удалено**. Полоса вернулась к прежнему поведению: только «Избранное», при пустом
> «Избранном» её нет. **В силе остаются:** витрина вместо глухого замка (в редакции §Р2.4)
> и снятие замка с пункта навбара «Лента».

#### Дата-слой: `store/feedStore.ts` + `hooks/useFeedPolling.ts`

Артефактные сигналы **не смешиваются** с watchlist-элементами в одном массиве — отдельные поля
стора, чтобы не ломать существующих потребителей (`Layout.tsx` читает `feedItems.length`,
`MonitoringPage` — `profitableItemIds`):
```ts
export interface ArtifactSignal { /* подмножество FeedLotOut: item_id, name_ru/name_en,
   icon_path, qlt, ptn, quality_name, lot_key, amount, buyout_per_unit, buyout_price,
   profit_total, profit_pct, risk, sales_per_day, supply_coverage_days, end_time */ }

artifactSignals: ArtifactSignal[]      // МАКС: до 5 строк из /feed/signals
teaserLot:       ArtifactSignal | null // не-МАКС: 1 строка из /feed/teaser
teaserTotal:     number                // total_profitable для CTA
feedAccess:      boolean               // has_access из ответа
loadArtifactSignals: () => Promise<void>
```
`loadArtifactSignals` сама выбирает источник: `feed_access` (из `authStore`) →
`/feed/signals?limit=5`, иначе → `/feed/teaser`. Ошибка → тихо оставляем предыдущее состояние
(как `loadWatchlistAndStats`).

`useFeedPolling` — **новый `useEffect` с интервалом 30 000 мс**, дословно тот же период, что у
существующего опроса лотов. Обязательные отличия:
- эффект **не зависит от `watchlistIds`** и работает при **пустом «Избранном»** — иначе тизер
  никогда не увидит новый пользователь, ради которого он и делается;
- существующие три интервала (5 мин / 30 с / 30 с) **не трогаем** —
  `docs/tasks/design-v5-implementation.md` §8;
- нагрузка на Stalcraft API не растёт: обе новые ручки читают свою БД/Redis.

#### Условие показа полосы — расширить (иначе тизер не появится)

Сейчас `GlobalFeed.tsx:96` и `MobileSignals.tsx:57` начинаются с
`if (!initialized || watchlist.length === 0) return null`, а `Layout.tsx:238` считает
`feedShown = initialized && watchlist.length > 0 && (…)`. **У пользователя с пустым
«Избранным» полосы нет вообще** — а это ровно тот, кому адресован тизер.

Новое условие (во всех трёх местах, формулировка одна):
```
показывать полосу, если initialized И (есть watchlist-сигналы ИЛИ есть артефактные сигналы/тизер)
```
`FEED_HEIGHT` и `--sc-top-offset` (`Layout.tsx:240`) пересчитываются по тому же флагу —
sticky-фильтры `/app/feed` и остальных страниц не должны разъехаться.

#### Визуальное отличие артефактных карточек

Артефактные сигналы идут **первыми** в треке (их мало, они новые), затем watchlist-карточки.
Отличие делается **двумя признаками сразу** — цвет/рамка сами по себе не проходят по
доступности (`AUDIT.md` A11Y-01/A11Y-02):
1. **Обводка** — `border: 1px solid ${tokens.goldLine}` вокруг карточки (у watchlist-карточек
   рамки нет, их разделяют 1px-щели трека). Токены только из `theme.ts`; **хекс/rgba вне темы
   = дефект**. Золотое свечение (`boxShadow`) **не использовать** — единственный золотой пик
   на экране зарезервирован за «Лучшим лотом» в сводке `/app/feed`.
2. **Текстовый кикер** в карточке: `ЛЕНТА` (Rajdhani, uppercase, `fs.f10`, `tokens.goldAccent`)
   против `ИЗБРАННОЕ` (`tokens.text2`) у watchlist-карточек.
3. Разный `aria-label`: «Лента: {предмет} {качество} +{заточка} — прибыль +{X} ₽, открыть в
   Ленте» против существующего «{предмет} — {N} выгодных лотов, открыть карточку».

Бейдж артефактной карточки показывает **прибыль**, а не счётчик: `+{profit_total} ₽`
(`tokens.success` / `successDim` / `successLine` — как существующий `.sig-badge`), под
названием — `{buyout_per_unit} ₽/шт · +{profit_pct} %`.

Для не-МАКС в полосе показывается **одна** карточка-тизер с тем же оформлением и кикером
`ЛЕНТА`; клик ведёт на `/app/feed` (там витрина + CTA).

#### Переход и подсветка лота

Клик по артефактной карточке:
```ts
navigate(`/app/feed?lot=${encodeURIComponent(lot_key)}`)
```
**Именно query-параметр**, не только `location.state`: переживает перезагрузку, шарится
ссылкой и заранее совместим с deep-link из push (`clients.openWindow` открывает URL, а не
router-state — открытый пункт `docs/NOTES.md:166`).

**Закрепление строки сверху, а не поиск нужной страницы пагинации.** Обоснование: срез живой,
сортировка по прибыли, лот живёт минуты — вычислять его страницу бессмысленно (к моменту
перехода он может оказаться на любой странице или исчезнуть). Поведение `FeedPage`:
1. `?lot=` есть → отдельный запрос `GET /feed/lots?lot_key=…` (одна строка).
2. Найдено → **закреплённая строка над таблицей**: та же вёрстка строки + рамка
   `tokens.goldLine` + кикер «из ленты сигналов» + крестик «открепить». Таблица остаётся на
   1-й странице с сортировкой по умолчанию — состояние детерминированное. Если та же строка
   попала в текущую выдачу — она подсвечивается тем же акцентом (дубль допустим и понятен:
   закреплённая строка = «то, по чему вы пришли»).
3. **Не найдено → честное состояние**, без молчаливого «ничего не произошло»:
   «Этот лот уже выкуплен или перестал быть выгодным — лоты в ленте живут минуты» + кнопка
   «Показать ленту». Обязательный кейс приёмки.
4. Открепление (крестик или смена фильтров) убирает `?lot=` из URL.

Мобильная версия (`MobileFeedPage`) — та же логика, закреплённая карточка над списком.

#### Витрина вместо глухого замка (не-МАКС)

> ⛔ **ОТМЕНЕНО Ревизией 2.** Принцип «витрина вместо глухого замка» сохранён, но строк не одна,
> а `feed_rows_limit` штук (1 / 10 / 20 по тарифу), и фильтры/сортировка не скрываются, а
> показываются закрытыми. Актуальное описание — §Р2.4.

`FeedPage` / `MobileFeedPage` при `feed_access === false && !is_admin`:
- сверху — **одна полная строка-витрина** из `/feed/teaser` (предмет, качество, заточка, цена
  за штуку и итог, прибыль ₽ и %, ликвидность). **Не размывать, не скрывать цифры**
  (уточнение 3): человек должен увидеть реальную ценность, а не силуэт;
- под ней — `ui/PageLock` с CTA на «Макс» и подписью «Показан 1 из {total_profitable}
  выгодных лотов, найденных прямо сейчас» (копирайт — §Фаза 6);
- фильтры, сортировка, пагинация, сводка и модалка — скрыты (нечего фильтровать);
- клик по строке-витрине **не открывает** `ArtifactModal` — ведёт на тот же CTA;
- пустая лента (`lot: null`) → `PageLock` без витрины, с обычным описанием раздела.

#### Навбар: пункт «Лента» перестаёт быть заблокированным

**Пересмотр §4.4 базового ТЗ.** Ранее предписывалось добавить `gateKey: 'feed'` в
`Layout.tsx` и замок в `MoreSheet.tsx`. С появлением витрины это противоречит цели: замок
прячет как раз ту страницу, которая должна конвертировать.

Новое поведение:
- `components/Layout.tsx` — пункт `{ label: 'Лента', to: '/app/feed' }` **без `gateKey`**;
  тип `GateKey` и `GATE_TOOLTIP` расширять **не нужно** (остаются `auction_access` /
  `market_radar` / `buy_sniper`);
- `components/mobile/MoreSheet.tsx` — строка `feed` **без `locked`/`lockTip`**;
- `components/mobile/MobileTabBar.tsx` — изменений нет (`/app/feed` остаётся в `SHEET_PATHS`);
- `store/authStore.ts` — `feed_access: boolean` в типе `User` **всё равно нужен**: по нему
  страница и стор выбирают между полной лентой и витриной, а `SettingsPage` — доступность
  фидовых тумблеров.

### Р1.3 Дополнения к тестам (`backend/tests/`)

`backend/tests/test_feed_teaser.py`:

> ⛔ **Кейс «выбор строки» ОТМЕНЁН Ревизией 2** — сортировка по `buyout_price ASC` заменена
> отбором по медианной ценовой полосе. Актуальный набор тестов витрины — §Р2.6. Кейсы
> «персональный порог», «нет гейта», «cache-read-only» остаются в силе.

- ~~**выбор строки**: выбирается минимальный `buyout_price`, а **не** минимальный
  `buyout_per_unit` — кейс, где это разные лоты (дорогой per-unit ×1 против дешёвого
  per-unit ×50);~~
- **персональный порог**: лот с `margin_adj_pct` ниже `min_profit_margin_percent`
  пользователя не попадает в витрину, даже если проходит по цене;
- **нет гейта**: селектор строится одинаково для `base` и для `advanced_max`, `_require_access`
  не участвует;
- **cache-read-only**: при подменённых (мок) `stalcraft_client` и пересчёте статистики ни один
  из них не вызывается; пустая `feed_lots` → `lot=None`, `total_profitable=0`, без исключений;
- `total_profitable` считается по тому же порогу, что и выбор строки.

~~`backend/tests/test_feed_signals.py`~~ — ⛔ **ОТМЕНЕНО Ревизией 4** (файл удалён вместе с
ручкой):
- ~~`limit` клампится в 1..10, дефолт 5; порядок — `profit_total` убыв.;~~
- ~~ключ Redis-кэша включает порог пользователя.~~

`backend/tests/test_feed_budget.py` ~~(расширить блок уведомлений Фазы 5)~~ — ⛔ **блок
уведомлений ОТМЕНЁН Ревизией 4** (тесты получателей удалены; остальные кейсы бюджета,
очереди и парковки — в силе):
- ~~**не-МАКС не получает `feed_lot`**: пользователь с `tier="advanced_plus"` и включёнными
  `feed_notify_push`/`feed_notify_telegram` **не попадает** в список получателей;~~
- ~~админ (`is_admin=True`, tier `base`) — попадает (ADMIN_LIMITS).~~

Фронтенд-тестов в проекте нет (vitest не подключён) — не заводить ради этой ревизии;
поведение ленты сигналов и подсветки проверяет `qa-tester`.

### Р1.4 Критерии приёмки ревизии

> ⛔ **Частично ОТМЕНЕНО Ревизией 4.** Не проверять и не считать долгом: всё про
> `/feed/signals`, `?lot=`/закреплённую строку, «лот уже выкуплен», артефактные карточки
> полосы и уведомления `feed_lot`. Пункт про `/feed/teaser` был отменён ещё Ревизией 2.
> **Остаются в силе:** пункт навбара без замка, витрина по тарифу (в редакции §Р2.7),
> отсутствие хексов вне `theme.ts`, неизменные интервалы поллинга (но **без** нового вызова
> раз в 30 с). Ни один критерий на живом приложении после сужения не подтверждён.

**Backend**
- [ ] ⛔ ~~`GET /feed/signals` — 403 для не-МАКС; для МАКС ≤ `limit` строк, отсортированных по `profit_total` убыв.; в ответе нет `total_count`.~~
- [ ] `GET /feed/teaser` — **200 для `base`/`advanced`/`advanced_plus`** и для МАКС; ровно 1 лот с минимальным `buyout_price` среди проходящих личный порог; `has_access` соответствует тарифу.
- [ ] `/feed/teaser` при пустой `feed_lots` возвращает `lot: null` и не порождает ни одного обращения к Stalcraft API (расход по `GET /admin/stats` не меняется).
- [ ] Повторные вызовы обеих ручек в пределах 30 с не дают новых SQL-запросов (Redis-кэш).
- [ ] ⛔ ~~`GET /feed/lots?lot_key=…` возвращает 0 или 1 строку.~~
- [ ] ⛔ ~~Пользователь `advanced_plus` с включёнными фидовыми тумблерами не получает ни push, ни Telegram по `feed_lot`.~~

**Frontend**
- [ ] ⛔ ~~Полоса сигналов отображается у пользователя с пустым «Избранным»~~ — откачено: при пустом «Избранном» полосы нет.
- [ ] ⛔ ~~Артефактная карточка отличается обводкой и текстовым кикером.~~
- [ ] ⛔ ~~Клик по артефактной карточке ведёт на `/app/feed?lot=…`; строка закреплена сверху с подсветкой.~~
- [ ] ⛔ ~~Лот, исчезнувший из среза, даёт честное сообщение «уже выкуплен…».~~
- [ ] Не-МАКС на `/app/feed`: **полная нерасплывчатая строка** + `PageLock` с CTA и счётчиком «1 из N»; фильтры/пагинация/сводка скрыты; клик по строке ведёт на CTA, а не в модалку.
- [ ] Пункт «Лента» в навбаре и в шите «Ещё» **не заблокирован ни для одной роли**.
- [ ] Мобильная лента сигналов (`MobileSignals`) повторяет поведение десктопной; `MobileFeedPage` показывает витрину.
- [ ] Ни одного хекса/rgba вне `theme.ts`; `npm run build` без ошибок.
- [ ] В DevTools Network за 2 минуты: интервалы существующих опросов не изменились (5 мин / 30 с), добавился ровно один новый вызов раз в 30 с.

### Р1.5 Что ревизия меняет в базовом ТЗ

| Место | Было | Стало |
|---|---|---|
| §2.2 API | 3 ручки `/feed/*` | + `GET /feed/signals` (МАКС, лёгкая), + `GET /feed/teaser` (**без гейта**), + фильтр `lot_key` в `/feed/lots` — ⛔ **всё три ОТМЕНЕНО** (teaser — Ревизией 2, signals и `lot_key` — Ревизией 4). Итог: 4 ручки, четвёртая — `GET /feed/variant/{item_id}` (§Р3.1) |
| §4.4 Навигация и гейт | `gateKey: 'feed'` + замок в навбаре и шите | Замка нет ни для одной роли; гейт живёт внутри страницы (витрина + `PageLock`) |
| §4.1 `FeedPage` | Не-МАКС → сплошной `PageLock` | Не-МАКС → строка-витрина + `PageLock`; для всех — закреплённая строка по `?lot=` |
| Лента сигналов | Не затрагивалась | ⛔ **ОТМЕНЕНО Ревизией 4** — ~~второй источник элементов + визуальное различие + переход с подсветкой~~; полоса снова не затрагивается |
| Индексы `feed_lots` | 7 индексов | + `ix_feed_lots_buyout_price` (в `0038`, либо `0039` — см. Р1.1) |
| Фаза 3 (прототип) | Таблица + модалка | + состояния «закреплённая строка», «лот выкуплен», «витрина не-МАКС», артефактная карточка в полосе сигналов |

---

## Ревизия 2: лимит строк по тарифам вместо бинарного доступа

> Добавлено пользователем после Ревизии 1. **Отменяет** правило «один самый дешёвый лот» и
> заменяет бинарный доступ числовым лимитом. Всё остальное из Ревизии 1 (лента сигналов,
> обводка + кикер, переход на `?lot=` с закреплённой строкой, отсутствие пушей у не-МАКС,
> снятие замка с пункта навбара) — **в силе**.

**Дословно от пользователя:** «Давай так, ещё по каждой роли будет разное количество предметов,
которые отображаются. Роль базовая — 1 предмет, следующая — 10 предметов, потом 20 предметов,
в максе — все предметы.»

**Подтверждённые уточнения:**
1. Единица лимита — **строки-лоты**, а не разные артефакты. 10 строк = 10 лотов, даже если
   часть из них — один артефакт в разных лотах.
2. Отбор строк витрины — **средняя ценовая полоса, внутри неё топ по прибыли** (не самые
   дорогие и не самые дешёвые). Отменяет правило «самый дешёвый» из Ревизии 1.
3. Витрина **фиксированная**: сортировка и фильтры лимитированным тарифам недоступны —
   показываются, но закрыты замком. Иначе лимит обходится перебором сортировок.

### Р2.1 Модель доступа: `feed_rows_limit`

`backend/app/core/tiers.py` — **добавить** поле в `TierLimits` (по образцу `watchlist_limit`):

| Тариф | `feed_rows_limit` | `feed_access` | Что это значит |
|---|---|---|---|
| `base` | `1` | `False` | витрина из 1 строки |
| `advanced` | `10` | `False` | витрина из 10 строк |
| `advanced_plus` | `20` | `False` | витрина из 20 строк |
| `advanced_max` | `None` | `True` | полная лента без ограничений |
| `ADMIN_LIMITS` | `None` | `True` | полная лента |

**`feed_access` НЕ удаляем** — сужаем его смысл до «полная лента + право на уведомления»,
и инвариант `feed_access == (feed_rows_limit is None)`. Так реализованный в Фазе 1 гейт
уведомлений (`_load_user_gate(..., "feed_access", ...)`, Фаза 5) и поле в `/auth/me` остаются
рабочими без переписывания — Ревизия 2 сводится к **добавлению** поля, а не к замене.
`None` = без ограничений, ровно как `watchlist_limit=None` у админа.

Хелпер рядом с `effective_watchlist_limit`:

```python
def effective_feed_rows_limit(user) -> int | None:
    """None = без ограничений. Админ и МАКС видят ленту целиком."""
```

### Р2.2 Правило отбора строк витрины

Для тарифов с лимитом (`feed_rows_limit is not None`):

1. **Выборка**: лоты, выгодные **по порогу этого пользователя** —
   `margin_adj_pct >= user.min_profit_margin_percent` (та же материализованная колонка, что и
   в основном `/feed/lots`, см. §2.1).
2. **Отсечение ценовых хвостов**: оставляем лоты, у которых `buyout_price` (полная сумма к
   оплате) лежит между 25-м и 75-м перцентилем этой выборки — `percentile_cont`.
3. **Ранжирование внутри полосы**: `ORDER BY profit_total DESC, id`, `LIMIT feed_rows_limit`.

Смысл: витрина одновременно доступна по деньгам (нет лотов за миллионы, которые новичок не
купит) и остаётся про заработок (нет пограничного шума у самого дна). Чистая медиана по цене
без ранжирования по прибыли дала бы случайный по доходности срез и не продавала бы тариф.

**Деградация на малой выборке.** При `count(*) < FEED_BAND_MIN_ROWS` (**= 4**) перцентили
вырождаются (на 1–3 строках 25-й и 75-й перцентиль схлопываются и могут отсечь всё).
В этом случае полоса **не применяется** — берём простой топ-N по `profit_total`.
Обязательный тест-кейс.

```sql
WITH prof AS (
    SELECT * FROM feed_lots WHERE margin_adj_pct >= :user_min AND region = :region
), band AS (
    SELECT count(*) AS n,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY buyout_price) AS lo,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY buyout_price) AS hi
    FROM prof
)
SELECT p.* FROM prof p, band b
WHERE b.n < :FEED_BAND_MIN_ROWS
   OR p.buyout_price BETWEEN b.lo AND b.hi
ORDER BY p.profit_total DESC, p.id
LIMIT :rows_limit;
```

`total_available` для CTA = `band.n` (**вся** выгодная выборка при пороге пользователя, не
только полоса) — честный ответ на «сколько я не вижу».

**Redis-кэш TTL 30 с**, ключ `feed:showcase:{region}:{int(user_min)}:{rows_limit}` — общий для
всех пользователей с одинаковыми порогом и тарифом.

### Р2.3 Эндпоинты: одна ручка вместо двух путей к одним данным

**Решение: `GET /feed/lots` перестаёт быть гейтированной и сама ветвится по тарифу.**
`GET /feed/teaser` из Ревизии 1 **не реализуется** — иначе к одним и тем же данным вело бы два
пути с разными правилами, и они неизбежно разъехались бы.

| Ручка | Гейт | Поведение |
|---|---|---|
| `GET /feed/lots` | нет | `feed_rows_limit is None` → полная лента (фильтры, сортировка, пагинация 25/50/100, `total_count`). Иначе → витрина по §Р2.2, параметры `sort` / фильтры / `page` / `page_size` **игнорируются** |
| ~~`GET /feed/signals`~~ | — | ⛔ **ОТМЕНЕНО Ревизией 4**: ~~МАКС → топ-5; лимитированные → префикс витрины~~ — ручка удалена, лента в полосу сигналов не транслируется |
| `GET /feed/summary` | `feed_access` | сводка 24 ч — только полная лента |
| `GET /feed/filters` | `feed_access` | счётчики фильтров — фильтров у витрины нет |
| `GET /feed/variant/{item_id}` | нет | **Ревизия 3 (§Р3.1):** статистика варианта для карточки артефакта, ответ — `MonitoringItemResponse` |
| ~~`GET /feed/teaser`~~ | — | ⛔ отменена Ревизией 2, не реализовывать |

**Требование безопасности сохраняется и распространяется на обе негейтированные ручки**
(урок `get_watchlist_suggestions`, `docs/BUSINESS_LOGIC.md` §17): только чтение готовой
`feed_lots` + join `master_items`; **никаких** вызовов `stalcraft_client`, `variant_stats`,
`market_stats`, `api_cache.get_or_fetch_*`; на пустой таблице — пустой ответ без пересчёта.

Дополнения к схеме ответа `/feed/lots`:

```python
rows_limit:      int | None   # None = без ограничений
total_available: int          # всего выгодных лотов при пороге пользователя
showcase:        bool         # True = выдача урезана и зафиксирована (sort/фильтры проигнорированы)
```

**Индекс.** Отбор идёт по `margin_adj_pct` + `profit_total DESC` — покрывается существующими
индексами `0038`. `ix_feed_lots_buyout_price` из Ревизии 1 (Р1.1) **больше не нужен**:
`buyout_price` участвует только в `percentile_cont` по всей выборке и в `BETWEEN`, где индекс
не даёт выигрыша на таблице в сотни–тысячи строк. Отдельную миграцию `0039` **не заводить**.

### Р2.4 Frontend: витрина по тарифу

Отменяет §Р1.2 «Витрина вместо глухого замка». `FeedPage` / `MobileFeedPage` при
`showcase === true`:

- **`rows_limit` строк обычной таблицы** — полная вёрстка, все колонки, **без размытия**
  (уточнение 3 Ревизии 1 в силе: человек должен видеть реальную ценность);
- панель фильтров и заголовки сортировки **отображаются, но закрыты** `ui/TierGate` —
  замок на элементе управления сам по себе продаёт тариф лучше, чем его отсутствие;
- под таблицей — `ui/PageLock` с CTA «Макс» и честной строкой
  «Показано {rows_limit} из {total_available} выгодных лотов»;
- пагинация скрыта (страница одна по построению);
- сводка 24 ч и `ArtifactModal` скрыты; клик по строке ведёт на CTA;
- `total_available === 0` → `PageLock` без таблицы, с обычным описанием раздела.

`store/authStore.ts` — в тип `User` добавить `feed_rows_limit: number | null` рядом с
существующим `feed_access`.

⛔ **ОТМЕНЕНО Ревизией 4:** ~~полоса сигналов (`GlobalFeed` / `MobileSignals`) у
лимитированных тарифов показывает `min(5, feed_rows_limit)` артефактных карточек (обводка +
кикер `ЛЕНТА`)~~ — артефактных карточек в полосе нет ни у одного тарифа.

### Р2.5 Правки к уже реализованной Фазе 1

Фаза 1 закрыта, но два файла придётся тронуть — **это добавление, не переписывание**:

- `backend/app/core/tiers.py` — поле `feed_rows_limit` в `TierLimits`, значения по таблице
  Р2.1, хелпер `effective_feed_rows_limit`. `feed_access` **оставить как есть**.
- `backend/app/api/v1/endpoints/auth.py` — отдать `feed_rows_limit` в `/auth/me` рядом с
  `feed_access`.

Миграцию `0038`, `feed_collector.py` и модели Ревизия 2 **не затрагивает**.

### Р2.6 Тесты

`backend/tests/test_feed_showcase.py` (заменяет отменённый `test_feed_teaser.py`):

- **лимит по тарифам**: `base` → 1 строка, `advanced` → 10, `advanced_plus` → 20,
  `advanced_max` → без обрезки; админ на тарифе `base` → без обрезки;
- **игнорирование параметров**: у лимитированного тарифа `sort=buyout_per_unit&order=asc`,
  фильтры по качеству и `page_size=100` **не меняют** выдачу; `showcase=True`;
- **ценовая полоса**: на выборке с явными хвостами самый дорогой и самый дешёвый лоты в
  витрину не попадают, а самый прибыльный из середины — попадает;
- **деградация**: при 3 выгодных лотах полоса не применяется, отдаётся топ-N по прибыли;
- **персональный порог**: лот ниже `min_profit_margin_percent` не попадает в витрину ни при
  какой цене; `total_available` считается по тому же порогу;
- **нет гейта**: `/feed/lots` отвечает 200 для `base`;
- **cache-read-only**: при мокнутых `stalcraft_client` и пересчёте статистики ни один не
  вызывается; пустая `feed_lots` → пустой список, `total_available=0`, без исключений;
- ⛔ ~~**согласованность**: строки `/feed/signals` для лимитированного тарифа — префикс набора
  `/feed/lots` того же пользователя~~ — **ОТМЕНЕНО Ревизией 4** (ручки нет).

⛔ **ОТМЕНЕНО Ревизией 4:** ~~остаются в силе из Р1.3 тесты `/feed/signals` и «не-МАКС не
получает `feed_lot`»~~ — оба набора удалены вместе с ручкой и уведомлениями.

### Р2.7 Критерии приёмки ревизии

- [ ] `GET /feed/lots` отвечает **200 на всех тарифах**; `rows_limit` / `total_available` / `showcase` соответствуют тарифу.
- [ ] `base` видит ровно 1 строку, `advanced` — 10, `advanced_plus` — 20, `advanced_max` — полную ленту с пагинацией.
- [ ] У лимитированного тарифа смена `sort`, фильтров и `page_size` **не меняет** выдачу (проверить прямыми запросами к API, не только через UI).
- [ ] Самый дорогой и самый дешёвый выгодные лоты в витрину не попадают, пока выгодных лотов ≥ 4.
- [ ] При 1–3 выгодных лотах витрина не пустеет (деградация в топ-N).
- [ ] ⛔ ~~Строки полосы сигналов совпадают с первыми строками витрины на том же аккаунте.~~ — **ОТМЕНЕНО Ревизией 4**.
- [ ] `/feed/lots` на пустой `feed_lots` не порождает обращений к Stalcraft API (расход по `GET /admin/stats` не меняется).
- [ ] На витрине фильтры и сортировка **видны и закрыты замком**, строки не размыты, есть строка «Показано N из M» и CTA на «Макс».
- [ ] Пункт «Лента» не заблокирован ни для одной роли (в силе из Р1.4).
- [ ] ⛔ ~~`advanced_plus` с включёнными фидовыми тумблерами не получает ни push, ни Telegram.~~ — **ОТМЕНЕНО Ревизией 4** (уведомлений нет ни у кого).

> После сужения объёма ни один из оставшихся критериев этого раздела на живом приложении
> **не подтверждён** — браузерное QA не прогонялось.

### Р2.8 Что Ревизия 2 отменяет

| Место | Было (Ревизия 1) | Стало (Ревизия 2) |
|---|---|---|
| Модель доступа | `feed_access: bool`, всё или ничего | + `feed_rows_limit: int \| None` (1 / 10 / 20 / None); `feed_access` = «полная лента + уведомления» → **с Ревизии 4 просто «полная лента»** |
| Отбор витрины | 1 самый дешёвый по `buyout_price ASC` | `feed_rows_limit` строк: ценовая полоса 25–75 перцентиль, внутри топ по `profit_total` |
| `GET /feed/teaser` | отдельная негейтированная ручка | отменена; лимит применяется внутри `GET /feed/lots`, которая становится негейтированной |
| `GET /feed/lots` | гейт `feed_access` | без гейта, ветвится по тарифу |
| Фильтры/сортировка у не-МАКС | скрыты | видны, закрыты `TierGate` |
| `ix_feed_lots_buyout_price` | добавить (в `0038` или `0039`) | не нужен, не заводить |
| `test_feed_teaser.py` | тесты выбора самого дешёвого | `test_feed_showcase.py`, §Р2.6 |

---

## Ревизия 3: исправления повторного QA (2026-08-04)

Дефекты P2-1…P3-2 повторного прогона `qa-tester`. Ревизия ничего не отменяет из
Ревизий 1–2, а фиксирует, **откуда карточка артефакта берёт статистику** и **по какой
величине сортируется колонка «₽/час»**.

### Р3.1 Источник статистики карточки: `artifact_variant_stats`, а не `/monitoring/item`

**Было.** `useLotStats` тянул `GET /monitoring/item/{item_id}`. Ручка отдаёт 404, если нет
ни `MarketStatistics`, ни `CollectedData` с `user_id IS NULL`, — а эти таблицы наполняет
watchlist-коллектор, тогда как лента по определению про предметы **вне** «Избранного».
Замер QA: 56 из 66 предметов ленты (223 из 377 строк, 59 %) давали пустую карточку.
Вторая беда того же корня: `/monitoring/item` считает по **предмету** целиком, лента — по
**варианту** «качество × заточка», из-за чего один лот показывал `est_sell_hours` 2.0 ч в
карточке и 0.3 ч в ленте, а прибыль расходилась вплоть до смены знака (+17 486 ₽ против
−1 799 ₽).

**Стало.** `GET /feed/variant/{item_id}?qlt=&ptn=[&region=]`:

- отдаёт **`MonitoringItemResponse`** — вторую схему под карточку не заводим, карточка
  (`LotStatCard` / `MobileLotStatCard`) одна на «Избранное» и «Ленту»;
- читает **одну строку `artifact_variant_stats`** по уникальному индексу
  `uq_artifact_variant`. Ни пересчёта, ни `stalcraft_client` — те же правила
  негейтированной ручки, что у `/feed/lots` (§Р2.3);
- **без гейта `feed_access`**: витрину лимитированного тарифа можно открыть карточкой.
  Тарифные окна режет тот же `_mask_stats_windows`, что и в `/monitoring/item`;
- формулы не форкаются: все значения уже посчитаны `calculate_artifact_variant_stats`
  теми же `pricing.*`, которыми лента скорит лоты. **`sell_options` карточки — ровно тот
  список, по которому `evaluate_lot_profit` оценивал лоты этого варианта**, поэтому цифры
  совпадают по построению, а не по совпадению;
- чего у варианта нет и приходит `null`: `best_sell_hour`/`best_buy_hour`/`weekend_bonus`
  (почасовая раскладка считается по предмету целиком), `price_volatility_30d` (вариант
  меряет волатильность за 7 д, `classify_risk` работает от неё же),
  `sell_options_now`/`current_min_price` (режим «Сейчас» строится от снапшота
  `collected_data`, которого у предметов вне «Избранного» нет — карточка честно показывает
  недельные цены). Карточка эти блоки просто не рисует.

**Фронт:** `useLotStats` при `signalsSource='feed'` запрашивает `/feed/variant`, при
`'watchlist'` — как раньше. Плюс поправка на размер пачки в what-if колонках «Выгодных
лотов»: множитель восстанавливается из самой оценки бэкенда
(`sell_price_used / цена тира «Быстро»`), а для тира, которым бэкенд оценивал лот
(`tier_used`), берётся его же число — второй формулы не заводим. Только для ленты: у
watchlist-сигналов опции карточки и оценка сигналов считаются на разных выборках.

`GET /monitoring/sales-chart` не трогали: он фильтрует `sales_history` по
`quality_filter`/`enchant_filter` и watchlist не требует — графики работали и до фикса.

### Р3.2 «₽/час»: сортировка идёт по показанной величине

В таблице напечатано `profit_total / est_sell_hours` (прибыль **всего лота** в час), а
сортировка шла по колонке `feed_lots.profit_per_hour`, которую `evaluate_lot_profit`
считает **на единицу**: при `amount > 1` величины расходятся ровно в `amount` раз, и
выдача переворачивалась (строка с 58 287 ₽/ч стояла ниже строки с 14 946).

`evaluate_lot_profit` не меняли. В `feed_lots` добавлена материализованная колонка
**`profit_per_hour_total`** = `profit_total / est_sell_hours` (та же формула, что печатает
UI), `_SORT_COLUMNS["profit_per_hour"]` указывает на неё, а `FeedLotOut` отдаёт её наружу —
клиентский расчёт остаётся фоллбеком для строк из кэша витрины, записанных до появления
поля. Колонка дописана в **`0038`** (миграция применена только на локальном стенде).

### Р3.3 Форма всплеска расхода API (реальные 429)

Средний расход ~168 ед/мин из 400 (42 %) — проблема не в объёме, а в том, что задачи
стартуют в одну секунду. Решение пользователя: **разводить расписание, общий rate limiter
не трогать** (`core/rate_limiter.py` не изменён, `FEED_BUDGET_UNITS_PER_MIN` не понижен).

- `collect-artifact-lots` → `crontab(minute="*")` вместо `timedelta(seconds=60)`: фаза
  привязана к стенным часам, а не к моменту старта beat (при рестарте контейнеров цикл
  ленты выпускался ровно вместе с watchlist-тиком и `collect_emission`);
- джиттер старта внутри задач: `FEED_CYCLE_JITTER_SEC = 10` (лента),
  `FEED_HISTORY_JITTER_SEC = 30` (история). Сон идёт **до** взятия лока;
- `HISTORY_ITEM_DELAY = 2.0` с между предметами в `collect_artifact_history`: 103 артефакта
  укладывались в минуту и давали 206 ед разом поверх ленты и watchlist. Теперь обход идёт
  ~4 минуты (~52 ед/мин) при том же часовом объёме.

Предохранитель `FEED_RATE_GUARD_UNITS` проверяется **до первого предмета**, поэтому цикл,
пришедшийся на чужой всплеск, обрывается, не начав тратить лимит.

### Р3.4 Парковка отказавшего предмета

`note_item_failure` писал в `feed:scan:last` то же значение, что и успешный обход
(`cycle_started_at`), поэтому `order_queue` (сортировка по времени ASC) отставлял
припаркованный предмет всего на один оборот очереди — QA замерил повторный опрос через
3 минуты вместо 900 с, TTL не доживал до истечения. Теперь пишется **будущая метка**
`cycle_started_at + FEED_ITEM_PARK_TTL`. Побочный (желаемый) эффект: припаркованный предмет
считается «покрытым» в `_finish_sweep_if_complete` и не блокирует закрытие круга.

### Р3.5 Индекс по `buyout_price` — не нужен (подтверждено планом запроса)

Ревизия 2 (§Р2.8) уже отменяла `ix_feed_lots_buyout_price` вместе с правилом «самый дешёвый
лот». Повторная проверка после появления перцентильной выборки — `EXPLAIN (ANALYZE, BUFFERS)`
на локальном стенде (299 строк `feed_lots`):

- перцентили: `Aggregate → Seq Scan on feed_lots (rows=61, 0.14 ms, shared hit=24)`.
  `percentile_cont` — ordered-set-агрегат: ему нужны **все** значения выборки, индекс по
  `buyout_price` для него бесполезен по определению;
- полоса + топ-N: `Limit → Incremental Sort → Nested Loop → Index Scan using
  ix_feed_lots_profit_total` (0.16 ms). `buyout_price BETWEEN` работает как **фильтр** внутри
  скана по индексу сортировки; отдельный индекс планировщик применить не может, не потеряв
  готовый порядок.

**Решение: индекс не заводить.** Таблица порядка сотен–тысяч строк, оба запроса < 0.2 мс.
Пересмотреть, только если `feed_lots` вырастет на порядки (мультирегион).

### Р3.6 Тесты Ревизии 3

`backend/tests/test_feed_card_parity.py` (новый):

- карточка предмета **вне** «Избранного» заполнена (медианы, объёмы, опора, `sell_options`,
  `batch_stats`, риск) и стоит **один** SELECT;
- источник — только `ArtifactVariantStats` (проверка по именам в AST, не по тексту);
- гейта `feed_access` нет; окна режутся по тарифу (`base` → без `7d`/`30d`);
- нет строки варианта → 404;
- `est_sell_hours` строки ленты == `estimated_hours` тира «Быстро» карточки;
- **паритет прибыли на лоте `amount = 7` с батч-поправкой**: расчёт «как было» даёт
  отрицательное число, расчёт с восстановленным множителем совпадает с
  `profit_per_unit` / `profit_total` строки (±1 ₽ на округлении);
- у лота из одной штуки множитель ровно 1.

`test_feed_scoring.py`: `profit_per_hour_total` равен показанному числу и `profit_per_hour ×
amount`; `_SORT_COLUMNS["profit_per_hour"]` указывает на `profit_per_hour_total`; порядок по
новой колонке совпадает с порядком по показанной величине, а по старой — нет; без прогноза
времени продажи величина `None`, а не деление на ноль.

`test_feed_budget.py`: метка парковки равна `cycle_started_at + FEED_ITEM_PARK_TTL`;
припаркованный предмет стоит в очереди **после** обойдённых в этом цикле.

Прогон: `cd backend && python -m pytest tests -q` → **208 passed** (было 192).

### Р3.7 Что осталось сделать руками

Миграция `0038` уже применена на локальном стенде, поэтому колонки `profit_per_hour_total`
там нет. `downgrade` для `0038` **уничтожает глобальную историю продаж** — вместо него:

```sql
ALTER TABLE feed_lots ADD COLUMN profit_per_hour_total numeric(14,2);
```

На проде `0038` не применялась — там достаточно обычного `alembic upgrade head`.
Старые строки `feed_lots` получат значение при первом же цикле сбора (апсерт обновляет все
колонки), до этого сортировка «₽/час» ставит их в конец (`NULLS LAST`).

---

## Ревизия 4: сужение объёма — лента без уведомлений и без трансляции в сигналы (2026-08-04)

> **Отменяет** реализованные Фазу 5 целиком, часть Ревизии 1 (`/feed/signals`, артефактные
> карточки полосы, переход `?lot=` с закреплённой строкой, фильтр `lot_key`) и три колонки
> `user_settings` из Фазы 1. Всё остальное (сбор, скоринг, `/feed/lots`, витрина по тарифам
> Ревизии 2, карточка варианта Ревизии 3, копирайт Фазы 6) — **в силе**.

**Дословно от пользователя:** «Что мне не нравится и что я считаю, что надо убрать:
1. Трансляция ленты в сигнал. 2. Пуш уведомления по лотам в ленте. Лента должна быть
отдельным разделом, мониторинг за которым надо производить напрямую с портала.»

**Уточнение (подтверждено):** трансляция **«Избранного»** в сигналы **остаётся** — полоса
сигналов работает по watchlist ровно как до фичи. Убрана только лента.

### Р4.1 Что отменено и удалено из кода

| Что | Где было | Статус |
|---|---|---|
| Тип события `feed_lot`, продюсер | §Фаза 5, `tasks/feed_collector.py`: `FeedRecipient`, `feed_recipient`, `select_new_lots_for_user`, `feed_lot_event`, `publish_new_lot_events`, `FEED_NOTIFY_MAX_PER_CYCLE` | удалено |
| Обработчики уведомлений | `push_service/consumer.py` (`render_feed_lot`, `handle_feed_lot`), `telegram_bot/bot.py` (`build_feed_message`, `handle_feed_lot`), записи в `HANDLERS` | удалено |
| Параметр `setting_attr` в `_load_user_gate` | оба консьюмера | **сигнатура откачена** к прежней |
| Дедуп-ключи `feed_push_sent:*` / `feed_tg_sent:*` | Redis | не создаются |
| `GET /feed/signals` + `FeedSignalsResponse` + кэш `feed:signals:*` + `showcase_signals_limit` | §Р1.1, `endpoints/feed.py` | удалено |
| Параметр `lot_key` в `GET /feed/lots`, `pinned_query`, `_pinned_response` | §Р1.1 «Фильтр `lot_key`», §Фаза 2 | удалено. Вместе с ним исчезла **поверхность дефекта H1** security-ревью |
| Колонки `user_settings`: `feed_notify_push`, `feed_notify_telegram`, `feed_min_profit_percent` | §1.1, §1.2, `endpoints/settings.py` | убраны из миграции `0038`, моделей и схем `/settings` |
| Артефактные карточки полосы сигналов, кикер «ИЗБРАННОЕ», переход `/app/feed?lot=…&item=…` | §Р1.2 | удалено; `FEED_PANEL_H` 62 → **54**, `signalsVisible` откачен (пустое «Избранное» → полосы нет) |
| `RETURNING (xmax = 0)` в `upsert_feed_rows` и счётчик `rows_new` в логе цикла | §Фаза 1 | удалено — существовали только ради уведомлений |

### Р4.2 Что осталось

- Раздел `/app/feed` и **четыре** ручки: `GET /feed/lots`, `GET /feed/variant/{item_id}`
  (обе **без гейта**, первая ветвится по тарифу), `GET /feed/summary`, `GET /feed/filters`
  (обе за `feed_access`).
- Витрина по тарифам (`feed_rows_limit`: base 1 / advanced 10 / advanced_plus 20 /
  advanced_max и админ — без ограничений), правило отбора §Р2.2 без изменений: выгодные по
  порогу → ценовая полоса 25–75 перцентиля `buyout_price` → топ-N по `profit_total`; при
  `< FEED_BAND_MIN_ROWS = 4` строках полоса не применяется. Витрина фиксированная:
  `sort`, фильтры, `page_size` игнорируются. Порог квантуется вниз шагом
  `FEED_SHOWCASE_MIN_STEP = 5` (`showcase_threshold`).
- **Смысл `feed_access` сужен до «полная лента»** (плюс гейт `/feed/summary` и
  `/feed/filters`). Прав на уведомления за ним больше нет; инвариант
  `feed_access == (feed_rows_limit is None)` сохраняется.
- Всё из Ревизии 3: карточка из `artifact_variant_stats`, `profit_per_hour_total`,
  разведённое расписание, парковка отказавшего предмета.

### Р4.3 Критерии приёмки ревизии

- [ ] В коде нет ни одного упоминания `feed_lot`, `feed_notify_push`, `feed_notify_telegram`,
      `feed_min_profit_percent`, `/feed/signals`, `lot_key=` как параметра запроса.
- [ ] Цикл `collect_artifact_lots` не открывает канал `push_broker` и ничего не публикует.
- [ ] Полоса сигналов при пустом «Избранном» не показывается; артефактных карточек в ней нет.
- [ ] `GET /feed/signals` → 404 (маршрута нет); `GET /feed/lots?lot_key=…` игнорирует параметр
      и отдаёт обычную выдачу.
- [ ] `GET /settings` не содержит фидовых полей; `PATCH` с ними — не падает и их не пишет.
- [ ] Уведомления «Избранного» (`profitable_lot`, `buy_alert`, `emission`) работают как раньше.
- [ ] Бэкенд `python -m pytest tests -q` → **172 passed**; фронт `tsc --noEmit` + `vite build`
      → EXIT=0. ✅ (проверено 2026-08-04)

### Р4.4 Побочное изменение за пределами фичи

`get_tier_limits` / `effective_feed_rows_limit` / `effective_watchlist_limit` берут тариф через
`current_tier(user)` — с учётом истёкшего `tier_expires_at` (`is_tier_expired`). Правка пришла
из security-ревью ленты (M5), но действует на **все** фичи: фоновые консьюмеры читают
пользователя из БД мимо `get_current_user`, поэтому раньше `profitable_lot` и `buy_alert`
продолжали уходить по истёкшей подписке до ближайшего входа пользователя или ночного
`sweep_expired_tiers`. Зафиксировано в `docs/BUSINESS_LOGIC.md` §17 и `docs/SERVICES.md`.

### Р4.5 Прототип `design/v5/app/feed.html` — расхождение с реализацией

Прототип не правился (вне объёма `tech-writer`). Разошлись: закреплённая строка
(`tr.pinhd` / `tr.pinned` / `tr.pinsep`, демо-кнопки `#d-pin` / `#d-miss`), состояние
«Лот уже выкуплен» (`tr.pinmiss`), артефактная карточка полосы сигналов
(`.sig.art` / `.sig-kick` / `.sig-kick.art` в `assets/base.css:671-675`). Пункт заведён в
`docs/NOTES.md` для `designer`.

---

## Калибровка после первого прогона (обязательный шаг между Фазой 2 и Фазой 3)

Замер `sum(lots_total)` по артефактам на проде выполнить **не удалось** (доступ заблокирован),
поэтому длительность цикла спроектирована как **следствие бюджета**, а не входной параметр.
Задача обязана деградировать в более длинный цикл, а не превышать бюджет.

**Метрики, которые надо снять (первый час работы на проде):**

| Метрика | Откуда | Норма |
|---|---|---|
| `units` за цикл | лог `feed cycle #…` | ≤ 200, без систематического упора в потолок |
| `full sweep` — время полного круга | лог `feed sweep: полный круг за Yс` | цель ≤ 120 с, приемлемо ≤ 240 с |
| `deferred` — сколько предметов не влезло | лог цикла | стремится к 0 на горячих |
| `guard_trips` | лог цикла | 0; > 0 систематически = бюджет великоват |
| Пиковый суммарный расход | `GET /admin/stats` (`requests_current_minute`) раз в минуту | ≤ 340 |
| Длина цикла «Избранного» | лог `Watchlist cycle for … since previous successful check` до/после | рост выше 90 с = лента душит основной сбор |
| Полнота обхода | 3 артефакта с максимальным `lots_total`: обработано лотов vs `total` из `/lots` | расхождение ≤ пары процентов |
| Доля вариантов с `ref_price` | `SELECT count(*) FILTER (WHERE ref_price IS NOT NULL)::float / count(*) FROM artifact_variant_stats` | > 0.5 после бэкфилла |

**Правила подкрутки:**
- `full sweep` > 240 с при `units` заметно ниже 200 → узкое место не бюджет, а
  `FEED_REQUEST_DELAY`/задержки API: снизить задержку до 0.2 с.
- `full sweep` > 240 с при упоре в бюджет → поднять `FEED_COLD_EVERY_N_CYCLES` (7–10) и/или
  ужесточить `FEED_HOT_SALES_PER_DAY`. **Повышение `FEED_BUDGET_UNITS_PER_MIN` — только с
  подтверждения пользователя** (влияет на rate limit).
- `guard_trips > 0` или рост цикла «Избранного» выше 90 с → снизить
  `FEED_BUDGET_UNITS_PER_MIN` до 150.
- Один предмет съедает > 30 % прогона → снизить `FEED_MAX_PAGES_PER_ITEM` до 5 (1000 лотов) и
  зафиксировать в доках, что для сверх-массовых артефактов срез неполный.
- Доля вариантов с `ref_price` низкая → расширить окно бэкфилла (`--days 60`), с подтверждения.

Результат калибровки (итоговые значения констант + снятые метрики) — записать в
`docs/SERVICES.md` и в `docs/NOTES.md` рядом с пунктом задачи.

---

## Тесты

Каталог `backend/tests/` (`conftest.py` — только `sys.path`, `test_pricing.py` — чистые
функции, без БД). Держимся того же уровня: **тестируем чистые функции**, для чего скоринг и
планировщик бюджета вынесены из тела Celery-задач в модульные функции.

`backend/tests/test_feed_scoring.py`:
- группировка продаж по варианту: `additional_info = {}` / `{"qlt": 4}` / `{"qlt":4,"ptn":15}` → `(0,0)` / `(4,0)` / `(4,15)`;
- `supply_coverage_days`: `sales_per_day = 0` → `None`; 30 шт при 3/дн → 10.0;
- `margin_adj_pct = profit_pct / risk_mult` и фильтр видимости — параметризовано по low/medium/high (порог 30 % → 30/39/48 %);
- маппинг лота в строку `feed_lots`: `profit_total = profit_per_unit × amount`; `evaluate_lot_profit → None` ⇒ строки нет;
- глитч-отсечка: `profit_pct > FEED_MAX_PROFIT_PCT` ⇒ строки нет;
- `trend_7d_pct` при `median_30d = 0` / `None` ⇒ `None` (без ZeroDivision);
- вариант без `ref_price`/`sell_options` ⇒ лоты пропускаются целиком.

`backend/tests/test_feed_budget.py`:
- `plan_run`: предмет берётся целиком или не берётся (частичной пагинации нет);
- бюджет исчерпан → остаток в `deferred`, оценка расхода ≤ бюджета;
- расчёт числа страниц из `total`: 0 / 200 / 201 / 5000 (упор в `FEED_MAX_PAGES_PER_ITEM`);
- порядок обхода: NULL-`last_scan` первыми, далее по возрастанию времени;
- отбор горячих/холодных: холодные попадают в очередь только на каждом N-м цикле;
- ⛔ ~~отбор получателей уведомлений: троттлинг 5, оба порога, сортировка по `profit_total`~~ —
  **ОТМЕНЕНО Ревизией 4**, тесты удалены; вместо них — парковка отказавшего предмета (§Р3.6).

~~`backend/tests/test_feed_teaser.py` и `test_feed_signals.py`~~ — ⛔ первый отменён Ревизией 2
(заменён `test_feed_showcase.py`), второй удалён Ревизией 4. Итоговый набор:
`test_feed_scoring.py`, `test_feed_budget.py`, `test_feed_showcase.py`,
`test_feed_card_parity.py` (+ существовавшие ранее `test_pricing.py`,
`test_signals_sell_options.py`) → `python -m pytest tests -q` = **172 passed**.

Интеграционный тест на пагинацию `/feed/lots` требует фикстуры БД, которой в проекте нет.
**Решение:** не заводить инфраструктуру ради одного теста — пагинацию, гейтинг и негейтированный
тизер проверяет `qa-tester` по критериям приёмки Фаз 2/4 и §Р1.4. Если `backend-dev` всё же
добавляет фикстуру — отдельным коммитом, с отметкой в отчёте.

---

## Документация для обновления (Фаза 7, `tech-writer`)

> **Выполнено 2026-08-04** — с поправкой на Ревизии 3 и 4: пять ручек стали четырьмя
> (`/lots`, `/variant`, `/summary`, `/filters`), разделы про событие `feed_lot`, `/feed/signals`,
> три колонки `user_settings` и «правило тизера» заменены на фиксацию их отмены, а в
> `ARCHITECTURE.md` убран `push.events` из общих точек конвейера. `CLAUDE.md` правок не
> потребовал: строка про `design/v5` и оценка расхода API (~103.4 ед/мин) остались верны.

- `docs/NOTES.md`: закрыть пункт «Внедрение Design v5 — Фаза 7 «Лента»» (`[ ]` → `[x]`) со
  ссылкой на это ТЗ; добавить открытый пункт-баг: **кнопка «Карточка» в «Радаре рынка» для
  неотслеживаемого предмета молча выбирает чужой предмет** — `MonitoringPage.tsx:99-117`
  резолвит `navigate`-состояние только по собственному watchlist и падает в
  `sortedWatchlist[0]`; `ArtifactModal` — естественное лекарство и для Радара (вне объёма);
  зафиксировать итоговые значения констант бюджета после калибровки; отметить частичное
  закрытие пункта про deep-link push (`?lot=` на `/app/feed`).
- `docs/BUSINESS_LOGIC.md`: новый раздел «Лента артефактов» — определение варианта
  (предмет × qlt × ptn), формула порога видимости `min_profit_margin_percent × RISK_MARGIN_MULT`,
  `sales_per_day`, `supply_coverage_days`, правило «тренд — метка, не поправка к цене»,
  разница с «Избранным», **правило тизера** (1 лот, самый дешёвый по `buyout_price`, порог
  пользователя, без уведомлений) и почему ручка cache-read-only (рядом с §17 «Подсказки
  пустого Избранного» — тот же принцип).
- `docs/DATABASE.md`: таблицы `feed_lots`, `artifact_variant_stats`, миграция `0038`
  (+ `0039`, если индекс уехал в отдельную ревизию), `sales_history.user_id` → nullable
  (и почему), 3 колонки `user_settings`.
- `docs/SERVICES.md`: `tasks/feed_collector.py` (три задачи, расписание, константы бюджета,
  Redis-ключи `feed:scan:*`, лок), `services/analytics/variant_stats.py`, `endpoints/feed.py`
  (**пять** ручек: `/lots`, `/summary`, `/filters`, `/signals`, `/teaser` — с пометкой, какая
  без гейта и какие кэши/TTL), событие `feed_lot` и его обработчики в обоих консьюмерах,
  `scripts/backfill_artifact_history.py`.
- `docs/ARCHITECTURE.md`: схема параллельного конвейера ленты рядом с watchlist-конвейером
  (общие точки: `StalcraftClient`/rate limiter, `pricing.*`, `api_cache`, `push.events`);
  второй источник данных для полосы сигналов.
- `docs/CHANGELOG.md`: запись о фиче с явным указанием, чем третья попытка отличается от двух
  удалённых (метрика от реальных сделок, а не от `avg_price_24h`), и о Ревизии 1.
- `docs/tasks/design-v5-implementation.md`: Фаза 7 «Лента» — статус внедрено.
- `CLAUDE.md`: строка про `design/v5` («осталась только Фаза 7») — обновить.

---

## Открытые вопросы / требует подтверждения пользователя

1. **Рост нагрузки на Stalcraft API.** `FEED_BUDGET_UNITS_PER_MIN = 200` (100 вызовов/мин) +
   3.4 ед/мин на историю. Ожидаемый итог ≈ **158 запросов/мин ≈ 39.5 %** от лимита 400
   (сейчас 54.5 / 13.6 %). Требуется подтверждение перед включением beat на проде. Любое
   последующее повышение бюджета — отдельное подтверждение.
   *Ревизия 1 нагрузку на внешний API не увеличивает вовсе:* обе новые ручки читают только
   свою БД и Redis.
2. **Разовый бэкфилл истории 30 дней** — расходует лимит залпом; запускать только вручную,
   после печати сметы и подтверждения (помнить инцидент 429 от 2026-06-29).
3. ⛔ ~~**Уведомления привязаны к обоим порогам** (`feed_min_profit_percent` И порог таблицы)~~ —
   **вопрос снят Ревизией 4**: уведомлений у ленты нет.
4. **`supply_coverage_days` живёт в `feed_lots`, а не в `artifact_variant_stats`** —
   уточнение реализации (один писатель на таблицу). Подтвердить.
5. **Поправка `design/v5/DIRECTION.md`** про read-only модалку — меняет действующее
   дизайн-правило проекта. Подтвердить формулировку.
6. **Мультирегион** — в v1 только RU; колонка `region` заложена, включение других регионов
   умножает расход API и требует отдельного решения.
7. **Batch-коррекция цены продажи считается по варианту**, а не по предмету — цифры для лотов
   `amount > 1` могут отличаться от карточки «Избранного». Считаем это улучшением; строгий
   паритет потребовал бы менять `compute_signals_for_entry` (вне объёма).
8. **Негейтированные ручки `/feed/*`** — после Ревизий 2–4 их две: `GET /feed/lots`
   (ветвится по тарифу) и `GET /feed/variant/{item_id}`. Риск снят архитектурно
   (cache-read-only, готовые таблицы, Redis TTL 30 с у витрины, никаких внешних вызовов);
   `security`-ревью прогнано 2026-08-04, находки закрыты. ~~`GET /feed/teaser`~~ отменён
   Ревизией 2.
9. **Ревизия 1: пункт «Лента» в навбаре больше не под замком ни для одной роли** — сознательный
   отказ от гейта в навигации в пользу конверсионной витрины. Отражается на восприятии
   тарифов; подтверждено пользователем, зафиксировано здесь как изменение поведения.

---

## Маршрутизация по агентам

| Порядок | Агент | Вход | Что делает |
|---|---|---|---|
| 1 | ✅ `backend-dev` | §Фаза 1 | миграция `0038`, модели, `feed_access`, `feed_collector.py`, бэкфилл-скрипт, beat |
| 2 | ✅ `backend-dev` | §Фаза 2 | `variant_stats.py`, скоринг, `endpoints/feed.py` (итог — **4 ручки**: `/lots`, `/variant`, `/summary`, `/filters`), тесты |
| 3 | — | §Калибровка | **не сделана**: снять метрики первого прогона, подкрутить константы (повышение бюджета — только с подтверждения) |
| 4 | ✅ `designer` | §Фаза 3 | `design/v5/app/feed.html`, поправка `DIRECTION.md`/`AUDIT.md`. ⚠ Прототип **разошёлся** с реализацией после Ревизии 4 — §Р4.5 |
| 5 | ✅ `frontend-dev` | §Фаза 4 | `FeedPage`, `ArtifactModal`, `MobileFeedPage`, витрина, навигация без замка (~~лента сигналов, подсветка `?lot=`, фидовые настройки~~ — ⛔ откачено Ревизией 4) |
| ~~6~~ | — | ~~§Фаза 5~~ | ⛔ **ОТМЕНЕНО Ревизией 4** — ~~продюсер `feed_lot`, оба консьюмера, троттлинг, дедуп~~ |
| 7 | ✅ `frontend-dev` | §Фаза 6 | копирайт: лендинг, FAQ, тарифы, тексты гейта и витрины |
| 8 | `qa-tester` | критерии приёмки Фаз 2/4 + §Р2.7 + §Р4.3 | **после сужения не прогонялся** — ручное и API-QA (в т.ч. прод — сервисным аккаунтом `deploy_qa`) |
| 9 | ✅ `security` | §Открытые вопросы п. 8 | прогнано 2026-08-04, находки закрыты (H1 снят вместе с `lot_key`) |
| 10 | ✅ `tech-writer` | §Документация | обновление docs/ (только diff), выполнено 2026-08-04 |

Локально: `docker compose up -d` → http://localhost:3000/app/feed.
Ручное/браузерное QA — только через `qa-tester`.
