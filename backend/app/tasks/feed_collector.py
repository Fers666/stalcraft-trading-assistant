"""
Адаптивный коллектор Ленты.

Запускается каждые 30 секунд. Использует только остаток rate-limit после мониторинга.
Приоритет: UserWatchlist (Избранное) > FeedWatchlist (Лента).

Алгоритм:
  1. Считаем уникальные пары (item_id, region) в UserWatchlist — это мониторинг.
  2. Вычисляем доступный бюджет: 400/60 - (monitoring_pairs * 2 / 20) req/sec.
  3. Если бюджет ≤ 0 — пропускаем запуск.
  4. Считаем items_per_run = int(available_per_sec * 30) // 2 (30 сек, 2 токена/запрос).
  5. Feed items, которые покрыты UserWatchlist — статистику читаем из CollectedData (без API).
  6. Остальные — запрашиваем у API (не более items_per_run за запуск).
  7. После сбора — обновляем cached stats в feed_watchlist.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

RATE_LIMIT_PER_MIN = 400
TOKENS_PER_REQUEST = 2           # каждый /lots запрос = 2 токена
MONITORING_INTERVAL_SEC = 20     # интервал мониторинга (celery beat)
FEED_INTERVAL_SEC = 30           # интервал ленты (celery beat)
REQUEST_DELAY_SEC = 0.5          # пауза между API-запросами


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.feed_collector.collect_feed_lots", bind=True, max_retries=2)
def collect_feed_lots(self):
    """
    Адаптивный сбор лотов для Ленты.
    Запускается каждые 30 секунд через beat_schedule.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import (
            FeedWatchlist, UserWatchlist, CollectedData, UserSettings
        )
        from app.services.feed_stats import compute_feed_stats
        from sqlalchemy import select, func, asc, nullsfirst

        async with get_db_session() as db:
            # ── 1. Мониторинг: уникальные (item_id, region) ─────────────────
            monitoring_pairs_row = await db.execute(
                select(func.count()).select_from(
                    select(UserWatchlist.item_id, UserWatchlist.region)
                    .where(UserWatchlist.is_active == True)
                    .distinct()
                    .subquery()
                )
            )
            monitoring_pairs = monitoring_pairs_row.scalar() or 0

            # ── 2. Бюджет req/sec для ленты ──────────────────────────────────
            monitoring_req_per_sec = (monitoring_pairs * TOKENS_PER_REQUEST) / MONITORING_INTERVAL_SEC
            available_per_sec = (RATE_LIMIT_PER_MIN / 60) - monitoring_req_per_sec

            if available_per_sec <= 0:
                logger.info(
                    f"feed_collector: skipping — monitoring uses all budget "
                    f"({monitoring_pairs} pairs × {TOKENS_PER_REQUEST} tokens / {MONITORING_INTERVAL_SEC}s)"
                )
                return

            items_per_run = max(1, int(available_per_sec * FEED_INTERVAL_SEC) // TOKENS_PER_REQUEST)
            logger.info(
                f"feed_collector: budget={available_per_sec:.2f} req/s → {items_per_run} items this run"
            )

            # ── 3. Пары из мониторинга (для быстрого lookup) ─────────────────
            monitoring_set = set(
                row for row in (await db.execute(
                    select(UserWatchlist.item_id, UserWatchlist.region)
                    .where(UserWatchlist.is_active == True)
                    .distinct()
                )).all()
            )

            # ── 4. Все feed items, отсортированные по давности обновления ────
            feed_items = (await db.execute(
                select(FeedWatchlist)
                .where(FeedWatchlist.is_active == True)
                .order_by(nullsfirst(asc(FeedWatchlist.last_collected_at)))
            )).scalars().all()

            if not feed_items:
                return

            # Разбиваем на: покрытые мониторингом (бесплатно) и остальные (API)
            covered  = [f for f in feed_items if (f.item_id, f.region) in monitoring_set]
            uncovered = [f for f in feed_items if (f.item_id, f.region) not in monitoring_set]

            # ── 5. Покрытые мониторингом — читаем из CollectedData ───────────
            now = datetime.now(timezone.utc)
            for feed_entry in covered:
                try:
                    user_settings = (await db.execute(
                        select(UserSettings).where(UserSettings.user_id == feed_entry.user_id)
                    )).scalar_one_or_none()
                    margin = float(user_settings.min_profit_margin_percent or 0) if user_settings else 0.0

                    stats = await compute_feed_stats(
                        db, feed_entry.item_id, feed_entry.region,
                        feed_entry.quality_filter, feed_entry.enchant_filter,
                        min_profit_margin_pct=margin,
                    )
                    feed_entry.sales_7d              = stats.sales_7d
                    feed_entry.sales_24h             = stats.sales_24h
                    feed_entry.profitable_lots_count = stats.profitable_lots_count
                    feed_entry.avg_profit            = stats.avg_profit
                    feed_entry.last_collected_at     = now
                except Exception as e:
                    logger.error(
                        f"feed_collector: stats update failed for covered "
                        f"{feed_entry.item_id}/{feed_entry.region}: {e}"
                    )

            if covered:
                await db.commit()

            # ── 6. Некрытые — API-запросы (с учётом бюджета) ─────────────────
            to_collect = uncovered[:items_per_run]
            if not to_collect:
                return

            from app.services.collector.client import stalcraft_client
            from app.services.cache.api_cache import api_cache
            from app.models.models import CollectedData as CD
            import statistics as _statistics

            for i, feed_entry in enumerate(to_collect):
                try:
                    old_region = stalcraft_client.region
                    stalcraft_client.region = feed_entry.region
                    try:
                        data = await stalcraft_client.get_auction_lots(feed_entry.item_id)
                    finally:
                        stalcraft_client.region = old_region

                    lots = data.get("lots", [])
                    if lots:
                        await api_cache.set_lots(feed_entry.region, feed_entry.item_id, data)

                        def ppu(lot):
                            p = lot.get("buyoutPrice", 0) or lot.get("startPrice", 0)
                            a = lot.get("amount", 1)
                            return p // a if a > 0 else p

                        def hrs_left(lot) -> float | None:
                            s = lot.get("endTime")
                            if not s:
                                return None
                            end = datetime.fromisoformat(s.replace("Z", "+00:00"))
                            return (end - now).total_seconds() / 3600

                        liquid   = [l for l in lots if (h := hrs_left(l)) is None or h >= 2]
                        expiring = [l for l in lots if (h := hrs_left(l)) is not None and h < 2]
                        prices   = [ppu(l) for l in lots    if ppu(l) > 0]
                        liqprice = [ppu(l) for l in liquid  if ppu(l) > 0]
                        best_lot = min(lots, key=ppu, default=None)

                        snap = CD(
                            user_id=None,
                            item_id=feed_entry.item_id,
                            region=feed_entry.region,
                            collect_time=now,
                            collect_type="feed",
                            total_lots=len(lots),
                            total_available_amount=sum(l.get("amount", 1) for l in lots),
                            best_price_per_unit=min(prices) if prices else None,
                            best_price_total=best_lot.get("buyoutPrice") if best_lot else None,
                            best_price_amount=best_lot.get("amount") if best_lot else None,
                            best_lot_id=best_lot.get("startTime") if best_lot else None,
                            avg_price_per_unit=round(_statistics.mean(prices), 2) if prices else None,
                            median_price_per_unit=round(_statistics.median(prices), 2) if prices else None,
                            min_price_per_unit=min(prices) if prices else None,
                            max_price_per_unit=max(prices) if prices else None,
                            best_buyout_per_unit=min(prices) if prices else None,
                            liquid_lots_count=len(liquid),
                            expiring_lots_count=len(expiring),
                            detected_buyouts_count=None,
                            best_liquid_price_per_unit=min(liqprice) if liqprice else None,
                            raw_lots=sorted(lots, key=ppu)[:200],
                        )
                        db.add(snap)
                        await db.commit()

                    # Обновляем cached stats
                    user_settings = (await db.execute(
                        select(UserSettings).where(UserSettings.user_id == feed_entry.user_id)
                    )).scalar_one_or_none()
                    margin = float(user_settings.min_profit_margin_percent or 0) if user_settings else 0.0

                    stats = await compute_feed_stats(
                        db, feed_entry.item_id, feed_entry.region,
                        feed_entry.quality_filter, feed_entry.enchant_filter,
                        min_profit_margin_pct=margin,
                    )
                    feed_entry.sales_7d              = stats.sales_7d
                    feed_entry.sales_24h             = stats.sales_24h
                    feed_entry.profitable_lots_count = stats.profitable_lots_count
                    feed_entry.avg_profit            = stats.avg_profit
                    feed_entry.last_collected_at     = now
                    await db.commit()

                    logger.info(
                        f"feed_collector: collected {feed_entry.item_id}/{feed_entry.region} "
                        f"lots={len(lots) if lots else 0}"
                    )

                except Exception as e:
                    logger.error(
                        f"feed_collector: failed {feed_entry.item_id}/{feed_entry.region}: {e}"
                    )

                if i < len(to_collect) - 1:
                    await asyncio.sleep(REQUEST_DELAY_SEC)

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=30)
