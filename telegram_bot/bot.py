#!/usr/bin/env python3
"""
Telegram Bot — Stalcraft Trading Assistant.

Команды:
  /start       — приветствие и инструкция по привязке
  /link CODE   — привязать аккаунт по 6-значному коду из настроек приложения
  /status      — показать статус привязки
  /stop        — отвязать аккаунт и отключить уведомления

Событийный консьюмер (RabbitMQ, вместо polling Redis):
  - Слушает durable-очередь telegram.notifications, привязанную к DIRECT-exchange
    push.events (routing_key push). Продюсер (Celery-коллектор) публикует туда
    события profitable_lot / buy_alert / emission — те же, что получает web push.
  - Fan-out на стороне брокера: web push и Telegram имеют по своей очереди на один
    exchange, поэтому каждый получает копию каждого события. Продюсер не меняется.
  - Рендер сообщений (build_lot_message / build_buy_message / тексты выброса)
    остаётся прежним; источник данных — payload события, а не Redis-poll.
  - Дедуп: Redis-ключи tg_sent:* / tg_buy_sent:* / tg_emission_sent:*
    (независимы от push_*). Best-effort ack всегда (poison-message safety, без DLX).
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

import aio_pika
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

sys.path.insert(0, "/app")
from app.models.models import User, UserWatchlist, UserSettings
from app.services.profitable_lots import NOTIF_DEDUP_TTL
from app.services.push_broker import EXCHANGE_NAME, ROUTING_KEY
from app.core.tiers import get_tier_limits

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Конфиг из env ────────────────────────────────────────────────────────────

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL    = os.environ.get("REDIS_URL", "redis://redis:6379/0")
RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
BOT_TOKEN    = os.environ["TELEGRAM_BOT_TOKEN"]
BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "SC_TRADING_auc_bot")
APP_ENV      = os.environ.get("APP_ENV", "production").lower()
IS_STAGE     = APP_ENV == "stage"

QUEUE_NAME = "telegram.notifications"
PREFETCH   = 20
QUEUE_TTL_MS = 15 * 60 * 1000  # 15 мин — очередь не отдаёт протухшее после простоя
CONSUMER_RETRY_SEC = 5  # пауза перед реконнектом консьюмера после сбоя цикла
EMISSION_MAX_AGE_MIN = 15  # мин — события старше не рассылаем (защита от спама историей)

# ─── DB / Redis ───────────────────────────────────────────────────────────────

engine        = create_async_engine(DATABASE_URL, pool_size=5, max_overflow=2)
SessionLocal  = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
_redis: Optional[aioredis.Redis] = None
_consumer_task: Optional[asyncio.Task] = None


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


def build_buy_message(
    item_name: str,
    quality_name: Optional[str],
    enchant: Optional[int],
    price_per_unit: int,
    target_price: int,
    amount: int,
) -> str:
    prefix = "[STAGE] " if IS_STAGE else ""

    title_extra = ""
    if quality_name:
        title_extra += f" · {quality_name}"
    if enchant is not None:
        enchant_str = "Не точёный" if enchant == 0 else f"+{enchant}"
        title_extra += f" · {enchant_str}"

    return (
        f"{prefix}🛒 <b>Дешёвый лот! {item_name}{title_extra}</b>\n\n"
        f"<b>{fmt(price_per_unit)} ₽/шт</b> ≤ ваш порог {fmt(target_price)} ₽/шт\n"
        f"📦 Доступно: <b>{amount}</b> шт"
    )


def build_emission_message(event: dict) -> str:
    """Текст уведомления о выбросе (start/end) — как в polling-версии,
    источник данных теперь payload события, а не строка EmissionEvent."""
    prefix = "[STAGE] " if IS_STAGE else ""

    if event.get("phase") == "start":
        time_line = ""
        started_at = event.get("started_at")
        if started_at:
            try:
                local_time = datetime.fromisoformat(started_at).astimezone(timezone(timedelta(hours=3)))
                time_line = f"Время: {local_time.strftime('%H:%M')} МСК\n"
            except ValueError:
                pass
        return (
            f"{prefix}<b>Выброс начался</b>\n"
            f"{time_line}"
            f"Аукционная активность снижена (~15 мин)"
        )

    duration_min = None
    started_at, ended_at = event.get("started_at"), event.get("ended_at")
    if started_at and ended_at:
        try:
            duration_min = round(
                (datetime.fromisoformat(ended_at) - datetime.fromisoformat(started_at)).total_seconds() / 60
            )
        except ValueError:
            pass
    dur_str = f" (длился {duration_min} мин)" if duration_min else ""
    return f"{prefix}<b>Выброс завершён</b>{dur_str}\nАукцион возвращается к норме"


# ─── Гейты получателя ─────────────────────────────────────────────────────────

async def _load_user_gate(db: AsyncSession, user_id: int, gate_attr: str) -> Optional[User]:
    """Загружает пользователя и проверяет: привязан Telegram (telegram_chat_id),
    активен/подтверждён, канальный тумблер notify_telegram, тарифный гейт.
    Возвращает User если можно слать, иначе None."""
    row = (await db.execute(
        select(User, UserSettings)
        .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
        .where(
            User.id == user_id,
            User.is_active == True,
            User.telegram_chat_id.isnot(None),
        )
    )).first()
    if row is None:
        return None
    user, us = row
    if not (user.is_approved or user.is_admin):
        return None
    if us is not None and not us.notify_telegram:
        return None
    if not (user.is_admin or getattr(get_tier_limits(user), gate_attr)):
        return None
    return user


# ─── Обработчики событий ──────────────────────────────────────────────────────

async def handle_profitable_lot(db, r, app: Application, event: dict) -> None:
    user = await _load_user_gate(db, event["user_id"], "telegram_notifications")
    if user is None:
        return

    signal = event.get("signal", {})
    sell_options = signal.get("sell_options", [])
    for lot in signal.get("lots", []):
        start_time = lot.get("start_time", "")
        dedup = (
            f"tg_sent:{user.id}:{event['item_id']}:{event['region']}"
            f":{event['quality_filter']}:{event['enchant_filter']}:{start_time}"
        )
        if await r.exists(dedup):
            continue

        msg = build_lot_message(
            item_name        = event["item_name"],
            quality_name     = lot.get("quality_name"),
            enchant          = lot.get("enchant"),
            buyout_per_unit  = lot["buyout_per_unit"],
            sell_options     = sell_options,
            sales_volume_7d  = signal.get("volume_7d"),
            volatility_7d    = signal.get("volatility_7d"),
            trend            = signal.get("trend"),
            saturation_ratio = signal.get("saturation_ratio"),
        )
        try:
            await app.bot.send_message(
                chat_id=user.telegram_chat_id, text=msg, parse_mode="HTML",
            )
            await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
            logger.info(
                f"Notified user={user.id} item={event['item_id']} price={lot['buyout_per_unit']}"
            )
        except Exception as e:
            logger.error(f"Failed to send message to chat_id={user.telegram_chat_id}: {e}")


async def handle_buy_alert(db, r, app: Application, event: dict) -> None:
    user = await _load_user_gate(db, event["user_id"], "buy_sniper_notifications")
    if user is None:
        return

    cheapest = event["cheapest"]
    start_time = cheapest.get("start_time", "")
    dedup = (
        f"tg_buy_sent:{user.id}:{event['item_id']}:{event['region']}"
        f":{event['quality_filter']}:{event['enchant_filter']}:{start_time}"
    )
    if await r.exists(dedup):
        return

    msg = build_buy_message(
        item_name      = event["item_name"],
        quality_name   = cheapest.get("quality_name"),
        enchant        = cheapest.get("enchant"),
        price_per_unit = cheapest["price_per_unit"],
        target_price   = event["target_price"],
        amount         = cheapest.get("amount", 0),
    )
    try:
        await app.bot.send_message(
            chat_id=user.telegram_chat_id, text=msg, parse_mode="HTML",
        )
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        logger.info(
            f"Buy-alert notified user={user.id} item={event['item_id']} "
            f"price={cheapest['price_per_unit']} target={event['target_price']}"
        )
    except Exception as e:
        logger.error(f"Failed to send buy-alert to chat_id={user.telegram_chat_id}: {e}")


async def handle_emission(db, r, app: Application, event: dict) -> None:
    # Отсечка свежести — не рассылаем историю после простоя консьюмера.
    ref_ts = event.get("started_at") if event.get("phase") == "start" else event.get("ended_at")
    if ref_ts:
        try:
            if datetime.now(timezone.utc) - datetime.fromisoformat(ref_ts) > timedelta(minutes=EMISSION_MAX_AGE_MIN):
                return
        except ValueError:
            pass

    dedup = f"tg_emission_sent:{event.get('event_id')}:{event.get('phase')}"
    if await r.exists(dedup):
        return

    # Получатели: все привязанные+активные+подтверждённые с включённым каналом.
    # Без тарифного гейта — как emission в старой polling-версии.
    rows = (await db.execute(
        select(User, UserSettings)
        .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
        .where(
            User.telegram_chat_id.isnot(None),
            User.is_active == True,
            User.is_approved == True,
        )
    )).all()
    recipients = [u for u, us in rows if us is None or us.notify_telegram]
    if not recipients:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        return

    text = build_emission_message(event)
    sent = 0
    for user in recipients:
        try:
            await app.bot.send_message(
                chat_id=user.telegram_chat_id, text=text, parse_mode="HTML",
            )
            sent += 1
        except Exception as e:
            logger.error(f"Emission send failed chat_id={user.telegram_chat_id}: {e}")

    if sent > 0:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        logger.info(
            f"Emission {event.get('phase')} notified: event_id={event.get('event_id')} "
            f"sent={sent}/{len(recipients)}"
        )


HANDLERS = {
    "profitable_lot": handle_profitable_lot,
    "buy_alert": handle_buy_alert,
    "emission": handle_emission,
}


async def handle_message(app: Application, body: bytes) -> None:
    event = json.loads(body)
    handler = HANDLERS.get(event.get("type"))
    if handler is None:
        logger.warning(f"Unknown event type: {event.get('type')}")
        return
    r = await get_redis()
    async with SessionLocal() as db:
        await handler(db, r, app, event)


# ─── Consumer loop ────────────────────────────────────────────────────────────

async def _consume_loop(app: Application) -> None:
    """Слушает telegram.notifications и рассылает события. Стартует из post_init
    как asyncio task в том же loop, что и PTB — переиспользует app.bot.

    Супервайзер-петля: если потребление упадёт с исключением, вышедшим за пределы
    самолечения connect_robust (например из queue.iterator()), логируем и
    переподнимаем консьюмер после паузы — иначе таск тихо умирает при живом
    процессе PTB (Docker restart не срабатывает, доставка молча встаёт)."""
    while True:
        connection = None
        try:
            connection = await aio_pika.connect_robust(RABBITMQ_URL)
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=PREFETCH)

            exchange = await channel.declare_exchange(EXCHANGE_NAME, aio_pika.ExchangeType.DIRECT, durable=True)
            queue = await channel.declare_queue(
                QUEUE_NAME, durable=True, arguments={"x-message-ttl": QUEUE_TTL_MS},
            )
            await queue.bind(exchange, routing_key=ROUTING_KEY)

            logger.info(f"Telegram consumer запущен, слушаю {QUEUE_NAME}")

            async with queue.iterator() as it:
                async for message in it:
                    try:
                        await handle_message(app, message.body)
                    except Exception as e:
                        logger.error(f"handle_message error: {e}", exc_info=True)
                    finally:
                        # Best-effort: всегда ack (без DLX не хотим бесконечный requeue).
                        await message.ack()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Consumer loop crashed, reconnect in {CONSUMER_RETRY_SEC}s: {e}", exc_info=True)
            await asyncio.sleep(CONSUMER_RETRY_SEC)
        finally:
            if connection is not None:
                await connection.close()


# ─── Command handlers ─────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 <b>SZ Trading Assistant</b>\n\n"
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
    global _consumer_task
    _consumer_task = asyncio.create_task(_consume_loop(application))
    logger.info("Consumer task started")


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
