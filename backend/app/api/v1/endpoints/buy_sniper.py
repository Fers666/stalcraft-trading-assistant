"""
Buy Sniper API — раздел «Закупки».

Пользователь задаёт порог цены (target_price) для записи Избранного; когда самый
дешёвый подходящий лот на рынке падает ≤ порога, бот шлёт Telegram-алерт.
Одна закупка = одна запись watchlist (UNIQUE watchlist_id).

Триггер-цена (current_min) читается из Redis-ключа buymin:{...}, который пишет
коллектор после каждого сбора (см. profitable_lots.cheapest_matching_lot).
"""
import json
import statistics as _statistics
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import User, UserWatchlist, MasterItem, BuyAlert, SalesHistory
from app.core.dependencies import get_current_user
from app.core.tiers import get_tier_limits
from app.services.profitable_lots import buymin_key

router = APIRouter(prefix="/buy-sniper", tags=["BuySniper"])


def _require_access(user: User) -> None:
    """403, если тариф не даёт доступа к разделу «Закупки»."""
    if not get_tier_limits(user).buy_sniper_access:
        raise HTTPException(status_code=403, detail="Раздел «Закупки» недоступен на вашем тарифе")


# ─── Схемы ────────────────────────────────────────────────────────────────────

class BuyAlertCreate(BaseModel):
    watchlist_id: int
    target_price: int


class BuyAlertUpdate(BaseModel):
    target_price: int | None = None
    is_active: bool | None = None


class BuyAlertResponse(BaseModel):
    id: int
    watchlist_id: int
    item_id: str
    name_ru: str | None = None
    name_en: str | None = None
    icon_path: str | None = None
    region: str
    quality_filter: int | None = None
    enchant_filter: int | None = None
    target_price: int
    is_active: bool
    # Обогащение текущей минимальной ценой из Redis (None если снапшота ещё нет)
    current_min: int | None = None
    current_amount: int | None = None
    created_at: datetime


class PriceWindowResponse(BaseModel):
    min: int | None
    median: float | None
    max: int | None
    count: int
    days: int


# ─── Список ───────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[BuyAlertResponse])
async def list_buy_alerts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_access(current_user)

    rows = (await db.execute(
        select(BuyAlert, UserWatchlist, MasterItem.name_ru, MasterItem.name_en, MasterItem.icon_path)
        .join(UserWatchlist, UserWatchlist.id == BuyAlert.watchlist_id)
        .outerjoin(MasterItem, MasterItem.item_id == UserWatchlist.item_id)
        .where(BuyAlert.user_id == current_user.id)
        .order_by(BuyAlert.created_at.desc())
    )).all()

    if not rows:
        return []

    import redis.asyncio as aioredis
    from app.core.config import settings

    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    result: list[BuyAlertResponse] = []
    try:
        for alert, wl, name_ru, name_en, icon_path in rows:
            current_min = None
            current_amount = None
            raw = await r.get(buymin_key(
                current_user.id, wl.item_id, wl.region,
                wl.quality_filter, wl.enchant_filter,
            ))
            if raw:
                try:
                    data = json.loads(raw)
                    current_min = data.get("price_per_unit")
                    current_amount = data.get("amount")
                except Exception:
                    pass
            result.append(BuyAlertResponse(
                id=alert.id,
                watchlist_id=alert.watchlist_id,
                item_id=wl.item_id,
                name_ru=name_ru,
                name_en=name_en,
                icon_path=icon_path,
                region=wl.region,
                quality_filter=wl.quality_filter,
                enchant_filter=wl.enchant_filter,
                target_price=alert.target_price,
                is_active=alert.is_active,
                current_min=current_min,
                current_amount=current_amount,
                created_at=alert.created_at,
            ))
    finally:
        await r.aclose()

    return result


# ─── Создание ─────────────────────────────────────────────────────────────────

@router.post("/", response_model=BuyAlertResponse, status_code=201)
async def create_buy_alert(
    payload: BuyAlertCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_access(current_user)

    wl = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.id == payload.watchlist_id,
            UserWatchlist.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if wl is None:
        raise HTTPException(status_code=404, detail="Запись Избранного не найдена")

    existing = (await db.execute(
        select(BuyAlert).where(BuyAlert.watchlist_id == payload.watchlist_id)
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Закупка для этой записи уже создана")

    alert = BuyAlert(
        user_id=current_user.id,
        watchlist_id=payload.watchlist_id,
        target_price=payload.target_price,
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)

    master = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == wl.item_id)
    )).scalar_one_or_none()

    return BuyAlertResponse(
        id=alert.id,
        watchlist_id=alert.watchlist_id,
        item_id=wl.item_id,
        name_ru=master.name_ru if master else None,
        name_en=master.name_en if master else None,
        icon_path=master.icon_path if master else None,
        region=wl.region,
        quality_filter=wl.quality_filter,
        enchant_filter=wl.enchant_filter,
        target_price=alert.target_price,
        is_active=alert.is_active,
        created_at=alert.created_at,
    )


# ─── Обновление ───────────────────────────────────────────────────────────────

@router.put("/{alert_id}", response_model=BuyAlertResponse)
async def update_buy_alert(
    alert_id: int,
    payload: BuyAlertUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_access(current_user)

    alert = (await db.execute(
        select(BuyAlert).where(
            BuyAlert.id == alert_id,
            BuyAlert.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=404, detail="Закупка не найдена")

    if payload.target_price is not None:
        alert.target_price = payload.target_price
    if payload.is_active is not None:
        alert.is_active = payload.is_active
    await db.commit()
    await db.refresh(alert)

    wl = (await db.execute(
        select(UserWatchlist).where(UserWatchlist.id == alert.watchlist_id)
    )).scalar_one_or_none()
    master = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == wl.item_id)
    )).scalar_one_or_none() if wl else None

    return BuyAlertResponse(
        id=alert.id,
        watchlist_id=alert.watchlist_id,
        item_id=wl.item_id if wl else "",
        name_ru=master.name_ru if master else None,
        name_en=master.name_en if master else None,
        icon_path=master.icon_path if master else None,
        region=wl.region if wl else "",
        quality_filter=wl.quality_filter if wl else None,
        enchant_filter=wl.enchant_filter if wl else None,
        target_price=alert.target_price,
        is_active=alert.is_active,
        created_at=alert.created_at,
    )


# ─── Удаление ─────────────────────────────────────────────────────────────────

@router.delete("/{alert_id}", status_code=204)
async def delete_buy_alert(
    alert_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_access(current_user)

    alert = (await db.execute(
        select(BuyAlert).where(
            BuyAlert.id == alert_id,
            BuyAlert.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=404, detail="Закупка не найдена")

    await db.delete(alert)
    await db.commit()


# ─── Окно цен (min/median/max за N дней) ──────────────────────────────────────

@router.get("/price-window", response_model=PriceWindowResponse)
async def price_window(
    watchlist_id: int = Query(...),
    days: int = Query(default=3, ge=1, le=30),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    min/median/max/count реальных продаж за N дней для записи Избранного,
    с учётом её quality_filter/enchant_filter. Только чтение sales_history —
    без нагрузки на Stalcraft API. Логика фильтрации по additional_info.qlt/ptn
    повторяет compute_signals_for_entry.
    """
    _require_access(current_user)

    wl = (await db.execute(
        select(UserWatchlist).where(
            UserWatchlist.id == watchlist_id,
            UserWatchlist.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if wl is None:
        raise HTTPException(status_code=404, detail="Запись Избранного не найдена")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(SalesHistory.price_per_unit).where(
        SalesHistory.item_id   == wl.item_id,
        SalesHistory.region    == wl.region,
        SalesHistory.sale_time >= cutoff,
    )
    if wl.quality_filter is not None:
        if wl.quality_filter == 0:
            q = q.where(or_(
                SalesHistory.additional_info["qlt"].astext.is_(None),
                SalesHistory.additional_info["qlt"].astext == "0",
            ))
        else:
            q = q.where(SalesHistory.additional_info["qlt"].astext == str(wl.quality_filter))
    if wl.enchant_filter is not None:
        if wl.enchant_filter == 0:
            q = q.where(or_(
                SalesHistory.additional_info["ptn"].astext.is_(None),
                SalesHistory.additional_info["ptn"].astext == "0",
            ))
        else:
            q = q.where(SalesHistory.additional_info["ptn"].astext == str(wl.enchant_filter))

    prices = (await db.execute(q)).scalars().all()

    if not prices:
        return PriceWindowResponse(min=None, median=None, max=None, count=0, days=days)

    return PriceWindowResponse(
        min=int(min(prices)),
        median=float(_statistics.median(prices)),
        max=int(max(prices)),
        count=len(prices),
        days=days,
    )
