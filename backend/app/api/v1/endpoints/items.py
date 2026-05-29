from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_
from pydantic import BaseModel
from datetime import datetime

from app.db.session import get_db
from app.models.models import MasterItem, User
from app.core.dependencies import get_current_user, get_current_admin
from app.services.catalog.github_parser import sync_catalog

router = APIRouter(prefix="/items", tags=["Items"])


class ItemResponse(BaseModel):
    id: int
    item_id: str
    name_ru: str | None
    name_en: str | None
    category: str | None
    can_be_batch_traded: bool
    last_updated: datetime | None

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
    query = select(MasterItem)

    if search:
        pattern = f"%{search}%"
        query = query.where(
            or_(MasterItem.name_ru.ilike(pattern), MasterItem.name_en.ilike(pattern))
        )

    if category:
        query = query.where(MasterItem.category.ilike(f"{category}%"))

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
