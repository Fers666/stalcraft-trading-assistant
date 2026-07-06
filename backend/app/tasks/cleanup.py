import asyncio
import logging
from datetime import datetime, timezone
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(coro)
        # Drain отложенных transport-close callbacks перед loop.close() —
        # реальные ненулевые sleep, см. подробный комментарий в collectors.run_async.
        for _ in range(3):
            loop.run_until_complete(asyncio.sleep(0.01))
        return result
    finally:
        loop.close()


@celery_app.task(name="app.tasks.cleanup.delete_old_data")
def delete_old_data():
    """Удаляет данные старше 120 дней (запускается в 3:00 по МСК)."""

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import SalesHistory, CollectedData, PurchaseRecommendation
        from sqlalchemy import delete

        now = datetime.now(timezone.utc)

        async with get_db_session() as db:
            # Удаляем истёкшие sales_history
            r1 = await db.execute(
                delete(SalesHistory).where(SalesHistory.will_be_deleted_at <= now)
            )
            # Удаляем старые снэпшоты (старше 120 дней)
            from datetime import timedelta
            cutoff = now - timedelta(days=120)
            r2 = await db.execute(
                delete(CollectedData).where(CollectedData.collect_time < cutoff)
            )
            # Удаляем просроченные рекомендации
            r3 = await db.execute(
                delete(PurchaseRecommendation).where(PurchaseRecommendation.expires_at <= now)
            )
            await db.commit()

            logger.info(
                f"Cleanup: removed {r1.rowcount} sales_history, "
                f"{r2.rowcount} collected_data, "
                f"{r3.rowcount} expired recommendations"
            )

    run_async(_run())
