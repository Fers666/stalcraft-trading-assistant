"""
Celery задача глобального скана предметов вне watchlist.

Принцип: скользящий цикл ~24 часа.
Каждый час берётся батч из ~93 предметов и сканируется.
Предметы из активных watchlist исключаются — они уже собираются каждые 5 мин.

Почему скользящий, а не ночной:
  Ночные данные отражают тихий рынок. Скользящий цикл захватывает прайм-тайм
  естественно — данные актуальны в любое время суток.
"""

import logging
import statistics
from datetime import datetime, timezone, timedelta

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

BATCH_SIZE = 93         # предметов за один запуск (~1 час / 24 часа × 2236)
CURSOR_KEY = "global_scan:cursor"
DEFAULT_REGION = "RU"
EXPIRY_THRESHOLD_HOURS = 2


def run_async(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.global_scanner.run_global_feed_batch", bind=True, max_retries=2)
def run_global_feed_batch(self):
    """
    Обрабатывает один батч предметов из глобального скана.
    Вызывается раз в час (minute=30).
    """

    async def _run():
        from app.db.session import get_db_session
        from app.models.models import MasterItem, UserWatchlist, GlobalItemScan
        from app.services.collector.client import stalcraft_client
        from sqlalchemy import select
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        import redis.asyncio as aioredis
        from app.core.config import settings

        async with get_db_session() as db:
            # Собираем предметы из активных watchlist (их исключаем)
            watchlist_rows = (await db.execute(
                select(UserWatchlist.item_id, UserWatchlist.region)
                .where(UserWatchlist.is_active == True)
            )).all()
            watchlist_pairs = {(row.item_id, row.region) for row in watchlist_rows}

            # Все предметы каталога
            all_items = (await db.execute(
                select(MasterItem.item_id)
                .order_by(MasterItem.item_id)
            )).scalars().all()

            # Исключаем watchlist предметы для текущего региона
            feed_items = [
                item_id for item_id in all_items
                if (item_id, DEFAULT_REGION) not in watchlist_pairs
            ]

            if not feed_items:
                logger.info("Global scan: no items outside watchlist to scan")
                return

            # Получаем текущую позицию курсора из Redis
            r = await aioredis.from_url(settings.redis_url, decode_responses=True)
            try:
                cursor = int(await r.get(CURSOR_KEY) or 0)
                cursor = cursor % len(feed_items)

                # Берём батч
                batch = feed_items[cursor: cursor + BATCH_SIZE]
                next_cursor = (cursor + BATCH_SIZE) % len(feed_items)
                await r.set(CURSOR_KEY, next_cursor)

                logger.info(
                    f"Global scan batch: cursor={cursor}, items={len(batch)}, "
                    f"total_feed={len(feed_items)}, watchlist_excluded={len(watchlist_pairs)}"
                )
            finally:
                await r.aclose()

            # Сканируем батч
            original_region = stalcraft_client.region
            stalcraft_client.region = DEFAULT_REGION

            try:
                for item_id in batch:
                    try:
                        await _scan_single_item(db, item_id, DEFAULT_REGION)
                    except Exception as e:
                        logger.warning(f"Global scan failed for {item_id}: {e}")
            finally:
                stalcraft_client.region = original_region

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=300)


async def _scan_single_item(db, item_id: str, region: str):
    """
    Лёгкий скан одного предмета: только /lots, без raw_lots и buyout detection.
    Результат upsert-ится в global_item_scan.
    """
    from app.services.collector.client import stalcraft_client
    from app.models.models import GlobalItemScan
    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    now = datetime.now(timezone.utc)

    data = await stalcraft_client.get_auction_lots(item_id)
    lots = data.get("lots", [])

    if not lots:
        return

    def buyout_per_unit(lot):
        price = lot.get("buyoutPrice", 0) or lot.get("startPrice", 0)
        amount = lot.get("amount", 1)
        return price // amount if amount > 0 else price

    def end_hours_remaining(lot):
        end_str = lot.get("endTime")
        if not end_str:
            return None
        try:
            end = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
            return (end - now).total_seconds() / 3600
        except Exception:
            return None

    prices = [buyout_per_unit(l) for l in lots if buyout_per_unit(l) > 0]
    liquid_lots = [
        l for l in lots
        if (h := end_hours_remaining(l)) is not None and h >= EXPIRY_THRESHOLD_HOURS
    ]
    total_volume = sum(l.get("amount", 1) for l in lots)

    if not prices:
        return

    best_price = min(prices)
    avg_price = round(statistics.mean(prices), 2)
    price_spread = (max(prices) - min(prices)) / min(prices) * 100 if len(prices) > 1 else 0

    # Скор торгуемости: больше ликвидных лотов и объёма → выше; большой разброс → ниже
    liquid_count = len(liquid_lots)
    tradability_score = round(
        liquid_count * total_volume / (1 + price_spread), 2
    )

    # Получаем предыдущую цену для расчёта изменения
    existing = (await db.execute(
        select(GlobalItemScan).where(
            GlobalItemScan.item_id == item_id,
            GlobalItemScan.region == region,
        )
    )).scalar_one_or_none()

    prev_best = existing.best_price if existing else None
    price_change_pct = None
    if prev_best and prev_best > 0:
        price_change_pct = round((best_price - prev_best) / prev_best * 100, 2)

    # Upsert — одна запись на пару (item_id, region)
    stmt = pg_insert(GlobalItemScan).values(
        item_id=item_id,
        region=region,
        scanned_at=now,
        lot_count=len(lots),
        liquid_lot_count=liquid_count,
        best_price=best_price,
        avg_price=avg_price,
        total_volume=total_volume,
        prev_best_price=prev_best,
        price_change_pct=price_change_pct,
        tradability_score=tradability_score,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_id", "region"],
        set_={
            "scanned_at": stmt.excluded.scanned_at,
            "lot_count": stmt.excluded.lot_count,
            "liquid_lot_count": stmt.excluded.liquid_lot_count,
            "prev_best_price": GlobalItemScan.best_price,  # сохраняем текущую как предыдущую
            "best_price": stmt.excluded.best_price,
            "avg_price": stmt.excluded.avg_price,
            "total_volume": stmt.excluded.total_volume,
            "price_change_pct": stmt.excluded.price_change_pct,
            "tradability_score": stmt.excluded.tradability_score,
        },
    )
    await db.execute(stmt)
    await db.commit()

    logger.debug(
        f"Global scan: {item_id}/{region} "
        f"lots={len(lots)} liquid={liquid_count} "
        f"best={best_price} score={tradability_score}"
    )
