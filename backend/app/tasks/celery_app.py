from celery import Celery
from celery.schedules import crontab
from app.core.config import settings

celery_app = Celery(
    "stalcraft",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks.collectors", "app.tasks.cleanup"],
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
        # Сбор активных лотов каждые 5 минут
        "collect-active-lots": {
            "task": "app.tasks.collectors.collect_all_active_lots",
            "schedule": crontab(minute="*/5"),
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
        # TODO: раскомментировать когда будут реализованы:
        # "generate-recommendations": {
        #     "task": "app.tasks.analyzers.generate_purchase_recommendations",
        #     "schedule": crontab(minute="5"),
        # },
        # "process-notification-queue": {
        #     "task": "app.tasks.notifications.process_queue",
        #     "schedule": crontab(minute="*/2"),
        # },
    },
)
