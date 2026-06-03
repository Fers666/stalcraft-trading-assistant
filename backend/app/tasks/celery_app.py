from celery import Celery
from celery.schedules import crontab
from app.core.config import settings

celery_app = Celery(
    "stalcraft",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.tasks.collectors",
        "app.tasks.cleanup",
        "app.tasks.analyzers",
        "app.tasks.global_scanner",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Europe/Moscow",
    enable_utc=True,
    worker_concurrency=1,
    task_routes={"app.tasks.*": {"queue": "collector"}},
    beat_schedule={
        # Сбор активных лотов: каждую минуту, берёт только "просроченные" записи
        # (last_successful_check < now - 5 мин). Нагрузка размазана по времени.
        "collect-active-lots": {
            "task": "app.tasks.collectors.collect_all_active_lots",
            "schedule": crontab(minute="*"),
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
        # Пересчёт рыночной статистики через 5 минут после сбора истории
        "calculate-market-stats": {
            "task": "app.tasks.analyzers.calculate_all_market_stats",
            "schedule": crontab(minute="5"),
        },
        # Глобальный скан предметов вне watchlist (10 предметов/мин → полный цикл ~4 ч)
        "global-feed-batch": {
            "task": "app.tasks.global_scanner.run_global_feed_batch",
            "schedule": crontab(minute="*"),
        },
        # "process-notification-queue": {
        #     "task": "app.tasks.notifications.process_queue",
        #     "schedule": crontab(minute="*/2"),
        # },
    },
)
