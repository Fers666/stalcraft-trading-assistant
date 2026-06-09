"""
Celery задачи сбора данных аукциона.
"""
import asyncio
import logging
import math
from datetime import datetime, timezone, timedelta

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

LOTS_REFRESH_INTERVAL = 20    # секунд между обновлениями одного предмета (задача каждые 20 сек)
LOTS_REQUEST_DELAY    = 0.5   # секунд между API-запросами (0.5 → 35 шт. умещаются в 20 сек)
TARGET_CYCLE_SEC      = 120   # целевой полный цикл обновления всех уникальных предметов
MAX_LOTS_PER_RUN      = 35    # потолок: 35 × 0.5s = 17.5s < 20s расписания
MIN_LOTS_PER_RUN      = 5     # минимум при малом вотчлисте


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.collectors.collect_all_active_lots", bind=True, max_retries=3)
def collect_all_active_lots(self):
    """
    Собирает активные лоты для watchlist записей, у которых подошло время обновления.

    Запускается каждые 20 сек (timedelta), обрабатывает 1 предмет за запуск → 3 лота/мин.
    Порядок: last_successful_check ASC NULLS FIRST — самые устаревшие идут первыми (очередь по давности).

    Дедупликация по (item_id, region): 100 пользователей следят за одним
    товаром → 1 API запрос.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select, or_

        now = datetime.now(timezone.utc)
        refresh_threshold = now - timedelta(seconds=LOTS_REFRESH_INTERVAL)

        async with get_db_session() as db:
            from sqlalchemy import asc, nullsfirst
            watchlist = (await db.execute(
                select(UserWatchlist)
                .where(UserWatchlist.is_active == True)
                .order_by(nullsfirst(asc(UserWatchlist.last_successful_check)))
            )).scalars().all()

            # Берём уникальные пары (item_id, region), которым пора обновиться
            due_pairs = {}
            for entry in watchlist:
                key = (entry.item_id, entry.region)
                if key not in due_pairs:
                    is_due = (
                        entry.last_successful_check is None
                        or entry.last_successful_check < refresh_threshold
                    )
                    if is_due:
                        due_pairs[key] = entry

            # Динамический batch: берём столько предметов, чтобы полный цикл уложился
            # в TARGET_CYCLE_SEC — при росте watchlist автоматически увеличиваем батч.
            runs_per_cycle = TARGET_CYCLE_SEC / LOTS_REFRESH_INTERVAL
            dynamic_batch = max(
                MIN_LOTS_PER_RUN,
                min(math.ceil(len(due_pairs) / runs_per_cycle), MAX_LOTS_PER_RUN),
            )
            pairs_to_collect = dict(list(due_pairs.items())[:dynamic_batch])

            if not pairs_to_collect:
                return

            logger.info(
                f"Collecting lots: batch={dynamic_batch} due={len(due_pairs)} "
                f"total={len(watchlist)} (target cycle {TARGET_CYCLE_SEC}s)"
            )

            collected_keys = set()
            for i, (key, entry) in enumerate(pairs_to_collect.items()):
                try:
                    await _collect_lots_for_item(db, entry)
                    collected_keys.add(key)
                except Exception as e:
                    logger.error(f"Failed to collect lots for {entry.item_id}/{entry.region}: {e}")
                    entry.error_status = str(e)
                    await db.commit()
                if i < len(pairs_to_collect) - 1:
                    await asyncio.sleep(LOTS_REQUEST_DELAY)

            # Обновляем last_successful_check для ВСЕХ записей собранных пар
            for entry in watchlist:
                if (entry.item_id, entry.region) in collected_keys and entry.error_status is None:
                    entry.last_successful_check = now
            await db.commit()

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(name="app.tasks.collectors.collect_all_history", bind=True, max_retries=3)
def collect_all_history(self):
    """Собирает историю продаж (раз в час)."""

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
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


@celery_app.task(name="app.tasks.collectors.force_refresh_all_history")
def force_refresh_all_history():
    """
    Принудительный пересбор истории для всех уникальных (item_id, region) из watchlist.
    Используется после изменений в логике сбора (например, добавление additional=true).
    После сбора автоматически пересчитывает статистику.
    """
    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import UserWatchlist, MasterItem
        from app.tasks.analyzers import calculate_market_stats
        from sqlalchemy import select

        async with get_db_session() as db:
            watchlist = (await db.execute(
                select(UserWatchlist).where(UserWatchlist.is_active == True)
            )).scalars().all()

            # Дедупликация: один API-запрос на пару (item_id, region)
            seen: set = set()
            unique_entries = []
            for entry in watchlist:
                key = (entry.item_id, entry.region)
                if key not in seen:
                    seen.add(key)
                    unique_entries.append(entry)

            logger.info(f"force_refresh_all_history: {len(unique_entries)} unique items")

            refreshed: set = set()
            for entry in unique_entries:
                try:
                    await _collect_history_for_item(db, entry)
                    refreshed.add((entry.item_id, entry.region))
                    logger.info(f"force_refresh: history collected for {entry.item_id}/{entry.region}")
                except Exception as e:
                    logger.error(f"force_refresh: failed {entry.item_id}/{entry.region}: {e}")

            # Пересчёт статистики для всех обновлённых пар
            from app.services.analytics.market_stats import calculate_market_stats as calc
            for item_id, region in refreshed:
                try:
                    await calc(db, item_id, region)
                    logger.info(f"force_refresh: stats recalculated for {item_id}/{region}")
                except Exception as e:
                    logger.error(f"force_refresh: stats failed for {item_id}/{region}: {e}")

    run_async(_run())


@celery_app.task(name="app.tasks.collectors.collect_single_item")
def collect_single_item(user_id: int, item_id: str, region: str):
    """
    Ручной сбор для одного предмета.
    Вызывается из API — не чаще раза в 2 минуты (throttle в Redis).
    """
    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select

        async with get_db_session() as db:
            entry = (await db.execute(
                select(UserWatchlist).where(
                    UserWatchlist.user_id == user_id,
                    UserWatchlist.item_id == item_id,
                    UserWatchlist.region == region,
                )
            )).scalars().first()

            if entry:
                await _collect_lots_for_item(db, entry)

    run_async(_run())


@celery_app.task(name="app.tasks.collectors.collect_history_single")
def collect_history_single(user_id: int, item_id: str, region: str):
    """
    Сбор истории продаж для одного предмета.
    Вызывается сразу после добавления в watchlist, чтобы не ждать планировщика.
    """
    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select

        async with get_db_session() as db:
            entry = (await db.execute(
                select(UserWatchlist).where(
                    UserWatchlist.user_id == user_id,
                    UserWatchlist.item_id == item_id,
                    UserWatchlist.region == region,
                )
            )).scalars().first()

            if entry:
                await _collect_history_for_item(db, entry)

    run_async(_run())


async def _collect_lots_for_item(db, entry):
    """
    Собирает снэпшот активных лотов и разделяет их на ликвидные/истекающие.

    Ликвидный лот: endTime > now + 2ч (цена актуальная, кто-то реально готов купить).
    Истекающий:    endTime ≤ now + 2ч (никто не купил по этой цене — нерыночная).

    Buyout detection удалён: Stalcraft API /history предоставляет 100% достоверные
    данные о реальных сделках, косвенное определение продаж не нужно.
    """
    from app.services.collector.client import stalcraft_client
    from app.services.cache.api_cache import api_cache
    from app.models.models import CollectedData
    import statistics

    client_region = stalcraft_client.region
    stalcraft_client.region = entry.region

    EXPIRY_THRESHOLD_HOURS = 2  # лот считается неликвидным если < 2ч до конца

    try:
        now = datetime.now(timezone.utc)
        data = await stalcraft_client.get_auction_lots(entry.item_id)
        lots = data.get("lots", [])

        # Обновляем Redis-кэш сразу — GET /lots/{id} отдаст свежие данные
        await api_cache.set_lots(entry.region, entry.item_id, data)

        if not lots:
            return

        def lot_price_per_unit(lot):
            price = lot.get("buyoutPrice", 0) or lot.get("startPrice", 0)
            amount = lot.get("amount", 1)
            return price // amount if amount > 0 else price

        def hours_remaining(lot) -> float | None:
            end_str = lot.get("endTime")
            if not end_str:
                return None
            end = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
            return (end - now).total_seconds() / 3600

        liquid_lots   = [l for l in lots if (h := hours_remaining(l)) is None or h >= EXPIRY_THRESHOLD_HOURS]
        expiring_lots = [l for l in lots if (h := hours_remaining(l)) is not None and h < EXPIRY_THRESHOLD_HOURS]

        all_prices    = [lot_price_per_unit(l) for l in lots    if lot_price_per_unit(l) > 0]
        liquid_prices = [lot_price_per_unit(l) for l in liquid_lots if lot_price_per_unit(l) > 0]
        amounts       = [l.get("amount", 1) for l in lots]
        best_lot      = min(lots, key=lot_price_per_unit, default=None)

        snapshot = CollectedData(
            user_id=None,
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
            detected_buyouts_count=None,
            best_liquid_price_per_unit=min(liquid_prices) if liquid_prices else None,
            raw_lots=sorted(lots, key=lot_price_per_unit)[:200],
        )
        db.add(snapshot)

        entry.last_successful_check = now
        entry.error_status = None

        await db.commit()
        logger.info(
            f"Collected {len(lots)} lots for {entry.item_id}/{entry.region} | "
            f"liquid={len(liquid_lots)} expiring={len(expiring_lots)}"
        )

        # После коммита — публикуем предвычисленные сигналы в Redis.
        # Бот и API читают из одного ключа → рассинхрон исключён.
        await _publish_signals(db, entry.item_id, entry.region, snapshot)

    finally:
        stalcraft_client.region = client_region


async def _publish_signals(db, item_id: str, region: str, snap) -> None:
    """
    Вычисляет выгодные лоты для каждой watchlist-записи (item_id, region)
    и записывает результат в Redis.

    Вызывается сразу после успешного сбора снапшота — пока данные максимально свежие.
    Использует shared-логику из profitable_lots.py, чтобы бот и API видели одно и то же.
    """
    import json
    import redis.asyncio as aioredis
    from app.core.config import settings
    from app.models.models import UserWatchlist, MasterItem, MarketStatistics, UserSettings
    from app.services.profitable_lots import compute_signals_for_entry, signals_key, SIGNALS_TTL
    from sqlalchemy import select

    entries = (await db.execute(
        select(UserWatchlist)
        .where(
            UserWatchlist.item_id   == item_id,
            UserWatchlist.region    == region,
            UserWatchlist.is_active == True,
        )
    )).scalars().all()

    if not entries:
        return

    master = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == item_id)
    )).scalar_one_or_none()
    if not master:
        return

    stats = (await db.execute(
        select(MarketStatistics).where(
            MarketStatistics.user_id == None,
            MarketStatistics.item_id == item_id,
            MarketStatistics.region  == region,
        )
    )).scalar_one_or_none()

    user_ids = list({e.user_id for e in entries if e.user_id is not None})
    user_settings_map: dict[int, float] = {}
    if user_ids:
        rows = (await db.execute(
            select(UserSettings).where(UserSettings.user_id.in_(user_ids))
        )).scalars().all()
        user_settings_map = {s.user_id: float(s.min_profit_margin_percent or 0) for s in rows}

    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        for entry in entries:
            try:
                margin_pct = user_settings_map.get(entry.user_id, 0.0)
                result = await compute_signals_for_entry(
                    db, entry, master, stats, snap,
                    min_profit_margin_pct=margin_pct,
                )
                if result is not None:
                    key = signals_key(
                        entry.user_id, item_id, region,
                        entry.quality_filter, entry.enchant_filter,
                    )
                    await r.setex(key, SIGNALS_TTL, json.dumps(result))
            except Exception as e:
                logger.error(
                    f"_publish_signals: entry user={entry.user_id} {item_id}/{region}: {e}"
                )
    finally:
        await r.aclose()


async def _collect_history_for_item(db, entry):
    """
    Собирает историю продаж из API /history и сохраняет в sales_history.

    Дополнительно: для каждой новой продажи пытается найти соответствующий лот
    в снэпшотах collected_data и восстановить lot_start — время выставления лота.
    Это даёт точное время нахождения на рынке: time_on_market = sale_time - lot_start.

    Алгоритм матчинга лота с продажей:
      1. buyoutPrice == sale.total_price AND lot.amount == sale.amount
      2. lot.endTime > sale_time  (лот не истёк сам — был именно куплен)
      3. Лот присутствовал в снэпшоте ДО продажи и отсутствует ПОСЛЕ

    При нескольких кандидатах (одинаковые лоты) — берём тот чей startTime наиболее ранний
    среди «исчезнувших», т.к. покупают обычно самый старый / самый дешёвый.
    Данные всё равно достоверны: цена и факт продажи подтверждены API.
    """
    from app.services.collector.client import stalcraft_client
    from app.models.models import SalesHistory, CollectedData
    from sqlalchemy import select, update
    from datetime import timedelta

    client_region = stalcraft_client.region
    stalcraft_client.region = entry.region

    try:
        data = await stalcraft_client.get_auction_history(entry.item_id)
        prices = data.get("prices", [])

        if not prices:
            return

        now    = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=120)

        # Загружаем все существующие записи за 120 дней:
        # нужны id и additional_info чтобы ретроактивно добавить qlt/ptn
        # для записей, собранных до добавления additional=true в API запросе.
        existing_rows = (await db.execute(
            select(SalesHistory.id, SalesHistory.sale_time, SalesHistory.additional_info).where(
                SalesHistory.item_id == entry.item_id,
                SalesHistory.region  == entry.region,
                SalesHistory.sale_time >= cutoff,
            )
        )).all()

        # sale_time → (id, additional_info) для быстрого поиска
        existing_map: dict = {}
        for row in existing_rows:
            existing_map[row.sale_time] = (row.id, row.additional_info)

        # Два последних снэпшота для матчинга лотов
        snapshots = (await db.execute(
            select(CollectedData)
            .where(
                CollectedData.user_id == None,
                CollectedData.item_id == entry.item_id,
                CollectedData.region  == entry.region,
                CollectedData.raw_lots.isnot(None),
            )
            .order_by(CollectedData.collect_time.desc())
            .limit(200)  # ~1.7 ч при интервале 20 сек — перекрывает окно между hourly сборами
        )).scalars().all()

        def find_lot_info(total_price: int, amount: int, sold_at: datetime) -> dict:
            """
            Ищет лот в снэпшотах по (buyoutPrice, amount, endTime).
            Возвращает dict с lot_start, qlt, ptn — всё что удалось извлечь.
            Это единственный способ узнать качество/заточку проданного артефакта,
            так как Stalcraft API /history не возвращает additional с qlt/ptn.
            """
            before = [s for s in snapshots if s.collect_time <= sold_at]
            after  = [s for s in snapshots if s.collect_time > sold_at]

            if not before:
                return {}

            before_lots = before[0].raw_lots or []
            candidates = [
                lot for lot in before_lots
                if lot.get("buyoutPrice") == total_price
                and lot.get("amount") == amount
                and _lot_end_after(lot, sold_at)
            ]

            if not candidates:
                return {}

            if after:
                after_start_times = {
                    l.get("startTime") for l in (after[0].raw_lots or [])
                }
                candidates = [
                    c for c in candidates
                    if c.get("startTime") not in after_start_times
                ]

            if not candidates:
                return {}

            candidates.sort(key=lambda l: l.get("startTime", ""))
            matched = candidates[0]

            result: dict = {}
            if matched.get("startTime"):
                result["lot_start"] = matched["startTime"]

            lot_add = matched.get("additional") or {}
            if "qlt" in lot_add:
                result["qlt"] = lot_add["qlt"]
            if "ptn" in lot_add and lot_add["ptn"] is not None:
                result["ptn"] = lot_add["ptn"]

            return result

        for record in prices:
            sold_at_str = record.get("time")
            if not sold_at_str:
                continue

            sold_at = datetime.fromisoformat(sold_at_str.replace("Z", "+00:00"))
            if sold_at < cutoff:
                continue

            total_price    = record.get("price", 0)
            amount         = record.get("amount", 1)
            price_per_unit = total_price // amount if amount > 0 else total_price

            # Ищем совпадение среди уже сохранённых (погрешность 1 секунда)
            match_key = next(
                (t for t in existing_map if abs((sold_at - t).total_seconds()) < 1),
                None,
            )
            if match_key is not None:
                existing_id, existing_additional = existing_map[match_key]
                # Если у существующей записи ещё нет qlt — пробуем найти лот и добавить
                if existing_additional is None or "qlt" not in (existing_additional or {}):
                    lot_info = find_lot_info(total_price, amount, sold_at)
                    if lot_info.get("qlt") is not None:
                        merged = dict(existing_additional or {})
                        merged.update(lot_info)
                        await db.execute(
                            update(SalesHistory)
                            .where(SalesHistory.id == existing_id)
                            .values(additional_info=merged)
                        )
                continue

            # Новая запись: пробуем сматчить лот из снэпшотов → получаем lot_start + qlt + ptn
            lot_info = find_lot_info(total_price, amount, sold_at)

            db.add(SalesHistory(
                user_id=entry.user_id,
                item_id=entry.item_id,
                region=entry.region,
                sale_time=sold_at,
                price_per_unit=price_per_unit,
                amount=amount,
                total_price=total_price,
                additional_info=lot_info if lot_info else None,
                will_be_deleted_at=sold_at + timedelta(days=120),
            ))

        await db.commit()

    finally:
        stalcraft_client.region = client_region


def _lot_end_after(lot: dict, sold_at: datetime) -> bool:
    """Возвращает True если лот истекает после момента продажи (значит куплен, не истёк)."""
    end_str = lot.get("endTime")
    if not end_str:
        return True  # нет данных — считаем валидным
    try:
        end = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
        return end > sold_at
    except Exception:
        return True
