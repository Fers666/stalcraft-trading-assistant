#!/usr/bin/env python3
"""
Telegram Bot — Stalcraft Trading Assistant.

Команды:
  /start       — приветствие и инструкция по привязке
  /link CODE   — привязать аккаунт по 6-значному коду из настроек приложения
  /status      — показать статус привязки
  /stop        — отвязать аккаунт и отключить уведомления

Фоновый цикл (каждые 30 сек):
  - Находит выгодные лоты для каждого пользователя с привязанным Telegram
  - Применяет те же фильтры что и лента "СИГНАЛЫ" в веб-приложении
  - Отправляет отдельное сообщение на каждый выгодный лот
  - Дедуплицирует по startTime лота (одно уведомление на лот за 48ч)
"""

import asyncio
import logging
import os
import statistics as _statistics
import sys
from datetime import datetime, timezone, timedelta
from typing import Optional

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

import redis.asyncio as aioredis
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

# /app — backend смонтирован как /app в docker-compose (build: ./backend, volumes: ./backend:/app)
sys.path.insert(0, "/app")
from app.models.models import User, UserWatchlist, UserSettings, MarketStatistics, CollectedData, MasterItem, SalesHistory

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Конфиг из env ────────────────────────────────────────────────────────────

DATABASE_URL  = os.environ["DATABASE_URL"]
REDIS_URL     = os.environ.get("REDIS_URL", "redis://redis:6379/0")
BOT_TOKEN     = os.environ["TELEGRAM_BOT_TOKEN"]
BOT_USERNAME  = os.environ.get("TELEGRAM_BOT_USERNAME", "SC_TRADING_auc_bot")
APP_ENV       = os.environ.get("APP_ENV", "production").lower()
IS_STAGE      = APP_ENV == "stage"

COMMISSION      = 0.05
LINK_CODE_TTL   = 600   # 10 мин — срок жизни кода привязки
NOTIF_DEDUP_TTL = 48 * 3600  # 48ч — один лот нотифицируется один раз
POLL_INTERVAL   = 30    # сек — интервал проверки

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}
_COLOR_TO_QLT: dict[str, int] = {
    "default": 0, "rank_newbie": 1, "rank_stalker": 2, "rank_veteran": 3,
    "rank_master": 4, "rank_legend": 5, "quest_item": 5,
    "gray": 0, "grey": 0, "white": 0, "green": 1, "blue": 2,
    "violet": 3, "purple": 3, "yellow": 4, "black": 4, "red": 5,
}

# ─── DB / Redis ───────────────────────────────────────────────────────────────

engine = create_async_engine(DATABASE_URL, pool_size=5, max_overflow=2)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
_redis: Optional[aioredis.Redis] = None
_notifier_task: Optional[asyncio.Task] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis


# ─── Форматирование ───────────────────────────────────────────────────────────

def fmt(n: int) -> str:
    """1234567 → '1 234 567'"""
    return f"{n:,}".replace(",", " ")


def volatility_label(v: float) -> str:
    if v <= 15:
        return "низкая"
    elif v <= 30:
        return "средняя"
    return "высокая"


def confidence_label(c: str) -> str:
    return {"high": "высокая", "medium": "средняя", "low": "мало данных"}.get(c, c)


def build_lot_message(
    item_name: str,
    quality_name: Optional[str],
    enchant: Optional[int],
    buyout_per_unit: int,
    sell_options: list[dict],
    sales_volume_7d: Optional[int],
    volatility_7d: Optional[float],
) -> str:
    prefix = "[STAGE] " if IS_STAGE else ""
    lines: list[str] = [f"{prefix}💰 <b>Выгодный лот</b> — {item_name}"]

    meta: list[str] = []
    if quality_name:
        meta.append(f"⭐ <b>{quality_name}</b>")
    if enchant:
        meta.append(f"⚡ <b>+{enchant}</b>")
    if meta:
        lines.append("  ".join(meta))

    lines.append(f"💵 Цена выкупа: <b>{fmt(buyout_per_unit)} ₽/шт</b>")
    lines.append("")
    lines.append("📈 <b>Прогноз продажи:</b>")

    confidence = "low"
    for opt in sell_options:
        profit = opt["net_price_per_unit"] - buyout_per_unit
        if profit <= 0:
            continue
        pct = profit / buyout_per_unit * 100
        label_ru = opt.get("label_ru", opt["label"])
        time_str  = opt.get("estimated_hours_display", "?")
        confidence = opt.get("confidence", "low")
        sign = "+" if profit >= 0 else ""
        lines.append(
            f"  ▸ <b>{label_ru}</b> (~{time_str}): {fmt(opt['net_price_per_unit'])} ₽"
            f"  →  <b>{sign}{fmt(profit)} ₽</b> ({sign}{pct:.1f}%)"
        )

    lines.append("")
    footer: list[str] = []
    if sales_volume_7d is not None:
        footer.append(f"📦 Продаж за 7д: <b>{sales_volume_7d}</b> шт")
    if volatility_7d is not None:
        footer.append(f"📉 Волатильность: <b>{volatility_7d:.1f}%</b> ({volatility_label(volatility_7d)})")
    if footer:
        lines.append("  ".join(footer))
    lines.append(f"🎯 Точность: <b>{confidence_label(confidence)}</b>")

    return "\n".join(lines)


# ─── Helpers: расчёт sell_options (зеркало monitoring.py) ────────────────────

def _fmt_hours(hours: float) -> str:
    if hours < 2:
        return "< 2 ч"
    if hours < 24:
        return f"~{round(hours)} ч"
    days = hours / 24
    if days < 2:
        return "~1-2 дня"
    return f"~{round(days)} дня" if days < 5 else f"~{round(days)} дней"


def _make_fresh_sell_options(ref: int, volume_7d: int) -> list[dict]:
    """
    Генерирует sell_options от текущей рыночной цены.
    Зеркало _make_sell_options() из monitoring.py — чтобы бот и фронтенд
    использовали один и тот же порог выгодности.
    """
    fast_price    = int(ref * 0.97)
    normal_price  = int(ref * 1.00)
    premium_price = int(ref * 1.05)

    sales_per_day = volume_7d / 7.0
    if sales_per_day >= 5:
        fh, nh, ph = 2.0, 8.0, 24.0
    elif sales_per_day >= 1:
        fh, nh, ph = 8.0, 24.0, 72.0
    elif sales_per_day >= 0.14:
        fh, nh, ph = 24.0, 72.0, 168.0
    else:
        fh, nh, ph = 72.0, 168.0, 336.0

    def opt(label, label_ru, price, hours):
        return {
            "label": label, "label_ru": label_ru,
            "price_per_unit": price,
            "net_price_per_unit": int(price * (1 - COMMISSION)),
            "estimated_hours": hours,
            "estimated_hours_display": _fmt_hours(hours),
            "confidence": "low",
            "data_points": volume_7d,
        }

    return [
        opt("fast",    "Быстро",    fast_price,    fh),
        opt("normal",  "Нормально", normal_price,  nh),
        opt("premium", "Выгодно",   premium_price, ph),
    ]


# ─── Логика поиска выгодных лотов ────────────────────────────────────────────

def _is_artefact(category: Optional[str]) -> bool:
    return bool(category and "artefact" in category.lower())


def _get_quality_value(additional: dict, master_color: Optional[str], is_art: bool) -> Optional[int]:
    qlt = additional.get("qlt")
    if is_art:
        return int(qlt) if qlt is not None else 0
    if qlt is not None:
        return int(qlt)
    if master_color:
        return _COLOR_TO_QLT.get(master_color.lower())
    return None


async def _find_profitable_lots(
    db: AsyncSession,
    entry: UserWatchlist,
    master: MasterItem,
    stats: Optional[MarketStatistics],
) -> tuple[list[dict], Optional[int], Optional[float]]:
    """
    Возвращает (lots, sales_volume_7d, volatility_7d) для уведомления.

    Порог выгодности зеркалирует логику monitoring endpoint:
    - без фильтров: ref = best_liquid_price_per_unit текущего снэпшота
    - с фильтрами:  ref = медиана SalesHistory по quality/enchant (или фолбэк на снэпшот)
    volume/volatility для сообщения тоже фильтруются по quality/enchant, как на мониторинг-пейдж.
    """
    snap = (await db.execute(
        select(CollectedData)
        .where(
            CollectedData.user_id == None,
            CollectedData.item_id == entry.item_id,
            CollectedData.region  == entry.region,
            CollectedData.raw_lots.isnot(None),
        )
        .order_by(CollectedData.collect_time.desc())
        .limit(1)
    )).scalar_one_or_none()

    if snap is None or not snap.raw_lots:
        return [], None, None

    # ── Строим sell_options тем же способом что мониторинг-эндпоинт ─────────
    volume_7d = (stats.sales_volume_7d or 0) if stats else 0

    # msg_volume / msg_volatility — то что попадёт в уведомление (зеркало мониторинг-пейдж)
    msg_volume: Optional[int]   = stats.sales_volume_7d if stats else None
    msg_volatility: Optional[float] = float(stats.price_volatility_7d) if stats and stats.price_volatility_7d else None

    if entry.quality_filter is None and entry.enchant_filter is None:
        # Нет фильтров: опорная цена = текущий минимум ликвидных лотов
        current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit
        if not current_min:
            return [], None, None
        fresh_sell_options = _make_fresh_sell_options(int(current_min), volume_7d)
    else:
        # С фильтрами: медиана реальных продаж с нужным quality/enchant
        cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)
        q = select(SalesHistory.price_per_unit).where(
            SalesHistory.item_id   == entry.item_id,
            SalesHistory.region    == entry.region,
            SalesHistory.sale_time >= cutoff_7d,
        )
        if entry.quality_filter is not None:
            if entry.quality_filter == 0:
                q = q.where(or_(
                    SalesHistory.additional_info["qlt"].astext.is_(None),
                    SalesHistory.additional_info["qlt"].astext == "0",
                ))
            else:
                q = q.where(
                    SalesHistory.additional_info["qlt"].astext == str(entry.quality_filter)
                )
        if entry.enchant_filter is not None:
            if entry.enchant_filter == 0:
                q = q.where(or_(
                    SalesHistory.additional_info["ptn"].astext.is_(None),
                    SalesHistory.additional_info["ptn"].astext == "0",
                ))
            else:
                q = q.where(
                    SalesHistory.additional_info["ptn"].astext == str(entry.enchant_filter)
                )

        prices = (await db.execute(q)).scalars().all()

        if prices:
            ref = int(_statistics.median(prices))
            vol = len(prices)
            # Фильтрованные метрики — как на мониторинг-пейдж
            msg_volume = vol
            if vol >= 5:
                avg7 = _statistics.mean(prices)
                if avg7 > 0:
                    msg_volatility = round(_statistics.stdev(prices) / avg7 * 100, 2)
                else:
                    msg_volatility = None
            else:
                msg_volatility = None
        else:
            # Нет истории продаж для этого фильтра — фолбэк на текущий минимум
            current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit
            if not current_min:
                return [], None, None
            ref = int(current_min)
            vol = volume_7d

        fresh_sell_options = _make_fresh_sell_options(ref, vol)

    normal_opt = next((o for o in fresh_sell_options if o.get("label") == "normal"), None)
    if not normal_opt:
        return [], None, None
    normal_net = int(normal_opt["net_price_per_unit"])

    now    = datetime.now(timezone.utc)
    is_art = _is_artefact(master.category)
    profitable: list[dict] = []

    for lot in snap.raw_lots:
        buyout = lot.get("buyoutPrice", 0)
        amount = lot.get("amount", 1)
        if buyout <= 0 or amount <= 0:
            continue

        end_str = lot.get("endTime", "")
        if end_str:
            try:
                end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                if (end_dt - now).total_seconds() / 3600 < 2:
                    continue
            except Exception:
                pass

        additional = lot.get("additional") or {}
        qlt_val    = _get_quality_value(additional, master.color, is_art)
        ptn        = additional.get("ptn")
        enchant    = int(ptn) if ptn is not None else None

        if entry.quality_filter is not None and qlt_val != entry.quality_filter:
            continue
        if entry.enchant_filter is not None and enchant != entry.enchant_filter:
            continue

        buyout_per_unit = buyout // amount
        if normal_net - buyout_per_unit <= 0:
            continue

        quality_name = _QLT_NAMES.get(qlt_val) if qlt_val is not None else None
        start_time   = lot.get("startTime", "")

        profitable.append({
            "start_time":      start_time,
            "buyout_per_unit": buyout_per_unit,
            "quality_name":    quality_name,
            "enchant":         enchant,
            "sell_options":    fresh_sell_options,
        })

    return profitable, msg_volume, msg_volatility


# ─── Notifier loop ────────────────────────────────────────────────────────────

async def notify_profitable_lots(app: Application) -> None:
    """Ищет выгодные лоты и отправляет уведомления в Telegram."""
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
            if us is None or us.notify_telegram
        ]
        if not users_to_notify:
            return

        masters_cache: dict[str, MasterItem]                    = {}
        stats_cache:   dict[tuple, Optional[MarketStatistics]]  = {}

        for user, _ in users_to_notify:
            watchlist = (await db.execute(
                select(UserWatchlist)
                .where(
                    UserWatchlist.user_id  == user.id,
                    UserWatchlist.is_active == True,
                )
            )).scalars().all()

            for entry in watchlist:
                # Кэш MasterItem
                if entry.item_id not in masters_cache:
                    m = (await db.execute(
                        select(MasterItem).where(MasterItem.item_id == entry.item_id)
                    )).scalar_one_or_none()
                    masters_cache[entry.item_id] = m
                master = masters_cache.get(entry.item_id)
                if not master:
                    continue

                # Кэш MarketStatistics (глобальная, user_id=None)
                skey = (entry.item_id, entry.region)
                if skey not in stats_cache:
                    s = (await db.execute(
                        select(MarketStatistics).where(
                            MarketStatistics.user_id == None,
                            MarketStatistics.item_id == entry.item_id,
                            MarketStatistics.region  == entry.region,
                        )
                    )).scalar_one_or_none()
                    stats_cache[skey] = s
                stats = stats_cache.get(skey)

                profitable, msg_volume_7d, msg_volatility_7d = await _find_profitable_lots(db, entry, master, stats)

                for lot in profitable:
                    # Дедупликация по startTime лота (одно уведомление за 48ч)
                    dedup = (
                        f"tg_sent:{user.id}:{entry.item_id}:{entry.region}"
                        f":{entry.quality_filter}:{entry.enchant_filter}"
                        f":{lot['start_time']}"
                    )
                    if await r.exists(dedup):
                        continue

                    item_name = master.name_ru or master.name_en or entry.item_id
                    msg = build_lot_message(
                        item_name      = item_name,
                        quality_name   = lot["quality_name"],
                        enchant        = lot["enchant"],
                        buyout_per_unit= lot["buyout_per_unit"],
                        sell_options   = lot["sell_options"],
                        sales_volume_7d= msg_volume_7d,
                        volatility_7d  = msg_volatility_7d,
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

        user.telegram_chat_id  = chat_id
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
