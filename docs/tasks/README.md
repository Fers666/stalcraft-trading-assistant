# Индекс ТЗ

Что здесь лежит: технические задания и аналитические разборы, по которым делались задачи.
Файлы **не удаляются** — на них ссылаются `docs/CHANGELOG.md`, `docs/NOTES.md` и `CLAUDE.md`,
и именно из них восстанавливается *почему* решение принято именно таким.

Как читать таблицу: она отвечает на один вопрос — **стоит ли вообще открывать файл**.
Что в итоге получилось — в `docs/CHANGELOG.md`; текущее поведение системы — в
`BUSINESS_LOGIC.md` / `SERVICES.md` / `DATABASE.md`.

> ⚠️ **ТЗ — это снимок замысла на дату написания, а не описание системы.** Строка
> «Статус» внутри многих файлов устарела (например, `artifact-feed.md` пишет «Фаза 1
> реализована», хотя фича давно на проде). Верить нужно этой таблице и CHANGELOG,
> а не шапке внутри ТЗ.

**Статусы:** ✅ внедрено · ⚠️ внедрено, но частично пересмотрено позже · 📄 аналитика (кода не касалось) · ⏸ не реализовано

| ТЗ | Статус | Дата | Что важно знать |
|----|--------|------|-----------------|
| [profitability-criteria-unification.md](profitability-criteria-unification.md) | ⚠️ | 2026-08-22 | Единый критерий выгодности. **Ось «допуск по трём тирам» для сигналов Избранного отменена 2026-08-24** — сигналы снова только `fast` (`SIGNAL_TIERS`). Формула и ранжирование по `ev_profit` остались общими |
| [feed-card-tier-price-mismatch.md](feed-card-tier-price-mismatch.md) | ✅ | 2026-08-22 | Карточка «Ленты» считала прибыль по чужому тиру; коммит `bcc1a79` |
| [feed-multi-tier-admission.md](feed-multi-tier-admission.md) | ⚠️ | 2026-08-21 | Допуск по трём тирам, `feed_lots.tier_used`, миграция `0048`, коммит `e497dda`. Для ленты и Радара в силе; на сигналы Избранного **не распространяется** (см. запись выше) |
| [watchlist-parallel-fetch.md](watchlist-parallel-fetch.md) | ⏸ | ТЗ 2026-08-21 | **Единственное нереализованное ТЗ.** Запасной вариант на случай остаточных 429 при `concurrency = 3` — разводить задачи по времени вместо порога горячих |
| [feed-gear-expansion.md](feed-gear-expansion.md) | ✅ | 2026-08-17 | Набор ленты 103 → 382 предмета; бэкфилл истории прогнан 2026-08-18. Источник правила отбора — `services/feed/scope.py` |
| [ev-ranking.md](ev-ranking.md) | ✅ | 2026-08-17 | P0-3, `feed_lots.ev_per_hour`, миграция `0044`, коммит `443649c` |
| [sale-survival-curve.md](sale-survival-curve.md) | ✅ | 2026-08-17 | P1-4 фаза B — кривая дожития вместо выдуманного срока продажи |
| [history-lot-reconstruction.md](history-lot-reconstruction.md) | ✅ | 2026-08-16 | Восстановление жизни лотов из снапшотов — стартовый набор для кривой дожития |
| [lot-observations.md](lot-observations.md) | ✅ | 2026-08-16 | P1-4 фаза A — таблица `lot_observations`, три исхода наблюдения |
| [quantile-sell-tiers.md](quantile-sell-tiers.md) | ✅ | 2026-08-16 | P0-1 — калибровка тиров по квантилям цен сделок |
| [ref-quality-floor.md](ref-quality-floor.md) | ✅ | 2026-08-16 | P0-2 — пол по данным, усадка опоры, trim выбросов |
| [sale-time-prediction-research.md](sale-time-prediction-research.md) | 📄 | 2026-08-16 | Что можно и чего нельзя предсказать о сроке продажи на наших данных |
| [profit-algo-review.md](profit-algo-review.md) | 📄 | 2026-08-14 | Разбор алгоритмов выгодности на прод-данных. Из него родились P0-1…P0-3 и P1-4 |
| [artifact-feed.md](artifact-feed.md) | ⚠️ | 2026-08-04 | Базовое ТЗ «Ленты» (1876 строк, Фазы 1–6 + Ревизии 1–4). **Ревизия 4 отменила уведомления и трансляцию в полосу сигналов**, ручка `GET /feed/signals` и параметр `lot_key` удалены — часть документа описывает несуществующее |
| [design-v5-implementation.md](design-v5-implementation.md) | ✅ | 2026-07-18 … 2026-08-03 | Дизайн-система «Терминал». Фазы 1–5 (07-18), Ф6 (07-19), Ф7 «Лента» (08-03) |
| [arsenal-items-verification.md](arsenal-items-verification.md) | ✅ | 2026-07-31 | +317 предметов в `master_items`. Внутри — мёртвая ссылка на репозиторий `stalcraft-database` (каталог переехал на `EXBO-Studio/stalzone-database` 2026-08-20), копировать URL оттуда нельзя |
| [mobile-adaptive-frontend.md](mobile-adaptive-frontend.md) | ✅ | 2026-07-29 | Мобильная версия, Фазы 1–5, коммит `82ba8a2`; прототип — `design/mobile/` |
| [reference-price-recency-weighted.md](reference-price-recency-weighted.md) | ✅ | 2026-07-27 | Опорная цена по свежести сделок вместо плоской медианы 7 дней |
| [audit-on-auction-status.md](audit-on-auction-status.md) | ✅ | 2026-07-24 | Статус торгуемости каталога через реальный API; гибридный фильтр финальный, Фаза B не нужна |
| [fix-favorite-card-stats-qlt-ptn.md](fix-favorite-card-stats-qlt-ptn.md) | ✅ | 2026-07-24 | Статистика карточки под фильтром качества/заточки, коммит `0367a96` |
| [telegram-notifications.md](telegram-notifications.md) | ✅ | 2026-07-21 | Перевод Telegram на RabbitMQ. ⚠️ Бот на проде в рестарт-лупе — прод-сервер не достаёт `api.telegram.org` (инфраструктура, не фича) |
| [web-push-notifications.md](web-push-notifications.md) | ✅ | 2026-07-20 | Web Push через RabbitMQ |
| [buy-sniper.md](buy-sniper.md) | ✅ | 2026-07-19 | Раздел «Закупки // Buy Sniper» вместо «Склада» |
| [design-v5-favorites-conformance.md](design-v5-favorites-conformance.md) | ✅ | 2026-07-18 | Приведение «Избранного» к эталону-прототипу. Внутри — мёртвая ссылка на `stalcraft-database` |
| [emission-notify-via-bot.md](emission-notify-via-bot.md) | ✅ | 2026-07-08 | Рассылка о выбросе перенесена из Celery worker в `telegram_bot` |
| [market-stats-spread-diff-skip.md](market-stats-spread-diff-skip.md) | ✅ | 2026-07-07 | Порционный пересчёт `market_statistics` — устранение часовых CPU-пиков |
| [cpu-spikes-recurring-2026-07-06.md](cpu-spikes-recurring-2026-07-06.md) | ✅ | 2026-07-07 | Расследование повторных CPU-спайков после фикса 2026-06-29 |
| [telegram-notification-bug.md](telegram-notification-bug.md) | ✅ | 2026-07-06 | Задержки 15–20 мин — убран блокирующий вызов |
| [emission-tracker.md](emission-tracker.md) | ✅ | 2026-07-06 | Таблица `emission_events` (миграция `0031`), задача `collect_emission` |
| [news-section.md](news-section.md) | ✅ | 2026-07-02 | Таблица `news` (миграция `0030`), 6 эндпоинтов |
| [faq-onboarding-stalzone-rebrand.md](faq-onboarding-stalzone-rebrand.md) | ✅ | 2026-06-29 | FAQ-онбординг + ребрендинг копирайта Stalcraft X → STALZONE |
| [backfill-rate-limit-burst-fix.md](backfill-rate-limit-burst-fix.md) | ✅ | 2026-06-29 | Фикс burst 429 в разовом backfill-скрипте (`BACKFILL_PAGE_DELAY`, ретраи) |
| [sales-history-qlt-ptn-coverage.md](sales-history-qlt-ptn-coverage.md) | ✅ | 2026-06-29 | Покрытие qlt/ptn — оказалось багом парсинга, а не ограничением API |
| [market-radar-sort-pagination.md](market-radar-sort-pagination.md) | ✅ | 2026-06-29 | Сортировка по выгодным лотам + пагинация «Радара» |
| [admin-stats-gaps.md](admin-stats-gaps.md) | ✅ | 2026-06-29 | Устранение пробелов после фазы «Статистика» |
| [admin-stats.md](admin-stats.md) | ✅ | 2026-06-28 | `GET /admin/stats` |
| [market-radar.md](market-radar.md) | ✅ | 2026-06-28 | «Радар рынка» — кросс-юзерная агрегация watchlist |
| [subscription-tiers.md](subscription-tiers.md) | ⚠️ | 2026-06-28 | Тарифы, Phase 0. **Реализована только Phase 0**, остальные фазы роадмапа — открытая задача в `NOTES.md` |
| [favorites-limit-override.md](favorites-limit-override.md) | ✅ | 2026-06-28 | Ручной override лимита избранного вне тарифа |
| [fix-publish-signals-nonetype.md](fix-publish-signals-nonetype.md) | ✅ | 2026-06-28 | `_publish_signals` падал на `'NoneType' object is not iterable` |
| [security-and-bugfix.md](security-and-bugfix.md) | ✅ | 2026-06-17 | 10 находок code review |
| [redesign-monitoring-page.md](redesign-monitoring-page.md) | ⚠️ | 2026-06-16 | Редизайн «Избранного» под UI v4. **Устарело**: страница дважды переделана — Design v5 «Терминал» (07-18) и мобильная версия (07-29) |
