from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from pydantic import BaseModel, computed_field
from datetime import datetime

from app.db.session import get_db
from app.models.models import MasterItem, User
from app.core.dependencies import get_current_user, get_current_admin
from app.services.catalog.github_parser import sync_catalog

router = APIRouter(prefix="/items", tags=["Items"])

# status.state из GitHub: предмет привязывается в момент получения
# и никогда не появляется на аукционе (history_total=0 / lots_total=0
# для всех таких предметов — подтверждено через Stalcraft API)
_UNTRADABLE_BIND_STATES = {"PERSONAL_ON_GET", "PERSONAL_DROP_ON_GET"}

# Маппинг color → человекочитаемое название качества
_COLOR_TO_QUALITY: dict[str, str] = {
    # Актуальный формат из stalcraft-database
    "default":      "Обычный",
    "rank_newbie":  "Необычный",
    "rank_stalker": "Особый",
    "rank_veteran": "Ветеран",
    "rank_master":  "Мастер",
    "rank_legend":  "Легендарный",
    "quest_item":   "Легендарный",
    # Легаси rgb-коды
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


class ItemResponse(BaseModel):
    id: int
    item_id: str
    name_ru: str | None
    name_en: str | None
    category: str | None
    color: str | None
    icon_path: str | None
    can_be_batch_traded: bool
    last_updated: datetime | None

    @computed_field
    @property
    def quality_name(self) -> str | None:
        if self.color is None:
            return None
        return _COLOR_TO_QUALITY.get(self.color.lower())

    class Config:
        from_attributes = True


class ItemListResponse(BaseModel):
    items: list[ItemResponse]
    total: int
    page: int
    page_size: int


@router.get("", response_model=ItemListResponse)
async def list_items(
    search: str | None = Query(None, description="Поиск по названию (ru или en)"),
    category: str | None = Query(None, description="Фильтр по категории"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    # Фаза A + временная митигация (см. docs/tasks/audit-on-auction-status.md):
    # on_auction=FALSE скрываем (подтверждённо не торгуется), TRUE/NULL показываем.
    # ИСКЛЮЧЕНИЕ: weapon/armor с on_auction=FALSE НЕ прячем — их каталожный item_id
    # может не совпадать с аукционным (catalog↔auction id mismatch): API отдаёт 0/0
    # по легаси/вариантному id, хотя ствол реально торгуется под другим id. До резолва
    # id-проблемы держим оружие/броню видимыми, чтобы не терять живой каталог.
    _gear_exempt = or_(
        MasterItem.category.like("weapon%"),
        MasterItem.category.like("armor%"),
    )
    query = select(MasterItem).where(
        or_(MasterItem.on_auction.is_not(False), _gear_exempt),
        or_(
            MasterItem.on_auction.is_(True),
            MasterItem.bind_state.is_(None),
            MasterItem.bind_state.notin_(_UNTRADABLE_BIND_STATES),
        ),
    )

    if search:
        pattern = f"%{search}%"
        query = query.where(
            or_(MasterItem.name_ru.ilike(pattern), MasterItem.name_en.ilike(pattern))
        )

    if category:
        query = query.where(
            or_(
                MasterItem.category == category,
                MasterItem.category.ilike(f"{category}/%"),
            )
        )

    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar()

    items = (
        await db.execute(
            query.order_by(MasterItem.name_ru)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    return ItemListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/{item_id}", response_model=ItemResponse)
async def get_item(
    item_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    item = (
        await db.execute(select(MasterItem).where(MasterItem.item_id == item_id))
    ).scalar_one_or_none()

    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    return item


@router.post("/refresh-catalog", status_code=200)
async def refresh_catalog(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Синхронизирует каталог предметов с GitHub. Занимает несколько секунд."""
    result = await sync_catalog(db)
    return {"status": "ok", **result}
