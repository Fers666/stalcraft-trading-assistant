from celery import Celery
from celery.schedules import crontab
from datetime import timedelta
from app.core.config import settings

celery_app = Celery(
    "stalcraft",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.tasks.collectors",
        "app.tasks.cleanup",
        "app.tasks.analyzers",
        "app.tasks.tiers",
        "app.tasks.audit",
        "app.tasks.feed_collector",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Europe/Moscow",
    enable_utc=True,
    # 3 при 4 ядрах: четвёртое оставлено postgres и backend. При concurrency=2
    # потолок задавали слоты, а не ядра — добавление ядер на сервер не давало
    # ничего, оба слота были заняты постоянно (замер 2026-08-06: очередь
    # collector 2330 задач и растёт).
    worker_concurrency=3,
    task_routes={"app.tasks.*": {"queue": "collector"}},
    beat_schedule={
        # Сбор активных лотов: каждые 20 сек, динамический батч под TARGET_CYCLE_SEC (60с).
        # Сортировка по last_successful_check ASC — самые устаревшие идут первыми.
        #
        # expires = такт расписания: прогон идёт 22–38с при такте 20с, и без
        # срока годности неуспевшие тики копились в очереди бесконечно (лаг рос
        # часами, предмет обновлялся раз в ~140с вместо 60с). Просроченный тик
        # бессмысленен — следующий соберёт те же предметы по свежему
        # last_successful_check, поэтому его выбрасываем, а не выполняем.
        "collect-active-lots": {
            "task": "app.tasks.collectors.collect_all_active_lots",
            "schedule": timedelta(seconds=20),
            "options": {"expires": 20},
        },
        # Сбор истории раз в час
        "collect-history-and-stats": {
            "task": "app.tasks.collectors.collect_all_history",
            "schedule": crontab(minute="0"),
        },
        # Очистка данных старше 120 дней каждую ночь в 3:00
        "cleanup-old-data": {
            "task": "app.tasks.cleanup.delete_old_data",
            "schedule": crontab(hour=3, minute=0),
        },
        # Порционный пересчёт статистики: 10 слотов в час (:12..:57), каждая пара —
        # ровно один слот (crc32 % 10). Окно :00–:11 оставлено collect_all_history
        # (сдвиг фаз вместо цепочки — мотивация 9f8086e сохранена). Дифф-пропуск пар
        # без новых продаж; в 04:xx МСК — принудительный полный круг.
        # timezone="Europe/Moscow" → crontab-минуты и вычисление слота в задаче
        # согласованы по МСК.
        "calculate-market-stats-batch": {
            "task": "app.tasks.analyzers.calculate_market_stats_batch",
            "schedule": crontab(minute="12-59/5"),
        },
        # Сверка предсказаний signal_outcomes с фактическими продажами — раз в сутки
        "evaluate-signal-outcomes": {
            "task": "app.tasks.analyzers.evaluate_signal_outcomes",
            "schedule": crontab(hour=4, minute=30),
        },
        # Понижение тарифов с истёкшим tier_expires_at — после cleanup (3:00),
        # до ночного force-круга статистики (04:12+). Не обращается к Stalcraft API.
        "sweep-expired-tiers": {
            "task": "app.tasks.tiers.sweep_expired_tiers",
            "schedule": crontab(hour=3, minute=30),
        },
        # ── Лента артефактов (docs/tasks/artifact-feed.md) ──────────────────
        # Обход всех артефактов с полной пагинацией /lots. Раз в минуту по
        # СТЕННЫМ часам (crontab), а не timedelta(60): у timedelta фаза
        # привязана к моменту старта beat, поэтому при рестарте контейнеров
        # цикл ленты выпускался в ту же секунду, что и watchlist-тик и
        # collect_emission — форма всплеска, дававшая реальные 429 при среднем
        # расходе всего ~42% лимита. Внутри задачи старт дополнительно смещён
        # джиттером FEED_CYCLE_JITTER_SEC. Наложения прогонов не бывает:
        # Redis-лок feed:scan:lock. В окне collect_all_history (:00–:11) цикл
        # выпускается по расписанию, но сам урезает бюджет и порог
        # предохранителя (FEED_WINDOW_* в feed_collector.py) — джиттера в 10 с
        # не хватало, чтобы развести ленту с одиннадцатиминутным всплеском
        # истории, и верхушка каждого часа давала 429.
        # expires чуть меньше такта: цикл занимает 58–73с при такте 60с, так что
        # неуспевший тик обязан умереть — иначе лента вытесняет watchlist из
        # очереди и сама выполняется не в ту минуту, на которую планировалась
        # (замер 2026-08-06: 11 циклов подряд отменены предохранителем «окно
        # истории», units=0).
        "collect-artifact-lots": {
            "task": "app.tasks.feed_collector.collect_artifact_lots",
            "schedule": crontab(minute="*"),
            "options": {"expires": 55},
        },
        # История продаж по всем артефактам (опора расчёта прибыли) — раз в час
        # на :15 (окно :00–:11 занято collect_all_history, слот :14 —
        # calculate_artifact_variant_stats, к API не ходит). Обход растянут
        # HISTORY_ITEM_DELAY примерно на 4 минуты (~52 ед/мин вместо 206 ед за
        # одну минуту) и смещён джиттером FEED_HISTORY_JITTER_SEC.
        "collect-artifact-history": {
            "task": "app.tasks.feed_collector.collect_artifact_history",
            "schedule": crontab(minute="15"),
        },
        # Статистика вариантов «предмет × качество × заточка» — опора скоринга
        # ленты. Слоты :14,:24,:34,:44,:54: шаг 10 мин, не пересекается ни с
        # окном collect_all_history (:00–:11), ни со слотами
        # calculate_market_stats_batch (:12–:57 шаг 5) — чтобы не воспроизвести
        # docs/tasks/cpu-spikes-recurring-2026-07-06.md.
        "calculate-artifact-variant-stats": {
            "task": "app.tasks.feed_collector.calculate_artifact_variant_stats",
            "schedule": crontab(minute="14,24,34,44,54"),
        },
        # Исходы наблюдений за лотами (docs/tasks/lot-observations.md §5) —
        # раз в 15 мин, к Stalcraft API не обращается. Минуты :13,:28,:43,:58
        # свободны от слотов calculate_market_stats_batch (:12–:57 шагом 5),
        # calculate_artifact_variant_stats (:14,:24,:34,:44,:54) и
        # collect_artifact_history (:15) — чтобы не складывать нагрузку на БД
        # (docs/tasks/cpu-spikes-recurring-2026-07-06.md).
        "resolve-lot-observations": {
            "task": "app.tasks.feed_collector.resolve_lot_observations",
            "schedule": crontab(minute="13,28,43,58"),
        },
        # Кривая дожития (docs/tasks/sale-survival-curve.md, P1-4 фаза B) —
        # раз в сутки: окно выборки 14 дней, и за час оно не меняется настолько,
        # чтобы это было видно в стратах по 200+ наблюдений. 04:07 — низкая
        # активность рынка, и минута не совпадает ни с одним другим слотом.
        "recalc-sale-survival": {
            "task": "app.tasks.analyzers.recalc_sale_survival",
            "schedule": crontab(hour="4", minute="7"),
        },
        # Telegram-уведомления — обрабатываются telegram_bot сервисом (polling),
        # scan_and_notify отключён во избежание дублирования.
        # Трекинг радиационных выбросов — каждые 2 минуты, 1 токен/запрос.
        "collect-emission": {
            "task": "app.tasks.collectors.collect_emission",
            "schedule": timedelta(seconds=120),
            "options": {"expires": 110},
        },
    },
)
