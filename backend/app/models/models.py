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
    created_at        = Column(DateTime(timezone=True), server_default=func.now())
    updated_at        = Column(DateTime(timezone=True), onupdate=func.now())

    settings    = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")
    watchlist   = relationship("UserWatchlist", back_populates="user", cascade="all, delete-orphan")
    inventory   = relationship("UserInventory", back_populates="user", cascade="all, delete-orphan")


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
    can_be_batch_traded = Column(Boolean, default=True)
    last_updated        = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_master_name_ru", "name_ru"),
        Index("ix_master_name_en", "name_en"),
        Index("ix_master_category", "category"),
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


# ─── Внутренний склад ────────────────────────────────────────────────────────

class UserInventory(Base):
    """Товары, которые пользователь уже купил и хочет продать."""
    __tablename__ = "user_inventory"

    id                      = Column(Integer, primary_key=True)
    user_id                 = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id                 = Column(String(50), nullable=False)
    region                  = Column(String(10), default="EU")
    quantity                = Column(Integer, nullable=False)
    avg_buy_price_per_unit  = Column(BigInteger)
    added_at                = Column(DateTime(timezone=True), server_default=func.now())
    last_updated            = Column(DateTime(timezone=True), onupdate=func.now())

    user              = relationship("User", back_populates="inventory")
    sell_recommendations = relationship("SellRecommendation", back_populates="inventory_item", cascade="all, delete-orphan")

    __table_args__ = (
        Index("uq_inventory_user_item", "user_id", "item_id", "region", unique=True),
    )


class SellRecommendation(Base):
    __tablename__ = "sell_recommendations"

    id                          = Column(Integer, primary_key=True)
    inventory_id                = Column(Integer, ForeignKey("user_inventory.id", ondelete="CASCADE"), nullable=False)
    recommended_price_per_unit  = Column(BigInteger, nullable=False)
    recommended_batch_size      = Column(Integer)
    expected_wait_hours         = Column(Numeric(8, 2))
    expected_revenue            = Column(BigInteger)
    expected_profit             = Column(BigInteger)
    expected_profit_percent     = Column(Numeric(5, 2))
    sell_now_vs_wait_benefit    = Column(Numeric(5, 2))
    confidence_score            = Column(Numeric(3, 2))
    created_at                  = Column(DateTime(timezone=True), server_default=func.now())
    is_viewed                   = Column(Boolean, default=False)

    inventory_item = relationship("UserInventory", back_populates="sell_recommendations")


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


# ─── Лента: фоновый мониторинг (research-watchlist) ──────────────────────────

class FeedWatchlist(Base):
    """
    Отдельный research-список пользователя для фонового мониторинга.
    Не путать с UserWatchlist (Избранное). Обновляется медленнее, с учётом
    остатка rate-limit после Избранного.
    """
    __tablename__ = "feed_watchlist"

    id                    = Column(Integer, primary_key=True)
    user_id               = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id               = Column(String(50), ForeignKey("master_items.item_id"), nullable=False)
    region                = Column(String(10), default="EU")
    quality_filter        = Column(Integer, nullable=True)   # NULL = любое качество
    enchant_filter        = Column(Integer, nullable=True)   # NULL = любая заточка
    is_active             = Column(Boolean, default=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    last_collected_at     = Column(DateTime(timezone=True), nullable=True)
    # Кэшированная статистика (обновляется коллектором)
    sales_7d              = Column(Integer, default=0)
    sales_24h             = Column(Integer, default=0)
    profitable_lots_count = Column(Integer, default=0)
    avg_profit            = Column(Float, default=0.0)

    user = relationship("User")
    item = relationship("MasterItem")

    __table_args__ = (
        Index(
            "uq_feed_watchlist",
            "user_id", "item_id", "region", "quality_filter", "enchant_filter",
            unique=True,
        ),
        Index("ix_feed_watchlist_collect", "is_active", "last_collected_at"),
    )

