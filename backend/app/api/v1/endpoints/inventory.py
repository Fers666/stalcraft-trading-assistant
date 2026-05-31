from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from pydantic import BaseModel
from datetime import datetime

from app.db.session import get_db
from app.models.models import User, UserInventory
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/inventory", tags=["Inventory"])


class InventoryCreate(BaseModel):
    item_id: str
    region: str = "RU"
    quantity: int
    avg_buy_price_per_unit: int | None = None


class InventoryResponse(BaseModel):
    id: int
    item_id: str
    region: str
    quantity: int
    avg_buy_price_per_unit: int | None
    added_at: datetime
    last_updated: datetime | None

    class Config:
        from_attributes = True


@router.get("", response_model=list[InventoryResponse])
async def get_inventory(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    items = (await db.execute(
        select(UserInventory)
        .where(UserInventory.user_id == current_user.id)
        .order_by(UserInventory.added_at.desc())
    )).scalars().all()
    return items


@router.post("", response_model=InventoryResponse, status_code=201)
async def add_to_inventory(
    payload: InventoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Если уже есть — обновляем количество и пересчитываем среднюю цену
    existing = (await db.execute(
        select(UserInventory).where(
            UserInventory.user_id == current_user.id,
            UserInventory.item_id == payload.item_id,
            UserInventory.region == payload.region,
        )
    )).scalar_one_or_none()

    if existing:
        if payload.avg_buy_price_per_unit and existing.avg_buy_price_per_unit:
            total_cost = (existing.avg_buy_price_per_unit * existing.quantity
                         + payload.avg_buy_price_per_unit * payload.quantity)
            new_qty = existing.quantity + payload.quantity
            existing.avg_buy_price_per_unit = total_cost // new_qty
        existing.quantity += payload.quantity
        await db.commit()
        await db.refresh(existing)
        return existing

    item = UserInventory(
        user_id=current_user.id,
        item_id=payload.item_id,
        region=payload.region,
        quantity=payload.quantity,
        avg_buy_price_per_unit=payload.avg_buy_price_per_unit,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


@router.delete("/{inventory_id}", status_code=204)
async def remove_from_inventory(
    inventory_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        delete(UserInventory).where(
            UserInventory.id == inventory_id,
            UserInventory.user_id == current_user.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Not found")
    await db.commit()
