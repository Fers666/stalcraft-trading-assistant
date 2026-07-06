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
        result = loop.run_until_complete(coro)
        # Drain pending transport-close callbacks: real non-zero sleeps (not
        # sleep(0)) — asyncio transport teardown may be deferred to writer
        # callbacks that only fire on an actual select() poll with non-zero
        # timeout; a single sleep(0) is one tick without a real poll and
        # leaves sockets open after loop.close() (см. collectors.run_async).
        for _ in range(3):
            loop.run_until_complete(asyncio.sleep(0.01))
        return result
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
                    await db.rollback()
                    logger.error(f"Failed to calculate stats for {item_id}/{region}: {e}")

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=120)


@celery_app.task(name="app.tasks.analyzers.evaluate_signal_outcomes", bind=True, max_retries=3)
def evaluate_signal_outcomes(self):
    """
    Сверяет ранее залогированные предсказания (signal_outcomes) с фактическими
    продажами из sales_history, заполняет realized_price/realized_hours/outcome.

    Строка обрабатывается, когда прошло >= predicted_hours с момента создания
    (ожидаемое время продажи) или >= 7 дней (таймаут — "not_sold").
    Подходящая продажа ищется по item/region(/qlt/ptn), цена в пределах ±15%
    от predicted_sell_price, время продажи в [created_at, now].
    """

    async def _run():
        from datetime import datetime, timedelta, timezone
        from app.db.session import get_celery_db_session
        from app.models.models import SignalOutcome, SalesHistory
        from sqlalchemy import select, or_

        NOT_SOLD_TIMEOUT = timedelta(days=7)
        PRICE_TOLERANCE = 0.15

        now = datetime.now(timezone.utc)

        async with get_celery_db_session() as db:
            pending = (await db.execute(
                select(SignalOutcome).where(SignalOutcome.evaluated_at.is_(None))
            )).scalars().all()

            evaluated_count = 0
            for row in pending:
                created_at = row.created_at
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)

                age = now - created_at
                predicted_hours = float(row.predicted_hours) if row.predicted_hours else 0.0
                timed_out = age >= NOT_SOLD_TIMEOUT

                if age < timedelta(hours=predicted_hours) and not timed_out:
                    continue

                predicted_price = row.predicted_sell_price
                price_lo = predicted_price * (1 - PRICE_TOLERANCE)
                price_hi = predicted_price * (1 + PRICE_TOLERANCE)

                q = (
                    select(SalesHistory)
                    .where(
                        SalesHistory.item_id == row.item_id,
                        SalesHistory.region == row.region,
                        SalesHistory.sale_time >= created_at,
                        SalesHistory.sale_time <= now,
                        SalesHistory.price_per_unit >= price_lo,
                        SalesHistory.price_per_unit <= price_hi,
                    )
                    .order_by(SalesHistory.sale_time.asc())
                )
                # qlt/ptn == 0 означает "0 или не указано" (Обычный / Не точёный) —
                # та же семантика, что и в profitable_lots.compute_signals_for_entry.
                if row.quality_filter is not None:
                    if row.quality_filter == 0:
                        q = q.where(or_(
                            SalesHistory.additional_info["qlt"].astext.is_(None),
                            SalesHistory.additional_info["qlt"].astext == "0",
                        ))
                    else:
                        q = q.where(SalesHistory.additional_info["qlt"].astext == str(row.quality_filter))
                if row.enchant_filter is not None:
                    if row.enchant_filter == 0:
                        q = q.where(or_(
                            SalesHistory.additional_info["ptn"].astext.is_(None),
                            SalesHistory.additional_info["ptn"].astext == "0",
                        ))
                    else:
                        q = q.where(SalesHistory.additional_info["ptn"].astext == str(row.enchant_filter))

                sale = (await db.execute(q)).scalars().first()

                if sale:
                    sale_time = sale.sale_time
                    if sale_time.tzinfo is None:
                        sale_time = sale_time.replace(tzinfo=timezone.utc)
                    row.realized_price = sale.price_per_unit
                    row.realized_hours = round((sale_time - created_at).total_seconds() / 3600, 2)
                    row.outcome = "sold_at_or_above" if sale.price_per_unit >= predicted_price else "sold_below"
                    row.evaluated_at = now
                    evaluated_count += 1
                elif timed_out:
                    row.outcome = "not_sold"
                    row.evaluated_at = now
                    evaluated_count += 1

            await db.commit()
            logger.info(
                f"evaluate_signal_outcomes: evaluated {evaluated_count}/{len(pending)} pending rows"
            )

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=300)
