#!/usr/bin/env python3
"""
Telegram Bot — Stalcraft Trading Assistant.

Команды:
  /start       — приветствие и инструкция по привязке
  /link CODE   — привязать аккаунт по 6-значному коду из настроек приложения
  /status      — показать статус привязки
  /stop        — отвязать аккаунт и отключить уведомления

Фоновый цикл (каждые 15 сек):
  - Читает предвычисленные сигналы из Redis (ключи signals:user_id:…)
  - Сигналы публикуются коллектором сразу после сбора свежего снапшота
  - Дедуплицирует по startTime лота (одно уведомление на лот за 48ч)
  - Отправляет отдельное сообщение на каждый выгодный лот
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

sys.path.insert(0, "/app")
from app.models.models import User, UserWatchlist, UserSettings
from app.services.profitable_lots import signals_key, NOTIF_DEDUP_TTL
from app.core.tiers import get_tier_limits

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Конфиг из env ────────────────────────────────────────────────────────────

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL    = os.environ.get("REDIS_URL", "redis://redis:6379/0")
BOT_TOKEN    = os.environ["TELEGRAM_BOT_TOKEN"]
BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "SC_TRADING_auc_bot")
APP_ENV      = os.environ.get("APP_ENV", "production").lower()
IS_STAGE     = APP_ENV == "stage"

POLL_INTERVAL = 15    # сек — интервал проверки Redis (просто чтение, быстро)

# ─── DB / Redis ───────────────────────────────────────────────────────────────

engine        = create_async_engine(DATABASE_URL, pool_size=5, max_overflow=2)
SessionLocal  = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
_redis: Optional[aioredis.Redis] = None
_notifier_task: Optional[asyncio.Task] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


# ─── Форматирование ───────────────────────────────────────────────────────────

def fmt(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def volatility_label(v: float) -> str:
    if v <= 15:
        return "низкая"
    elif v <= 30:
        return "средняя"
    return "высокая"


def build_lot_message(
    item_name: str,
    quality_name: Optional[str],
    enchant: Optional[int],
    buyout_per_unit: int,
    sell_options: list[dict],
    sales_volume_7d: Optional[int],
    volatility_7d: Optional[float],
    profit_per_hour: Optional[float] = None,
    trend: Optional[str] = None,
    saturation_ratio: Optional[float] = None,
) -> str:
    prefix = "[STAGE] " if IS_STAGE else ""

    title_extra = ""
    if quality_name:
        title_extra += f" · {quality_name}"
    if enchant is not None:
        enchant_str = "Не точёный" if enchant == 0 else f"+{enchant}"
        title_extra += f" · {enchant_str}"

    lines: list[str] = [
        f"{prefix}🟢 <b>{item_name}{title_extra}</b>",
        "",
        f"💰 Купить: <b>{fmt(buyout_per_unit)} ₽/шт</b>",
    ]

    if trend == "falling":
        lines.append("⚠️ Рынок ниже недельной медианы — прогноз цены снижен")

    lines += ["", "📈 <b>Варианты продажи (−5% комиссия):</b>"]

    label_map = {"fast": "Быстро   ", "normal": "Нормально", "premium": "Выгодно  "}
    for opt in sell_options:
        net    = opt["net_price_per_unit"]
        profit = net - buyout_per_unit
        sign   = "+" if profit >= 0 else ""
        marker = "✅" if profit > 0 else "❌"
        label  = label_map.get(opt.get("label", ""), opt.get("label_ru", ""))
        lines.append(
            f"{marker} <code>{label}</code>"
            f" → выставить <b>{fmt(opt['price_per_unit'])} ₽</b>"
            f" · получишь {fmt(net)} ₽"
            f" · <b>{sign}{fmt(profit)} ₽</b>"
        )

    if profit_per_hour is not None:
        lines.append(f"⏱ Доходность: <b>~{fmt(round(profit_per_hour))} ₽/час</b> (на тарифе «Быстро»)")

    footer: list[str] = []
    if sales_volume_7d is not None:
        footer.append(f"📦 Продаж за 7д: <b>{sales_volume_7d}</b> шт")
    if volatility_7d is not None:
        footer.append(f"📉 Волатильность: <b>{volatility_7d:.1f}%</b> ({volatility_label(volatility_7d)})")
    if saturation_ratio is not None and saturation_ratio > 1:
        footer.append("⚠️ Много похожих выгодных лотов сразу — рынок может не успеть их переварить")
    if footer:
        lines += [""] + footer

    return "\n".join(lines)


# ─── Notifier loop ────────────────────────────────────────────────────────────

async def notify_profitable_lots(app: Application) -> None:
    """
    Читает предвычисленные сигналы из Redis и отправляет Telegram-уведомления.

    Сигналы публикуются коллектором сразу после каждого успешного сбора,
    поэтому бот видит те же данные что и сайт — рассинхрон невозможен.
    """
    r = await get_redis()

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(User, UserSettings)
            .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
            .where(
                User.telegram_chat_id.isnot(None),
                User.is_active == True,
            )
        )).all()

        users_to_notify = [
            (user, us) for user, us in rows
            if (us is None or us.notify_telegram)
            and (user.is_admin or get_tier_limits(user).telegram_notifications)
        ]
        if not users_to_notify:
            return

        for user, _ in users_to_notify:
            watchlist = (await db.execute(
                select(UserWatchlist)
                .where(
                    UserWatchlist.user_id   == user.id,
                    UserWatchlist.is_active == True,
                )
            )).scalars().all()

            for entry in watchlist:
                key = signals_key(
                    user.id, entry.item_id, entry.region,
                    entry.quality_filter, entry.enchant_filter,
                )
                raw = await r.get(key)
                if not raw:
                    continue

                try:
                    signals = json.loads(raw)
                except Exception:
                    continue

                lots        = signals.get("lots", [])
                sell_options = signals.get("sell_options", [])
                volume_7d   = signals.get("volume_7d")
                volatility  = signals.get("volatility_7d")
                trend       = signals.get("trend")
                saturation  = signals.get("saturation_ratio")

                for lot in lots:
                    start_time = lot.get("start_time", "")
                    dedup = (
                        f"tg_sent:{user.id}:{entry.item_id}:{entry.region}"
                        f":{entry.quality_filter}:{entry.enchant_filter}"
                        f":{start_time}"
                    )
                    if await r.exists(dedup):
                        continue

                    # Получаем имя предмета из БД (можно закэшировать, но watchlist небольшой)
                    from app.models.models import MasterItem
                    master = (await db.execute(
                        select(MasterItem).where(MasterItem.item_id == entry.item_id)
                    )).scalar_one_or_none()
                    item_name = (
                        (master.name_ru or master.name_en or entry.item_id)
                        if master else entry.item_id
                    )

                    msg = build_lot_message(
                        item_name        = item_name,
                        quality_name     = lot.get("quality_name"),
                        enchant          = lot.get("enchant"),
                        buyout_per_unit  = lot["buyout_per_unit"],
                        sell_options     = sell_options,
                        sales_volume_7d  = volume_7d,
                        volatility_7d    = volatility,
                        profit_per_hour  = lot.get("profit_per_hour"),
                        trend            = trend,
                        saturation_ratio = saturation,
                    )

                    try:
                        await app.bot.send_message(
                            chat_id=user.telegram_chat_id,
                            text=msg,
                            parse_mode="HTML",
                        )
                        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
                        logger.info(
                            f"Notified user={user.id} item={entry.item_id} "
                            f"price={lot['buyout_per_unit']}"
                        )
                    except Exception as e:
                        logger.error(
                            f"Failed to send message to chat_id={user.telegram_chat_id}: {e}"
                        )


async def _notifier_loop(app: Application) -> None:
    """Бесконечный цикл уведомлений, запускается как asyncio task при старте бота."""
    await asyncio.sleep(15)  # небольшая задержка после старта
    while True:
        try:
            await notify_profitable_lots(app)
        except Exception as e:
            logger.error(f"Notifier loop error: {e}", exc_info=True)
        await asyncio.sleep(POLL_INTERVAL)


# ─── Command handlers ─────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 <b>Stalcraft Trading Assistant</b>\n\n"
        "Этот бот отправляет уведомления о выгодных лотах из вашего вотчлиста.\n\n"
        "📋 <b>Как привязать аккаунт:</b>\n"
        "1. Войдите в приложение SC Trading\n"
        "2. Перейдите в <b>Настройки → Telegram</b>\n"
        "3. Нажмите «Получить код привязки»\n"
        "4. Отправьте сюда: <code>/link XXXXXX</code>\n\n"
        "Проверить статус: /status\n"
        "Отключить уведомления: /stop",
        parse_mode="HTML",
    )


async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text(
            "❌ Укажите код: <code>/link XXXXXX</code>\n\n"
            "Код получается в <b>Настройки → Telegram</b> приложения SC Trading.",
            parse_mode="HTML",
        )
        return

    code = context.args[0].strip().upper()
    r    = await get_redis()

    user_id_str = await r.get(f"tg_link:{code}")
    if not user_id_str:
        await update.message.reply_text(
            "❌ Код не найден или истёк срок действия (10 мин).\n"
            "Запросите новый код в настройках приложения.",
        )
        return

    user_id    = int(user_id_str)
    chat_id    = update.effective_chat.id
    tg_user    = update.effective_user
    tg_username = tg_user.username if tg_user else None

    async with SessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.id == user_id)
        )).scalar_one_or_none()

        if not user:
            await update.message.reply_text("❌ Пользователь не найден.")
            return

        user.telegram_chat_id = chat_id
        if tg_username:
            user.telegram_username = tg_username
        await db.commit()

    await r.delete(f"tg_link:{code}")

    await update.message.reply_text(
        "✅ <b>Аккаунт успешно привязан!</b>\n\n"
        "Теперь вы будете получать уведомления о выгодных лотах из вашего вотчлиста.\n\n"
        "Отключить: /stop",
        parse_mode="HTML",
    )
    logger.info(f"Linked user_id={user_id} → chat_id={chat_id}")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    async with SessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        )).scalar_one_or_none()

    if user:
        watchlist_count = 0
        async with SessionLocal() as db:
            from sqlalchemy import func
            watchlist_count = (await db.execute(
                select(func.count()).select_from(UserWatchlist)
                .where(UserWatchlist.user_id == user.id, UserWatchlist.is_active == True)
            )).scalar_one()

        await update.message.reply_text(
            f"✅ <b>Аккаунт привязан</b>\n"
            f"Логин: <b>{user.username}</b>\n"
            f"Предметов в вотчлисте: <b>{watchlist_count}</b>\n\n"
            f"Уведомления о выгодных лотах активны.\n"
            f"Отключить: /stop",
            parse_mode="HTML",
        )
    else:
        await update.message.reply_text(
            "❌ <b>Аккаунт не привязан</b>\n\n"
            "Используйте /start для инструкции по привязке.",
            parse_mode="HTML",
        )


async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    async with SessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.telegram_chat_id == chat_id)
        )).scalar_one_or_none()

        if user:
            user.telegram_chat_id = None
            await db.commit()
            await update.message.reply_text(
                "✅ Уведомления отключены. Аккаунт отвязан от Telegram.\n"
                "Для повторной привязки используйте /start.",
            )
        else:
            await update.message.reply_text("Аккаунт и так не привязан.")


# ─── Lifecycle ────────────────────────────────────────────────────────────────

async def post_init(application: Application) -> None:
    global _notifier_task
    _notifier_task = asyncio.create_task(_notifier_loop(application))
    logger.info("Notifier task started")


# ─── Entrypoint ───────────────────────────────────────────────────────────────

def main() -> None:
    if not BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is not set — exiting")
        return

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("link",   cmd_link))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("stop",   cmd_stop))

    logger.info(f"Bot @{BOT_USERNAME} starting, polling...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
