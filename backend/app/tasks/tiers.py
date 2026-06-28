"""
Celery задачи целостности тарифов — отдельная зона ответственности от
cleanup.py (там про удаление старых данных, здесь про корректность tier).
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


@celery_app.task(name="app.tasks.tiers.sweep_expired_tiers")
def sweep_expired_tiers():
    """Понижает до base всех пользователей с истёкшим tier_expires_at.
    Дополняет ленивое понижение — гарантирует, что админка не показывает
    устаревший тариф у давно неактивных пользователей."""

    async def _run():
        from app.db.session import get_celery_db_session
        from app.models.models import User
        from app.core.tiers import TIERS, deactivate_excess_watchlist
        from sqlalchemy import select, update
        from datetime import datetime, timezone

        async with get_celery_db_session() as db:
            expired_ids = (await db.execute(
                select(User.id).where(
                    User.tier != "base", User.is_admin == False,
                    User.tier_expires_at.isnot(None),
                    User.tier_expires_at < datetime.now(timezone.utc),
                )
            )).scalars().all()

            if not expired_ids:
                logger.info("sweep_expired_tiers: no expired tiers found")
                return

            for user_id in expired_ids:
                await deactivate_excess_watchlist(user_id, TIERS["base"].watchlist_limit, db)

            await db.execute(
                update(User)
                .where(User.id.in_(expired_ids))
                .values(tier="base", tier_expires_at=None)
            )
            await db.commit()
            logger.info(f"sweep_expired_tiers: downgraded {len(expired_ids)} user(s) to base")

    run_async(_run())
