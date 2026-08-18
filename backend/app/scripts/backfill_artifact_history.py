"""
Разовый backfill истории продаж по всем артефактам каталога.

Без него в первый день у «Ленты артефактов» не будет ни опорной цены, ни
волатильности по большинству вариантов — то есть не будет ни одной строки:
sales_history наполняется только по watchlist-парам, а артефакты вне чьего-то
«Избранного» не имеют реальных сделок в базе.

Не периодическая задача, не Celery-таск, не admin-эндпоинт — запускается
вручную:

    docker compose exec backend python -m app.scripts.backfill_artifact_history --days 30

Использует тот же stalcraft_client / Redis token bucket rate limiter, что и
обычный сбор — отдельного троттлинга здесь нет и не должно быть.

Перед основным проходом делает лёгкую оценку (offset=0, limit=1 на каждый
артефакт), печатает ожидаемое количество страниц/запросов/единиц лимита и
просит подтверждения — операция расходует реальный лимит Stalcraft API
залпом (помнить инцидент 429 от 2026-06-29, docs/NOTES.md).

Отличия от app/scripts/backfill_sales_qlt.py: набор — артефакты из
master_items (а не пары из sales_history), пишутся НОВЫЕ строки с
user_id = NULL (а не UPDATE существующих).
"""
import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("backfill_artifact_history")

HISTORY_PAGE_LIMIT = 200        # максимум, который принимает /history за раз
HISTORY_REQUEST_COST = 2        # см. app.core.rate_limiter.TokenCost.HISTORY
BACKFILL_PAGE_DELAY = 1.0       # секунд между страницами — не бёрстить резерв
BACKFILL_MAX_PAGE_RETRIES = 5   # повторов одной страницы при 429, прежде чем сдаться


async def _find_items(db) -> list[str]:
    """
    Набор ленты целиком (feed_scope_clause): артефакты, снаряжение высоких
    рангов, части предметов, премиум и сезонные пропуска.

    Правило набора не дублируется здесь намеренно — разъехавшийся список
    означал бы бэкфилл истории не по тем предметам, которые лента опрашивает.
    """
    from app.models.models import MasterItem
    from app.services.feed.scope import feed_scope_clause

    rows = (await db.execute(
        select(MasterItem.item_id)
        .where(feed_scope_clause())
        .order_by(MasterItem.item_id)
    )).all()
    return [row.item_id for row in rows]


async def _estimate(item_ids: list[str], region: str) -> dict[str, int]:
    """
    Один лёгкий запрос (limit=1) на предмет — читает "total" из ответа, чтобы
    оценить глубину истории без выгрузки данных. Тратит реальные единицы
    лимита (cost=2), но даёт точную оценку стоимости до начала прохода.
    """
    from app.services.collector.client import stalcraft_client

    totals: dict[str, int] = {}
    for item_id in item_ids:
        try:
            data = await stalcraft_client.get_auction_history(item_id, region=region, offset=0, limit=1)
        except Exception as e:
            logger.warning(f"estimate failed for {item_id}/{region}: {e}")
            continue
        totals[item_id] = data.get("total", 0)
        await asyncio.sleep(BACKFILL_PAGE_DELAY)
    return totals


def _print_cost_estimate(totals: dict[str, int], days: int) -> int:
    """Печатает смету и возвращает суммарное (оценочное) количество запросов."""
    total_requests = 0
    print(f"\n=== Оценка стоимости backfill истории артефактов (--days {days}) ===")
    print(f"{'item_id':<12} {'total в /history':>18} {'оценка запросов':>18}")
    for item_id, total in sorted(totals.items(), key=lambda kv: -kv[1]):
        # Верхняя оценка: предполагаем, что весь total нужно пройти постранично.
        # По факту проход останавливается раньше — как только пройдено --days.
        pages = (total + HISTORY_PAGE_LIMIT - 1) // HISTORY_PAGE_LIMIT if total else 0
        total_requests += pages
        print(f"{item_id:<12} {total:>18} {pages:>18}")

    estimated_units = total_requests * HISTORY_REQUEST_COST
    print(f"\nАртефактов затронуто: {len(totals)}")
    print(f"Верхняя оценка запросов /history: {total_requests} (по {HISTORY_PAGE_LIMIT} записей/страница)")
    print(f"Верхняя оценка единиц лимита: {estimated_units} (cost={HISTORY_REQUEST_COST}/запрос)")
    print(
        "Это верхняя граница (весь объём /history предмета) — реальный проход "
        f"останавливается раньше, как только покрыт диапазон --days {days}.\n"
    )
    return total_requests


async def _backfill_item(db, item_id: str, region: str, cutoff: datetime) -> tuple[int, int]:
    """
    Постранично проходит /history для предмета, пока не покрыт cutoff или
    ответ не опустеет, и вставляет новые строки sales_history с user_id = NULL.

    Дедуп — на существующем уникальном индексе uq_sales_history_sale
    (item_id, region, sale_time, total_price, amount), поэтому повторный запуск
    скрипта безопасен.

    Возвращает (запросов_к_api, вставлено_строк).
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.models import SalesHistory
    from app.services.collector.client import stalcraft_client
    from app.tasks.feed_collector import sale_values

    requests_spent = 0
    inserted = 0
    offset = 0
    while True:
        for attempt in range(BACKFILL_MAX_PAGE_RETRIES):
            try:
                data = await stalcraft_client.get_auction_history(
                    item_id, region=region, offset=offset, limit=HISTORY_PAGE_LIMIT,
                )
                break
            except RuntimeError as e:
                if "429" not in str(e) or attempt == BACKFILL_MAX_PAGE_RETRIES - 1:
                    raise
                logger.warning(
                    f"{item_id}/{region}: 429 на странице offset={offset}, "
                    f"повтор {attempt + 1}/{BACKFILL_MAX_PAGE_RETRIES} после паузы"
                )
                # client.py больше не спит на 429 (docs/tasks/telegram-notification-bug.md,
                # причина A) — пауза перед ретраем нужна здесь явно.
                await asyncio.sleep(60)
        requests_spent += 1
        await asyncio.sleep(BACKFILL_PAGE_DELAY)

        records = data.get("prices", [])
        if not records:
            break

        oldest_in_page = None
        values: list[dict] = []
        seen_keys: set[tuple[int, int, int]] = set()
        for record in records:
            row = sale_values(item_id, region, record)
            if row is None:
                continue
            if oldest_in_page is None or row["sale_time"] < oldest_in_page:
                oldest_in_page = row["sale_time"]
            if row["sale_time"] < cutoff:
                continue
            # /history может вернуть одну продажу дважды в пределах ответа —
            # в одном INSERT ... ON CONFLICT дубль ключа даёт ошибку Postgres.
            key = (int(row["sale_time"].timestamp()), row["total_price"], row["amount"])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            values.append(row)

        if values:
            result = await db.execute(
                pg_insert(SalesHistory).values(values).on_conflict_do_nothing(
                    index_elements=["item_id", "region", "sale_time", "total_price", "amount"]
                )
            )
            inserted += result.rowcount or 0
            await db.commit()

        if oldest_in_page is not None and oldest_in_page < cutoff:
            break  # страница уже старше --days — дальше идти не нужно
        if len(records) < HISTORY_PAGE_LIMIT:
            break  # ответ опустел — конец истории на API

        offset += HISTORY_PAGE_LIMIT

    return requests_spent, inserted


async def run(days: int, yes: bool) -> None:
    from app.db.session import get_celery_db_session as get_db_session
    from app.core.config import settings

    region = settings.stalcraft_region
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    async with get_db_session() as db:
        item_ids = await _find_items(db)

    if not item_ids:
        logger.info("В каталоге нет артефактов с on_auction IS NOT FALSE. Нечего делать.")
        return

    logger.info(f"Найдено {len(item_ids)} артефактов (регион {region}).")
    logger.info("Оцениваю глубину /history по каждому предмету (это уже расходует лимит)...")
    totals = await _estimate(item_ids, region)
    _print_cost_estimate(totals, days)

    if not yes:
        answer = input("Продолжить и запустить полный backfill? [y/N]: ").strip().lower()
        if answer not in ("y", "yes", "да"):
            logger.info("Отменено пользователем.")
            return

    total_requests_spent = len(totals)  # уже потрачено на оценку
    total_inserted = 0

    async with get_db_session() as db:
        for i, item_id in enumerate(item_ids, start=1):
            logger.info(f"[{i}/{len(item_ids)}] backfill {item_id}/{region}...")
            try:
                requests_spent, inserted = await _backfill_item(db, item_id, region, cutoff)
            except Exception as e:
                logger.error(f"[{i}/{len(item_ids)}] {item_id}/{region} failed: {e}")
                continue
            total_requests_spent += requests_spent
            total_inserted += inserted
            logger.info(
                f"[{i}/{len(item_ids)}] {item_id}/{region}: "
                f"{requests_spent} запросов, {inserted} строк вставлено "
                f"(всего запросов: {total_requests_spent}, вставлено: {total_inserted})"
            )

    logger.info(
        f"Backfill завершён. Артефактов обработано: {len(item_ids)}, "
        f"строк вставлено: {total_inserted}, запросов к /history потрачено: "
        f"{total_requests_spent} (~{total_requests_spent * HISTORY_REQUEST_COST} единиц лимита)."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Backfill истории продаж по всем артефактам (sales_history, user_id=NULL).",
    )
    parser.add_argument("--days", type=int, default=30, help="Глубина в днях (default: 30)")
    parser.add_argument(
        "--yes", action="store_true",
        help="Не спрашивать подтверждения после вывода оценки стоимости (для неинтерактивного запуска)",
    )
    args = parser.parse_args()

    if args.days <= 0:
        print("--days должен быть положительным числом", file=sys.stderr)
        sys.exit(1)

    asyncio.run(run(args.days, args.yes))


if __name__ == "__main__":
    main()
