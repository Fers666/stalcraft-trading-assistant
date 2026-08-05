from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, Field

from app.db.session import get_db
from app.models.models import User, UserSettings
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/settings", tags=["Settings"])


class SettingsResponse(BaseModel):
    min_profit_margin_percent: int
    exclude_less_than_amount: int
    notify_telegram: bool
    notify_browser_push: bool
    auto_refresh_enabled: bool

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    # Порог валидируется на сервере, а не только клампом в UI:
    # min_profit_margin_percent входит и в WHERE ленты, и в ключ кэша витрины —
    # произвольные значения дают перебор выдачи по строке и обход TTL 30 с.
    min_profit_margin_percent: int | None = Field(None, ge=0, le=100)
    exclude_less_than_amount: int | None = None
    notify_telegram: bool | None = None
    notify_browser_push: bool | None = None
    auto_refresh_enabled: bool | None = None


@router.get("", response_model=SettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    settings = (await db.execute(
        select(UserSettings).where(UserSettings.user_id == current_user.id)
    )).scalar_one_or_none()

    if settings is None:
        settings = UserSettings(user_id=current_user.id)
        db.add(settings)
        await db.commit()
        await db.refresh(settings)

    return settings


@router.put("", response_model=SettingsResponse)
async def update_settings(
    payload: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    settings = (await db.execute(
        select(UserSettings).where(UserSettings.user_id == current_user.id)
    )).scalar_one_or_none()

    if settings is None:
        settings = UserSettings(user_id=current_user.id)
        db.add(settings)

    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)
    return settings
