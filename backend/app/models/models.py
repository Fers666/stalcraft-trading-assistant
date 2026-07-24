from sqlalchemy import (
    Column, String, Integer, BigInteger, Boolean, Float,
    DateTime, ForeignKey, Text, ARRAY, Numeric, Index
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.sql import func, text

Base = declarative_base()


# ─── Пользователи ────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id                = Column(Integer, primary_key=True)
    username          = Column(String(50), unique=True, nullable=False)
    email             = Column(String(100), unique=True, nullable=False)
    password_hash     = Column(String(255), nullable=False)
    telegram_username = Column(String(50))
    telegram_chat_id  = Column(BigInteger)
    is_active         = Column(Boolean, default=True)
    is_admin          = Column(Boolean, default=False)
    is_approved       = Column(Boolean, default=False)
    tier                   = Column(String(20), nullable=False, server_default="base")
    tier_expires_at        = Column(DateTime(timezone=True), nullable=True)
    last_seen              = Column(DateTime(timezone=True), nullable=True)
    has_market_radar_addon = Column(Boolean, nullable=False, default=False, server_default="false")
    favorites_limit_override = Column(Integer, nullable=True, default=None)
    created_at        = Column(DateTime(timezone=True), server_default=func.now())
    updated_at        = Column(DateTime(timezone=True), onupdate=func.now())

    settings    = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")
    watchlist   = relationship("UserWatchlist", back_populates="user", cascade="all, delete-orphan")
    buy_alerts  = relationship("BuyAlert", back_populates="user", cascade="all, delete-orphan")
    push_subscriptions = relationship("PushSubscription", back_populates="user", cascade="all, delete-orphan")


class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id                   = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    min_profit_margin_percent = Column(Integer, default=10)
    exclude_less_than_amount  = Column(Integer, default=1)
    notify_telegram           = Column(Boolean, default=True)
    notify_browser_push       = Column(Boolean, default=True)
    auto_refresh_enabled      = Column(Boolean, default=True)
    updated_at                = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User", back_populates="settings")


class RegistrationSettings(Base):
    """Синглтон (id=1) — настройки авто-подтверждения регистрации новых пользователей."""
    __tablename__ = "registration_settings"

    id                         = Column(Integer, primary_key=True)
    auto_approve_enabled       = Column(Boolean, default=False, server_default="false")
    default_tier               = Column(String(20), default="base", server_default="base")
    default_tier_duration_days = Column(Integer, nullable=True)
    updated_at                 = Column(DateTime(timezone=True), onupdate=func.now())


# ─── Каталог товаров (из GitHub) ─────────────────────────────────────────────

class MasterItem(Base):
    __tablename__ = "master_items"

    id                  = Column(Integer, primary_key=True)
    item_id             = Column(String(50), unique=True, nullable=False, index=True)
    name_ru             = Column(String(200))
    name_en             = Column(String(200))
    category            = Column(String(50))
    color               = Column(String(20))    # gray/green/blue/violet/yellow/red → качество предмета
    icon_path           = Column(String(200))   # путь вида /icons/medicine/9mmq.png
    bind_state          = Column(String(30))    # status.state из GitHub: NONE/NON_DROP/PERSONAL_ON_USE/PERSONAL_ON_GET/PERSONAL_DROP_ON_GET
    can_be_batch_traded = Column(Boolean, default=True)
    # Реальная торгуемость по данным Stalcraft API (задача audit_auction_status):
    # NULL = ещё не проверено, TRUE = торгуется, FALSE = не появляется на аукционе.
    on_auction          = Column(Boolean, nullable=True)
    auction_checked_at  = Column(DateTime(timezone=True), nullable=True)   # момент последней проверки через API
    history_total       = Column(Integer, nullable=True)                   # последний замер total из /history (отладка)
    lots_total          = Column(Integer, nullable=True)                   # последний замер total из /lots (отладка)
    last_updated        = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_master_name_ru", "name_ru"),
        Index("ix_master_name_en", "name_en"),
        Index("ix_master_category", "category"),
        Index("ix_master_on_auction", "on_auction"),
    )


# ─── Watchlist пользователя ───────────────────────────────────────────────────

class UserWatchlist(Base):
    """Товары, которые пользователь добавил для мониторинга."""
    __tablename__ = "user_watchlist"

    id                    = Column(Integer, primary_key=True)
    user_id               = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id               = Column(String(50), ForeignKey("master_items.item_id"), nullable=False)
    region                = Column(String(10), default="EU")
    # Фильтры по характеристикам: NULL = без фильтра (показывать все)
    quality_filter        = Column(Integer, nullable=True)   # qlt 0-5; NULL = любое качество
    enchant_filter        = Column(Integer, nullable=True)   # точность 0-15; 0 = "Не точёный"; NULL = любая
    # Выбранные пачки для статистики: [10, 20, 30, 50]
    tracked_batch_sizes   = Column(ARRAY(Integer), default=list)
    is_active             = Column(Boolean, default=True)
    last_successful_check = Column(DateTime(timezone=True))
    error_status          = Column(Text)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User", back_populates="watchlist")
    item = relationship("MasterItem")
    buy_alert = relationship("BuyAlert", back_populates="watchlist", uselist=False, cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_watchlist_active", "user_id", "is_active", "region"),
    )


# ─── Собранные данные (снэпшоты лотов) ───────────────────────────────────────

class CollectedData(Base):
    """Агрегированный снэпшот лотов на момент сбора."""
    __tablename__ = "collected_data"

    id                      = Column(Integer, primary_key=True)
    # NULL = глобальный снэпшот (дедуплицированный по item_id/region)
    # <id> = ручной refresh конкретного пользователя
    user_id                 = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    item_id                 = Column(String(50), nullable=False)
    region                  = Column(String(10), nullable=False)
    collect_time            = Column(DateTime(timezone=True), nullable=False)
    collect_type            = Column(String(20), nullable=False)  # auto | manual
    total_lots              = Column(Integer, default=0)
    total_available_amount  = Column(Integer, default=0)
    best_price_per_unit     = Column(BigInteger)
    best_price_total        = Column(BigInteger)
    best_price_amount       = Column(Integer)
    best_lot_id             = Column(String(100))
    avg_price_per_unit      = Column(Numeric(12, 2))
    median_price_per_unit   = Column(Numeric(12, 2))
    min_price_per_unit      = Column(BigInteger)
    max_price_per_unit      = Column(BigInteger)
    best_buyout_per_unit      = Column(BigInteger)
    liquid_lots_count         = Column(Integer)   # лотов с остатком >= 2ч
    expiring_lots_count       = Column(Integer)   # лотов с остатком < 2ч (неликвид)
    detected_buyouts_count    = Column(Integer)   # выкупленных лотов с прошлого снэпшота
    best_liquid_price_per_unit = Column(BigInteger)  # лучшая цена среди ликвидных лотов
    raw_lots                  = Column(JSONB)
    created_at                = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_collected_user_item", "user_id", "item_id", "collect_time"),
        Index("ix_collected_time", "collect_time"),
    )


# ─── История продаж (из API /history) ────────────────────────────────────────

class SalesHistory(Base):
    """Реальные завершённые сделки из Stalcraft API."""
    __tablename__ = "sales_history"

    id               = Column(Integer, primary_key=True)
    user_id          = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id          = Column(String(50), nullable=False)
    region           = Column(String(10), nullable=False)
    sale_time        = Column(DateTime(timezone=True), nullable=False)
    price_per_unit   = Column(BigInteger, nullable=False)
    amount           = Column(Integer, nullable=False)
    total_price      = Column(BigInteger, nullable=False)
    additional_info  = Column(JSONB)
    collected_at     = Column(DateTime(timezone=True), server_default=func.now())
    # Автоудаление через 120 дней — устанавливается триггером или Celery задачей
    will_be_deleted_at = Column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_sales_item_time", "user_id", "item_id", "sale_time"),
        Index("ix_sales_cleanup", "will_be_deleted_at"),
        # Дифф-пропуск в calculate_market_stats_batch: поиск продаж,
        # собранных за последние 26ч после последнего расчёта статистики.
        Index("ix_sales_collected_at", "collected_at"),
    )


# ─── Статистика рынка (пересчитывается раз в час) ────────────────────────────

class MarketStatistics(Base):
    __tablename__ = "market_statistics"

    id                  = Column(Integer, primary_key=True)
    # NULL = глобальная статистика (одна на пару item_id/region, читается всеми)
    user_id             = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    item_id             = Column(String(50), nullable=False)
    region              = Column(String(10), nullable=False)
    avg_price_24h       = Column(Numeric(12, 2))
    min_price_24h       = Column(BigInteger)
    max_price_24h       = Column(BigInteger)
    sales_volume_24h    = Column(Integer)
    avg_price_48h       = Column(Numeric(12, 2))
    min_price_48h       = Column(BigInteger)
    max_price_48h       = Column(BigInteger)
    sales_volume_48h    = Column(Integer)
    avg_price_7d        = Column(Numeric(12, 2))
    median_price_7d     = Column(Numeric(12, 2))
    min_price_7d        = Column(BigInteger)
    max_price_7d        = Column(BigInteger)
    sales_volume_7d     = Column(Integer)
    sales_volume_30d    = Column(Integer)
    price_volatility_7d  = Column(Numeric(5, 2))
    price_volatility_30d = Column(Numeric(5, 2))
    best_sell_hour      = Column(Integer)           # 0-23 MSK — лучший час продажи (вся неделя)
    best_sell_day       = Column(String(10))        # лучший день продажи
    best_buy_hour       = Column(Integer)           # 0-23 MSK — лучший час покупки (вся неделя)
    best_buy_day        = Column(String(10))        # лучший день покупки
    sell_hours_by_day   = Column(JSONB)             # {"Monday": 20, "Tuesday": 19, ...}
    buy_hours_by_day    = Column(JSONB)             # {"Monday": 2, "Tuesday": 3, ...}
    weekend_bonus_percent = Column(Numeric(5, 2))
    avg_sell_time_hours = Column(Numeric(8, 2))
    batch_stats         = Column(JSONB)
    sell_options        = Column(JSONB)
    demand_signals      = Column(JSONB)             # {"recent_bulk_share_24h", "baseline_bulk_share_29d", "bulk_spike"}
    calculated_at       = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("uq_market_stats", "user_id", "item_id", "region", unique=True),
    )


# ─── Рекомендации к покупке ───────────────────────────────────────────────────

class PurchaseRecommendation(Base):
    __tablename__ = "purchase_recommendations"

    id                          = Column(Integer, primary_key=True)
    user_id                     = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id                     = Column(String(50), nullable=False)
    region                      = Column(String(10), nullable=False)
    lot_amount                  = Column(Integer, nullable=False)
    lot_price_per_unit          = Column(BigInteger, nullable=False)
    lot_total_price             = Column(BigInteger, nullable=False)
    lot_end_time                = Column(DateTime(timezone=True))
    expected_listing_price_per_unit = Column(BigInteger, nullable=False)  # за сколько выставить лот
    expected_net_revenue_per_unit   = Column(BigInteger, nullable=False)  # получишь на руки (listing * 0.95)
    expected_profit_per_unit        = Column(BigInteger, nullable=False)  # net_revenue - buy_price
    expected_profit_percent         = Column(Numeric(5, 2), nullable=False)
    confidence_score            = Column(Numeric(3, 2))
    recommend_sell_hour         = Column(Integer)
    recommend_sell_day          = Column(String(10))
    risk_level                  = Column(String(20))  # low | medium | high
    is_viewed                   = Column(Boolean, default=False)
    is_notified                 = Column(Boolean, default=False)
    expires_at                  = Column(DateTime(timezone=True))
    created_at                  = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_purchase_rec", "user_id", "is_viewed", "expires_at"),
    )


# ─── Закупки (Buy Sniper) ────────────────────────────────────────────────────

class BuyAlert(Base):
    """
    Цель закупки: порог цены для записи Избранного. Когда самый дешёвый
    подходящий лот на рынке падает ≤ target_price — бот шлёт Telegram-алерт.
    Одна закупка = одна запись watchlist (UNIQUE watchlist_id).
    """
    __tablename__ = "buy_alerts"

    id            = Column(Integer, primary_key=True)
    user_id       = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    watchlist_id  = Column(Integer, ForeignKey("user_watchlist.id", ondelete="CASCADE"), nullable=False, unique=True)
    target_price  = Column(BigInteger, nullable=False)   # порог ₽/шт: цена ≤ target → уведомить
    is_active     = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())

    user      = relationship("User", back_populates="buy_alerts")
    watchlist = relationship("UserWatchlist", back_populates="buy_alert")


# ─── Логирование и очереди ────────────────────────────────────────────────────

class ApiRequestLog(Base):
    __tablename__ = "api_request_log"

    id               = Column(Integer, primary_key=True)
    user_id          = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    endpoint         = Column(String(200))
    request_time     = Column(DateTime(timezone=True), server_default=func.now())
    response_time_ms = Column(Integer)
    status_code      = Column(Integer)
    tokens_used      = Column(Integer)
    error_message    = Column(Text)


class SignalOutcome(Base):
    """Лог предсказаний по выгодным лотам — для будущей калибровки констант."""
    __tablename__ = "signal_outcomes"

    id                   = Column(Integer, primary_key=True)
    item_id              = Column(String(50), nullable=False)
    region               = Column(String(10), nullable=False)
    quality_filter       = Column(Integer, nullable=True)
    enchant_filter       = Column(Integer, nullable=True)
    lot_start_time       = Column(String(50), nullable=False)
    buyout_per_unit      = Column(BigInteger, nullable=False)
    ref_price            = Column(BigInteger, nullable=False)
    predicted_sell_price = Column(BigInteger, nullable=False)
    predicted_hours      = Column(Numeric(8, 2))
    predicted_profit_pct = Column(Numeric(6, 2))
    trend                = Column(String(10))
    created_at           = Column(DateTime(timezone=True), server_default=func.now())
    evaluated_at         = Column(DateTime(timezone=True))
    realized_price       = Column(BigInteger)
    realized_hours       = Column(Numeric(8, 2))
    outcome              = Column(String(20))  # sold_at_or_above | sold_below | not_sold

    __table_args__ = (
        Index("uq_signal_outcome", "item_id", "region", "lot_start_time", unique=True),
        Index("ix_signal_outcome_pending", "evaluated_at"),
    )


class NotificationQueue(Base):
    __tablename__ = "notification_queue"

    id                = Column(Integer, primary_key=True)
    user_id           = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    notification_type = Column(String(30))  # purchase_recommendation | sell_recommendation
    channel           = Column(String(20))  # telegram | browser_push
    payload           = Column(JSONB)
    attempts          = Column(Integer, default=0)
    max_attempts      = Column(Integer, default=3)
    next_attempt_at   = Column(DateTime(timezone=True))
    status            = Column(String(20), default="pending")  # pending | sent | failed
    created_at        = Column(DateTime(timezone=True), server_default=func.now())


class PushSubscription(Base):
    """Web Push подписка одного устройства/браузера пользователя.

    Один пользователь = много подписок (ПК + телефон = отдельные записи).
    endpoint уникален (capability-URL push-сервиса браузера); p256dh/auth —
    ключи шифрования из PushSubscription.getKey() на фронте.
    """
    __tablename__ = "push_subscriptions"

    id           = Column(Integer, primary_key=True)
    user_id      = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    endpoint     = Column(Text, nullable=False, unique=True)
    p256dh       = Column(Text, nullable=False)
    auth         = Column(Text, nullable=False)
    user_agent   = Column(String(300), nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User", back_populates="push_subscriptions")


# ─── Новости / Анонсы ────────────────────────────────────────────────────────

class News(Base):
    __tablename__ = "news"

    id           = Column(Integer, primary_key=True)
    author_id    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title        = Column(String(300), nullable=False)
    content      = Column(Text, nullable=False)
    tags         = Column(ARRAY(String), nullable=False, default=list, server_default="{}")
    is_pinned    = Column(Boolean, nullable=False, default=False, server_default="false")
    is_published = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    updated_at   = Column(DateTime(timezone=True), nullable=True, onupdate=func.now())

    author = relationship("User", foreign_keys=[author_id])

    __table_args__ = (
        Index("ix_news_published_pinned", "is_published", "is_pinned", "created_at"),
    )


# ─── Выбросы (emission events) ───────────────────────────────────────────────

class EmissionEvent(Base):
    """Зафиксированный выброс (emission). Одна строка на событие."""
    __tablename__ = "emission_events"

    id          = Column(Integer, primary_key=True)
    region      = Column(String(10), nullable=False)                        # "RU", "EU" и т.д.
    started_at  = Column(DateTime(timezone=True), nullable=False)           # currentStart из API
    ended_at    = Column(DateTime(timezone=True), nullable=True)            # NULL пока идёт
    detected_at = Column(DateTime(timezone=True), nullable=False,           # момент обнаружения
                         server_default=func.now())
    notified     = Column(Boolean, nullable=False, default=False)           # Telegram о старте отправлен
    end_notified = Column(Boolean, nullable=False, default=False)           # Telegram о завершении отправлен

    __table_args__ = (
        Index("ix_emission_region_started", "region", "started_at"),
        Index("ix_emission_active", "region", "ended_at"),
    )

