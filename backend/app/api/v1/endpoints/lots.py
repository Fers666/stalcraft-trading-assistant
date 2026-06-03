"""
Быстрый поиск активных лотов по товару без добавления в watchlist.

Данные берутся из Redis-кэша (TTL 5 мин).
Если кэш пуст или force_refresh=true — делается прямой запрос к Stalcraft API.
"""

import asyncio
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from pydantic import BaseModel

from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.models import User, MasterItem
from app.services.cache.api_cache import api_cache

router = APIRouter(prefix="/lots", tags=["Lots"])

_QLT_TO_QUALITY: dict[int, str] = {
    0: "Обычный",
    1: "Необычный",
    2: "Особый",
    3: "Ветеран",
    4: "Мастер",
    5: "Легендарный",
}

# Маппинг color из master_items → качество (для оружия/брони/контейнеров)
_COLOR_TO_QUALITY: dict[str, str] = {
    "default":      "Обычный",
    "rank_newbie":  "Необычный",
    "rank_stalker": "Особый",
    "rank_veteran": "Ветеран",
    "rank_master":  "Мастер",
    "rank_legend":  "Легендарный",
    "quest_item":   "Легендарный",
    "gray":   "Обычный",
    "grey":   "Обычный",
    "white":  "Обычный",
    "green":  "Необычный",
    "blue":   "Особый",
    "violet": "Ветеран",
    "purple": "Ветеран",
    "yellow": "Мастер",
    "black":  "Мастер",
    "red":    "Легендарный",
}


class CategoryLotItem(BaseModel):
    item_id: str
    item_name_ru: str | None
    item_name_en: str | None
    icon_path: str | None
    amount: int
    start_price: int
    buyout_price: int
    start_time: str
    end_time: str
    hours_remaining: float | None = None
    is_expiring: bool = False
    quality_name: str | None = None
    quality_value: int | None = None
    enchant_level: int | None = None


class CategoryLotsResponse(BaseModel):
    category: str
    region: str
    items_total: int
    lots_total: int
    lots: list[CategoryLotItem]


class LotItem(BaseModel):
    item_id: str
    amount: int
    start_price: int
    buyout_price: int
    start_time: str
    end_time: str
    hours_remaining: float | None = None
    is_expiring: bool = False
    quality_name: str | None = None   # из additional.qlt (артефакты) или master_items.color
    quality_value: int | None = None  # raw qlt 0-5 для watchlist (только для артефактов)
    enchant_level: int | None = None  # заточка 1-15 (из additional.ptn)


class LotsResponse(BaseModel):
    item_id: str
    region: str
    total: int
    lots: list[LotItem]
    from_cache: bool
    cache_note: str


def _parse_lot(
    lot: dict,
    master: MasterItem,
    now: datetime,
) -> "CategoryLotItem":
    """Общий парсер одного лота из raw API-ответа."""
    is_artefact = master.category and "artefact" in master.category.lower()
    item_color_quality = _COLOR_TO_QUALITY.get(master.color.lower(), None) if master.color else None

    end_str = lot.get("endTime", "")
    hours_remaining = None
    is_expiring = False
    if end_str:
        try:
            end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
            hours_remaining = round((end_dt - now).total_seconds() / 3600, 1)
            is_expiring = hours_remaining < 2
        except Exception:
            pass

    additional = lot.get("additional") or {}
    qlt = additional.get("qlt")
    ptn = additional.get("ptn")

    quality_value: int | None = None
    if is_artefact:
        actual_qlt = qlt if qlt is not None else 0
        quality_name = _QLT_TO_QUALITY.get(actual_qlt)
        quality_value = actual_qlt
    else:
        quality_name = _QLT_TO_QUALITY.get(qlt) if qlt is not None else item_color_quality

    enchant_level = int(ptn) if ptn is not None and int(ptn) > 0 else None

    return CategoryLotItem(
        item_id=master.item_id,
        item_name_ru=master.name_ru,
        item_name_en=master.name_en,
        icon_path=master.icon_path,
        amount=lot.get("amount", 1),
        start_price=lot.get("startPrice", 0),
        buyout_price=lot.get("buyoutPrice", 0),
        start_time=lot.get("startTime", ""),
        end_time=end_str,
        hours_remaining=hours_remaining,
        is_expiring=is_expiring,
        quality_name=quality_name,
        quality_value=quality_value,
        enchant_level=enchant_level,
    )


@router.get("", response_model=CategoryLotsResponse)
async def get_category_lots(
    category: str = Query(..., description="Категория предметов, напр. weapon/assault_rifle"),
    region: str = Query(default="RU", description="Регион: RU, EU, NA, SEA"),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Возвращает все активные лоты по всем предметам категории (из кэша или API)."""
    region = region.upper()
    if region not in ("RU", "EU", "NA", "SEA"):
        raise HTTPException(status_code=400, detail="Invalid region. Use: RU, EU, NA, SEA")

    items = (await db.execute(
        select(MasterItem)
        .where(or_(
            MasterItem.category == category,
            MasterItem.category.ilike(f"{category}/%"),
        ))
        .order_by(MasterItem.name_ru)
        .limit(100)
    )).scalars().all()

    if not items:
        return CategoryLotsResponse(category=category, region=region, items_total=0, lots_total=0, lots=[])

    now = datetime.now(timezone.utc)

    async def fetch_for_item(master: MasterItem) -> list[CategoryLotItem]:
        try:
            data = await api_cache.get_or_fetch_lots(region, master.item_id)
        except Exception:
            return []
        return [_parse_lot(lot, master, now) for lot in data.get("lots", [])]

    results = await asyncio.gather(*[fetch_for_item(m) for m in items])
    lots: list[CategoryLotItem] = [lot for batch in results for lot in batch]
    lots.sort(key=lambda l: l.buyout_price)

    return CategoryLotsResponse(
        category=category,
        region=region,
        items_total=len(items),
        lots_total=len(lots),
        lots=lots,
    )


@router.get("/{item_id}", response_model=LotsResponse)
async def get_item_lots(
    item_id: str,
    region: str = Query(default="RU", description="Регион: RU, EU, NA, SEA"),
    force_refresh: bool = Query(default=False, description="Обойти кэш и получить свежие данные из API"),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    region = region.upper()
    if region not in ("RU", "EU", "NA", "SEA"):
        raise HTTPException(status_code=400, detail="Invalid region. Use: RU, EU, NA, SEA")

    # Получаем качество предмета из master_items (fallback для оружия/брони)
    master = (await db.execute(select(MasterItem).where(MasterItem.item_id == item_id))).scalar_one_or_none()
    is_artefact = master and master.category and "artefact" in master.category.lower()
    item_color_quality = _COLOR_TO_QUALITY.get(master.color.lower(), None) if master and master.color else None

    if force_refresh:
        await api_cache.invalidate_lots(region, item_id)

    data = await api_cache.get_or_fetch_lots(region, item_id)
    raw_lots = data.get("lots", [])
    from_cache = data.get("_from_cache", False) and not force_refresh

    now = datetime.now(timezone.utc)
    lots = []
    for lot in raw_lots:
        end_str = lot.get("endTime", "")
        hours_remaining = None
        is_expiring = False
        if end_str:
            try:
                end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                hours_remaining = round((end_dt - now).total_seconds() / 3600, 1)
                is_expiring = hours_remaining < 2
            except Exception:
                pass

        additional = lot.get("additional") or {}
        qlt = additional.get("qlt")
        # Заточка хранится в поле "ptn" (pattern) со значением 0-15
        ptn = additional.get("ptn")

        # Качество: для артефактов — из additional.qlt (пустой additional = qlt 0)
        # Для остального — из master_items.color (одинаково для всех лотов предмета)
        quality_value: int | None = None
        if is_artefact:
            actual_qlt = qlt if qlt is not None else 0
            quality_name = _QLT_TO_QUALITY.get(actual_qlt)
            quality_value = actual_qlt
        else:
            quality_name = _QLT_TO_QUALITY.get(qlt) if qlt is not None else item_color_quality

        # ptn=0 означает "без заточки", показываем None
        enchant_level = int(ptn) if ptn is not None and int(ptn) > 0 else None

        lots.append(LotItem(
            item_id=lot.get("itemId", item_id),
            amount=lot.get("amount", 1),
            start_price=lot.get("startPrice", 0),
            buyout_price=lot.get("buyoutPrice", 0),
            start_time=lot.get("startTime", ""),
            end_time=end_str,
            hours_remaining=hours_remaining,
            is_expiring=is_expiring,
            quality_name=quality_name,
            quality_value=quality_value,
            enchant_level=enchant_level,
        ))

    lots.sort(key=lambda l: (l.is_expiring, l.buyout_price))

    cache_note = (
        "Свежие данные из API" if force_refresh
        else ("Данные из кэша (обновляются каждые 5 мин)" if from_cache else "Свежие данные из API")
    )

    return LotsResponse(
        item_id=item_id,
        region=region,
        total=data.get("total", len(lots)),
        lots=lots,
        from_cache=from_cache,
        cache_note=cache_note,
    )
