from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.security import decode_token
from app.core.tiers import apply_tier_expiry
from app.db.session import get_db
from app.models.models import User

bearer = HTTPBearer(auto_error=False)

LAST_SEEN_THROTTLE_SECONDS = 60


async def _throttled_update_last_seen(user: User, db: AsyncSession) -> None:
    """Обновляет last_seen не чаще раза в LAST_SEEN_THROTTLE_SECONDS на пользователя."""
    import redis.asyncio as aioredis
    from app.core.config import settings

    r = await aioredis.from_url(settings.redis_url, decode_responses=True)
    throttle_key = f"last_seen:{user.id}"
    try:
        if not await r.exists(throttle_key):
            await r.setex(throttle_key, LAST_SEEN_THROTTLE_SECONDS, "1")
            user.last_seen = datetime.now(timezone.utc)
            await db.commit()
    finally:
        await r.aclose()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user_id = decode_token(credentials.credentials)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = (await db.execute(select(User).where(User.id == user_id, User.is_active == True))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if not user.is_approved and not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account not approved")

    await apply_tier_expiry(user, db)
    await _throttled_update_last_seen(user, db)
    return user


async def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


async def get_market_radar_access(current_user: User = Depends(get_current_user)) -> User:
    """Радар рынка — отдельный аддон-флаг, не часть тарифной лестницы. Админы обходят флаг."""
    if not current_user.is_admin and not current_user.has_market_radar_addon:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Market radar addon required")
    return current_user
