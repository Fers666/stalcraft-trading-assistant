"""
Telegram интеграция — привязка аккаунта и webhook-обработчик бота.

Поток привязки:
1. GET /telegram/link-code  → генерирует 6-значный код, TTL 10 мин (Redis)
2. Пользователь отправляет боту: /link XXXXXX
3. Бот получает команду через webhook POST /telegram/webhook
4. Бот ищет user_id по коду в Redis, сохраняет telegram_chat_id в БД
5. GET /telegram/status → возвращает is_linked=True после привязки

Webhook регистрируется автоматически при старте приложения если TELEGRAM_WEBHOOK_URL задан.
"""
import hashlib
import hmac
import logging
import random
import string

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.models import User

router = APIRouter(prefix="/telegram", tags=["Telegram"])
logger = logging.getLogger(__name__)

LINK_CODE_TTL  = 600  # 10 мин
_redis_client: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def _gen_code() -> str:
    return "".join(random.choices(string.digits, k=6))


async def _bot_send(chat_id: int, text: str) -> None:
    """Быстрая отправка без создания Application."""
    from app.services.telegram_sender import send_telegram_message
    await send_telegram_message(chat_id, text)


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
    bot_username = settings.telegram_bot_username
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


@router.post("/webhook", include_in_schema=False)
async def telegram_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Webhook-обработчик обновлений от Telegram Bot API.
    Обрабатывает команду /link {code} и /start.
    """
    if not settings.telegram_bot_token:
        return Response(status_code=403)

    # Проверяем X-Telegram-Bot-Api-Secret-Token если задан
    secret = getattr(settings, "telegram_webhook_secret", "") or ""
    if secret:
        incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not hmac.compare_digest(incoming, secret):
            return Response(status_code=403)

    try:
        data = await request.json()
    except Exception:
        return Response(status_code=400)

    message = data.get("message") or data.get("edited_message")
    if not message:
        return Response(status_code=200)  # ignoring non-message updates

    chat_id  = message.get("chat", {}).get("id")
    text     = (message.get("text") or "").strip()
    from_obj = message.get("from") or {}
    username = from_obj.get("username")

    if not chat_id or not text:
        return Response(status_code=200)

    # /start — приветствие
    if text in ("/start", "/start@" + settings.telegram_bot_username):
        await _bot_send(
            chat_id,
            "👋 <b>Stalcraft Trading Assistant</b>\n\n"
            "Для привязки аккаунта:\n"
            "1. Зайдите в приложение → Настройки\n"
            "2. Получите код и отправьте боту: <code>/link 123456</code>\n\n"
            "Проверить статус: /status\n"
            "Отключить уведомления: /stop",
        )
        return Response(status_code=200)

    # /status — статус привязки
    if text in ("/status", "/status@" + settings.telegram_bot_username):
        user = (await db.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        )).scalar_one_or_none()
        if user:
            from sqlalchemy import func
            from app.models.models import UserWatchlist
            wl_count = (await db.execute(
                select(func.count()).select_from(UserWatchlist).where(
                    UserWatchlist.user_id == user.id,
                    UserWatchlist.is_active == True,
                )
            )).scalar_one()
            await _bot_send(
                chat_id,
                f"✅ <b>Аккаунт привязан</b>\n"
                f"Логин: <b>{user.username}</b>\n"
                f"Предметов в вотчлисте: <b>{wl_count}</b>\n\n"
                f"Уведомления о выгодных лотах активны.\n"
                f"Отключить: /stop",
            )
        else:
            await _bot_send(
                chat_id,
                "❌ <b>Аккаунт не привязан</b>\n\n"
                "Используйте /start для инструкции по привязке.",
            )
        return Response(status_code=200)

    # /stop — отвязать аккаунт
    if text in ("/stop", "/stop@" + settings.telegram_bot_username):
        user = (await db.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        )).scalar_one_or_none()
        if user:
            user.telegram_chat_id  = None
            user.telegram_username = None
            await db.commit()
            await _bot_send(
                chat_id,
                "✅ Уведомления отключены. Аккаунт отвязан от Telegram.\n"
                "Для повторной привязки используйте /start.",
            )
        else:
            await _bot_send(chat_id, "Аккаунт и так не привязан.")
        return Response(status_code=200)

    # /link {code}
    if text.startswith("/link"):
        parts = text.split()
        if len(parts) < 2:
            await _bot_send(chat_id, "❌ Укажите код: <code>/link 123456</code>")
            return Response(status_code=200)

        code = parts[1].strip()
        r = await _get_redis()
        user_id_str = await r.get(f"tg_link:{code}")

        if not user_id_str:
            await _bot_send(
                chat_id,
                "❌ Код не найден или истёк (TTL 10 минут).\n"
                "Сгенерируйте новый код в приложении.",
            )
            return Response(status_code=200)

        user_id = int(user_id_str)
        user = (await db.execute(
            select(User).where(User.id == user_id)
        )).scalar_one_or_none()

        if not user:
            await _bot_send(chat_id, "❌ Пользователь не найден.")
            return Response(status_code=200)

        user.telegram_chat_id  = chat_id
        user.telegram_username = username
        await db.commit()
        await r.delete(f"tg_link:{code}")  # одноразовый код

        await _bot_send(
            chat_id,
            "✅ <b>Telegram успешно привязан!</b>\n\n"
            "Теперь вы будете получать уведомления о выгодных лотах.\n"
            "Управление уведомлениями — в Настройках приложения.",
        )
        logger.info(f"Telegram linked: user_id={user_id} chat_id={chat_id}")
        return Response(status_code=200)

    return Response(status_code=200)


async def register_webhook() -> None:
    """
    Регистрирует webhook у Telegram при старте приложения.
    Вызывается из lifespan в main.py.
    """
    if not settings.telegram_bot_token or not settings.telegram_webhook_url:
        logger.info("Telegram webhook не настроен (TELEGRAM_WEBHOOK_URL не задан)")
        return
    try:
        from telegram import Bot
        webhook_url = settings.telegram_webhook_url.rstrip("/") + "/api/v1/telegram/webhook"
        async with Bot(token=settings.telegram_bot_token) as bot:
            await bot.set_webhook(
                url=webhook_url,
                allowed_updates=["message"],
                drop_pending_updates=True,
            )
        logger.info(f"Telegram webhook зарегистрирован: {webhook_url}")
    except Exception as exc:
        logger.error(f"Не удалось зарегистрировать Telegram webhook: {exc}")
