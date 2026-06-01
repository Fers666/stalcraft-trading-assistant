# Бизнес-логика Stalcraft Trading Assistant

## Обзор системы

Приложение анализирует аукцион игры Stalcraft X. Каждые 5 минут собираются активные лоты, раз в час — история продаж. На основе этих данных рассчитываются рекомендации по покупке и прогнозы времени продажи.

**Основной цикл:**
1. Celery воркер собирает лоты (каждые 5 мин) и историю продаж (раз в час)
2. Analytics сервис пересчитывает статистику (раз в час, на 5-й минуте)
3. FastAPI выдаёт рекомендации
4. Уведомления отправляются в Telegram / браузер

---

## 1. Расчёт выгодности покупки

```
expected_revenue = avg_sell_price_7d × (1 − 0.05)   // минус 5% комиссия
profit_per_unit  = expected_revenue − lot.price_per_unit
profit_percent   = (profit_per_unit / lot.price_per_unit) × 100

confidence = min(1.0, sales_volume_7d / 100)
score      = profit_percent × confidence
```

**Константы:**
- Комиссия продажи: **5%**
- Минимальная маржа по умолчанию: **10%** (пользователь может изменить)
- Уверенность = 1.0 при 100+ продажах за неделю

**Условие показа рекомендации:** `profit_percent ≥ user.min_profit_margin_percent`

---

## 2. Риск-анализ (волатильность)

```
volatility = (stdev(prices_7d) / mean(prices_7d)) × 100
```

| Уровень | Условие |
|---------|---------|
| LOW | volatility ≤ 15% |
| MEDIUM | 15% < volatility ≤ 30% |
| HIGH | volatility > 30% |

---

## 3. Прогноз времени продажи

Для каждого товара генерируются **3 ценовые стратегии**:

| Стратегия | Формула цены | Смысл |
|-----------|---|---|
| Быстро | `min_liquid_price × 0.99` | Чуть ниже минимума → быстрая продажа |
| Нормально | `median_price_7d × 0.97` | Рыночная минус страховка |
| Выгодно | `median_price_7d × 1.03` | Выше медианы за ожидание |

### Алгоритм расчёта времени (3 уровня)

Уровень точности определяется **покрытием** — какой процент продаж за 30 дней
имеет восстановленный `lot_start` (время выставления лота):

```
coverage = matched_count / total_sales_30d × 100%

matched_count    — продажи, для которых найден lot_start через матчинг снэпшот→история
total_sales_30d  — все продажи за 30 дней из API /history
```

**Уровень 1 — Высокая точность** (`coverage ≥ 30%` И `matched_count ≥ 10`):

Используем реальные пары `(price_per_unit, time_on_market)`.
По цене каждой стратегии берём 5 ближайших точек → среднее их времени жизни.

**Уровень 2 — Средняя точность** (`coverage 10–30%` И `matched_count ≥ 3`):

Данных достаточно для направления, но мало для точной интерполяции.
```
avg_time = среднее time_on_market по всем matched точкам

fast:    avg_time × 0.4   // ниже рынка → продаётся быстрее среднего
normal:  avg_time × 1.0   // рыночная цена → среднее время
premium: avg_time × 2.5   // выше рынка → дольше ждать
```

**Уровень 3 — Оценка по активности рынка** (`coverage < 10%`):

Нет достаточных реальных данных. Используем `sales_volume_7d` (продаж за 7 дней)
как косвенный показатель скорости рынка.

```
sales_per_day = sales_volume_7d / 7

sales_per_day ≥ 5       → активный рынок:    fast=2ч  / normal=8ч   / premium=24ч
sales_per_day 1–5       → умеренный рынок:   fast=8ч  / normal=24ч  / premium=72ч
sales_per_day 0.14–1    → редкий (~1/неделю): fast=24ч / normal=72ч  / premium=168ч
sales_per_day < 0.14    → очень редкий:       fast=72ч / normal=168ч / premium=336ч
```

**Переменные confidence (отображаются в UI):**
- `high`   — покрытие ≥30%, ≥10 точек с lot_start
- `medium` — покрытие 10–30%, ≥3 точки
- `low`    — покрытие <10%, оценка по объёму

---

## 4. Лучшее время для продажи

На основе `sales_history` за 30 дней:
```
best_sell_hour = час с максимальным объёмом продаж
best_sell_day  = день с максимальным объёмом продаж

weekend_bonus% = ((weekend_avg − weekday_avg) / weekday_avg) × 100
```

Если weekend_bonus > 0 → выходные выгоднее → лучше выставлять в пятницу вечером.

Минимум данных для расчёта: **3 продажи за 30 дней**.

---

## 5. Источник данных о продажах

Единственный источник — **Stalcraft API `/history`**, который возвращает реальные завершённые сделки.
Данные 100% достоверны: факт продажи, цена и время подтверждены самим аукционом.

```
GET /{region}/auction/{item_id}/history
→ "prices": [{ "amount": 1, "price": 3 699 990, "time": "2026-05-29T16:55:32Z" }]
```

Переменные записи:
- `amount`  — количество единиц товара в одной сделке
- `price`   — итоговая сумма всей сделки (не за штуку)
- `time`    — момент совершения сделки

В `sales_history` сохраняется:
- `price_per_unit = price // amount` — цена за единицу
- `total_price = price` — итог сделки

### Восстановление времени нахождения на рынке (lot_start)

API `/history` не сообщает когда лот был **выставлен** — только когда продан.
Для расчёта прогноза времени продажи нужно знать `time_on_market = sale_time - lot_start`.

При каждом сборе истории система пытается найти соответствующий лот в снэпшотах (`collected_data.raw_lots`).

**Алгоритм матчинга (поиск лота по продаже):**
```
Условия совпадения:
  lot.buyoutPrice == sale.price   — одинаковая сумма сделки
  lot.amount == sale.amount       — одинаковое количество
  lot.endTime > sale_time         — лот куплен до истечения (не истёк сам)

Лот должен:
  → присутствовать в снэпшоте ДО sale_time
  → отсутствовать в снэпшоте ПОСЛЕ sale_time

При нескольких кандидатах (одинаковые лоты):
  → берём с наиболее ранним startTime среди исчезнувших
  → данные всё равно достоверны: продажа реальная, цена точная
```

Если лот найден — в `sales_history.additional_info` сохраняется `lot_start` (startTime лота).
Это позволяет вычислить: `time_on_market = sale_time - lot_start`.

### Ликвидные vs неликвидные лоты

При каждом снэпшоте лоты разделяются:
```
liquid_lots:   lot.endTime > now + 2 часа  // ликвидные — цена актуальна
expiring_lots: lot.endTime ≤ now + 2 часа  // истекающие — никто не купил по этой цене
```

Переменная `EXPIRY_THRESHOLD_HOURS = 2` — порог в часах.

`best_liquid_price_per_unit` — минимальная цена только среди ликвидных лотов.
Используется как базовая цена для варианта "Быстро" в прогнозе.

---

## 6. Подбор пачки (Batch Matcher)

Жадный алгоритм: набрать `target_quantity` штук по минимальной цене.

```
sorted_lots = сортировка лотов по price_per_unit (возрастание)
remaining   = target_quantity

for lot in sorted_lots:
    take = min(lot.amount, remaining)
    remaining -= take
    if remaining == 0: break

if remaining > 0: return None  // не хватает товара
```

---

## 7. Среднее время продажи

```
avg_sell_time_hours = mean(time_on_market) по всем продажам за 30 дней
                      где time_on_market = sale_time - lot_start
```

`lot_start` берётся из `sales_history.additional_info.lot_start` —
восстанавливается при матчинге снэпшот→история (раздел 5).
Фильтр аномалий: `0 < time_on_market < 336 часов` (исключаем лоты старше 14 дней).

Фильтр аномалий: `0 < hours < 168` (исключаем лоты старше 7 дней).

---

## 8. Rate Limiting (Token Bucket)

**Лимиты Stalcraft API:** 100 токенов / минута

| Запрос | Стоимость |
|--------|----------|
| `/auction/{id}/lots` | 2 токена |
| `/auction/{id}/history` | 2 токена |
| `/emission` | 1 токен |

**Алгоритм:**
```
CAPACITY     = 100 токенов
REFILL_RATE  = 100/60 ≈ 1.667 токена/сек

tokens = min(CAPACITY, tokens + elapsed × REFILL_RATE)

if tokens ≥ needed:
    tokens -= needed → OK
else:
    wait = (needed − tokens) / REFILL_RATE → ждём
```

Реализован через атомарный Lua-скрипт в Redis.

---

## 9. Redis-кэш API ответов

| Эндпоинт | TTL | Ключ |
|----------|-----|------|
| `/lots` | 5 мин | `stalcraft:cache:{region}:{item_id}:lots` |
| `/history` | 60 мин | `stalcraft:cache:{region}:{item_id}:history` |

---

## 10. Расписание задач Celery

| Задача | Расписание | Описание |
|--------|-----------|---------|
| `collect_all_active_lots` | каждые 5 мин | Сбор активных лотов для всех watchlist |
| `collect_all_history` | раз в час (мин. 0) | Сбор истории продаж |
| `calculate_all_market_stats` | раз в час (мин. 5) | Пересчёт market_statistics и sell_options |
| `delete_old_data` | ежедневно 03:00 UTC | Удаление данных старше 120 дней |

---

## 11. Пользовательские настройки

```python
user_settings = {
    "min_profit_margin_percent": 10,    # % маржи для показа рекомендации
    "exclude_less_than_amount": 1,      # исключить лоты с кол-вом < N
    "notify_telegram": True,
    "notify_browser_push": True,
    "auto_refresh_enabled": True,
}
```

---

## 12. Ключевые константы

| Константа | Значение | Назначение |
|-----------|----------|-----------|
| `SELL_COMMISSION` | 5% | Комиссия аукциона с каждой продажи |
| `EXPIRY_THRESHOLD_HOURS` | 2 ч | Лот с остатком < 2ч считается неликвидным (никто не купил по этой цене) |
| `MIN_SALES_FOR_STATS` | 3 | Минимум продаж за 30 дней для расчёта волатильности и лучшего времени |
| `COVERAGE_HIGH` | 30% | Покрытие lot_start ≥30% + ≥10 точек → высокая точность прогноза |
| `COVERAGE_MEDIUM` | 10% | Покрытие lot_start 10–30% + ≥3 точки → средняя точность |
| `MIN_PROFIT_MARGIN_PERCENT` | 10% | Маржа по умолчанию в настройках пользователя |
| `RATE_LIMIT_CAPACITY` | 100 токенов | Ёмкость корзины rate limiter (токенов в минуту) |
| `DATA_RETENTION` | 120 дней | Хранение sales_history, после — автоудаление |

---

## 13. Поток данных

```
Stalcraft API (/lots, /history)
        ↓
StalcraftClient (rate limiter + token manager)
        ↓
Celery Worker (collect_all_active_lots, collect_all_history)
        ↓
PostgreSQL (collected_data, sales_history) + Redis Cache
        ↓
Analytics Service (calculate_market_stats)
        ↓
PostgreSQL (market_statistics, sell_options)
        ↓
FastAPI Backend → React Frontend
        ↓
Notifications (Telegram, Browser Push)
```

---

## 14. Краткое резюме алгоритмов

1. **Выгодность** = (avg_price_7d × 0.95 − цена_лота) / цена_лота × 100%
2. **Уверенность** = min(1.0, продаж_за_7д / 100)
3. **Score** = выгодность% × уверенность
4. **Риск** = волатильность: >30% (high), >15% (medium), ≤15% (low)
5. **Время продажи** = интерполяция по реальным выкупам (или эвристика)
6. **Batch matching** = жадный алгоритм по цене до target_quantity
7. **Buyout detection** = исчезнувшие лоты до истечения = выкупы
8. **Rate limit** = Token Bucket: 100 токенов/мин, восстановление 1.67/сек
