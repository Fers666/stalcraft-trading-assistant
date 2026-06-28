from datetime import datetime, timezone, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_admin
from app.core.rate_limiter import rate_limiter
from app.core.tiers import TIERS, get_tier_limits, deactivate_excess_watchlist
from app.db.session import get_db
from app.models.models import User, UserWatchlist, RegistrationSettings

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
    tier: str
    tier_expires_at: datetime | None
    last_seen: datetime | None
    is_online: bool
    watchlist_count: int

    class Config:
        from_attributes = True


ONLINE_THRESHOLD_MINUTES = 5


@router.get("/users", response_model=list[UserAdminResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    wl_counts_subq = (
        select(UserWatchlist.user_id, func.count().label("cnt"))
        .where(UserWatchlist.is_active == True)
        .group_by(UserWatchlist.user_id)
        .subquery()
    )
    rows = (await db.execute(
        select(User, func.coalesce(wl_counts_subq.c.cnt, 0))
        .outerjoin(wl_counts_subq, wl_counts_subq.c.user_id == User.id)
        .order_by(User.created_at.desc())
    )).all()

    online_threshold = datetime.now(timezone.utc) - timedelta(minutes=ONLINE_THRESHOLD_MINUTES)
    return [
        UserAdminResponse(
            id=user.id,
            username=user.username,
            email=user.email,
            telegram_username=user.telegram_username,
            is_admin=user.is_admin,
            is_approved=user.is_approved,
            is_active=user.is_active,
            created_at=user.created_at,
            tier=user.tier,
            tier_expires_at=user.tier_expires_at,
            last_seen=user.last_seen,
            is_online=bool(user.last_seen and user.last_seen >= online_threshold),
            watchlist_count=count,
        )
        for user, count in rows
    ]


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
    user.tier = "base"
    await db.commit()
    return {"ok": True}


@router.post("/tasks/force-refresh-history")
async def force_refresh_history(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Принудительный пересбор истории продаж с additional=true для всего watchlist."""
    count = (await db.execute(
        select(func.count()).select_from(UserWatchlist).where(UserWatchlist.is_active == True)
    )).scalar_one()

    from app.tasks.collectors import force_refresh_all_history
    force_refresh_all_history.delay()

    return {"ok": True, "watchlist_entries": count, "message": f"Запущен пересбор для {count} записей"}


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


# ─── Статистика ───────────────────────────────────────────────────────────────

class AdminStatsResponse(BaseModel):
    users_by_tier: dict[str, int]
    users_online_now: int
    unique_watchlist_pairs: int
    total_watchlist_entries: int
    rate_limit: dict

    class Config:
        from_attributes = True


@router.get("/stats", response_model=AdminStatsResponse)
async def get_admin_stats(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    tier_counts = (await db.execute(
        select(User.tier, func.count()).group_by(User.tier)
    )).all()
    users_by_tier = {tier: 0 for tier in TIERS}
    users_by_tier.update({tier: count for tier, count in tier_counts})

    online_threshold = datetime.now(timezone.utc) - timedelta(minutes=ONLINE_THRESHOLD_MINUTES)
    users_online_now = (await db.execute(
        select(func.count()).select_from(User).where(User.last_seen >= online_threshold)
    )).scalar_one()

    unique_pairs_subq = (
        select(UserWatchlist.item_id, UserWatchlist.region)
        .where(UserWatchlist.is_active == True)
        .distinct()
        .subquery()
    )
    unique_watchlist_pairs = (await db.execute(
        select(func.count()).select_from(unique_pairs_subq)
    )).scalar_one()

    total_watchlist_entries = (await db.execute(
        select(func.count()).select_from(UserWatchlist).where(UserWatchlist.is_active == True)
    )).scalar_one()

    rate_limit = await rate_limiter.get_consumption_stats()

    return AdminStatsResponse(
        users_by_tier=users_by_tier,
        users_online_now=users_online_now,
        unique_watchlist_pairs=unique_watchlist_pairs,
        total_watchlist_entries=total_watchlist_entries,
        rate_limit=rate_limit,
    )


# ─── Тарифы ───────────────────────────────────────────────────────────────────

class TierUpdateRequest(BaseModel):
    tier: str                       # base | advanced | advanced_plus | advanced_max
    expires_at: datetime | None = None


@router.post("/users/{user_id}/tier")
async def set_user_tier(
    user_id: int,
    payload: TierUpdateRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Ручная установка тарифа + даты окончания."""
    if payload.tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {payload.tier}")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    new_limit = TIERS[payload.tier].watchlist_limit
    if new_limit is not None:
        await deactivate_excess_watchlist(user_id, new_limit, db)

    user.tier = payload.tier
    user.tier_expires_at = payload.expires_at
    await db.commit()
    return {"ok": True}


class TierExtendRequest(BaseModel):
    delta: Literal["1d", "1w", "1m"]


@router.post("/users/{user_id}/tier/extend")
async def extend_user_tier(
    user_id: int,
    payload: TierExtendRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    """Продление от max(текущий tier_expires_at или now(), now()) + delta."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    delta_map = {"1d": timedelta(days=1), "1w": timedelta(weeks=1), "1m": timedelta(days=30)}
    now = datetime.now(timezone.utc)
    base_time = max(user.tier_expires_at or now, now)
    user.tier_expires_at = base_time + delta_map[payload.delta]
    await db.commit()
    return {"ok": True, "tier_expires_at": user.tier_expires_at}


# ─── Настройки регистрации ────────────────────────────────────────────────────

class RegistrationSettingsResponse(BaseModel):
    auto_approve_enabled: bool
    default_tier: str
    default_tier_duration_days: int | None

    class Config:
        from_attributes = True


class RegistrationSettingsUpdate(BaseModel):
    auto_approve_enabled: bool
    default_tier: str
    default_tier_duration_days: int | None = None


@router.get("/settings/registration", response_model=RegistrationSettingsResponse)
async def get_registration_settings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    settings_row = (await db.execute(
        select(RegistrationSettings).where(RegistrationSettings.id == 1)
    )).scalar_one()
    return settings_row


@router.put("/settings/registration", response_model=RegistrationSettingsResponse)
async def update_registration_settings(
    payload: RegistrationSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    if payload.default_tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {payload.default_tier}")

    settings_row = (await db.execute(
        select(RegistrationSettings).where(RegistrationSettings.id == 1)
    )).scalar_one()
    settings_row.auto_approve_enabled = payload.auto_approve_enabled
    settings_row.default_tier = payload.default_tier
    settings_row.default_tier_duration_days = payload.default_tier_duration_days
    await db.commit()
    await db.refresh(settings_row)
    return settings_row
