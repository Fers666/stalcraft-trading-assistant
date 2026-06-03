"""
Celery задачи аналитики: пересчёт рыночной статистики.
Запускается раз в час после сбора истории.
"""
import logging
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


def run_async(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.analyzers.calculate_stats_single")
def calculate_stats_single(item_id: str, region: str):
    """
    Пересчёт статистики для одного предмета.
    Вызывается сразу после сбора истории при добавлении в watchlist.
    """
    async def _run():
        from app.db.session import get_celery_db_session
        from app.services.analytics.market_stats import calculate_market_stats

        async with get_celery_db_session() as db:
            await calculate_market_stats(db=db, item_id=item_id, region=region)

    run_async(_run())


@celery_app.task(name="app.tasks.analyzers.calculate_all_market_stats", bind=True, max_retries=3)
def calculate_all_market_stats(self):
    """Пересчитывает market_statistics для всех активных watchlist записей."""

    async def _run():
        from app.db.session import get_celery_db_session
        from app.models.models import UserWatchlist
        from app.services.analytics.market_stats import calculate_market_stats
        from sqlalchemy import select

        async with get_celery_db_session() as db:
            watchlist = (await db.execute(
                select(UserWatchlist).where(UserWatchlist.is_active == True)
            )).scalars().all()

            # Дедупликация: считаем статистику один раз на пару (item_id, region)
            unique_pairs = {(e.item_id, e.region) for e in watchlist}
            logger.info(f"Calculating market stats for {len(unique_pairs)} unique pairs")

            for item_id, region in unique_pairs:
                try:
                    result = await calculate_market_stats(
                        db=db,
                        item_id=item_id,
                        region=region,
                    )
                    if result:
                        opts = result.sell_options or []
                        logger.info(
                            f"Stats calculated for {item_id}/{region} | "
                            f"sell_options={len(opts)} variants"
                        )
                    else:
                        logger.info(f"No sales data for {item_id}/{region} — stats skipped")
                except Exception as e:
                    logger.error(f"Failed to calculate stats for {item_id}/{region}: {e}")

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=120)
