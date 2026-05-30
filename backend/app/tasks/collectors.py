"""
Celery задачи сбора данных аукциона.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.collectors.collect_all_active_lots", bind=True, max_retries=3)
def collect_all_active_lots(self):
    """Собирает активные лоты для всех активных watchlist записей."""

    async def _run():
        from app.db.session import get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select

        async with get_db_session() as db:
            watchlist = (await db.execute(
                select(UserWatchlist).where(UserWatchlist.is_active == True)
            )).scalars().all()

            logger.info(f"Collecting lots for {len(watchlist)} watchlist items")

            for entry in watchlist:
                try:
                    await _collect_lots_for_item(db, entry)
                except Exception as e:
                    logger.error(f"Failed to collect lots for {entry.item_id}: {e}")
                    # Обновляем статус ошибки
                    entry.error_status = str(e)
                    await db.commit()

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(name="app.tasks.collectors.collect_all_history", bind=True, max_retries=3)
def collect_all_history(self):
    """Собирает историю продаж (раз в час)."""

    async def _run():
        from app.db.session import get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select

        async with get_db_session() as db:
            watchlist = (await db.execute(
                select(UserWatchlist).where(UserWatchlist.is_active == True)
            )).scalars().all()

            for entry in watchlist:
                try:
                    await _collect_history_for_item(db, entry)
                except Exception as e:
                    logger.error(f"Failed to collect history for {entry.item_id}: {e}")

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=120)


@celery_app.task(name="app.tasks.collectors.collect_single_item")
def collect_single_item(user_id: int, item_id: str, region: str):
    """
    Ручной сбор для одного предмета.
    Вызывается из API — не чаще раза в 2 минуты (throttle в Redis).
    """
    async def _run():
        from app.db.session import get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select

        async with get_db_session() as db:
            entry = (await db.execute(
                select(UserWatchlist).where(
                    UserWatchlist.user_id == user_id,
                    UserWatchlist.item_id == item_id,
                    UserWatchlist.region == region,
                )
            )).scalar_one_or_none()

            if entry:
                await _collect_lots_for_item(db, entry)

    run_async(_run())


async def _collect_lots_for_item(db, entry):
    """Собирает снэпшот лотов, разделяет ликвидные/неликвидные, детектирует выкупы."""
    from app.services.collector.client import stalcraft_client
    from app.services.cache.api_cache import api_cache
    from app.models.models import CollectedData, SalesHistory
    from sqlalchemy import select
    import statistics

    client_region = stalcraft_client.region
    stalcraft_client.region = entry.region

    EXPIRY_THRESHOLD_HOURS  = 2     # лот считается неликвидным если < 2ч до конца
    BUYOUT_BUFFER_MINUTES   = 10    # буфер: лот точно выкуплен если исчез за N мин до endTime
    RELIST_PRICE_THRESHOLD  = 1.20  # лот дороже рынка на 20%+ → вероятно перевыставление

    try:
        now = datetime.now(timezone.utc)
        data = await stalcraft_client.get_auction_lots(entry.item_id)
        lots = data.get("lots", [])

        # Обновляем кэш свежими данными сразу после получения от API
        await api_cache.set_lots(entry.region, entry.item_id, data)

        if not lots:
            return

        def lot_price_per_unit(lot):
            buyout = lot.get("buyoutPrice", 0)
            start = lot.get("startPrice", 0)
            price = buyout if buyout > 0 else start
            amount = lot.get("amount", 1)
            return price // amount if amount > 0 else price

        def lot_end_time(lot):
            end_str = lot.get("endTime")
            if not end_str:
                return None
            return datetime.fromisoformat(end_str.replace("Z", "+00:00"))

        # Разделяем лоты на ликвидные и истекающие
        liquid_lots = []
        expiring_lots = []
        for lot in lots:
            end = lot_end_time(lot)
            if end is None:
                liquid_lots.append(lot)
                continue
            hours_left = (end - now).total_seconds() / 3600
            if hours_left >= EXPIRY_THRESHOLD_HOURS:
                liquid_lots.append(lot)
            else:
                expiring_lots.append(lot)

        all_prices = [lot_price_per_unit(l) for l in lots if lot_price_per_unit(l) > 0]
        liquid_prices = [lot_price_per_unit(l) for l in liquid_lots if lot_price_per_unit(l) > 0]

        best_lot = min(lots, key=lot_price_per_unit, default=None) if lots else None
        amounts = [lot.get("amount", 1) for lot in lots]

        # ── Детектирование выкупов ───────────────────────────────────────────
        # Берём предыдущий снэпшот и сравниваем по startTime лота
        prev_snapshot = (await db.execute(
            select(CollectedData)
            .where(
                CollectedData.user_id == entry.user_id,
                CollectedData.item_id == entry.item_id,
                CollectedData.region == entry.region,
            )
            .order_by(CollectedData.collect_time.desc())
            .limit(1)
        )).scalar_one_or_none()

        detected_buyouts = 0
        if prev_snapshot and prev_snapshot.raw_lots:
            current_start_times = {lot.get("startTime") for lot in lots}
            for prev_lot in prev_snapshot.raw_lots:
                start_time = prev_lot.get("startTime")
                end_str = prev_lot.get("endTime")
                if not start_time or not end_str:
                    continue

                # Лот был, теперь его нет
                if start_time in current_start_times:
                    continue

                end_time = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                # Лот исчез ДО истечения (с буфером) → выкупили
                if now < end_time - timedelta(minutes=BUYOUT_BUFFER_MINUTES):
                    buyout_price = prev_lot.get("buyoutPrice", 0)
                    amount = prev_lot.get("amount", 1)
                    price_per_unit = buyout_price // amount if amount > 0 else buyout_price

                    # Фильтр перевыставлений: если цена пропавшего лота была на 20%+
                    # выше текущего ликвидного минимума — скорее всего продавец
                    # снял лот и перевыставил по рыночной цене, а не продал
                    current_min = min(liquid_prices) if liquid_prices else None
                    if current_min and price_per_unit > current_min * RELIST_PRICE_THRESHOLD:
                        logger.debug(
                            f"Skipping probable relist: {entry.item_id} price={price_per_unit} "
                            f"vs market={current_min} ({price_per_unit/current_min:.0%})"
                        )
                        continue

                    detected_buyouts += 1
                    if price_per_unit > 0:
                        db.add(SalesHistory(
                            user_id=entry.user_id,
                            item_id=entry.item_id,
                            region=entry.region,
                            sale_time=now,
                            price_per_unit=price_per_unit,
                            amount=amount,
                            total_price=buyout_price,
                            additional_info={"source": "buyout_detection",
                                             "lot_start": start_time,
                                             "lot_end": end_str},
                            will_be_deleted_at=now + timedelta(days=120),
                        ))

        snapshot = CollectedData(
            user_id=entry.user_id,
            item_id=entry.item_id,
            region=entry.region,
            collect_time=now,
            collect_type="auto",
            total_lots=len(lots),
            total_available_amount=sum(amounts),
            best_price_per_unit=min(all_prices) if all_prices else None,
            best_price_total=best_lot.get("buyoutPrice") if best_lot else None,
            best_price_amount=best_lot.get("amount") if best_lot else None,
            best_lot_id=best_lot.get("startTime") if best_lot else None,
            avg_price_per_unit=round(statistics.mean(all_prices), 2) if all_prices else None,
            median_price_per_unit=round(statistics.median(all_prices), 2) if all_prices else None,
            min_price_per_unit=min(all_prices) if all_prices else None,
            max_price_per_unit=max(all_prices) if all_prices else None,
            best_buyout_per_unit=min(all_prices) if all_prices else None,
            liquid_lots_count=len(liquid_lots),
            expiring_lots_count=len(expiring_lots),
            detected_buyouts_count=detected_buyouts,
            best_liquid_price_per_unit=min(liquid_prices) if liquid_prices else None,
            raw_lots=lots[:50],
        )
        db.add(snapshot)

        entry.last_successful_check = now
        entry.error_status = None

        await db.commit()
        logger.info(
            f"Collected {len(lots)} lots for {entry.item_id} | "
            f"liquid={len(liquid_lots)} expiring={len(expiring_lots)} buyouts={detected_buyouts}"
        )

    finally:
        stalcraft_client.region = client_region


async def _collect_history_for_item(db, entry):
    """Собирает историю продаж и сохраняет в sales_history."""
    from app.services.collector.client import stalcraft_client
    from app.models.models import SalesHistory
    from datetime import timedelta

    client_region = stalcraft_client.region
    stalcraft_client.region = entry.region

    try:
        data = await stalcraft_client.get_auction_history(entry.item_id)
        prices = data.get("prices", [])

        cutoff = datetime.now(timezone.utc) - timedelta(days=120)

        for record in prices:
            sold_at_str = record.get("time")
            if not sold_at_str:
                continue

            sold_at = datetime.fromisoformat(sold_at_str.replace("Z", "+00:00"))
            if sold_at < cutoff:
                continue

            total_price = record.get("price", 0)
            amount = record.get("amount", 1)
            price_per_unit = total_price // amount if amount > 0 else total_price

            sh = SalesHistory(
                user_id=entry.user_id,
                item_id=entry.item_id,
                region=entry.region,
                sale_time=sold_at,
                price_per_unit=price_per_unit,
                amount=amount,
                total_price=total_price,
                additional_info=record.get("additional"),
                will_be_deleted_at=sold_at + timedelta(days=120),
            )
            db.add(sh)

        await db.commit()

    finally:
        stalcraft_client.region = client_region
