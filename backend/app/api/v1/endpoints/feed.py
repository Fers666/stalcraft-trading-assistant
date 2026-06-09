"""
Feed API — Лента: отдельный research-watchlist пользователя.
Отличается от /watchlist (Избранное): обновляется медленнее, служит для
предварительного изучения товаров перед добавлением в мониторинг.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, or_
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from app.db.session import get_db
from app.models.models import (
    User, FeedWatchlist, MasterItem, UserWatchlist, UserSettings
)
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/feed", tags=["Feed"])


class FeedItemCreate(BaseModel):
    item_id: str
    region: str = "EU"
    quality_filter: Optional[int] = None
    enchant_filter: Optional[int] = None


class FeedBatchCreate(BaseModel):
    category: str          # напр. "weapon" или "weapon/assault_rifle"
    region: str = "EU"
    quality_filter: Optional[int] = None
    enchant_filter: Optional[int] = None


class FeedItemResponse(BaseModel):
    id: int
    item_id: str
    name_ru: Optional[str] = None
    name_en: Optional[str] = None
    icon_path: Optional[str] = None
    region: str
    quality_filter: Optional[int] = None
    enchant_filter: Optional[int] = None
    is_active: bool
    created_at: Optional[datetime]
    last_collected_at: Optional[datetime]
    sales_7d: int
    sales_24h: int
    profitable_lots_count: int
    avg_profit: float

    class Config:
        from_attributes = False


@router.get("/items", response_model=list[FeedItemResponse])
async def list_feed_items(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(
            FeedWatchlist,
            MasterItem.name_ru,
            MasterItem.name_en,
            MasterItem.icon_path,
        )
        .outerjoin(MasterItem, MasterItem.item_id == FeedWatchlist.item_id)
        .where(FeedWatchlist.user_id == current_user.id)
        .order_by(FeedWatchlist.created_at.desc())
    )).all()

    return [
        FeedItemResponse(
            id=r.FeedWatchlist.id,
            item_id=r.FeedWatchlist.item_id,
            name_ru=r.name_ru,
            name_en=r.name_en,
            icon_path=r.icon_path,
            region=r.FeedWatchlist.region,
            quality_filter=r.FeedWatchlist.quality_filter,
            enchant_filter=r.FeedWatchlist.enchant_filter,
            is_active=r.FeedWatchlist.is_active,
            created_at=r.FeedWatchlist.created_at,
            last_collected_at=r.FeedWatchlist.last_collected_at,
            sales_7d=r.FeedWatchlist.sales_7d or 0,
            sales_24h=r.FeedWatchlist.sales_24h or 0,
            profitable_lots_count=r.FeedWatchlist.profitable_lots_count or 0,
            avg_profit=r.FeedWatchlist.avg_profit or 0.0,
        )
        for r in rows
    ]


@router.post("/items", response_model=FeedItemResponse, status_code=201)
async def add_feed_item(
    payload: FeedItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    item = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == payload.item_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail=f"Item {payload.item_id} not found")

    existing = (await db.execute(
        select(FeedWatchlist).where(
            FeedWatchlist.user_id        == current_user.id,
            FeedWatchlist.item_id        == payload.item_id,
            FeedWatchlist.region         == payload.region,
            FeedWatchlist.quality_filter == payload.quality_filter,
            FeedWatchlist.enchant_filter == payload.enchant_filter,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Already in feed")

    entry = FeedWatchlist(
        user_id=current_user.id,
        item_id=payload.item_id,
        region=payload.region,
        quality_filter=payload.quality_filter,
        enchant_filter=payload.enchant_filter,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)

    return FeedItemResponse(
        id=entry.id,
        item_id=entry.item_id,
        name_ru=item.name_ru,
        name_en=item.name_en,
        icon_path=item.icon_path,
        region=entry.region,
        quality_filter=entry.quality_filter,
        enchant_filter=entry.enchant_filter,
        is_active=entry.is_active,
        created_at=entry.created_at,
        last_collected_at=entry.last_collected_at,
        sales_7d=0,
        sales_24h=0,
        profitable_lots_count=0,
        avg_profit=0.0,
    )


@router.post("/items/batch", status_code=201)
async def add_feed_items_batch(
    payload: FeedBatchCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Добавить все товары из категории (или подкатегории) в Ленту."""
    # category может быть "weapon" (всё оружие) или "weapon/assault_rifle" (подкат.)
    items = (await db.execute(
        select(MasterItem).where(
            or_(
                MasterItem.category == payload.category,
                MasterItem.category.like(f"{payload.category}/%"),
            )
        )
    )).scalars().all()

    if not items:
        raise HTTPException(
            status_code=404,
            detail=f"No items found for category '{payload.category}'"
        )

    # Загружаем уже существующие записи чтобы не создавать дубли
    existing_ids = set(
        (await db.execute(
            select(FeedWatchlist.item_id).where(
                FeedWatchlist.user_id == current_user.id,
                FeedWatchlist.region  == payload.region,
                FeedWatchlist.quality_filter == payload.quality_filter,
                FeedWatchlist.enchant_filter == payload.enchant_filter,
            )
        )).scalars().all()
    )

    added = 0
    skipped = 0
    for item in items:
        if item.item_id in existing_ids:
            skipped += 1
            continue
        db.add(FeedWatchlist(
            user_id=current_user.id,
            item_id=item.item_id,
            region=payload.region,
            quality_filter=payload.quality_filter,
            enchant_filter=payload.enchant_filter,
        ))
        added += 1

    await db.commit()
    return {"added": added, "skipped": skipped, "total_in_category": len(items)}


@router.delete("/items/{feed_id}", status_code=204)
async def delete_feed_item(
    feed_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        delete(FeedWatchlist).where(
            FeedWatchlist.id      == feed_id,
            FeedWatchlist.user_id == current_user.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Not found")
    await db.commit()


@router.post("/items/{feed_id}/promote", status_code=201)
async def promote_to_watchlist(
    feed_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Переместить товар из Ленты в Избранное (мониторинг)."""
    feed_entry = (await db.execute(
        select(FeedWatchlist).where(
            FeedWatchlist.id      == feed_id,
            FeedWatchlist.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not feed_entry:
        raise HTTPException(status_code=404, detail="Not found")

    # Проверяем, нет ли уже в мониторинге
    existing = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.user_id        == current_user.id,
            UserWatchlist.item_id        == feed_entry.item_id,
            UserWatchlist.region         == feed_entry.region,
            UserWatchlist.quality_filter == feed_entry.quality_filter,
            UserWatchlist.enchant_filter == feed_entry.enchant_filter,
        )
    )).scalar_one_or_none()

    if not existing:
        watchlist_entry = UserWatchlist(
            user_id=current_user.id,
            item_id=feed_entry.item_id,
            region=feed_entry.region,
            quality_filter=feed_entry.quality_filter,
            enchant_filter=feed_entry.enchant_filter,
            tracked_batch_sizes=[10, 20, 30, 50],
        )
        db.add(watchlist_entry)

    # Удаляем из ленты (hard delete)
    await db.execute(
        delete(FeedWatchlist).where(FeedWatchlist.id == feed_id)
    )
    await db.commit()

    if existing:
        return {"message": "Already in watchlist, removed from feed"}

    # Запускаем начальный сбор
    from celery import chain
    from app.tasks.collectors import collect_single_item, collect_history_single
    from app.tasks.analyzers import calculate_stats_single
    chain(
        collect_single_item.si(current_user.id, feed_entry.item_id, feed_entry.region),
        collect_history_single.si(current_user.id, feed_entry.item_id, feed_entry.region),
        calculate_stats_single.si(feed_entry.item_id, feed_entry.region),
    ).delay()

    return {"message": "Promoted to watchlist", "item_id": feed_entry.item_id}
