"""
Центральная точка истины по тарифным лимитам (Phase 0 роадмапа подписок).

Везде, где нужен текущий тариф пользователя, использовать effective_tier()/
get_tier_limits(), а не читать user.tier напрямую — это гарантирует
применение ленивого понижения при истёкшем tier_expires_at.
"""
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import User, UserWatchlist


@dataclass(frozen=True)
class TierLimits:
    watchlist_limit: int | None       # None = без лимита (admin)
    telegram_notifications: bool
    stats_windows: tuple[str, ...]    # подмножество ("24h","48h","7d","30d")
    auction_access: bool
    buy_sniper_access: bool           # доступ к разделу «Закупки» (видеть/добавлять/мониторить)
    buy_sniper_notifications: bool    # Telegram-алерты при падении цены ниже порога
    # «Лента артефактов»: feed_access — полная лента (сводка 24 ч и счётчики
    # фильтров гейтируются им же); уведомлений по ленте нет — раздел смотрят
    # с портала. feed_rows_limit — сколько строк видит тариф без полного
    # доступа (None = без ограничений).
    # Инвариант: feed_access == (feed_rows_limit is None).
    feed_access: bool
    feed_rows_limit: int | None


TIERS: dict[str, TierLimits] = {
    "base":          TierLimits(watchlist_limit=6,  telegram_notifications=False, stats_windows=("24h",),                    auction_access=False, buy_sniper_access=False, buy_sniper_notifications=False, feed_access=False, feed_rows_limit=1),
    "advanced":      TierLimits(watchlist_limit=10, telegram_notifications=True,  stats_windows=("24h", "48h"),               auction_access=False, buy_sniper_access=True,  buy_sniper_notifications=False, feed_access=False, feed_rows_limit=10),
    "advanced_plus": TierLimits(watchlist_limit=20, telegram_notifications=True,  stats_windows=("24h", "48h", "7d"),         auction_access=True,  buy_sniper_access=True,  buy_sniper_notifications=True,  feed_access=False, feed_rows_limit=20),
    "advanced_max":  TierLimits(watchlist_limit=25, telegram_notifications=True,  stats_windows=("24h", "48h", "7d", "30d"),  auction_access=True,  buy_sniper_access=True,  buy_sniper_notifications=True,  feed_access=True,  feed_rows_limit=None),
}

DEFAULT_TIER = "base"

ADMIN_LIMITS = TierLimits(
    watchlist_limit=None, telegram_notifications=True,
    stats_windows=("24h", "48h", "7d", "30d"), auction_access=True,
    buy_sniper_access=True, buy_sniper_notifications=True,
    feed_access=True, feed_rows_limit=None,
)


def is_tier_expired(user: User) -> bool:
    """
    Истёк ли платный тариф — ЧИСТАЯ проверка, без записи в БД.

    apply_tier_expiry коммитит понижение и работает только на HTTP-запрос
    пользователя, а sweep_expired_tiers — раз в сутки. Между ними есть окно до
    ~24 ч, в котором user.tier ещё «Макс», хотя срок вышел. Фоновым
    потребителям (консьюмеры push/Telegram) писать в БД нельзя, но и слать по
    истёкшему тарифу нельзя тем более — поэтому здесь только чтение.
    """
    expires = user.tier_expires_at
    if expires is None or user.is_admin or user.tier == DEFAULT_TIER:
        return False
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires < datetime.now(timezone.utc)


def current_tier(user: User) -> str:
    """Тариф с учётом истечения срока (без записи в БД) — источник для лимитов."""
    return DEFAULT_TIER if is_tier_expired(user) else user.tier


def effective_feed_rows_limit(user: User) -> int | None:
    """
    Сколько строк «Ленты артефактов» видит пользователь.
    None = без ограничений (админ и тариф «Макс»); иначе лимит тарифа.
    """
    if user.is_admin:
        return ADMIN_LIMITS.feed_rows_limit
    return TIERS.get(current_tier(user), TIERS[DEFAULT_TIER]).feed_rows_limit


def effective_watchlist_limit(user: User) -> int | None:
    """
    Лимит watchlist пользователя с учётом ручного override (вне тарифа).
    is_admin — без лимита; иначе override, если задан, иначе лимит тарифа.
    None = без лимита.
    """
    if user.is_admin:
        return ADMIN_LIMITS.watchlist_limit
    if user.favorites_limit_override is not None:
        return user.favorites_limit_override
    return TIERS.get(current_tier(user), TIERS[DEFAULT_TIER]).watchlist_limit


def get_tier_limits(user: User) -> TierLimits:
    """
    is_admin обходит все лимиты целиком, независимо от user.tier.

    Тариф берётся через current_tier: истёкший срок = лимиты base, даже если
    ленивое понижение ещё не отработало (фоновые консьюмеры уведомлений).
    """
    if user.is_admin:
        return ADMIN_LIMITS
    base = TIERS.get(current_tier(user), TIERS[DEFAULT_TIER])
    if user.favorites_limit_override is not None:
        return replace(base, watchlist_limit=user.favorites_limit_override)
    return base


WINDOW_MAX_HOURS: dict[str, int] = {"24h": 24, "48h": 48, "7d": 168, "30d": 720}


def max_stats_hours(limits: TierLimits) -> int:
    """Максимум часов истории, доступный тарифу (по самому широкому разрешённому окну)."""
    return max(WINDOW_MAX_HOURS[w] for w in limits.stats_windows)


async def deactivate_excess_watchlist(user_id: int, new_limit: int, db: AsyncSession) -> None:
    """
    Деактивирует (is_active=False) карточки watchlist пользователя сверх
    new_limit, оставляя активными самые старые по created_at.
    Не удаляет данные — пользователь может реактивировать после возврата
    на старший тариф (add_to_watchlist учитывает is_active при подсчёте лимита).
    """
    rows = (await db.execute(
        select(UserWatchlist.id)
        .where(UserWatchlist.user_id == user_id, UserWatchlist.is_active == True)
        .order_by(UserWatchlist.created_at.asc())
        .offset(new_limit)
    )).scalars().all()
    if rows:
        await db.execute(
            update(UserWatchlist).where(UserWatchlist.id.in_(rows)).values(is_active=False)
        )


async def apply_tier_expiry(user: User, db: AsyncSession) -> None:
    """
    Ленивое понижение тарифа при истечении tier_expires_at.
    Коммитит только при реальном переходе на base — дешёвая проверка в памяти
    в остальных случаях (tier_expires_at не NULL только для платных тарифов
    с установленным сроком).
    """
    if is_tier_expired(user):
        user.tier = "base"
        user.tier_expires_at = None
        new_limit = effective_watchlist_limit(user)
        if new_limit is not None:
            await deactivate_excess_watchlist(user.id, new_limit, db)
        await db.commit()


async def effective_tier(user: User, db: AsyncSession) -> str:
    """Текущий тариф пользователя с применением ленивого понижения."""
    await apply_tier_expiry(user, db)
    return user.tier
