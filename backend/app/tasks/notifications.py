"""
Celery задача: уведомления о выгодных лотах в Telegram.

Принцип работы (каждые 2 минуты):
  1. Берём всех пользователей с привязанным Telegram и notify_telegram=True.
  2. Для каждой записи в их watchlist:
     - Читаем последний снэпшот лотов (CollectedData.raw_lots).
     - Вычисляем sell_options от текущего market minimum (≡ /monitoring/item API).
     - Находим самый дешёвый лот, у которого net_received > buy_price (прибыль > 0).
     - Проверяем Redis dedup-ключ: не шлём повторно ту же позицию < 2 часов.
  3. Отправляем одно сообщение на items_entry с детальным расчётом по всем 3 опциям.

Правило прибыльности:
  buy_price < sell_option.net_price  ↔  buy_price < listing_price * 0.95
  т.е. 5% комиссия платформы уже вычтена из expected revenue.
"""
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

COMMISSION          = 0.05
EXPIRY_HOURS        = 2        # лоты с остатком < 2ч — неликвид, игнорируем
DEDUP_TTL           = 7_200    # 2 часа: не дублируем уведомление по той же позиции

_QLT_NAMES: dict[int, str] = {
    0: "Обычный", 1: "Необычный", 2: "Особый",
    3: "Ветеран",  4: "Мастер",   5: "Легендарный",
}
_DAYS_RU: dict[str, str] = {
    "Monday": "Пн", "Tuesday": "Вт", "Wednesday": "Ср",
    "Thursday": "Чт", "Friday": "Пт", "Saturday": "Сб", "Sunday": "Вс",
}


def _fmt(n: int) -> str:
    return f"{n:,}".replace(",", " ")  # узкий неразрывный пробел


def _compute_sell_options(current_min: int) -> list[dict]:
    """Три ценовые точки относительно текущего рыночного минимума."""
    prices = {
        "fast":    int(current_min * 0.97),
        "normal":  int(current_min * 1.00),
        "premium": int(current_min * 1.05),
    }
    labels = {"fast": "Быстро   ", "normal": "Нормально", "premium": "Выгодно  "}
    return [
        {
            "label":             key,
            "label_display":     labels[key],
            "price_per_unit":    price,
            "net_price_per_unit": int(price * (1 - COMMISSION)),
        }
        for key, price in prices.items()
    ]


def _build_message(
    item_name: str,
    quality_label: str | None,
    enchant_label: str | None,
    buy_per_unit: int,
    amount: int,
    sell_options: list[dict],
    best_sell_hour: int | None,
    best_sell_day: str | None,
    sales_volume_7d: int | None,
    risk_level: str | None,
) -> str:
    # Заголовок
    title_extra = ""
    if quality_label:
        title_extra += f" · {quality_label}"
    if enchant_label:
        title_extra += f" · {enchant_label}"

    lines = [
        f"🟢 <b>{item_name}{title_extra}</b>",
        "",
        f"💰 Купить: <b>{_fmt(buy_per_unit)} ₽/шт</b>" + (f" × {amount} шт" if amount > 1 else ""),
        "",
        "📈 <b>Варианты продажи (−5% комиссия):</b>",
    ]

    for opt in sell_options:
        net    = opt["net_price_per_unit"]
        profit = net - buy_per_unit
        sign   = "+" if profit >= 0 else ""
        marker = "✅" if profit > 0 else "❌"
        lines.append(
            f"{marker} <code>{opt['label_display']}</code>"
            f" → выставить <b>{_fmt(opt['price_per_unit'])} ₽</b>"
            f" · получишь {_fmt(net)} ₽"
            f" · <b>{sign}{_fmt(profit)} ₽</b>"
        )

    footer = []
    if best_sell_hour is not None or best_sell_day is not None:
        t = f"{best_sell_hour}:00" if best_sell_hour is not None else ""
        if best_sell_day:
            t += (" · " if t else "") + _DAYS_RU.get(best_sell_day, best_sell_day)
        footer.append(f"🕐 Лучшее время продажи: {t}")
    if sales_volume_7d:
        footer.append(f"📊 Продаж за 7д: {sales_volume_7d}")
    if risk_level:
        risk_labels = {"low": "🟢 стабильный", "medium": "🟡 умеренный", "high": "🔴 высокий"}
        footer.append(f"⚡ Риск: {risk_labels.get(risk_level, risk_level)}")

    if footer:
        lines += [""] + footer

    return "\n".join(lines)


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(name="app.tasks.notifications.scan_and_notify", bind=True, max_retries=2)
def scan_and_notify(self):
    """Сканирует watchlist всех пользователей и шлёт Telegram-уведомления о выгодных лотах."""

    async def _run():
        from app.db.session import get_celery_db_session
        from app.models.models import (
            User, UserSettings, UserWatchlist,
            CollectedData, MarketStatistics, MasterItem,
        )
        from app.services.telegram_sender import send_telegram_message
        from sqlalchemy import select
        import redis.asyncio as aioredis
        from app.core.config import settings as cfg

        async with get_celery_db_session() as db:
            # Все пользователи с привязанным Telegram и включёнными уведомлениями
            users = (await db.execute(
                select(User, UserSettings)
                .join(UserSettings, UserSettings.user_id == User.id)
                .where(
                    User.telegram_chat_id.isnot(None),
                    UserSettings.notify_telegram == True,
                )
            )).all()

            if not users:
                return

            r = await aioredis.from_url(cfg.redis_url, decode_responses=True)
            try:
                now = datetime.now(timezone.utc)
                for user, user_settings in users:
                    min_margin = float(user_settings.min_profit_margin_percent or 0)

                    watchlist = (await db.execute(
                        select(UserWatchlist).where(
                            UserWatchlist.user_id == user.id,
                            UserWatchlist.is_active == True,
                        )
                    )).scalars().all()

                    for entry in watchlist:
                        try:
                            await _process_entry(
                                db, r, user, entry, min_margin, now, send_telegram_message
                            )
                        except Exception as exc:
                            logger.error(
                                f"notifications: error for user={user.id} "
                                f"item={entry.item_id}: {exc}"
                            )
            finally:
                await r.aclose()

    try:
        run_async(_run())
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)


async def _process_entry(db, redis_client, user, entry, min_margin_pct, now, send_fn):
    """Проверяет одну watchlist-запись и при необходимости шлёт уведомление."""
    from app.models.models import CollectedData, MarketStatistics, MasterItem
    from sqlalchemy import select

    # 1. Последний снэпшот с лотами
    snap = (await db.execute(
        select(CollectedData).where(
            CollectedData.user_id.is_(None),
            CollectedData.item_id == entry.item_id,
            CollectedData.region  == entry.region,
            CollectedData.raw_lots.isnot(None),
        ).order_by(CollectedData.collect_time.desc()).limit(1)
    )).scalar_one_or_none()

    if not snap or not snap.raw_lots:
        return

    # Снэпшот старше 5 минут — данные устаревшие, не шлём
    if snap.collect_time < now - timedelta(minutes=5):
        return

    # 2. Рыночная статистика
    stats = (await db.execute(
        select(MarketStatistics).where(
            MarketStatistics.user_id.is_(None),
            MarketStatistics.item_id == entry.item_id,
            MarketStatistics.region  == entry.region,
        )
    )).scalar_one_or_none()

    if not stats:
        return

    # 3. Sell options от текущего market minimum
    current_min = snap.best_liquid_price_per_unit or snap.best_price_per_unit
    if not current_min:
        return
    sell_options = _compute_sell_options(int(current_min))
    normal_net = sell_options[1]["net_price_per_unit"]  # [1] = "normal"

    # 4. Имя предмета
    item = (await db.execute(
        select(MasterItem).where(MasterItem.item_id == entry.item_id)
    )).scalar_one_or_none()
    item_name = (item.name_ru or item.name_en or entry.item_id) if item else entry.item_id

    # 5. Ищем лучший (самый дешёвый) прибыльный лот
    expiry_cutoff = now + timedelta(hours=EXPIRY_HOURS)
    best_lot_price:   int | None = None
    best_lot_amount:  int = 1
    best_lot_qlt:     int | None = None
    best_lot_ptn:     int | None = None

    for lot in snap.raw_lots:
        raw_price = lot.get("buyoutPrice", 0) or lot.get("startPrice", 0)
        amount    = lot.get("amount", 1) or 1
        if not raw_price:
            continue

        # Пропускаем истекающие лоты
        end_str = lot.get("endTime")
        if end_str:
            try:
                end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                if end_dt < expiry_cutoff:
                    continue
            except Exception:
                continue

        buy_per_unit = raw_price // amount
        lot_add = lot.get("additional") or {}

        # Фильтр по качеству (qlt)
        if entry.quality_filter is not None:
            lot_qlt = int(lot_add.get("qlt", 0))
            if lot_qlt != entry.quality_filter:
                continue

        # Фильтр по заточке (ptn)
        if entry.enchant_filter is not None:
            lot_ptn = int(lot_add.get("ptn", 0))
            if lot_ptn != entry.enchant_filter:
                continue

        # Проверка прибыльности: чистая выручка по "normal" > цена покупки
        profit     = normal_net - buy_per_unit
        profit_pct = (profit / buy_per_unit * 100) if buy_per_unit > 0 else 0

        if profit <= 0 or profit_pct < min_margin_pct:
            continue

        # Берём лот с минимальной ценой покупки (максимальная прибыль)
        if best_lot_price is None or buy_per_unit < best_lot_price:
            best_lot_price  = buy_per_unit
            best_lot_amount = amount
            # Сохраняем реальные параметры найденного лота
            raw_qlt = lot_add.get("qlt")
            raw_ptn = lot_add.get("ptn")
            best_lot_qlt = int(raw_qlt) if raw_qlt is not None else None
            best_lot_ptn = int(raw_ptn) if raw_ptn is not None else None

    if best_lot_price is None:
        return  # нет выгодных лотов

    # 6. Dedup: один сигнал на (item + фильтры) не чаще раза в 2 часа
    dedup_key = f"notif:{user.id}:{entry.item_id}:{entry.region}"
    if entry.quality_filter is not None:
        dedup_key += f":q{entry.quality_filter}"
    if entry.enchant_filter is not None:
        dedup_key += f":e{entry.enchant_filter}"

    if await redis_client.exists(dedup_key):
        return

    # 7. Подписи качества/заточки из данных самого лота
    quality_label = _QLT_NAMES.get(best_lot_qlt) if best_lot_qlt is not None else None
    enchant_label = (
        "Не точёный" if best_lot_ptn == 0
        else f"+{best_lot_ptn}" if best_lot_ptn is not None
        else None
    )

    # 8. Формируем и отправляем сообщение
    risk_level = None
    if stats.price_volatility_7d is not None:
        v = float(stats.price_volatility_7d)
        risk_level = "high" if v > 30 else "medium" if v > 15 else "low"

    msg = _build_message(
        item_name      = item_name,
        quality_label  = quality_label,
        enchant_label  = enchant_label,
        buy_per_unit   = best_lot_price,
        amount         = best_lot_amount,
        sell_options   = sell_options,
        best_sell_hour = stats.best_sell_hour,
        best_sell_day  = stats.best_sell_day,
        sales_volume_7d= stats.sales_volume_7d,
        risk_level     = risk_level,
    )

    ok = await send_fn(user.telegram_chat_id, msg)
    if ok:
        await redis_client.setex(dedup_key, DEDUP_TTL, "1")
        logger.info(
            f"Telegram notified user={user.id} item={entry.item_id}/{entry.region} "
            f"buy={best_lot_price} profit={sell_options[1]['net_price_per_unit'] - best_lot_price}"
        )
