"""
Парсер каталога предметов из репозитория EXBO-Studio/stalcraft-database.

Использует listing.json — один файл со всеми 2000+ предметами.
Формат каждой записи:
  {
    "data": "/items/artefact/biochemical/04yr.json",  → item_id = "04yr", category = "artefact/biochemical"
    "name": { "lines": { "ru": "...", "en": "..." } },
    "status": { "state": "NON_DROP" | "PERSONAL_ON_USE" | ... }
  }
"""

import logging
from pathlib import PurePosixPath

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import MasterItem

logger = logging.getLogger(__name__)

LISTING_URL = "https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru/listing.json"

# Предметы этих категорий продаются поштучно — batch trading не имеет смысла
_SINGLE_CATEGORIES = {"weapon", "armor", "attachment", "weapon_modules", "backpacks"}


def _parse_item(entry: dict) -> dict | None:
    """Извлекает нужные поля из одной записи listing.json."""
    data_path = entry.get("data", "")
    if not data_path:
        return None

    # "/items/artefact/biochemical/04yr.json" → item_id="04yr", category="artefact/biochemical"
    parts = PurePosixPath(data_path).parts
    # parts = ('/', 'items', 'artefact', 'biochemical', '04yr.json')
    if len(parts) < 3:
        return None

    item_id = PurePosixPath(parts[-1]).stem          # "04yr"
    category = "/".join(parts[2:-1])                 # "artefact/biochemical" или "bullet"
    top_category = parts[2] if len(parts) > 2 else ""

    name_block = entry.get("name", {})
    lines = name_block.get("lines", {}) if isinstance(name_block, dict) else {}
    name_ru = lines.get("ru") or lines.get("en") or item_id
    name_en = lines.get("en") or name_ru

    can_batch = top_category not in _SINGLE_CATEGORIES
    icon_path = entry.get("icon")  # "/icons/medicine/9mmq.png"

    return {
        "item_id": item_id,
        "name_ru": name_ru,
        "name_en": name_en,
        "category": category,
        "icon_path": icon_path,
        "can_be_batch_traded": can_batch,
    }


async def sync_catalog(db: AsyncSession) -> dict:
    """
    Скачивает listing.json и делает upsert всех предметов в master_items.
    Возвращает статистику: { inserted, updated, total }.
    """
    logger.info("Starting catalog sync from GitHub...")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(LISTING_URL)
        response.raise_for_status()
        listing = response.json()

    logger.info(f"Downloaded listing.json: {len(listing)} entries")

    items = []
    for entry in listing:
        parsed = _parse_item(entry)
        if parsed:
            items.append(parsed)

    if not items:
        logger.warning("No items parsed from listing.json")
        return {"inserted": 0, "updated": 0, "total": 0}

    # Upsert: если item_id уже есть — обновляем поля, иначе вставляем
    stmt = pg_insert(MasterItem).values(items)
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_id"],
        set_={
            "name_ru": stmt.excluded.name_ru,
            "name_en": stmt.excluded.name_en,
            "category": stmt.excluded.category,
            "icon_path": stmt.excluded.icon_path,
            "can_be_batch_traded": stmt.excluded.can_be_batch_traded,
            "last_updated": stmt.excluded.last_updated,
        },
    )
    await db.execute(stmt)
    await db.commit()

    total = (await db.execute(select(MasterItem).where(MasterItem.item_id.isnot(None)))).scalars()
    count = len(list(total))

    logger.info(f"Catalog sync done: {len(items)} processed, {count} total in DB")
    return {"processed": len(items), "total_in_db": count}
