"""
Telegram интеграция — привязка аккаунта.

Поток привязки:
1. GET /telegram/link-code  → генерирует 6-значный код, TTL 10 мин (Redis)
2. Пользователь отправляет боту: /link XXXXXX
3. Бот ищет user_id по коду в Redis, сохраняет telegram_chat_id в БД
4. GET /telegram/status → возвращает is_linked=True после привязки
"""
import random
import string

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.models import User

router = APIRouter(prefix="/telegram", tags=["Telegram"])

LINK_CODE_TTL  = 600  # 10 мин
_redis_client: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def _gen_code() -> str:
    return "".join(random.choices(string.digits, k=6))


# ─── Схемы ───────────────────────────────────────────────────────────────────

class LinkCodeResponse(BaseModel):
    code: str
    ttl_seconds: int
    bot_username: str
    instruction: str


class TelegramStatusResponse(BaseModel):
    is_linked: bool
    telegram_username: str | None


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/link-code", response_model=LinkCodeResponse)
async def get_link_code(
    current_user: User = Depends(get_current_user),
    _: AsyncSession = Depends(get_db),
):
    """
    Генерирует 6-значный код для привязки Telegram.
    Код живёт 10 минут. Повторный вызов выдаёт новый код.
    """
    r = await _get_redis()
    code = _gen_code()
    await r.setex(f"tg_link:{code}", LINK_CODE_TTL, str(current_user.id))
    bot_username = getattr(settings, "telegram_bot_username", "SC_TRADING_auc_bot")
    return LinkCodeResponse(
        code=code,
        ttl_seconds=LINK_CODE_TTL,
        bot_username=bot_username,
        instruction=f"Отправьте боту @{bot_username} команду:\n/link {code}",
    )


@router.get("/status", response_model=TelegramStatusResponse)
async def get_telegram_status(
    current_user: User = Depends(get_current_user),
):
    """Возвращает статус привязки Telegram для текущего пользователя."""
    return TelegramStatusResponse(
        is_linked=current_user.telegram_chat_id is not None,
        telegram_username=current_user.telegram_username,
    )


@router.delete("/unlink")
async def unlink_telegram(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Отвязывает Telegram от аккаунта."""
    current_user.telegram_chat_id  = None
    current_user.telegram_username = None
    await db.commit()
    return {"ok": True}
