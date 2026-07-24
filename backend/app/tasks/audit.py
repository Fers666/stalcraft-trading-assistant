"""
Разовый аудит торгуемости предметов каталога (master_items.on_auction).

Пробивает каждый item_id через Stalcraft API и определяет РЕАЛЬНОЕ наличие на
аукционе через total в ответах /history и /lots. Заменяет неверную эвристику по
bind_state (привязка ≠ торгуемость). Не непрерывный опрос — разовый бэкфилл,
resumable через WHERE on_auction IS NULL + покоммитный прогресс.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

import httpx

from app.tasks.celery_app import celery_app
from app.tasks.collectors import run_async

logger = logging.getLogger(__name__)

# Бюджет ≈100 ед/мин лимитера (см. ТЗ). Торгуемый предмет = 2 ед (/history),
# кандидат в неторгуемые = 4 ед (/history + /lots). При среднем ~2.5 ед/предмет
# задержка 1.5с → ~40 предметов/мин → ~100 ед/мин. Token Bucket (400/мин) жёстко
# гарантирует потолок; self-throttle держит бэкфилл в согласованном бюджете и не
# даёт ему выесть резерв непрерывного сбора лотов.
AUDIT_REQUEST_DELAY = 1.5          # секунд между предметами
AUDIT_ITEM_RETRIES = 2             # ретраев на один предмет при транзиентной ошибке
AUDIT_RETRY_BACKOFF = (2, 5)       # backoff по ретраям, сек
AUDIT_PROGRESS_EVERY = 50          # логировать прогресс каждые N предметов


async def _classify_item(client, item_id: str, region: str, redis_client) -> tuple[bool, int, int | None]:
    """
    Критерий торгуемости (экономия запросов — /history первым):
      1. /history (cost 2): history_total>0 → TRUE, /lots не запрашиваем.
      2. иначе /lots (cost 2): lots_total>0 → TRUE, оба 0 → FALSE.

    Возвращает (on_auction, history_total, lots_total | None).
    404 (предмета нет в системе аукциона) → валидный (False, 0, 0).
    Транзиентные ошибки (5xx/таймаут/сеть/429) пробрасываются наружу для ретрая.
    """
    try:
        history = await client.get_auction_history(item_id, region)
        history_total = int(history.get("total", 0))
        if history_total > 0:
            # Была история продаж → торгуется (в т.ч. редкие/сезонные без активных лотов).
            return True, history_total, None

        lots = await client.get_auction_lots(item_id, region, redis_client=redis_client)
        lots_total = int(lots.get("total", 0))
        # Нет истории, но есть активные лоты → новый предмет, выставлен, ещё не продан.
        return lots_total > 0, history_total, lots_total
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return False, 0, 0
        raise


@celery_app.task(name="app.tasks.audit.audit_auction_status", bind=True, max_retries=0)
def audit_auction_status(self, force_recheck: bool = False, stale_days: int | None = None, limit: int | None = None):
    """
    Бэкфилл master_items.on_auction по данным Stalcraft API.

    Параметры:
      - force_recheck=True  — перепроверить ВСЕ предметы (игнор on_auction).
      - stale_days=N        — предметы с on_auction IS NULL ИЛИ проверенные раньше N дней
                              назад (для периодического ре-чека).
      - limit=N             — обработать не более N предметов (тестовый прогон).
      - без параметров      — обычный resumable-прогон: только WHERE on_auction IS NULL.

    bind=True, max_retries=0: ретраи внутренние (на уровне одного предмета), падение
    на одном предмете не рестартует всю задачу. Коммит после каждого предмета —
    прогресс не теряется при рестарте воркера/деплое.
    """

    async def _run():
        from app.db.session import get_celery_db_session as get_db_session
        from app.models.models import MasterItem
        from app.services.collector.client import stalcraft_client
        from app.core.config import settings
        from sqlalchemy import select, or_
        import redis.asyncio as aioredis

        region = settings.stalcraft_region
        # Один Redis-клиент на весь прогон — передаётся в get_auction_lots (rate limiter).
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

        stats = {"checked": 0, "true": 0, "false": 0, "errors": 0}
        try:
            async with get_db_session() as db:
                query = select(MasterItem)
                if force_recheck:
                    pass  # все предметы
                elif stale_days is not None:
                    threshold = datetime.now(timezone.utc) - timedelta(days=stale_days)
                    query = query.where(or_(
                        MasterItem.on_auction.is_(None),
                        MasterItem.auction_checked_at < threshold,
                    ))
                else:
                    query = query.where(MasterItem.on_auction.is_(None))  # resumable
                query = query.order_by(MasterItem.id)
                if limit is not None:
                    query = query.limit(limit)

                items = (await db.execute(query)).scalars().all()
                total = len(items)
                logger.info(
                    f"audit_auction_status: старт region={region} предметов={total} "
                    f"(force_recheck={force_recheck}, stale_days={stale_days}, limit={limit})"
                )

                for idx, item in enumerate(items):
                    result = None
                    for attempt in range(AUDIT_ITEM_RETRIES + 1):
                        try:
                            result = await _classify_item(stalcraft_client, item.item_id, region, redis_client)
                            break
                        except Exception as e:
                            if attempt < AUDIT_ITEM_RETRIES:
                                backoff = AUDIT_RETRY_BACKOFF[min(attempt, len(AUDIT_RETRY_BACKOFF) - 1)]
                                logger.warning(
                                    f"audit: транзиентная ошибка {item.item_id} "
                                    f"(попытка {attempt + 1}/{AUDIT_ITEM_RETRIES + 1}): {e}; retry через {backoff}s"
                                )
                                await asyncio.sleep(backoff)
                            else:
                                # Не пишем FALSE — оставляем on_auction=NULL, предмет попадёт в следующий прогон.
                                logger.error(
                                    f"audit: {item.item_id} оставлен NULL после "
                                    f"{AUDIT_ITEM_RETRIES + 1} попыток: {e}"
                                )
                                stats["errors"] += 1

                    if result is not None:
                        on_auction, history_total, lots_total = result
                        item.on_auction = on_auction
                        item.history_total = history_total
                        item.lots_total = lots_total
                        item.auction_checked_at = datetime.now(timezone.utc)
                        await db.commit()  # покоммитный прогресс — устойчивость к рестарту
                        stats["checked"] += 1
                        stats["true" if on_auction else "false"] += 1

                    if (idx + 1) % AUDIT_PROGRESS_EVERY == 0:
                        logger.info(
                            f"audit: прогресс {idx + 1}/{total} "
                            f"TRUE={stats['true']} FALSE={stats['false']} errors={stats['errors']}"
                        )

                    if idx < total - 1:
                        await asyncio.sleep(AUDIT_REQUEST_DELAY)

                logger.info(
                    f"audit_auction_status: завершено checked={stats['checked']}/{total} "
                    f"TRUE={stats['true']} FALSE={stats['false']} errors={stats['errors']}"
                )
        finally:
            await redis_client.aclose()
            await redis_client.connection_pool.disconnect(inuse_connections=True)

        return stats

    return run_async(_run())
