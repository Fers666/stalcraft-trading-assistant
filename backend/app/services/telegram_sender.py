"""Отправка сообщений через Telegram Bot API."""
import logging
from app.core.config import settings

logger = logging.getLogger(__name__)


async def send_telegram_message(chat_id: int, text: str) -> bool:
    """Отправляет HTML-сообщение пользователю. Возвращает True при успехе."""
    if not settings.telegram_bot_token:
        logger.warning("TELEGRAM_BOT_TOKEN не задан — уведомление пропущено")
        return False
    try:
        from telegram import Bot
        async with Bot(token=settings.telegram_bot_token) as bot:
            await bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        return True
    except Exception as exc:
        logger.error(f"Telegram send failed → chat_id={chat_id}: {exc}")
        return False
