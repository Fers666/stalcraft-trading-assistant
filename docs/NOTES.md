# Заметки и идеи

---

## Задачи в очереди

- [x] **Повысить покрытие qlt/ptn в sales_history** — реальная причина оказалась
  не ограничением API, а багом парсинга ← 2026-06-29. Stalcraft API `/history`
  уже возвращает `additional.qlt`/`ptn` напрямую в каждой записи продажи
  (подтверждено живым запросом к API), но `_collect_history_for_item()`
  (`backend/app/tasks/collectors.py`) никогда не читал `record.get("additional")`
  — поле молча отбрасывалось, хотя запрос уже шёл с `additional=true`. Старый
  комментарий в коде, утверждавший обратное, был неверным предположением, не
  фактом. Фикс: `record.get("additional")` теперь первичный, authoritative
  источник qlt/ptn; снэпшот-матчинг (`find_lot_info`) сохранён только для
  `lot_start` (время выставления лота, для `time_on_market`). Подробности и
  диагностика — `docs/tasks/sales-history-qlt-ptn-coverage.md`.
  Дополнительно: разовый CLI backfill-скрипт
  `backend/app/scripts/backfill_sales_qlt.py` (`docker compose exec backend
  python -m app.scripts.backfill_sales_qlt --days 30`) для существующих
  записей без qlt — печатает смету по rate limit перед запуском, **пока не
  запускался**.
- [x] **Инцидент: CPU-спайки на проде раз в час** — устранён 2026-06-29
  (`HISTORY_CONCURRENCY=6`, параллельная обработка `collect_all_history`),
  внеплановый фикс, не из бэклога. Подробности — `docs/CHANGELOG.md`,
  `docs/SERVICES.md`.
- [x] **Опробовать skill `systematic-debugging`** — применён 2026-06-28 на
  реальном баге (тариф `base` видел полную историю продаж за все окна вместо
  24ч) — root cause найден чтением кода за один проход (незащищённый
  `/monitoring/sales-chart`), фикс точечный, без лишних итераций. Эффект
  положительный, закрепляем как практику. `test-driven-development` в этом
  заходе не использовался (правки тестировались curl/tsc, не автотестами) —
  оценку оставляем открытой на следующий backend-таск с тестами.
- [ ] **Роадмап подписок — оставшиеся фазы** (Phase 0 "Тарифы" реализована,
  см. `docs/CHANGELOG.md` и `docs/BUSINESS_LOGIC.md` §17):
  - [x] Статистика в админке (rate-limit consumption, уникальные карточки по
    всем пользователям) ← 2026-06-28, см. `docs/CHANGELOG.md`,
    `docs/SERVICES.md` (`GET /admin/stats`, `get_consumption_stats()`).
    Дополнено 2026-06-28 — 4 пункта, потерянных при первом восстановлении ТЗ
    (зашедшие сегодня, активные за неделю, счётчик подключивших Telegram,
    колонка Telegram в таблице пользователей): см. `docs/CHANGELOG.md`,
    `docs/SERVICES.md`, `docs/tasks/admin-stats-gaps.md`.
  - [ ] Раздел новостей.
  - [ ] Форма обращений → Telegram админам.
  - [x] "Радар рынка" (кросс-юзерная агрегация watchlist, отдельный аддон не
    по тарифам, гейтинг через `User.has_market_radar_addon`; топ группируется
    по `item_id, quality_filter, enchant_filter` — один предмет может занимать
    несколько строк; метрика `profitable_offers_count` — число выгодных лотов
    в снэпшоте, дедуплицированное по лотам, не по watcher'ам) ← 2026-06-28,
    см. `docs/CHANGELOG.md`, `docs/BUSINESS_LOGIC.md` §17, `docs/SERVICES.md`
    (`GET /market-radar/`, `get_market_radar_aggregate()`).
    - [x] Ревизия 2026-06-29 — сортировка по `profitable_offers_count` (убыв.,
      `None`→0) вместо `watchers_count`, полная серверная пагинация
      (`page`/`page_size`, default 20) вместо жёсткого SQL-лимита топ-20,
      safety-cap `MAX_BUCKETS=500` на число бакетов. См.
      `docs/tasks/market-radar-sort-pagination.md`, `docs/CHANGELOG.md`,
      `docs/BUSINESS_LOGIC.md` §17, `docs/SERVICES.md`.
  - [ ] FAQ-онбординг + копирайт лендинга под переименование игры в STALZONE.
  - [x] Ручной override лимита избранного (watchlist) вне тарифа ← 2026-06-28,
    см. `docs/CHANGELOG.md`, `docs/BUSINESS_LOGIC.md` §17 (подраздел «Override
    лимита избранного»), `docs/DATABASE.md` (`users.favorites_limit_override`).
  Черновой план остальных пунктов — в истории чата/архиве планов, при
  возврате к теме — заново зафиксировать через `researcher`.
- [ ] **Обязательная привязка Telegram при регистрации + восстановление
  пароля через неё** — ОТЛОЖЕНО решением пользователя (2026-06-28). Была
  частью роадмапа подписок (фаза "Telegram-регистрация"), реализация
  поставлена на паузу намеренно, не забыта. При возврате — учесть наработки:
  `register()` не возвращает токен, `/telegram/link-code` требует авторизации
  → нужен отдельный неавторизованный flow для привязки до approve.

---

## Идеи на будущее

- Уведомления в реальном времени — WebSocket push.
- Сравнение регионов — один товар, несколько регионов рядом.
- При параллельной работе нескольких сессий Claude Code в одном репозитории —
  после любой деструктивной git-операции (filter-repo, reset --hard, force-push)
  в ОДНОЙ сессии явно сверять `git log`/`git status`/`git diff` в ОСТАЛЬНЫХ
  открытых сессиях: рабочая копия может сброситься и молча потерять
  uncommitted-правки, сделанные параллельно.

---

## Архив

- Полная история закрытых задач и редизайна фронтенда → `docs/CHANGELOG.md`
- Деплой и инфраструктура (VPS, Caddy, первый запуск) → `docs/DEPLOY.md`
