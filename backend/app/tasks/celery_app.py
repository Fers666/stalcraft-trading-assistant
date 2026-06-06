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
        "app.tasks.global_scanner",
        "app.tasks.notifications",
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
        # Сбор активных лотов: каждые 20 сек, 1 предмет за запуск → 3 лота/мин.
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
        # Telegram-уведомления о выгодных лотах — каждые 2 минуты
        "notify-profitable-lots": {
            "task": "app.tasks.notifications.scan_and_notify",
            "schedule": timedelta(minutes=2),
        },
    },
)
