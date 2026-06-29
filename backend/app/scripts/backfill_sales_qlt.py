"""
Разовый backfill: докручивает qlt/ptn для существующих записей sales_history,
у которых их нет, запрашивая Stalcraft API /history напрямую (поле
"additional" в каждой записи — authoritative источник, см.
docs/tasks/sales-history-qlt-ptn-coverage.md).

Не периодическая задача, не Celery-таск, не admin-эндпоинт — запускается
вручную через:

    docker compose exec backend python -m app.scripts.backfill_sales_qlt --days 30

Использует тот же stalcraft_client / Redis token bucket rate limiter, что и
обычный сбор — отдельного троттлинга здесь нет и не должно быть.

Перед основным проходом скрипт делает лёгкую оценку (offset=0, limit=1 на
каждую затронутую пару item_id/region) и печатает в консоль ожидаемое
количество страниц/запросов/токенов rate limit, требуемых для полного
покрытия --days дней, и просит подтверждения — операция расходует реальные
токены лимита Stalcraft API (cost=2 за запрос к /history).
"""
import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update, or_

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("backfill_sales_qlt")

HISTORY_PAGE_LIMIT = 200  # максимум, который принимает /history за раз
HISTORY_REQUEST_COST = 2  # см. app.core.rate_limiter.TokenCost.HISTORY
BACKFILL_PAGE_DELAY = 1.0  # секунд между страницами одной пары — не бёрстить
                            # резерв token bucket на полной сетевой скорости
BACKFILL_MAX_PAGE_RETRIES = 5  # повторов одной страницы при 429, прежде чем сдаться


async def _find_pairs(db, cutoff: datetime) -> list[tuple[str, str]]:
    """(item_id, region) пары с продажами без qlt в окне --days."""
    from app.models.models import SalesHistory

    # Тот же стиль проверки "нет qlt", что уже используется в analyzers.py /
    # profitable_lots.py / pricing.py: additional_info IS NULL или ["qlt"] IS NULL.
    rows = (await db.execute(
        select(SalesHistory.item_id, SalesHistory.region)
        .where(
            SalesHistory.sale_time >= cutoff,
            or_(
                SalesHistory.additional_info.is_(None),
                SalesHistory.additional_info["qlt"].astext.is_(None),
            ),
        )
        .distinct()
    )).all()
    return [(r.item_id, r.region) for r in rows]


async def _estimate(pairs: list[tuple[str, str]]) -> dict[tuple[str, str], int]:
    """
    Один лёгкий запрос (limit=1) на пару — читает поле "total" из ответа,
    чтобы оценить глубину истории без выгрузки данных. Тратит реальные токены
    rate limit (cost=2 на запрос), но даёт точную оценку стоимости полного
    прохода до его начала.
    """
    from app.services.collector.client import stalcraft_client

    totals: dict[tuple[str, str], int] = {}
    for item_id, region in pairs:
        try:
            data = await stalcraft_client.get_auction_history(item_id, region=region, offset=0, limit=1)
        except Exception as e:
            logger.warning(f"estimate failed for {item_id}/{region}: {e}")
            continue
        totals[(item_id, region)] = data.get("total", 0)
        await asyncio.sleep(BACKFILL_PAGE_DELAY)
    return totals


def _print_cost_estimate(totals: dict[tuple[str, str], int], days: int) -> int:
    """Печатает смету и возвращает суммарное (оценочное) количество запросов."""
    total_requests = 0
    print(f"\n=== Оценка стоимости backfill (--days {days}) ===")
    print(f"{'item_id':<12} {'region':<8} {'total в /history':>18} {'оценка запросов':>18}")
    for (item_id, region), total in sorted(totals.items(), key=lambda kv: -kv[1]):
        # Грубая верхняя оценка: предполагаем что весь total нужно пройти
        # постранично по HISTORY_PAGE_LIMIT (по факту обычно меньше — проход
        # останавливается раньше, как только пройдено --days дней).
        pages = (total + HISTORY_PAGE_LIMIT - 1) // HISTORY_PAGE_LIMIT if total else 0
        total_requests += pages
        print(f"{item_id:<12} {region:<8} {total:>18} {pages:>18}")

    estimated_tokens = total_requests * HISTORY_REQUEST_COST
    print(f"\nПар затронуто: {len(totals)}")
    print(f"Верхняя оценка запросов /history: {total_requests} (по {HISTORY_PAGE_LIMIT} записей/страница)")
    print(f"Верхняя оценка токенов rate limit: {estimated_tokens} (cost={HISTORY_REQUEST_COST}/запрос)")
    print(
        "Это верхняя граница (весь объём /history для предмета) — реальный проход "
        f"останавливается раньше, как только покрыт диапазон --days {days}.\n"
    )
    return total_requests


async def _backfill_pair(db, item_id: str, region: str, cutoff: datetime) -> tuple[int, int]:
    """
    Постранично проходит /history для (item_id, region) пока не покрыт cutoff
    или ответ не опустеет, матчит записи с существующими строками sales_history
    без qlt по (sale_time, total_price, amount) и обновляет additional_info.

    Возвращает (запросов_к_api, обновлённых_строк).
    """
    from app.models.models import SalesHistory
    from app.services.collector.client import stalcraft_client

    existing_rows = (await db.execute(
        select(
            SalesHistory.id, SalesHistory.sale_time,
            SalesHistory.total_price, SalesHistory.amount,
            SalesHistory.additional_info,
        ).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region == region,
            SalesHistory.sale_time >= cutoff,
        )
    )).all()

    # Индекс только записей, которым реально не хватает qlt — нет смысла
    # матчить то, что уже заполнено (в т.ч. обычным часовым сбором за это время).
    index: dict[tuple[int, int, int], int] = {}
    for row in existing_rows:
        additional = row.additional_info or {}
        if "qlt" in additional:
            continue
        key = (int(row.sale_time.timestamp()), row.total_price, row.amount)
        index[key] = row.id

    if not index:
        return 0, 0

    requests_spent = 0
    updated = 0
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
                # client.py уже спит 60с внутри _request() перед рейзом — здесь
                # дополнительной паузы не нужно, повторяем сразу после возврата.
        requests_spent += 1
        await asyncio.sleep(BACKFILL_PAGE_DELAY)
        prices = data.get("prices", [])
        if not prices:
            break

        oldest_in_page = None
        for record in prices:
            sold_at_str = record.get("time")
            if not sold_at_str:
                continue
            sold_at = datetime.fromisoformat(sold_at_str.replace("Z", "+00:00"))
            if oldest_in_page is None or sold_at < oldest_in_page:
                oldest_in_page = sold_at

            api_additional = record.get("additional") or {}
            if "qlt" not in api_additional:
                continue

            total_price = record.get("price", 0)
            amount = record.get("amount", 1)
            sec = int(sold_at.timestamp())

            row_id = None
            for cand_sec in (sec - 1, sec, sec + 1):
                row_id = index.get((cand_sec, total_price, amount))
                if row_id is not None:
                    break
            if row_id is None:
                continue

            await db.execute(
                update(SalesHistory)
                .where(SalesHistory.id == row_id)
                .values(additional_info=api_additional)
            )
            updated += 1
            # Не матчить эту строку повторно на следующих страницах (на случай
            # дублей записей в ответах /history между соседними offset).
            for cand_sec in (sec - 1, sec, sec + 1):
                index.pop((cand_sec, total_price, amount), None)

        await db.commit()

        if not index:
            break  # все интересующие записи найдены и обновлены
        if oldest_in_page is not None and oldest_in_page < cutoff:
            break  # страница уже старше --days — дальше идти не нужно
        if len(prices) < HISTORY_PAGE_LIMIT:
            break  # ответ опустел — конец истории на API

        offset += HISTORY_PAGE_LIMIT

    return requests_spent, updated


async def run(days: int, yes: bool) -> None:
    from app.db.session import get_celery_db_session as get_db_session

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    async with get_db_session() as db:
        pairs = await _find_pairs(db, cutoff)

    if not pairs:
        logger.info("Нет записей sales_history без qlt в указанном окне --days %s. Нечего делать.", days)
        return

    logger.info(f"Найдено {len(pairs)} пар (item_id, region) с продажами без qlt за последние {days} дн.")
    logger.info("Оцениваю глубину /history по каждой паре (это уже расходует токены rate limit)...")
    totals = await _estimate(pairs)
    estimated_requests = _print_cost_estimate(totals, days)

    if not yes:
        answer = input("Продолжить и запустить полный backfill? [y/N]: ").strip().lower()
        if answer not in ("y", "yes", "да"):
            logger.info("Отменено пользователем.")
            return

    total_requests_spent = len(totals)  # уже потрачено на оценку
    total_updated = 0

    async with get_db_session() as db:
        for i, (item_id, region) in enumerate(pairs, start=1):
            logger.info(f"[{i}/{len(pairs)}] backfill {item_id}/{region}...")
            try:
                requests_spent, updated = await _backfill_pair(db, item_id, region, cutoff)
            except Exception as e:
                logger.error(f"[{i}/{len(pairs)}] {item_id}/{region} failed: {e}")
                continue
            total_requests_spent += requests_spent
            total_updated += updated
            logger.info(
                f"[{i}/{len(pairs)}] {item_id}/{region}: "
                f"{requests_spent} запросов, {updated} строк обновлено "
                f"(всего потрачено запросов: {total_requests_spent}, обновлено: {total_updated})"
            )

    logger.info(
        f"Backfill завершён. Пар обработано: {len(pairs)}, "
        f"строк обновлено: {total_updated}, запросов к /history потрачено: {total_requests_spent} "
        f"(~{total_requests_spent * HISTORY_REQUEST_COST} токенов rate limit)."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Backfill qlt/ptn в sales_history из Stalcraft API /history additional.",
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
