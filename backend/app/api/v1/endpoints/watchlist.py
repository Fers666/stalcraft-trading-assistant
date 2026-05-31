"""
Watchlist API — управление списком отслеживаемых товаров.
Ручной сбор данных: не чаще раза в 2 минуты на пользователя (throttle через Redis).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

from app.db.session import get_db
from app.models.models import User, UserWatchlist, MasterItem
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/watchlist", tags=["Watchlist"])

MANUAL_REFRESH_COOLDOWN = 120  # секунд


class WatchlistCreate(BaseModel):
    item_id: str
    region: str = "EU"
    tracked_batch_sizes: List[int] = [10, 20, 30, 50]


class WatchlistUpdate(BaseModel):
    tracked_batch_sizes: Optional[List[int]] = None
    is_active: Optional[bool] = None


class WatchlistResponse(BaseModel):
    id: int
    item_id: str
    name_ru: Optional[str] = None
    name_en: Optional[str] = None
    icon_path: Optional[str] = None
    region: str
    tracked_batch_sizes: List[int]
    is_active: bool
    last_successful_check: Optional[datetime]
    error_status: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = False


@router.get("/", response_model=List[WatchlistResponse])
async def get_watchlist(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(
            UserWatchlist,
            MasterItem.name_ru,
            MasterItem.name_en,
            MasterItem.icon_path,
        )
        .outerjoin(MasterItem, MasterItem.item_id == UserWatchlist.item_id)
        .where(UserWatchlist.user_id == current_user.id)
    )).all()

    return [
        WatchlistResponse(
            id=row.UserWatchlist.id,
            item_id=row.UserWatchlist.item_id,
            name_ru=row.name_ru,
            name_en=row.name_en,
            icon_path=row.icon_path,
            region=row.UserWatchlist.region,
            tracked_batch_sizes=row.UserWatchlist.tracked_batch_sizes or [],
            is_active=row.UserWatchlist.is_active,
            last_successful_check=row.UserWatchlist.last_successful_check,
            error_status=row.UserWatchlist.error_status,
            created_at=row.UserWatchlist.created_at,
        )
        for row in rows
    ]


@router.post("/", response_model=WatchlistResponse, status_code=201)
async def add_to_watchlist(
    payload: WatchlistCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Проверяем что товар существует в каталоге
    item = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == payload.item_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail=f"Item {payload.item_id} not found in catalog")

    # Проверяем дубли
    existing = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.user_id == current_user.id,
            UserWatchlist.item_id == payload.item_id,
            UserWatchlist.region == payload.region,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Already in watchlist")

    entry = UserWatchlist(
        user_id=current_user.id,
        item_id=payload.item_id,
        region=payload.region,
        tracked_batch_sizes=payload.tracked_batch_sizes,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)

    # Запускаем первоначальный сбор.
    # user_id используется только для поиска watchlist-записи в task-е.
    # Снэпшот сохраняется глобально (user_id=None) в _collect_lots_for_item.
    from app.tasks.collectors import collect_single_item
    collect_single_item.delay(current_user.id, payload.item_id, payload.region)

    return entry


@router.put("/{watchlist_id}", response_model=WatchlistResponse)
async def update_watchlist_item(
    watchlist_id: int,
    payload: WatchlistUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.id == watchlist_id,
            UserWatchlist.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Not found")

    if payload.tracked_batch_sizes is not None:
        entry.tracked_batch_sizes = payload.tracked_batch_sizes
    if payload.is_active is not None:
        entry.is_active = payload.is_active

    await db.commit()
    await db.refresh(entry)
    return entry


@router.delete("/{watchlist_id}", status_code=204)
async def remove_from_watchlist(
    watchlist_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        delete(UserWatchlist).where(
            UserWatchlist.id == watchlist_id,
            UserWatchlist.user_id == current_user.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Not found")
    await db.commit()


@router.post("/{watchlist_id}/refresh", status_code=202)
async def manual_refresh(
    watchlist_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Ручной сбор данных. Не чаще раза в 2 минуты."""
    import redis.asyncio as aioredis
    from app.core.config import settings

    entry = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.id == watchlist_id,
            UserWatchlist.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Not found")

    # Throttle: проверяем Redis
    r = await aioredis.from_url(settings.redis_url, decode_responses=True)
    throttle_key = f"manual_refresh:{current_user.id}:{entry.item_id}:{entry.region}"

    try:
        if await r.exists(throttle_key):
            ttl = await r.ttl(throttle_key)
            raise HTTPException(
                status_code=429,
                detail=f"Manual refresh cooldown: wait {ttl}s"
            )
        await r.setex(throttle_key, MANUAL_REFRESH_COOLDOWN, "1")
    finally:
        await r.aclose()

    from app.tasks.collectors import collect_single_item
    collect_single_item.delay(current_user.id, entry.item_id, entry.region)

    return {"message": "Refresh scheduled", "item_id": entry.item_id}
