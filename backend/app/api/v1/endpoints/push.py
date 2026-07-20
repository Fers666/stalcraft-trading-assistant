"""Web Push: выдача VAPID-ключа и управление подписками устройств.

Подписка создаётся фронтом (SettingsPage) после согласия пользователя в браузере:
Notification.requestPermission() → pushManager.subscribe(applicationServerKey) →
POST /push/subscribe. Один пользователь = много подписок (ПК + телефон).
Рассылку выполняет отдельный сервис push_service (consumer RabbitMQ).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import User, PushSubscription
from app.core.dependencies import get_current_user
from app.core.config import settings

router = APIRouter(prefix="/push", tags=["Push"])


class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribePayload(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


class UnsubscribePayload(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
async def get_vapid_public_key():
    """Публичный VAPID-ключ для pushManager.subscribe() на фронте."""
    if not settings.vapid_public_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Web push не сконфигурирован (VAPID-ключи отсутствуют)",
        )
    return {"public_key": settings.vapid_public_key}


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def subscribe(
    payload: SubscribePayload,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upsert подписки по endpoint: одно устройство/браузер = одна запись."""
    existing = (await db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )).scalar_one_or_none()

    user_agent = request.headers.get("user-agent", "")[:300] or None

    if existing is not None:
        # endpoint мог принадлежать другому пользователю (общий браузер) —
        # переназначаем и обновляем ключи.
        existing.user_id = current_user.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        existing.user_agent = user_agent
        existing.last_used_at = datetime.now(timezone.utc)
    else:
        db.add(PushSubscription(
            user_id=current_user.id,
            endpoint=payload.endpoint,
            p256dh=payload.keys.p256dh,
            auth=payload.keys.auth,
            user_agent=user_agent,
        ))

    await db.commit()


@router.post("/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    payload: UnsubscribePayload,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Удаляет подписку текущего пользователя по endpoint (idempotent)."""
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint,
            PushSubscription.user_id == current_user.id,
        )
    )
    await db.commit()
