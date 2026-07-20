#!/usr/bin/env python3
"""
Push Service — consumer RabbitMQ, рассылка Web Push.

Отдельный сервис (по образцу telegram_bot): переиспользует backend-образ,
монтируется в /push_service, импортирует backend-модели через /app.

Поток:
  Celery-коллектор публикует событие {type, user_id, item, ...} в exchange
  push.events → сюда приходит в очередь push.notifications → консьюмер решает,
  кто подписан (notify_browser_push + тариф), дедуплицирует (Redis) и шлёт web
  push на все устройства пользователя (pywebpush + VAPID).

Продюсер о подписках ничего не знает — вся «курация» здесь.

Гейт по тарифу зеркалит Telegram:
  profitable_lot → telegram_notifications   (Продвинутая+)
  buy_alert      → buy_sniper_notifications  (Продвинутая+/Макс)
  emission       → без тарифного гейта (как в боте) — всем с включённым каналом
Канальный тумблер для push — notify_browser_push (вместо notify_telegram).
"""
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

import aio_pika
import redis.asyncio as aioredis
from pywebpush import webpush, WebPushException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

sys.path.insert(0, "/app")
from app.models.models import User, UserSettings, PushSubscription
from app.core.tiers import get_tier_limits
from app.services.profitable_lots import NOTIF_DEDUP_TTL
from app.services.push_broker import EXCHANGE_NAME, ROUTING_KEY

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("push_service")

# ─── Конфиг из env ────────────────────────────────────────────────────────────

DATABASE_URL       = os.environ["DATABASE_URL"]
REDIS_URL          = os.environ.get("REDIS_URL", "redis://redis:6379/0")
RABBITMQ_URL       = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
VAPID_PRIVATE_KEY  = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT      = os.environ.get("VAPID_SUBJECT", "mailto:admin@sctrading.ru")
APP_ENV            = os.environ.get("APP_ENV", "production").lower()
IS_STAGE           = APP_ENV == "stage"

QUEUE_NAME = "push.notifications"
PREFETCH   = 20
EMISSION_MAX_AGE_MIN = 15  # мин — старые emission-события не рассылаем

engine       = create_async_engine(DATABASE_URL, pool_size=5, max_overflow=2)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


# ─── Форматирование payload для showNotification ──────────────────────────────

def fmt(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def _title_extra(quality_name: Optional[str], enchant: Optional[int]) -> str:
    extra = ""
    if quality_name:
        extra += f" · {quality_name}"
    if enchant is not None:
        extra += " · " + ("Не точёный" if enchant == 0 else f"+{enchant}")
    return extra


def _stage(text: str) -> str:
    return f"[STAGE] {text}" if IS_STAGE else text


def _best_sell_net(sell_options: Optional[list]) -> Optional[int]:
    """Максимальный net_price_per_unit среди вариантов продажи."""
    if not sell_options:
        return None
    nets = [o.get("net_price_per_unit") for o in sell_options if o.get("net_price_per_unit")]
    return max(nets) if nets else None


def render_profitable_lot(item_name: str, lot: dict, sell_options: Optional[list]) -> dict:
    buyout = lot["buyout_per_unit"]
    extra = _title_extra(lot.get("quality_name"), lot.get("enchant"))
    best_net = _best_sell_net(sell_options)
    if best_net is not None:
        profit = best_net - buyout
        sign = "+" if profit >= 0 else ""
        body = f"Купить {fmt(buyout)} ₽/шт → продать ~{fmt(best_net)} ₽ ({sign}{fmt(profit)} ₽)"
    else:
        body = f"Купить {fmt(buyout)} ₽/шт"
    return {
        "title": _stage(f"💰 {item_name}{extra}"),
        "body": body,
        "url": "/app/lots",
        "tag": f"lot:{item_name}:{buyout}",
    }


def render_buy_alert(item_name: str, cheapest: dict, target_price: int) -> dict:
    price = cheapest["price_per_unit"]
    extra = _title_extra(cheapest.get("quality_name"), cheapest.get("enchant"))
    amount = cheapest.get("amount", 0)
    return {
        "title": _stage(f"🛒 Дешёвый лот! {item_name}{extra}"),
        "body": f"{fmt(price)} ₽/шт ≤ порог {fmt(target_price)} ₽ · {amount} шт",
        "url": "/app/buy-sniper",
        "tag": f"buy:{item_name}:{price}",
    }


def render_emission(event: dict) -> dict:
    if event.get("phase") == "start":
        return {
            "title": _stage("☢️ Выброс начался"),
            "body": "Аукционная активность снижена (~15 мин)",
            "url": "/app",
            "tag": "emission",
        }
    duration_min = None
    started_at, ended_at = event.get("started_at"), event.get("ended_at")
    if started_at and ended_at:
        duration_min = round(
            (datetime.fromisoformat(ended_at) - datetime.fromisoformat(started_at)).total_seconds() / 60
        )
    dur = f" (длился {duration_min} мин)" if duration_min else ""
    return {
        "title": _stage("✅ Выброс завершён"),
        "body": f"Аукцион возвращается к норме{dur}",
        "url": "/app",
        "tag": "emission",
    }


# ─── Отправка web push ────────────────────────────────────────────────────────

def _send_sync(sub: dict, payload: dict) -> None:
    """Синхронная отправка (pywebpush на requests) — вызывается через to_thread."""
    webpush(
        subscription_info={
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
        },
        data=json.dumps(payload),
        vapid_private_key=VAPID_PRIVATE_KEY,
        vapid_claims={"sub": VAPID_SUBJECT},
        ttl=600,
    )


async def send_to_subscriptions(db: AsyncSession, subs: list, payload: dict) -> int:
    """Шлёт payload на все подписки. Возвращает число успешных. Мёртвые (404/410)
    подписки удаляет из БД."""
    sent = 0
    dead_endpoints: list[str] = []
    for sub in subs:
        sub_info = {"endpoint": sub.endpoint, "p256dh": sub.p256dh, "auth": sub.auth}
        try:
            await asyncio.to_thread(_send_sync, sub_info, payload)
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                dead_endpoints.append(sub.endpoint)
                logger.info(f"Dead subscription removed: user={sub.user_id} status={status}")
            else:
                logger.warning(f"WebPush failed user={sub.user_id} status={status}: {e}")
        except Exception as e:
            logger.warning(f"WebPush unexpected error user={sub.user_id}: {e}")

    if dead_endpoints:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead_endpoints)))
        await db.commit()
    return sent


async def _load_user_gate(db: AsyncSession, user_id: int, gate_attr: str) -> Optional[User]:
    """Загружает пользователя и проверяет канал (notify_browser_push) + тариф.
    Возвращает User если можно слать, иначе None."""
    row = (await db.execute(
        select(User, UserSettings)
        .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
        .where(User.id == user_id, User.is_active == True)
    )).first()
    if row is None:
        return None
    user, us = row
    if not (user.is_approved or user.is_admin):
        return None
    if us is not None and not us.notify_browser_push:
        return None
    if not (user.is_admin or getattr(get_tier_limits(user), gate_attr)):
        return None
    return user


async def _subs_for_user(db: AsyncSession, user_id: int) -> list:
    return (await db.execute(
        select(PushSubscription).where(PushSubscription.user_id == user_id)
    )).scalars().all()


# ─── Обработчики событий ──────────────────────────────────────────────────────

async def handle_profitable_lot(db, r, event: dict) -> None:
    user = await _load_user_gate(db, event["user_id"], "telegram_notifications")
    if user is None:
        return
    subs = await _subs_for_user(db, user.id)
    if not subs:
        return

    signal = event.get("signal", {})
    sell_options = signal.get("sell_options")
    for lot in signal.get("lots", []):
        start_time = lot.get("start_time", "")
        dedup = (
            f"push_sent:{user.id}:{event['item_id']}:{event['region']}"
            f":{event['quality_filter']}:{event['enchant_filter']}:{start_time}"
        )
        if await r.exists(dedup):
            continue
        payload = render_profitable_lot(event["item_name"], lot, sell_options)
        if await send_to_subscriptions(db, subs, payload) > 0:
            await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
            logger.info(f"Push lot user={user.id} item={event['item_id']} price={lot['buyout_per_unit']}")


async def handle_buy_alert(db, r, event: dict) -> None:
    user = await _load_user_gate(db, event["user_id"], "buy_sniper_notifications")
    if user is None:
        return
    subs = await _subs_for_user(db, user.id)
    if not subs:
        return

    cheapest = event["cheapest"]
    start_time = cheapest.get("start_time", "")
    dedup = (
        f"push_buy_sent:{user.id}:{event['item_id']}:{event['region']}"
        f":{event['quality_filter']}:{event['enchant_filter']}:{start_time}"
    )
    if await r.exists(dedup):
        return
    payload = render_buy_alert(event["item_name"], cheapest, event["target_price"])
    if await send_to_subscriptions(db, subs, payload) > 0:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        logger.info(f"Push buy user={user.id} item={event['item_id']} price={cheapest['price_per_unit']}")


async def handle_emission(db, r, event: dict) -> None:
    # Отсечка свежести — не рассылаем историю после простоя сервиса.
    ref_ts = event.get("started_at") if event.get("phase") == "start" else event.get("ended_at")
    if ref_ts:
        try:
            if datetime.now(timezone.utc) - datetime.fromisoformat(ref_ts) > timedelta(minutes=EMISSION_MAX_AGE_MIN):
                return
        except ValueError:
            pass

    dedup = f"push_emission_sent:{event.get('event_id')}:{event.get('phase')}"
    if await r.exists(dedup):
        return

    # Получатели: все активные+подтверждённые с включённым push-каналом.
    # Без тарифного гейта — как emission в telegram-боте.
    rows = (await db.execute(
        select(User, UserSettings)
        .join(UserSettings, UserSettings.user_id == User.id, isouter=True)
        .where(User.is_active == True, User.is_approved == True)
    )).all()
    recipient_ids = [u.id for u, us in rows if us is None or us.notify_browser_push]
    if not recipient_ids:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        return

    subs = (await db.execute(
        select(PushSubscription).where(PushSubscription.user_id.in_(recipient_ids))
    )).scalars().all()
    if not subs:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        return

    payload = render_emission(event)
    sent = await send_to_subscriptions(db, subs, payload)
    if sent > 0:
        await r.setex(dedup, NOTIF_DEDUP_TTL, "1")
        logger.info(f"Push emission {event.get('phase')} event_id={event.get('event_id')} sent={sent}/{len(subs)}")


HANDLERS = {
    "profitable_lot": handle_profitable_lot,
    "buy_alert": handle_buy_alert,
    "emission": handle_emission,
}


async def handle_message(body: bytes) -> None:
    event = json.loads(body)
    handler = HANDLERS.get(event.get("type"))
    if handler is None:
        logger.warning(f"Unknown event type: {event.get('type')}")
        return
    r = await get_redis()
    async with SessionLocal() as db:
        await handler(db, r, event)


# ─── Consumer loop ────────────────────────────────────────────────────────────

async def main() -> None:
    if not VAPID_PRIVATE_KEY:
        logger.warning("VAPID_PRIVATE_KEY не задан — web push отправка провалится. Задайте VAPID-ключи.")

    connection = await aio_pika.connect_robust(RABBITMQ_URL)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=PREFETCH)

    exchange = await channel.declare_exchange(EXCHANGE_NAME, aio_pika.ExchangeType.DIRECT, durable=True)
    queue = await channel.declare_queue(QUEUE_NAME, durable=True)
    await queue.bind(exchange, routing_key=ROUTING_KEY)

    logger.info(f"push_service запущен, слушаю {QUEUE_NAME}")

    async with queue.iterator() as it:
        async for message in it:
            try:
                await handle_message(message.body)
            except Exception as e:
                logger.error(f"handle_message error: {e}", exc_info=True)
            finally:
                # Best-effort: всегда ack (без DLX не хотим бесконечный requeue).
                await message.ack()


if __name__ == "__main__":
    asyncio.run(main())
