"""Данные о радиационных выбросах (emission events)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.models import EmissionEvent

router = APIRouter(prefix="/emission", tags=["Emission"])


class EmissionCurrentResponse(BaseModel):
    is_active: bool
    started_at: datetime | None
    duration_min: int | None
    previous_start: datetime | None
    previous_end: datetime | None
    previous_duration_min: int | None
    seconds_since_last: int | None


class EmissionHistoryItem(BaseModel):
    id: int
    started_at: datetime
    ended_at: datetime | None
    duration_min: int | None
    detected_at: datetime


def _duration_min(event: EmissionEvent, now: datetime) -> int | None:
    if event is None:
        return None
    end = event.ended_at or now
    return round((end - event.started_at).total_seconds() / 60)


@router.get("/current", response_model=EmissionCurrentResponse)
async def get_emission_current(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Текущий статус выброса и данные о последнем завершённом событии."""
    now = datetime.now(timezone.utc)

    rows = (await db.execute(
        select(EmissionEvent)
        .order_by(desc(EmissionEvent.started_at))
        .limit(2)
    )).scalars().all()

    active = next((e for e in rows if e.ended_at is None), None)
    last_ended = next((e for e in rows if e.ended_at is not None), None)

    return EmissionCurrentResponse(
        is_active=active is not None,
        started_at=active.started_at if active else None,
        duration_min=_duration_min(active, now) if active else None,
        previous_start=last_ended.started_at if last_ended else None,
        previous_end=last_ended.ended_at if last_ended else None,
        previous_duration_min=_duration_min(last_ended, now) if last_ended else None,
        seconds_since_last=(
            round((now - last_ended.ended_at).total_seconds()) if last_ended else None
        ),
    )


@router.get("/history", response_model=list[EmissionHistoryItem])
async def get_emission_history(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
):
    """История последних N выбросов (по умолчанию 50)."""
    rows = (await db.execute(
        select(EmissionEvent)
        .order_by(desc(EmissionEvent.started_at))
        .limit(limit)
    )).scalars().all()

    return [
        EmissionHistoryItem(
            id=e.id,
            started_at=e.started_at,
            ended_at=e.ended_at,
            duration_min=(
                round((e.ended_at - e.started_at).total_seconds() / 60)
                if e.ended_at else None
            ),
            detected_at=e.detected_at,
        )
        for e in rows
    ]
