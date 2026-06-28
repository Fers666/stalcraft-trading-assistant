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


TIERS: dict[str, TierLimits] = {
    "base":          TierLimits(watchlist_limit=6,  telegram_notifications=False, stats_windows=("24h",),                    auction_access=False),
    "advanced":      TierLimits(watchlist_limit=10, telegram_notifications=True,  stats_windows=("24h", "48h"),               auction_access=False),
    "advanced_plus": TierLimits(watchlist_limit=20, telegram_notifications=True,  stats_windows=("24h", "48h", "7d"),         auction_access=True),
    "advanced_max":  TierLimits(watchlist_limit=25, telegram_notifications=True,  stats_windows=("24h", "48h", "7d", "30d"),  auction_access=True),
}

DEFAULT_TIER = "base"

ADMIN_LIMITS = TierLimits(
    watchlist_limit=None, telegram_notifications=True,
    stats_windows=("24h", "48h", "7d", "30d"), auction_access=True,
)


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
    return TIERS.get(user.tier, TIERS[DEFAULT_TIER]).watchlist_limit


def get_tier_limits(user: User) -> TierLimits:
    """is_admin обходит все лимиты целиком, независимо от user.tier."""
    if user.is_admin:
        return ADMIN_LIMITS
    base = TIERS.get(user.tier, TIERS[DEFAULT_TIER])
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
    if (user.tier != "base" and not user.is_admin
            and user.tier_expires_at is not None
            and user.tier_expires_at < datetime.now(timezone.utc)):
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
