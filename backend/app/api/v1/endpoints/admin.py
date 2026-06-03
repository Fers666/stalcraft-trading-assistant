from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_admin
from app.db.session import get_db
from app.models.models import User

router = APIRouter(prefix="/admin", tags=["Admin"])


class UserAdminResponse(BaseModel):
    id: int
    username: str
    email: str
    telegram_username: str | None
    is_admin: bool
    is_approved: bool
    is_active: bool
    created_at: datetime | None

    class Config:
        from_attributes = True


@router.get("/users", response_model=list[UserAdminResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    return result.scalars().all()


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_approved = True
    await db.commit()
    return {"ok": True}


@router.post("/users/{user_id}/revoke")
async def revoke_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_admin.id:
        raise HTTPException(status_code=400, detail="Cannot revoke your own access")
    if user.is_admin:
        raise HTTPException(status_code=400, detail="Cannot revoke another admin's access")
    user.is_approved = False
    await db.commit()
    return {"ok": True}
