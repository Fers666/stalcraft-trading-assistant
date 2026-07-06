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
LOTS_REQUEST_DELAY    = 0.2   # секунд между API-запросами (0.2 → 50 шт. умещаются в 10с < 20с)
TARGET_CYCLE_SEC      = 60    # целевой полный цикл обновления всех уникальных предметов
MAX_LOTS_PER_RUN      = 50    # потолок: 50 × 0.2s = 10s < 20s расписания
MIN_LOTS_PER_RUN      = 5     # минимум при малом вотчлисте

SNAPSHOT_MATCH_WINDOW_HOURS = 2  # окно снэпшотов ~1.7ч (200 шт. при цикле ~60с) + запас
HISTORY_CONCURRENCY = 6  # параллельных воркеров в collect_all_history (round-robin по chunks)

EMISSION_REDIS_KEY = "emission:current_fingerprint"  # fingerprint текущего выброса


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(coro)
        # Drain pending transport-close callbacks so redis.asyncio connections
        # clean up while the loop is still running (prevents __del__ warnings).
        loop.run_until_complete(asyncio.sleep(0))
        return result
    finally:
        loop.close()


@celery_app.task(name="app.tasks.collectors.collect_all_active_lots", bind=True, max_retries=3)
def collect_all_active_lots(self):
    """
    Собирает активные лоты для watchlist записей, у которых подошло время обновления.

    Запускается каждые 20 сек, динамический батч подгоняется под TARGET_CYCLE_SEC (60с) —
    то есть каждый предмет обновляется не реже раза в ~60 секунд.
    Порядок: last_successful_check ASC NULLS FIRST — самые устаревшие идут первыми (очередь по давности).

    Дедупликация по (item_id, region): 100 пользователей следят за одним
    товаром → 1 API запрос.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import UserWatchlist
        from sqlalchemy import select, or_
        import redis.asyncio as aioredis
        from app.core.config import settings

        now = datetime.now(timezone.utc)
        refresh_threshold = now - timedelta(seconds=LOTS_REFRESH_INTERVAL)

        # Один Redis-клиент на весь запуск батча (до 50 предметов × 2+ redis-вызова) —
        # вместо нового TCP-соединения на каждый вызов rate_limiter.acquire()/
        # _publish_signals(). Закрывается в finally ниже. Между разными Celery-тасками
        # клиент НЕ переиспользуется — только внутри одного прохода _run().
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
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
                        await _collect_lots_for_item(db, entry, redis_client=redis_client)
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
        finally:
            await redis_client.aclose()

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

            # Дедупликация: один API-запрос на пару (item_id, region) —
            # _collect_history_for_item и так дедуплицирует записи по (item_id, region)
            # независимо от user_id, так что повторные вызовы для той же пары
            # только впустую расходуют лимит запросов к Stalcraft API.
            seen: set = set()
            unique_entries = []
            for entry in watchlist:
                key = (entry.item_id, entry.region)
                if key not in seen:
                    seen.add(key)
                    unique_entries.append(entry)

        # Раньше обрабатывалось строго последовательно (один await за раз) —
        # весь прогон занимал 50+ секунд и пересекался по времени с
        # collect_all_active_lots (каждые 20с), нагружая оба forked worker-процесса
        # одновременно. Разбиваем на HISTORY_CONCURRENCY воркеров round-robin —
        # у каждого своя сессия на весь чанк (один AsyncSession нельзя использовать
        # параллельно из нескольких корутин).
        chunks = [unique_entries[i::HISTORY_CONCURRENCY] for i in range(HISTORY_CONCURRENCY)]

        async def _process_chunk(chunk):
            if not chunk:
                return
            try:
                async with get_db_session() as worker_db:
                    for entry in chunk:
                        try:
                            await _collect_history_for_item(worker_db, entry)
                        except Exception as e:
                            logger.error(f"Failed to collect history for {entry.item_id}: {e}")
            except Exception as e:
                logger.error(f"History chunk failed to start/complete: {e}")

        # return_exceptions=True — чтобы сбой/отмена одного чанка (например,
        # CancelledError при SIGTERM на деплое — он не Exception, мимо try/except
        # выше) не оборвал event loop раньше, чем остальные чанки успеют закрыть
        # свои сессии (иначе dispose() части чанков не выполнится → утечка
        # соединений к Postgres).
        results = await asyncio.gather(
            *(_process_chunk(chunk) for chunk in chunks), return_exceptions=True
        )
        for result in results:
            if isinstance(result, BaseException):
                logger.error(f"History chunk crashed: {result}")

    try:
        run_async(_run())
        from app.tasks.analyzers import calculate_all_market_stats
        calculate_all_market_stats.delay()
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
        from app.models.models import UserWatchlist
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


async def _collect_lots_for_item(db, entry, redis_client=None):
    """
    Собирает снэпшот активных лотов и разделяет их на ликвидные/истекающие.

    Ликвидный лот: endTime > now + 2ч (цена актуальная, кто-то реально готов купить).
    Истекающий:    endTime ≤ now + 2ч (никто не купил по этой цене — нерыночная).

    Buyout detection удалён: Stalcraft API /history предоставляет 100% достоверные
    данные о реальных сделках, косвенное определение продаж не нужно.

    redis_client: опциональный общий Redis-клиент на весь батч (см.
    collect_all_active_lots._run()) — переиспользуется в rate_limiter.acquire()
    и _publish_signals() вместо создания нового соединения на каждый вызов.
    """
    from app.services.collector.client import stalcraft_client
    from app.services.cache.api_cache import api_cache
    from app.models.models import CollectedData
    import statistics

    EXPIRY_THRESHOLD_HOURS = 2  # лот считается неликвидным если < 2ч до конца

    now = datetime.now(timezone.utc)
    prev_check = entry.last_successful_check
    data = await stalcraft_client.get_auction_lots(entry.item_id, region=entry.region, redis_client=redis_client)
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

    # Наблюдаемость для причины B (docs/tasks/telegram-notification-bug.md):
    # фактическая длина полного цикла обновления этой пары (item_id, region) —
    # чтобы при жалобе на задержку уведомлений сразу видеть число в логах,
    # без ручного SQL по проду. Сравнивать с SIGNALS_TTL (profitable_lots.py).
    if prev_check is not None:
        cycle_sec = (now - prev_check).total_seconds()
        logger.info(
            f"Watchlist cycle for {entry.item_id}/{entry.region}: {cycle_sec:.1f}s "
            f"since previous successful check"
        )

    # После коммита — публикуем предвычисленные сигналы в Redis.
    # Бот и API читают из одного ключа → рассинхрон исключён.
    await _publish_signals(db, entry.item_id, entry.region, snapshot, redis_client=redis_client)


async def _publish_signals(db, item_id: str, region: str, snap, redis_client=None) -> None:
    """
    Вычисляет выгодные лоты для каждой watchlist-записи (item_id, region)
    и записывает результат в Redis.

    Вызывается сразу после успешного сбора снапшота — пока данные максимально свежие.
    Использует shared-логику из profitable_lots.py, чтобы бот и API видели одно и то же.

    redis_client: опциональный общий Redis-клиент на весь батч (см.
    collect_all_active_lots._run()) — если передан, используется вместо создания
    нового соединения и не закрывается здесь (жизненным циклом владеет вызывающий код).
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
    user_settings_map: dict[int, tuple[float, int]] = {}
    if user_ids:
        rows = (await db.execute(
            select(UserSettings).where(UserSettings.user_id.in_(user_ids))
        )).scalars().all()
        user_settings_map = {
            s.user_id: (float(s.min_profit_margin_percent or 0), s.exclude_less_than_amount or 1)
            for s in rows
        }

    owns_client = redis_client is None
    r = redis_client
    try:
        if owns_client:
            r = aioredis.from_url(settings.redis_url, decode_responses=True)
        for entry in entries:
            try:
                margin_pct, exclude_less_than = user_settings_map.get(entry.user_id, (0.0, 1))
                result = await compute_signals_for_entry(
                    db, entry, master, stats, snap,
                    min_profit_margin_pct=margin_pct,
                    exclude_less_than_amount=exclude_less_than,
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
        if owns_client and r is not None:
            await r.aclose()

    # Лог для будущей калибровки — раз за цикл на каждую уникальную комбинацию
    # (quality_filter, enchant_filter), встречающуюся в watchlist для этого item/region.
    # margin=0, без отсечения по amount — независимо от персональных настроек пользователей.
    # У разных качеств/заточек разные цены, поэтому ref считается отдельно для каждой
    # комбинации (а не один общий "средний по больнице" ref).
    seen_combos: set[tuple] = set()
    combo_entries: list = []
    for entry in entries:
        combo = (entry.quality_filter, entry.enchant_filter)
        if combo not in seen_combos:
            seen_combos.add(combo)
            combo_entries.append(entry)

    # Более специфичные фильтры — первыми: если один и тот же лот попадёт под
    # несколько комбинаций (например (3, 0) и (None, None)), ON CONFLICT DO NOTHING
    # оставит запись с более точным (не "средним по больнице") ref.
    combo_entries.sort(key=lambda e: (e.quality_filter is None, e.enchant_filter is None))

    for entry in combo_entries:
        try:
            baseline = await compute_signals_for_entry(
                db, entry, master, stats, snap,
                min_profit_margin_pct=0.0,
                exclude_less_than_amount=1,
            )
            if baseline and baseline["lots"]:
                await _log_signal_outcomes(
                    db, item_id, region, baseline,
                    quality_filter=entry.quality_filter,
                    enchant_filter=entry.enchant_filter,
                )
        except Exception as e:
            logger.error(
                f"_publish_signals: log outcomes {item_id}/{region} "
                f"qlt={entry.quality_filter} ptn={entry.enchant_filter}: {e}"
            )


async def _log_signal_outcomes(
    db, item_id: str, region: str, signals: dict,
    quality_filter: int | None = None, enchant_filter: int | None = None,
) -> None:
    """Сохраняет предсказания по профитным лотам в signal_outcomes для будущей калибровки."""
    from app.models.models import SignalOutcome
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    sell_options = signals.get("sell_options") or []
    fast_opt = next((o for o in sell_options if o.get("label") == "fast"), None)
    predicted_hours = fast_opt["estimated_hours"] if fast_opt else None

    rows = [
        {
            "item_id": item_id,
            "region": region,
            "quality_filter": quality_filter,
            "enchant_filter": enchant_filter,
            "lot_start_time": lot["start_time"],
            "buyout_per_unit": lot["buyout_per_unit"],
            "ref_price": signals["ref"],
            "predicted_sell_price": lot["sell_price_used"],
            "predicted_hours": predicted_hours,
            "predicted_profit_pct": lot["profit_pct"],
            "trend": signals.get("trend"),
        }
        for lot in signals["lots"]
        if lot.get("start_time")
    ]
    if not rows:
        return

    stmt = pg_insert(SignalOutcome).values(rows)
    stmt = stmt.on_conflict_do_nothing(index_elements=["item_id", "region", "lot_start_time"])
    await db.execute(stmt)
    await db.commit()


async def _collect_history_for_item(db, entry):
    """
    Собирает историю продаж из API /history и сохраняет в sales_history.

    qlt/ptn (качество/заточка) приходят напрямую из ответа /history (поле
    "additional", см. ниже api_additional) — это первичный источник, не
    реконструкция. Снэпшот-матчинг описанный ниже нужен дополнительно только
    для lot_start: для каждой новой продажи пытается найти соответствующий лот
    в снэпшотах collected_data и восстановить время выставления лота.
    Это даёт точное время нахождения на рынке: time_on_market = sale_time - lot_start.

    Алгоритм матчинга лота с продажей:
      1. buyoutPrice == sale.total_price AND lot.amount == sale.amount
      2. lot.endTime > sale_time  (лот не истёк сам — был именно куплен)
      3. Лот присутствовал в снэпшоте ДО продажи и отсутствует ПОСЛЕ

    При нескольких кандидатах (одинаковые лоты) — берём тот чей startTime наиболее ранний
    среди «исчезнувших», т.к. покупают обычно самый старый / самый дешёвый.
    Данные всё равно достоверны: цена и факт продажи подтверждены API.

    Матчинг возможен только для продаж моложе SNAPSHOT_MATCH_WINDOW_HOURS — окно
    хранимых снэпшотов ограничено (200 шт. ≈ 1.7ч). Для записей старше этого окна
    снэпшоты не загружаются вовсе — без этого тяжёлая JSONB-выборка (до 200 строк
    с raw_lots) выполнялась на каждый предмет каждый час, хотя матч заведомо
    невозможен (лот давно выпал из окна снэпшотов).
    """
    from app.services.collector.client import stalcraft_client
    from app.models.models import SalesHistory, CollectedData
    from sqlalchemy import select, update
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from datetime import timedelta

    data = await stalcraft_client.get_auction_history(entry.item_id, region=entry.region)
    prices = data.get("prices", [])

    if not prices:
        return

    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=120)
    snapshot_cutoff = now - timedelta(hours=SNAPSHOT_MATCH_WINDOW_HOURS)

    # Загружаем все существующие записи за 120 дней:
    # нужны id и additional_info чтобы ретроактивно добавить qlt/ptn
    # для записей, собранных до добавления additional=true в API запросе.
    existing_rows = (await db.execute(
        select(
            SalesHistory.id, SalesHistory.sale_time, SalesHistory.additional_info,
            SalesHistory.total_price, SalesHistory.amount,
        ).where(
            SalesHistory.item_id == entry.item_id,
            SalesHistory.region  == entry.region,
            SalesHistory.sale_time >= cutoff,
        )
    )).all()

    # Индекс по (секунда sale_time, total_price, amount) → (id, sale_time, additional_info).
    # Ключ включает total_price/amount, чтобы две РАЗНЫЕ продажи в одну и ту же
    # секунду (с разной ценой/количеством) не считались одной записью.
    # id=None означает «запись добавлена в этом же проходе» — используется ниже,
    # чтобы не дублировать продажу, если API вернул её в /history несколько раз
    # за один вызов (existing_rows — снэпшот ДО цикла и новые db.add() в него не попадают).
    existing_index: dict[tuple[int, int, int], tuple[int | None, datetime, dict | None]] = {}
    for row in existing_rows:
        key = (int(row.sale_time.timestamp()), row.total_price, row.amount)
        existing_index[key] = (row.id, row.sale_time, row.additional_info)

    def find_existing(sold_at: datetime, total_price: int, amount: int):
        sec = int(sold_at.timestamp())
        for cand_sec in (sec - 1, sec, sec + 1):
            found = existing_index.get((cand_sec, total_price, amount))
            if found is not None and abs((sold_at - found[1]).total_seconds()) < 1:
                return found
        return None

    # Снэпшоты для матчинга лотов — грузим лениво, только если встретится
    # продажа моложе snapshot_cutoff, которой нужен матчинг.
    snapshots_cache: list | None = None

    async def get_snapshots():
        nonlocal snapshots_cache
        if snapshots_cache is None:
            snapshots_cache = (await db.execute(
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
        return snapshots_cache

    async def find_lot_info(total_price: int, amount: int, sold_at: datetime) -> dict:
        """
        Ищет лот в снэпшотах по (buyoutPrice, amount, endTime).
        Возвращает dict с lot_start, qlt, ptn — всё что удалось извлечь.

        Stalcraft API /history САМ возвращает qlt/ptn напрямую в каждой записи
        (поле "additional", запрашивается с additional=true) — это первичный,
        authoritative источник, см. начало цикла for record in prices. Матчинг
        по снэпшотам здесь нужен только для lot_start (время выставления лота,
        используется для time_on_market = sale_time - lot_start) — этого поля
        в /history нет, и единственный способ его узнать — найти тот же лот в
        снэпшоте /lots, сделанном до продажи.
        """
        snapshots = await get_snapshots()

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

        # Источник qlt/ptn №1 (authoritative): сам Stalcraft API уже отдаёт их
        # прямо в записи /history (поле "additional", запрашивается с
        # additional=true). Для предметов без качества (оружие/броня) поле
        # пустое — это корректный случай, не ошибка.
        api_additional = record.get("additional") or {}

        existing = find_existing(sold_at, total_price, amount)
        if existing is not None:
            existing_id, _, existing_additional = existing
            # existing_id=None → запись добавлена в этом же проходе и уже обогащена выше.
            needs_qlt = existing_additional is None or "qlt" not in (existing_additional or {})
            if existing_id is not None and needs_qlt:
                # api_additional не зависит от снэпшотов и доступен для записей
                # любого возраста (в пределах того, что вообще вернул /history) —
                # в отличие от find_lot_info, не ограничен snapshot_cutoff.
                merged = dict(existing_additional or {})
                if sold_at >= snapshot_cutoff:
                    merged.update(await find_lot_info(total_price, amount, sold_at))
                merged.update(api_additional)  # API приоритетнее при пересечении по qlt/ptn
                if merged != (existing_additional or {}):
                    await db.execute(
                        update(SalesHistory)
                        .where(SalesHistory.id == existing_id)
                        .values(additional_info=merged or None)
                    )
            continue

        # Новая запись: lot_start берём из снэпшотов (если продажа ещё в окне),
        # qlt/ptn — приоритетно из самого API (надёжнее любой реконструкции).
        lot_info = {}
        if sold_at >= snapshot_cutoff:
            lot_info = await find_lot_info(total_price, amount, sold_at)
        lot_info = {**lot_info, **api_additional}

        stmt = pg_insert(SalesHistory).values(
            user_id=entry.user_id,
            item_id=entry.item_id,
            region=entry.region,
            sale_time=sold_at,
            price_per_unit=price_per_unit,
            amount=amount,
            total_price=total_price,
            additional_info=lot_info if lot_info else None,
            will_be_deleted_at=sold_at + timedelta(days=120),
        ).on_conflict_do_nothing(
            index_elements=["item_id", "region", "sale_time", "total_price", "amount"]
        )
        await db.execute(stmt)

        # Отмечаем как обработанную — если /history вернёт эту же продажу
        # повторно в этом же ответе, она будет найдена через existing_index.
        existing_index[(int(sold_at.timestamp()), total_price, amount)] = (
            None, sold_at, lot_info if lot_info else None,
        )

    await db.commit()


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


# ─── Emission tracker ─────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.collectors.collect_emission", bind=True, max_retries=3)
def collect_emission(self):
    """
    Опрашивает Stalcraft API /emission каждые 2 минуты.
    Детектирует начало/конец выброса, сохраняет в emission_events,
    рассылает Telegram-уведомления всем пользователям с привязанным чатом.
    """
    run_async(_collect_emission_async())


async def _collect_emission_async():
    import redis.asyncio as aioredis
    from sqlalchemy import select, desc
    from app.core.config import settings
    from app.db.session import get_celery_db_session as get_db_session
    from app.models.models import EmissionEvent, User
    from app.services.collector.client import stalcraft_client
    from app.services.telegram_sender import send_telegram_message

    region = settings.stalcraft_region

    data = await stalcraft_client.get_emission(region=region)
    # API возвращает camelCase: currentStart / previousStart / previousEnd
    current_start_raw = data.get("currentStart")  # ISO-строка или None

    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        prev_fingerprint = await r.get(EMISSION_REDIS_KEY)

        async with get_db_session() as db:
            if current_start_raw and current_start_raw != prev_fingerprint:
                # Начало нового выброса
                event = EmissionEvent(
                    region=region,
                    started_at=datetime.fromisoformat(current_start_raw.replace("Z", "+00:00")),
                    ended_at=None,
                    notified=False,
                )
                db.add(event)
                await db.flush()

                await _emission_broadcast(db, event, send_telegram_message, started=True)
                event.notified = True
                await db.commit()

                await r.set(EMISSION_REDIS_KEY, current_start_raw, ex=7200)
                logger.info(f"Emission started: {current_start_raw} region={region}")

            elif not current_start_raw and prev_fingerprint:
                # Конец выброса — закрываем открытое событие
                result = await db.execute(
                    select(EmissionEvent)
                    .where(EmissionEvent.region == region)
                    .where(EmissionEvent.ended_at.is_(None))
                    .order_by(desc(EmissionEvent.started_at))
                    .limit(1)
                )
                active = result.scalar_one_or_none()
                if active:
                    active.ended_at = datetime.now(timezone.utc)
                    await db.commit()
                    await _emission_broadcast(db, active, send_telegram_message, started=False)

                await r.delete(EMISSION_REDIS_KEY)
                logger.info(f"Emission ended region={region}")
    finally:
        await r.aclose()


async def _emission_broadcast(db, event: "EmissionEvent", send_fn, *, started: bool) -> None:
    """Рассылает Telegram-уведомление о выбросе всем активным пользователям с chat_id."""
    from sqlalchemy import select
    from app.models.models import User

    chat_ids = (await db.execute(
        select(User.telegram_chat_id)
        .where(User.telegram_chat_id.isnot(None))
        .where(User.is_active == True)
        .where(User.is_approved == True)
    )).scalars().all()

    if not chat_ids:
        return

    if started:
        local_time = event.started_at.astimezone(timezone(timedelta(hours=3)))
        time_str = local_time.strftime("%H:%M")
        text = (
            f"<b>Выброс начался</b>\n"
            f"Время: {time_str} МСК\n"
            f"Аукционная активность снижена (~15 мин)"
        )
    else:
        duration_min = None
        if event.ended_at and event.started_at:
            duration_min = round((event.ended_at - event.started_at).total_seconds() / 60)
        dur_str = f" (длился {duration_min} мин)" if duration_min else ""
        text = f"<b>Выброс завершён</b>{dur_str}\nАукцион возвращается к норме"

    for chat_id in chat_ids:
        try:
            await send_fn(chat_id, text)
        except Exception as e:
            logger.warning(f"_emission_broadcast: failed for chat_id={chat_id}: {e}")
