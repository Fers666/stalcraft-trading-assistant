"""
Быстрый поиск активных лотов по товару без добавления в watchlist.

Данные берутся из Redis-кэша (TTL 5 мин).
Если кэш пуст — делается прямой запрос к Stalcraft API.
Это позволяет разным пользователям не дублировать запросы к API.
"""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.core.dependencies import get_current_user
from app.models.models import User
from app.services.cache.api_cache import api_cache

router = APIRouter(prefix="/lots", tags=["Lots"])


class LotItem(BaseModel):
    item_id: str
    amount: int
    start_price: int
    buyout_price: int
    start_time: str
    end_time: str
    hours_remaining: float | None = None
    is_expiring: bool = False       # True если осталось < 2ч


class LotsResponse(BaseModel):
    item_id: str
    region: str
    total: int
    lots: list[LotItem]
    from_cache: bool
    cache_note: str


@router.get("/{item_id}", response_model=LotsResponse)
async def get_item_lots(
    item_id: str,
    region: str = Query(default="RU", description="Регион: RU, EU, NA, SEA"),
    _: User = Depends(get_current_user),
):
    """
    Возвращает активные лоты для товара из кэша или напрямую из Stalcraft API.
    Не требует добавления товара в watchlist.
    """
    region = region.upper()
    if region not in ("RU", "EU", "NA", "SEA"):
        raise HTTPException(status_code=400, detail="Invalid region. Use: RU, EU, NA, SEA")

    data = await api_cache.get_or_fetch_lots(region, item_id)
    raw_lots = data.get("lots", [])
    from_cache = data.get("_from_cache", False)

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

        lots.append(LotItem(
            item_id=lot.get("itemId", item_id),
            amount=lot.get("amount", 1),
            start_price=lot.get("startPrice", 0),
            buyout_price=lot.get("buyoutPrice", 0),
            start_time=lot.get("startTime", ""),
            end_time=end_str,
            hours_remaining=hours_remaining,
            is_expiring=is_expiring,
        ))

    # Сортируем: сначала ликвидные, потом по цене
    lots.sort(key=lambda l: (l.is_expiring, l.buyout_price))

    cache_note = (
        "Данные из кэша (обновляются каждые 5 мин)" if from_cache
        else "Свежие данные из API"
    )

    return LotsResponse(
        item_id=item_id,
        region=region,
        total=data.get("total", len(lots)),
        lots=lots,
        from_cache=from_cache,
        cache_note=cache_note,
    )
