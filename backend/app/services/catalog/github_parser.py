"""
Парсер каталога предметов из репозитория EXBO-Studio/stalcraft-database.

Использует listing.json — один файл со всеми 2000+ предметами.
Формат каждой записи:
  {
    "data": "/items/artefact/biochemical/04yr.json",  → item_id = "04yr", category = "artefact/biochemical"
    "name": { "lines": { "ru": "...", "en": "..." } },
    "color": "blue",                                  → качество: gray/green/blue/violet/yellow/red
    "icon": "/icons/...",
    "status": { "state": "NON_DROP" | "PERSONAL_ON_USE" | ... }
  }

Если поля color нет в listing.json (для части предметов) — дофетчиваем отдельный JSON файла.
"""

import asyncio
import logging
from pathlib import PurePosixPath

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import MasterItem

logger = logging.getLogger(__name__)

LISTING_URL = "https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru/listing.json"
ITEM_BASE_URL = "https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru"

# Предметы этих категорий продаются поштучно — batch trading не имеет смысла
_SINGLE_CATEGORIES = {"weapon", "armor", "attachment", "weapon_modules", "backpacks"}

# Допустимые значения color в репозитории (актуальный формат RANK_* + легаси rgb-коды)
_VALID_COLORS = {
    "default", "rank_newbie", "rank_stalker", "rank_veteran", "rank_master", "rank_legend", "quest_item",
    "gray", "grey", "green", "blue", "violet", "purple", "yellow", "red", "black", "white",
}


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

    raw_color = entry.get("color")
    color = raw_color.lower() if isinstance(raw_color, str) and raw_color.lower() in _VALID_COLORS else None

    return {
        "item_id": item_id,
        "name_ru": name_ru,
        "name_en": name_en,
        "category": category,
        "color": color,
        "icon_path": icon_path,
        "can_be_batch_traded": can_batch,
        "_data_path": data_path,   # служебное поле для дофетча, не пишем в БД
    }


async def _fetch_item_color(client: httpx.AsyncClient, data_path: str) -> str | None:
    """Загружает отдельный JSON предмета и извлекает color."""
    url = f"{ITEM_BASE_URL}{data_path}"
    try:
        r = await client.get(url, timeout=10.0)
        if r.status_code != 200:
            return None
        raw_color = r.json().get("color")
        if isinstance(raw_color, str) and raw_color.lower() in _VALID_COLORS:
            return raw_color.lower()
    except Exception:
        pass
    return None


async def _enrich_colors(items: list[dict], concurrency: int = 20) -> None:
    """
    Дофетчивает color для предметов, у которых он отсутствует в listing.json.
    Изменяет items на месте.
    """
    missing = [item for item in items if item["color"] is None]
    if not missing:
        return

    logger.info(f"Fetching color for {len(missing)} items without color in listing.json...")

    sem = asyncio.Semaphore(concurrency)

    async def fetch_one(item: dict) -> None:
        async with sem:
            color = await _fetch_item_color(client, item["_data_path"])
            if color:
                item["color"] = color

    async with httpx.AsyncClient(timeout=15.0) as client:
        await asyncio.gather(*[fetch_one(item) for item in missing])

    filled = sum(1 for item in missing if item["color"] is not None)
    logger.info(f"Color enrichment done: {filled}/{len(missing)} filled")


async def sync_catalog(db: AsyncSession) -> dict:
    """
    Скачивает listing.json и делает upsert всех предметов в master_items.
    Возвращает статистику: { processed, total_in_db }.
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

    # Дофетчиваем color для предметов, где его нет в listing.json
    await _enrich_colors(items)

    # Убираем служебное поле перед вставкой в БД
    db_items = [{k: v for k, v in item.items() if k != "_data_path"} for item in items]

    # Upsert: если item_id уже есть — обновляем поля, иначе вставляем
    stmt = pg_insert(MasterItem).values(db_items)
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_id"],
        set_={
            "name_ru":             stmt.excluded.name_ru,
            "name_en":             stmt.excluded.name_en,
            "category":            stmt.excluded.category,
            "color":               stmt.excluded.color,
            "icon_path":           stmt.excluded.icon_path,
            "can_be_batch_traded": stmt.excluded.can_be_batch_traded,
            "last_updated":        stmt.excluded.last_updated,
        },
    )
    await db.execute(stmt)
    await db.commit()

    total = (await db.execute(select(MasterItem).where(MasterItem.item_id.isnot(None)))).scalars()
    count = len(list(total))

    logger.info(f"Catalog sync done: {len(items)} processed, {count} total in DB")
    return {"processed": len(items), "total_in_db": count}
