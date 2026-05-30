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

**Уровень 1 — достаточно данных (≥ 5 выкупов за 30 дней):**
По цене каждой стратегии берём 5 ближайших реальных выкупов → среднее их времени жизни.

**Уровень 2 — мало данных (2–4 выкупа):**
```
fast:    avg_time × 0.4
normal:  avg_time × 1.0
premium: avg_time × 2.5
```

**Уровень 3 — данных нет (< 2 выкупов):**
```
fast:    3 часа
normal:  18 часов
premium: 60 часов
```

**Confidence:**
- `high` — ≥ 5 выкупов
- `medium` — 2–4 выкупа
- `low` — < 2 выкупов

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

## 5. Детектирование выкупов

Сравниваются два последовательных снэпшота. Если лот исчез раньше истечения — считается выкупленным.

```
EXPIRY_THRESHOLD_HOURS   = 2     // лот < 2ч до конца = неликвидный
BUYOUT_BUFFER_MINUTES    = 10    // буфер точности
RELIST_PRICE_THRESHOLD   = 1.20  // 20% выше рынка = вероятно перевыставление
```

Лот записывается в `sales_history` с `source = "buyout_detection"`.

### Проблема ложных выкупов (перевыставление лотов)

**Сценарий:** продавец видит, что его лот дороже других → снимает → выставляет заново по рыночной цене.
В системе исчезновение лота = выкуп → создаёт ложные данные о продажах.

**Ограничение API:** никнейм продавца не передаётся (`additional: {}`), прямую проверку сделать нельзя.

**Эвристика (реализована):**
```
if disappeared_lot_price > best_liquid_price × RELIST_PRICE_THRESHOLD:
    → пропускаем, не записываем в sales_history
```
Логика: реальные покупки происходят по рыночной или близкой цене.
Лот на 20%+ дороже минимума — шанс реальной продажи крайне мал.

**Будущее улучшение:** если EXBO добавит никнейм продавца в API → точная проверка:
новый лот того же продавца появился = перевыставление (не продажа).

**Два источника sales_history:**
1. Официальный API `/history` — реальные сделки
2. Buyout detection — обнаруженные выкупы

### Ликвидные vs неликвидные лоты

```
liquid_lots:   endTime > now + 2 часа
expiring_lots: endTime ≤ now + 2 часа
```

`best_liquid_price_per_unit` — минимальная цена только среди ликвидных лотов.
Неликвидные исключаются из расчётов (их цена часто нерыночная).

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
avg_sell_time_hours = mean(часов жизни выкупленных лотов за 30 дней)
```

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
| `SELL_COMMISSION` | 5% | Комиссия платформы |
| `EXPIRY_THRESHOLD_HOURS` | 2 ч | Порог ликвидности лота |
| `BUYOUT_BUFFER_MINUTES` | 10 мин | Буфер детектирования выкупов |
| `RELIST_PRICE_THRESHOLD` | 1.20 (120%) | Лот дороже рынка на 20%+ → вероятно перевыставление |
| `MIN_SALES_FOR_STATS` | 3 | Минимум продаж для расчётов |
| `MIN_BUYOUTS_FOR_TIME_MODEL` | 5 | Минимум выкупов для высокой уверенности |
| `MIN_PROFIT_MARGIN_PERCENT` | 10% | Маржа по умолчанию |
| `MANUAL_REFRESH_COOLDOWN` | 120 сек | Минимум между ручными обновлениями |
| `RATE_LIMIT_CAPACITY` | 100 токенов | Лимит API в минуту |
| `DATA_RETENTION` | 120 дней | Хранение истории |

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
