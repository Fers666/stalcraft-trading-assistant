"""
Разовый импорт: добавляет в `master_items` 317 предметов, найденных внешним
ресерчем по бартеру у NPC «Арсен» и подтверждённых напрямую через
`stalcraft_client.get_auction_lots`/`get_auction_history` (см.
docs/tasks/arsenal-items-verification.md — 251 реально торгуемых
(`on_auction=True`) + 66 без лотов и истории (`on_auction=False`)).

Данные — в `app/scripts/data/arsenal_items.json` (item_id, name_ru, category,
lots_total, history_total, on_auction, icon_path). Никаких обращений к
Stalcraft API здесь нет — аудит уже выполнен вручную, этот скрипт только
записывает его результат в БД, поэтому rate limit не расходуется.

`name_en`/`color`/`bind_state` всегда NULL для этих строк — это не аномалия,
а обычный синк (`sync_catalog`/`github_parser.py`) их прежде не видел; если
EXBO официально добавит один из этих id в listing.json, обычный
`refresh-catalog` дозаполнит эти поля поверх (см. docs/tasks/arsenal-items-
verification.md, п.3).

`can_be_batch_traded` вычисляется той же логикой, что `_parse_item()`
(`app/services/catalog/github_parser.py`): top-level категория (часть до
первого "/") не входит в `_SINGLE_CATEGORIES`.

Идемпотентно — `INSERT ... ON CONFLICT (item_id) DO NOTHING`, повторный
запуск ничего не ломает и не перезаписывает уже существующие строки.

Запуск:

    docker compose exec backend python -m app.scripts.import_arsenal_items
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert as pg_insert

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("import_arsenal_items")

DATA_PATH = Path(__file__).parent / "data" / "arsenal_items.json"

# Тот же список, что в app/services/catalog/github_parser.py::_SINGLE_CATEGORIES —
# предметы этих top-level категорий продаются поштучно, batch trading не имеет смысла.
_SINGLE_CATEGORIES = {"weapon", "armor", "attachment", "weapon_modules", "backpacks"}


def _can_be_batch_traded(category: str) -> bool:
    top_category = category.split("/")[0] if category else ""
    return top_category not in _SINGLE_CATEGORIES


def _load_items() -> list[dict]:
    with open(DATA_PATH, encoding="utf-8") as f:
        raw_items = json.load(f)

    now = datetime.now(timezone.utc)
    db_items = []
    for item in raw_items:
        db_items.append({
            "item_id": item["item_id"],
            "name_ru": item["name_ru"],
            "name_en": None,
            "category": item["category"],
            "color": None,
            "icon_path": item.get("icon_path"),
            "bind_state": None,
            "can_be_batch_traded": _can_be_batch_traded(item["category"]),
            "on_auction": item["on_auction"],
            "auction_checked_at": now,
            "history_total": item["history_total"],
            "lots_total": item["lots_total"],
        })
    return db_items


async def run() -> None:
    from app.db.session import get_celery_db_session as get_db_session
    from app.models.models import MasterItem

    db_items = _load_items()
    logger.info(f"Загружено {len(db_items)} записей из {DATA_PATH}")

    async with get_db_session() as db:
        before = (await db.execute(select(func.count()).select_from(MasterItem))).scalar_one()

        stmt = pg_insert(MasterItem).values(db_items)
        stmt = stmt.on_conflict_do_nothing(index_elements=["item_id"])
        result = await db.execute(stmt)
        await db.commit()

        after = (await db.execute(select(func.count()).select_from(MasterItem))).scalar_one()

    inserted = result.rowcount or 0
    skipped = len(db_items) - inserted

    logger.info(
        f"Готово. Вставлено: {inserted}, пропущено (уже существовали): {skipped}. "
        f"master_items: {before} -> {after}."
    )


def main():
    asyncio.run(run())


if __name__ == "__main__":
    main()
