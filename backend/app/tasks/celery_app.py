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
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Europe/Moscow",
    enable_utc=True,
    worker_concurrency=2,
    task_routes={"app.tasks.*": {"queue": "collector"}},
    beat_schedule={
        # Сбор активных лотов: каждые 20 сек, динамический батч под TARGET_CYCLE_SEC (60с).
        # Сортировка по last_successful_check ASC — самые устаревшие идут первыми.
        "collect-active-lots": {
            "task": "app.tasks.collectors.collect_all_active_lots",
            "schedule": timedelta(seconds=20),
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
        # Telegram-уведомления — обрабатываются telegram_bot сервисом (polling),
        # scan_and_notify отключён во избежание дублирования.
        # Трекинг радиационных выбросов — каждые 2 минуты, 1 токен/запрос.
        "collect-emission": {
            "task": "app.tasks.collectors.collect_emission",
            "schedule": timedelta(seconds=120),
        },
    },
)
