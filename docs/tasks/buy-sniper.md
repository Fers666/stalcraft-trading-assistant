# ТЗ: раздел «Закупки // Buy Sniper» (замена «Склада»)

## Context

Раздел «Склад» (`/app/inventory`, `frontend/src/pages/InventoryPage.tsx`, таблица `user_inventory`) — простой CRUD «уже купленных» товаров. Аналитика (медиана, P&L) в нём заложена, но никогда не была реализована — колонки показывают «—». Раздел фактически не приносит пользы.

Задача — **переделать его в инструмент мониторинга закупок**: пользователь задаёт цену, за которую готов купить товар (порог), и когда **самый дешёвый лот** на рынке падает **≤ порога** — приходит уведомление в Telegram «пора покупать». Товары добавляются **только из «Избранного»** (watchlist). При добавлении карточки показываются **min / медиана / max цены продажи за 3 дня**, чтобы осмысленно выставить порог.

Ключевая находка: почти вся инфраструктура уже есть и переиспользуется — сбор данных и идентификация товара по качеству/заточке (watchlist), Telegram-доставка (бот + `User.telegram_chat_id` + `notify_telegram`), дедупликация уведомлений по лоту (`tg_sent:*`), паттерн расчёта min/median/max (`backend/app/services/analytics/market_stats.py`). Новая фича — это **связка**, а не постройка с нуля.

**Решения:** название — **«Закупки // Buy Sniper»**; модель данных — **новая таблица + FK на запись Избранного** (каскадное удаление, старый `user_inventory` дропаем); триггер — **самый дешёвый лот (min)**.

**Тарифная доступность:**
- **Доступ к разделу** (видеть/добавлять/мониторить): тарифы **Продвинутая / Продвинутая+ / Макс** (`advanced` / `advanced_plus` / `advanced_max`), не Базовая.
- **Уведомления/пуши** из раздела: только **Продвинутая+ / Макс** (`advanced_plus` / `advanced_max`). На «Продвинутой» раздел работает как ручной список целей закупки без алертов.
- **Лимит добавляемых товаров = числу товаров в Избранном** — получается автоматически: каждая закупка привязана к записи watchlist по UNIQUE FK, значит максимум закупок = число активных избранных (а оно уже ограничено `watchlist_limit` тарифа). Отдельный лимит не вводим.

---

## Архитектура (что переиспользуем)

| Нужно | Уже есть | Действие |
|---|---|---|
| Идентификация товара (item_id/регион/качество/заточка) | `UserWatchlist` (`quality_filter`, `enchant_filter`) | Buy-alert ссылается на запись watchlist по FK |
| Сбор свежих лотов каждые 20с | `collect_all_active_lots` → `_publish_signals` | Добавить публикацию «самого дешёвого подходящего лота» |
| Фильтрация лотов по qlt/ptn + ликвидности | `_lot_quality_enchant`, `_is_liquid`, `_is_artefact` (pricing.py / profitable_lots.py L34-L50) | Переиспользовать в новом хелпере |
| Доставка в Telegram + дедуп по лоту | `notify_profitable_lots`, ключ `tg_sent:*` TTL 48ч | Добавить `notify_buy_alerts` с ключом `tg_buy_sent:*` |
| Привязка Telegram + флаг рассылки | `User.telegram_chat_id`, `UserSettings.notify_telegram`, тариф-гейт `telegram_notifications` | Переиспользовать те же гейты |
| min/median/max цен | median-логика по `sales_history` | Новый on-demand эндпоинт с окном 3 дня |

Триггер-цена (**min**) считается по подходящим под фильтр `quality_filter`/`enchant_filter` **ликвидным** лотам снапшота — потому что `snap.min_price_per_unit`/`best_price_per_unit` не отфильтрованы по качеству и для карточек с фильтром дали бы неверную цену.

---

## 0. Тарифный гейт

`backend/app/core/tiers.py` — расширить `TierLimits` двумя флагами и заполнить в `TIERS` + `ADMIN_LIMITS`:

| Тариф | `buy_sniper_access` | `buy_sniper_notifications` |
|---|---|---|
| base (Базовая) | ✗ | ✗ |
| advanced (Продвинутая) | ✓ | ✗ |
| advanced_plus (Продвинутая+) | ✓ | ✓ |
| advanced_max (Макс) | ✓ | ✓ |
| admin | ✓ | ✓ |

- **`backend/app/api/v1/endpoints/auth.py`** (`/auth/me` + login, где формируются `auction_access`/`has_market_radar_addon`, ~L52/L74): добавить в ответ `buy_sniper_access` и `buy_sniper_notifications`.
- **API-гейт**: `POST /buy-sniper/` и `GET /buy-sniper/*` → 403, если `get_tier_limits(user).buy_sniper_access` == False.
- **Бот-гейт**: `notify_buy_alerts` фильтрует получателей по `get_tier_limits(user).buy_sniper_notifications` (а не `telegram_notifications`).
- **Frontend nav-гейт**: `frontend/src/components/Layout.tsx` — расширить тип `GateKey` значением `'buy_sniper'`, добавить пункт `{ label: 'Закупки', to: '/app/buy-sniper', gateKey: 'buy_sniper' }`, запись в `GATE_TOOLTIP`; логика замка уже читает права из `/auth/me`. `frontend/src/store/authStore.ts` — добавить `buy_sniper_access` / `buy_sniper_notifications` в тип `User`.

**Лимит:** отдельного лимита нет — число закупок ограничено числом активных избранных через UNIQUE `watchlist_id`. В диалоге добавления показываем только ещё не добавленные избранные; когда все добавлены — список пуст.

## 1. Данные / миграция Alembic

Новый файл `backend/alembic/versions/00NN_buy_alerts.py`:

- **Drop** таблиц `sell_recommendations` (сначала — зависит по FK) и `user_inventory`.
- **Create** таблицы `buy_alerts`:

| Поле | Тип | Смысл |
|---|---|---|
| `id` | int PK | |
| `user_id` | int FK→`users.id` ON DELETE CASCADE, NOT NULL, index | скоуп/запросы бота |
| `watchlist_id` | int FK→`user_watchlist.id` ON DELETE CASCADE, NOT NULL, **UNIQUE** | одна закупка = одна карточка Избранного |
| `target_price` | BigInteger, NOT NULL | порог ₽/шт: цена ≤ target → уведомить |
| `is_active` | bool default True | пауза без удаления |
| `created_at` / `updated_at` | timestamptz | |

Модели `backend/app/models/models.py`: удалить классы `UserInventory` (L259) и `SellRecommendation` (L280) + relationship `User.inventory` (L36) и `UserWatchlist.sell_recommendations`; добавить класс `BuyAlert` и relationship `User.buy_alerts` / `UserWatchlist.buy_alert`.

---

## 2. Backend: эндпоинты `buy-sniper`

Новый файл `backend/app/api/v1/endpoints/buy_sniper.py`, префикс `/buy-sniper`, tag `BuySniper`, все ручки scoped по `get_current_user`. Зарегистрировать в `backend/app/main.py` (~L52) рядом с остальными; **удалить** регистрацию `inventory` роутера и сам файл `backend/app/api/v1/endpoints/inventory.py`.

- `GET /buy-sniper/` — список закупок пользователя, join с `user_watchlist` + `master_items` (name/icon/qlt/ench/region). Для каждой обогащаем **текущей минимальной ценой** из Redis-ключа `buymin:{...}` (см. §4) → UI показывает «текущая: X / ваш порог: Y».
- `POST /buy-sniper/` — тело `{ watchlist_id, target_price }`. Проверки: запись watchlist принадлежит пользователю; ещё не добавлена (UNIQUE `watchlist_id`, иначе 409). Создаёт `BuyAlert`.
- `PUT /buy-sniper/{id}` — обновить `target_price` / `is_active`.
- `DELETE /buy-sniper/{id}` — удалить.
- `GET /buy-sniper/price-window?watchlist_id=&days=3` — **min/median/max/count** реальных продаж за N дней. Берёт `item_id/region/quality_filter/enchant_filter` из записи watchlist и повторяет **ту же** фильтрацию по `additional_info.qlt/ptn`, что и `profitable_lots.py` L102-L146, но с `cutoff = now - 3d`. Только чтение `sales_history`, без миграций и без нагрузки на Stalcraft API. Вызывается фронтом при открытии диалога добавления.

Pydantic-схемы — в том же файле (как в `watchlist.py`).

---

## 3. Триггер-цена: публикация «самого дешёвого подходящего лота»

Проблема: `signals.lots` содержит только **прибыльные** лоты (прошли `evaluate_lot_profit`). Buy-alert должен срабатывать на любой лот ≤ порога, независимо от прибыльности перепродажи.

Решение — отдельная лёгкая публикация, **не трогающая** существующую логику сигналов:

- В `backend/app/services/profitable_lots.py` добавить функцию `cheapest_matching_lot(entry, master, snap) -> dict | None` — проходит `snap.raw_lots`, фильтрует `_is_liquid` + `quality_filter`/`enchant_filter` (как L161-L177), возвращает лот с минимальной `buyout // amount`: `{ start_time, price_per_unit, amount, quality_name, enchant }`. Не зависит от наличия исторических данных (в отличие от `compute_signals_for_entry`, который возвращает `None` при отсутствии `ref`).
- В `_publish_signals` (collectors.py, ~L430) для **каждой активной** watchlist-записи дополнительно писать Redis-ключ `buymin:{user_id}:{item_id}:{region}:{qlt}:{ench}` = JSON результата, TTL `SIGNALS_TTL` (300с). Публикуется всегда, даже когда сигналов о прибыли нет.

---

## 4. Bot: рассылка buy-alert

В `telegram_bot/bot.py` добавить `notify_buy_alerts(app)` и вызвать в `_notifier_loop` (L378) рядом с `notify_profitable_lots`:

- Гейты: `telegram_chat_id IS NOT NULL`, `is_active`, `notify_telegram`, и тариф **`buy_sniper_notifications`** (только Продвинутая+/Макс — отличие от прибыльных лотов, которые гейтятся `telegram_notifications`).
- Для каждого пользователя грузить его `buy_alerts` (join `user_watchlist`, только `is_active` с обеих сторон), читать `buymin:{...}`.
- Если `price_per_unit ≤ target_price` → отправить сообщение. Дедуп по лоту: ключ `tg_buy_sent:{user}:{item}:{region}:{qlt}:{ench}:{start_time}`, TTL `NOTIF_DEDUP_TTL` (48ч) — один и тот же лот не спамит каждые 15с; новый более дешёвый лот (другой `start_time`) уведомит снова.
- Сообщение (HTML, стиль `build_lot_message`): «🛒 Дешёвый лот! <Товар · качество · +заточка> — <b>{цена} ₽/шт</b> ≤ ваш порог {target} ₽/шт · доступно {amount} шт».

Существующую отключённую `scan_and_notify` в Celery **не трогаем** (celery_app.py L64-65).

---

## 5. Frontend

- **Навбар/роут** `Layout.tsx` (L28): `{ label: 'Закупки', to: '/app/buy-sniper', gateKey: 'buy_sniper' }`. `App.tsx`: маршрут `buy-sniper` → `BuySniperPage`, редирект `/app/inventory → /app/buy-sniper`. Удалить импорт/маршрут `InventoryPage` и сам файл `InventoryPage.tsx`.
- **`BuySniperPage.tsx`** (новый, по образцу структуры InventoryPage + MonitoringPage — обе уже в Design v5 «Терминал», токены строго из `frontend/src/theme.ts`):
  - Таблица закупок: Товар (иконка+имя), Качество/Заточка (бейджи), Регион, **Порог ₽/шт**, **Текущая мин. цена** (из `GET /buy-sniper/`, подсветка когда ≤ порога — «горит»), статус (active), редактировать порог, удалить (`ArmDeleteButton`).
  - Пустое состояние + предупреждение, если Telegram не привязан (ссылка в Настройки — привязка уже есть на `SettingsPage.tsx`).
  - **Диалог «Добавить»**: список записей **Избранного**, ещё не добавленных в закупки (из feedStore/`GET /watchlist/` минус существующие). Выбор карточки → запрос `GET /buy-sniper/price-window?watchlist_id=&days=3` → показать **min / медиана / max за 3 дня** → поле «Порог ₽/шт» (предзаполнить медианой как ориентир) → сохранить `POST /buy-sniper/`.
  - Данные через axios `../api/client` напрямую (как InventoryPage), без нового Zustand-стора.

## 6. FAQ

`frontend/src/pages/FaqPage.tsx` (маршрут `/faq`, статичный массив `FAQ_GROUPS`):
- Добавить новую группу **«Закупки (Buy Sniper)»** с 3-4 Q&A: что это, как добавить (только из Избранного), как выставить порог (min/медиана/max за 3 дня), кому доступны уведомления (Продвинутая+/Макс), нужна ли привязка Telegram.
- В компоненте `TierTable` (`tierRows`) добавить строки/колонки: «Раздел Закупки» — ✓ для Продвинутая/Продвинутая+/Макс, ✗ Базовая; «Уведомления Закупок» — ✓ только Продвинутая+/Макс.

## 7. Лендинг

`frontend/src/pages/LandingPage.tsx` (маршрут `/`, статичные массивы):
- **Секция «Фичи»** (`id="features"`, сетка `repeat(3,1fr)` ~L305): добавить 4-ю карточку **«Закупки // Buy Sniper»** (снайпер выгодных цен покупки + Telegram-алерт при падении ниже порога). Сетку сделать `repeat(4,1fr)` / адаптивной.
- **Секция «Тарифы»** (`id="tariffs"`, массив `PLANS`): в каждый план добавить две строки `rows`:
  - `{ k: 'закупки — мониторинг', v: … , kind }` — Базовая `no`, Продвинутая/Продвинутая+/Макс `ok`.
  - `{ k: 'закупки — уведомления', v: … , kind }` — Базовая/Продвинутая `no`, Продвинутая+/Макс `ok`.

Прототип-эталон Design v5 — при желании обновить `design/v5/app/index.html` (не блокирует; фронт правится по `theme.ts`).

## 8. Новость для портала

Раздел «Новости» (`news.py` + `NewsPage.tsx`, таблица `news`) публикуется **админом через UI `/app/news`** (`POST /news/`, `content` — обычный текст с `pre-wrap`, теги из `ALLOWED_TAGS`). Готовый текст к публикации (тег `обновление`, `is_pinned=true`):

> **Заголовок:** Новый раздел «Закупки» — снайпер выгодных цен
>
> **Содержание:**
> Встречайте новый раздел «Закупки // Buy Sniper» — он приходит на смену «Складу».
>
> Теперь можно ловить момент выгодной покупки автоматически:
> • Добавляйте товары в закупки прямо из «Избранного».
> • При добавлении вы видите минимальную, медианную и максимальную цену продажи за 3 дня — чтобы осмысленно выставить свою цену.
> • Задайте порог: как только на рынке появится лот дешевле или равный вашей цене — мы пришлём уведомление в Telegram «пора покупать».
>
> Доступ к разделу — на тарифах «Продвинутая», «Продвинутая+» и «Макс».
> Уведомления о падении цены — на «Продвинутая+» и «Макс».
>
> Не забудьте привязать Telegram в Настройках, чтобы получать алерты.

Финальную формулировку согласовать перед публикацией; сам `POST /news/` выполняет админ.

---

## Критические файлы

Создать: `backend/app/api/v1/endpoints/buy_sniper.py`, `backend/alembic/versions/00NN_buy_alerts.py`, `frontend/src/pages/BuySniperPage.tsx`.
Изменить (backend): `core/tiers.py`, `api/v1/endpoints/auth.py`, `models/models.py`, `main.py`, `services/profitable_lots.py`, `tasks/collectors.py` (`_publish_signals`), `telegram_bot/bot.py`.
Изменить (frontend): `components/Layout.tsx`, `App.tsx`, `store/authStore.ts`, `pages/FaqPage.tsx`, `pages/LandingPage.tsx`.
Удалить: `api/v1/endpoints/inventory.py`, `pages/InventoryPage.tsx`, классы `UserInventory`/`SellRecommendation`.
Новость: опубликовать через `/app/news` (текст в §8).

---

## Verification (end-to-end)

1. **Миграция:** `docker compose exec backend alembic upgrade head` — `buy_alerts` создана, `user_inventory`/`sell_recommendations` дропнуты; `alembic downgrade -1` откатывает чисто.
2. **Backend API:** через Swagger/curl с JWT — `POST /buy-sniper/` (валидный `watchlist_id`), `GET /buy-sniper/` возвращает `current_min`, `GET /buy-sniper/price-window` отдаёт min/median/max за 3д с учётом качества; 409 на дубль, 404 на чужой watchlist_id.
3. **Тарифный гейт:** пользователь `base` → `POST /buy-sniper/` даёт 403, в навбаре пункт «Закупки» с замком. Пользователь `advanced` → раздел доступен, но buy-alert в Telegram НЕ приходит. Пользователь `advanced_plus`/`advanced_max` → приходит.
4. **Триггер + Telegram (главный сценарий, тариф Продвинутая+):** привязать Telegram; добавить закупку с `target_price` **выше** текущей мин. цены → в течение ~20-35с (цикл коллектора + polling бота) приходит одно сообщение; повторное не приходит (дедуп); поднять порог ниже рынка → тишина. Проверять через `qa-tester`.
5. **Frontend:** `cd frontend; npm run build` (tsc+vite) без ошибок; вручную — навбар «Закупки» (с гейтом), добавление только из Избранного, отображение 3-дневных цен, подсветка «текущая ≤ порога», редактор порога, удаление; редирект `/app/inventory`; FAQ-группа и строки тарифов на лендинге отображаются.

## Отложено (не в этом объёме, отметить в NOTES.md)
- Browser-push для того же триггера (`UserSettings.notify_browser_push` уже есть).
- «% ниже медианы» как альтернатива абсолютному порогу — сейчас только абсолютная цена.
- `last_triggered_at` в UI (дедуп живёт в Redis; при желании добавить позже).
