from sqlalchemy import (
    Column, String, Integer, BigInteger, SmallInteger, Boolean, Float,
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
    # NULL = глобально собранная продажа (задача collect_artifact_history по всем
    # артефактам, вне чьего-либо watchlist) — та же конвенция, что у
    # collected_data.user_id и market_statistics.user_id.
    user_id          = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
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
    median_price_24h    = Column(Numeric(12, 2))    # краткосрочный ориентир + база тренда
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
    # Опорная цена sell_options: взвешенная по свежести медиана продаж за 7д
    # (pricing.weighted_reference). НЕ равна median_price_7d — та остаётся
    # описательной статистикой для отображения.
    reference_price     = Column(BigInteger)
    # Эффективное число сделок за reference_price: сумма весов 0.5 ** (age/48)
    # (pricing.weighted_reference). НЕ равно sales_volume_7d — три сделки
    # трёхдневной давности дают вес ~1. По нему считается уверенность опоры и
    # пол по данным, живьём его не пересчитать: история за 7д на каждый
    # поллинг карточки (30с) слишком дорога.
    reference_weight    = Column(Numeric(10, 2))
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


class SurvivalCalibration(Base):
    """
    Сверка публикуемых вероятностей с фактом. Замыкает петлю, которую
    signal_outcomes так и не замкнул.

    Проверяется ровно то, что видит пользователь: p_sold_lo своей страты.
    Обучающий период и проверочный НЕ ПЕРЕСЕКАЮТСЯ во времени — иначе это
    подгонка, а не калибровка.

    Повод (замер 2026-08-19): кривая, обученная на 16-17 августа, промахнулась
    на 18-19 августа по ВСЕМ семи стратам в одну сторону, на 4.7-16.4 п.п.
    Смешивание классов исключено, незрелость окна тоже (её перекос обратный),
    сокращение окна обучения не помогает (10.3 п.п. против 9.7) — то есть это
    смена режима, которую прошлое не предсказывает. Порядок страт при этом
    устойчив, поэтому ранжирование не задето, а проценты задеты.
    """
    __tablename__ = "survival_calibration"

    id          = Column(Integer, primary_key=True)
    item_class  = Column("class", String(8), nullable=False)
    feature     = Column(String(8), nullable=False)
    bucket      = Column(String(16), nullable=False)
    horizon_h   = Column(SmallInteger, nullable=False)
    # Границы проверочного окна: без них строку нельзя перепроверить руками
    window_from = Column(DateTime(timezone=True), nullable=False)
    window_to   = Column(DateTime(timezone=True), nullable=False)
    n           = Column(Integer, nullable=False)
    predicted   = Column(Numeric(5, 2), nullable=False)
    realized    = Column(Numeric(5, 2), nullable=False)
    # realized - predicted. ОТРИЦАТЕЛЬНОЕ = обещали больше, чем вышло, то есть
    # ошибка в опасную для пользователя сторону.
    error_pp    = Column(Numeric(6, 2), nullable=False)
    computed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("uq_survival_calibration", "class", "feature", "bucket",
              "horizon_h", "window_from", unique=True),
        Index("ix_survival_calibration_computed", "computed_at"),
    )


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


# ─── Лента артефактов ─────────────────────────────────────────────────────────

class FeedLot(Base):
    """
    Живой отскоренный срез ТОЛЬКО выгодных лотов (одна строка = один лот).

    Переписывается каждым циклом collect_artifact_lots: лот исчез из среза =
    выкуплен, истёк или перестал быть выгодным. Персональный порог видимости
    применяется при чтении (margin_adj_pct >= min_profit_margin_percent),
    поэтому один общий срез обслуживает всех пользователей.
    """
    __tablename__ = "feed_lots"

    id                   = Column(BigInteger, primary_key=True)
    item_id              = Column(String(50), ForeignKey("master_items.item_id"), nullable=False)
    region               = Column(String(10), nullable=False)
    # startTime|qlt|ptn|buyoutPrice|amount — см. feed_collector.lot_identity_key:
    # startTime один не различает лоты, выставленные в одну секунду.
    # 128 при реалистичном максимуме ~58 символов: переполнение роняет запись
    # предмета целиком, запас ничего не стоит
    lot_key              = Column(String(128), nullable=False)
    qlt                  = Column(SmallInteger, nullable=False)  # 0-5
    ptn                  = Column(SmallInteger, nullable=False)  # 0-15
    amount               = Column(Integer, nullable=False)
    buyout_price         = Column(BigInteger, nullable=False)    # итого к оплате
    buyout_per_unit      = Column(BigInteger, nullable=False)
    start_time           = Column(DateTime(timezone=True), nullable=True)
    end_time             = Column(DateTime(timezone=True), nullable=True)
    # Скоринг: всё из pricing.evaluate_lot_profit + artifact_variant_stats
    ref_price            = Column(BigInteger, nullable=False)
    # Тир, по которому лот прошёл в ленту — САМЫЙ БЫСТРЫЙ из подошедших
    # (pricing.TIER_ORDER: fast -> normal -> premium). Отвечает на вопрос «как
    # быстро это можно перепродать с прибылью», поэтому лот, выгодный и по
    # fast, и по premium, помечен fast. Все остальные колонки прибыли
    # (profit_*, sell_price_used, est_sell_hours) посчитаны по ЭТОМУ тиру.
    # До 2026-08-21 допуск шёл только по fast, и колонка была бы константой.
    tier_used            = Column(String(10), nullable=False, server_default="fast")
    sell_price_used      = Column(BigInteger, nullable=False)
    breakeven_per_unit   = Column(BigInteger, nullable=False)
    profit_per_unit      = Column(BigInteger, nullable=False)
    profit_total         = Column(BigInteger, nullable=False)    # profit_per_unit * amount, сортировка по умолчанию
    profit_pct           = Column(Numeric(8, 2), nullable=False)
    # profit_pct / risk_mult — sargable-форма фильтра profit_pct >= user_min * risk_mult
    margin_adj_pct       = Column(Numeric(8, 2), nullable=False)
    profit_per_hour      = Column(Numeric(14, 2))   # НА ЕДИНИЦУ (evaluate_lot_profit)
    # profit_total / est_sell_hours — ровно та величина, которую печатает UI в
    # колонке «₽/час». Материализована, потому что сортировка обязана идти по
    # показанному числу: сортировка по profit_per_hour (на единицу) при amount > 1
    # инвертировала выдачу.
    profit_per_hour_total = Column(Numeric(14, 2))
    # ОЖИДАЕМАЯ прибыль в рублях — ключ сортировки ленты по умолчанию.
    # Максимум по двум сценариям продажи (быстро / дороже): рациональный игрок
    # выбирает лучшую стратегию для каждого лота. profit_total отвечал на
    # вопрос «сколько заработаю, ЕСЛИ продам» и молча предполагал, что продажа
    # состоится; замер показал, что 77.3 % строк ленты продаются реже чем в
    # 40 % случаев за 6 ч, и именно у них прибыль выше — связь структурная,
    # большую маржу забирают, продавая близко к опоре, то есть глубоко в
    # стакане. NULL = вероятность не измерена, строка уходит в конец выдачи
    # (nulls_last); подставлять p = 1 нельзя.
    #
    # В рублях, а не в ₽/час: часовая ставка подразумевает поток одинаковых
    # лотов, которого на этом рынке нет — заработок случится один раз.
    ev_profit            = Column(BigInteger)
    est_sell_hours       = Column(Numeric(8, 2))
    # Кривая дожития (P1-4 фаза B, sale_survival). Считаются по позиции
    # ПЛАНОВОЙ цены продажи в живом стакане варианта — самому сильному из
    # измеренных признаков. NULL, пока таблица дожития не заполнена или страта
    # не набрала MIN_STRATUM_N: отсутствие честнее выдуманного числа.
    p_sold_6h            = Column(Numeric(5, 2))   # P(продан <= 6 ч), нижняя граница
    pct_sold_ever        = Column(Numeric(5, 2))   # доля страты, продавшаяся когда-либо
    # Сценарий «подождать и продать дороже»: цена СЛЕДУЮЩЕГО тира вверх от
    # tier_used, своя позиция в стакане и потому свои срок и вероятность.
    # NULL у строк тира premium — выше него тира нет, и сценарий ожидания
    # совпал бы с самой строкой. Замер на проде:
    # верхняя цена даёт в среднем +451 % прибыли (у 139 строк из 188 — больше
    # чем вдвое) ценой ~17 п.п. вероятности. Прибыль — это РАЗНОСТЬ «продажа
    # минус закупка», поэтому при тонкой марже +12.8 % к цене умножают её в
    # разы. До этих колонок лента показывала только нижний сценарий и прятала
    # апсайд целиком.
    profit_total_slow    = Column(BigInteger)
    est_sell_hours_slow  = Column(Numeric(8, 2))
    p_sold_6h_slow       = Column(Numeric(5, 2))
    risk                 = Column(String(10), nullable=False)    # low/medium/high
    risk_mult            = Column(Numeric(3, 2), nullable=False)  # pricing.RISK_MARGIN_MULT
    volatility_7d        = Column(Numeric(6, 2))
    trend_24h            = Column(String(10))                    # falling/stable/rising/unknown
    trend_24h_pct        = Column(Numeric(8, 2))
    trend_7d_pct         = Column(Numeric(8, 2))
    sales_per_day        = Column(Numeric(10, 2))
    supply_coverage_days = Column(Numeric(10, 2))                # Σ amount живых лотов варианта / sales_per_day
    stats_confidence     = Column(String(10))
    stats_samples        = Column(Integer)
    first_seen_at        = Column(DateTime(timezone=True), nullable=False)  # ставится только при вставке
    seen_at              = Column(DateTime(timezone=True), nullable=False)  # последний цикл, подтвердивший лот

    __table_args__ = (
        Index("uq_feed_lots_lot", "item_id", "region", "lot_key", unique=True),
        Index("ix_feed_lots_profit_total", text("profit_total DESC")),
        Index("ix_feed_lots_profit_pct", text("profit_pct DESC")),
        Index("ix_feed_lots_margin_adj", text("margin_adj_pct DESC")),
        Index("ix_feed_lots_item", "item_id"),
        Index("ix_feed_lots_variant", "qlt", "ptn"),
        Index("ix_feed_lots_end_time", "end_time"),
        Index("ix_feed_lots_seen_at", "seen_at"),
    )


class LotObservation(Base):
    """
    Наблюдение за жизнью лота: одна строка = один лот, от появления до исхода.

    Сырьё для кривой дожития (P1-4, фаза B): «с какой вероятностью и за какое
    время продастся лот, выставленный по цене X относительно опоры». В отличие
    от feed_lots строки НЕ удаляются при исчезновении лота из скана — само
    исчезновение и есть событие, ради которого таблица заведена. Закрывает
    строку резолвер resolve_lot_observations, ретеншен — delete_old_data.

    Источник — ТОЛЬКО полный свип ленты (feed_collector.collect_artifact_lots):
    там идёт полная пагинация /lots, поэтому пропажа лота — настоящая пропажа.
    Снэпшоты watchlist (collected_data.raw_lots) источником быть НЕ МОГУТ: они
    обрезаны до 200 самых дешёвых лотов, и «вытеснен более дешёвым» там
    неотличимо от «продан» (docs/tasks/lot-observations.md §2).

    Наблюдаются только артефакты — кривая будет описывать артефактный рынок.
    """
    __tablename__ = "lot_observations"

    id                = Column(BigInteger, primary_key=True)
    item_id           = Column(String(50), ForeignKey("master_items.item_id"), nullable=False)
    region            = Column(String(10), nullable=False)
    qlt               = Column(SmallInteger, nullable=False)
    ptn               = Column(SmallInteger, nullable=False)
    # Идентичность лота — та же, что у feed_lots (feed_collector.lot_identity_key)
    lot_key           = Column(String(128), nullable=False)
    start_time        = Column(DateTime(timezone=True), nullable=True)   # выставление, из лота
    end_time          = Column(DateTime(timezone=True), nullable=True)   # плановое истечение (48 ч)
    amount            = Column(Integer, nullable=False)
    buyout_price      = Column(BigInteger, nullable=False)               # цена всего лота
    buyout_per_unit   = Column(BigInteger, nullable=False)
    # Опора варианта на момент ПЕРВОГО наблюдения. Задним числом не
    # восстанавливается: artifact_variant_stats перезаписывается каждый час.
    # NULL = у варианта не было опоры (нет сделок / ниже пола по данным) —
    # такое наблюдение идёт только в безусловную кривую.
    ref_price_at_seen = Column(BigInteger, nullable=True)
    # Состояние стакана ВАРИАНТА на момент первого наблюдения. Считается по
    # (item_id, qlt, ptn), а не по предмету: качество и заточка — главный
    # ценообразующий признак, агрегат по предмету смешивает разные товары.
    # Задним числом не восстанавливается (нужен весь срез варианта), поэтому
    # пишется сразу и только при вставке. NULL = лот на момент наблюдения был
    # неликвиден (< 2 ч до конца аукциона) и в очереди не стоял.
    queue_rank        = Column(Integer, nullable=True)   # 1 = самый дешёвый живой лот варианта
    cheaper_units     = Column(Integer, nullable=True)   # Σ amount живых лотов строго дешевле
    variant_live_lots = Column(Integer, nullable=True)   # всего живых лотов варианта (знаменатель)
    first_seen_at     = Column(DateTime(timezone=True), nullable=False)  # ставится только при вставке
    last_seen_at      = Column(DateTime(timezone=True), nullable=False)  # последний цикл, видевший лот
    # NULL пока лот жив; далее sold / expired / withdrawn. Три значения, а не
    # флаг: expired — полное наблюдение «не продался», withdrawn —
    # цензурированное. Спутать их значит исказить кривую в фазе B.
    outcome           = Column(String(12), nullable=True)
    resolved_at       = Column(DateTime(timezone=True), nullable=True)
    # Сделка, закрывшая наблюдение. Одна сделка закрывает МАКСИМУМ одно
    # наблюдение (уникальный частичный индекс ниже): без этого одна продажа
    # помечала sold все неразличимые лоты варианта (та же цена и количество) —
    # замер на проде дал 47.5% строк sold в таких группах, то есть долю продаж
    # как завышенную верхнюю границу. ON DELETE SET NULL: sales_history живёт
    # 120 дней и чистится в том же delete_old_data РАНЬШЕ наблюдений — ссылка
    # не должна блокировать уборку (outcome при этом остаётся sold).
    matched_sale_id   = Column(
        BigInteger, ForeignKey("sales_history.id", ondelete="SET NULL"), nullable=True,
    )
    # Происхождение наблюдения: live — записано сборщиком ленты в момент
    # события; snapshot — восстановлено задним числом из collected_data
    # (app/scripts/reconstruct_lot_history.py). У источников РАЗНЫЕ смещения:
    # набор предметов, шаг обхода, левое усечение, доля цензурированных. Фаза B
    # обязана уметь их разделять и взвешивать, иначе две выборки необратимо
    # перемешаются (docs/tasks/history-lot-reconstruction.md §2.3).
    source            = Column(String(12), nullable=False, server_default="live")

    __table_args__ = (
        # source в ключе идентичности: один и тот же лот в окне пересечения
        # виден ОБОИМ источникам, и это две независимые записи о нём. Без
        # source восстановление затирало бы last_seen_at живых строк, а
        # сверка §5.2 (живой источник как эталон) стала бы невозможна.
        Index("uq_lot_obs_lot", "source", "item_id", "region", "lot_key", unique=True),
        Index("ix_lot_obs_pending", "outcome", "last_seen_at"),   # выборка резолвера
        Index("ix_lot_obs_variant", "item_id", "region", "qlt", "ptn"),  # фаза B
        # Частичный: NULL-ы друг другу не конфликтуют, но без предиката индекс
        # распух бы на всех живых и незакрытых строках. Уникальность внутри
        # source, а не глобально: «одна сделка = максимум одно наблюдение» —
        # правило учёта ВНУТРИ выборки. Глобальная уникальность означала бы,
        # что восстановление отбирает сделку у живого наблюдения того же лота
        # и портит эталон сверки.
        Index(
            "uq_lot_obs_matched_sale", "source", "matched_sale_id", unique=True,
            postgresql_where=text("matched_sale_id IS NOT NULL"),
        ),
    )


class SaleSurvival(Base):
    """
    Кривая дожития: «с какой вероятностью лот продастся за H часов».

    Одна строка = страта x горизонт. Пересчитывается раз в сутки целиком из
    lot_observations (P1-4 фаза B, docs/tasks/sale-survival-curve.md).

    Заменяет два набора выдуманных чисел: множители времени 0.4/1.0/2.5 и
    лестницу 2/8/24...72/168/336 в make_sell_options. Ни одно из тех 12 чисел
    не измерялось; здесь каждое взято из наблюдений за реальными лотами,
    включая непроданные — их не видит ни один другой источник в системе.

    ТОЛЬКО source='live'. Восстановленные из снапшотов наблюдения измеряют
    позицию в книге корректно (corr=0.992 с живым на общих лотах), но их
    ПОПУЛЯЦИЯ смещена: снапшот watchlist обрезан 200 дешёвыми лотами предмета,
    поэтому глубокие стаканы в нём не представлены (p90 книги 31 против 409),
    и он пропускает самые быстрые лоты (те, кого видел только живой сборщик,
    продаются в 80.1% против 56.9% у общих). На одних и тех же предметах это
    даёт заниженную на 8-16 п.п. вероятность продажи. Пул источников запрещён.
    """
    __tablename__ = "sale_survival"

    id            = Column(Integer, primary_key=True)
    # Класс предмета: artefact / gear. Полноценное измерение страты, а не метка —
    # у снаряжения качество является свойством предмета, а высокие тиры чаще
    # получают апгрейдом, чем покупкой, поэтому артефактная кривая ему чужая.
    # Имя колонки в БД — "class" (ключевое слово Python, атрибутом быть не может).
    # Классов ровно два: дробить мельче нельзя, страты не наберут MIN_STRATUM_N.
    item_class    = Column("class", String(8), nullable=False)
    # pos — нормированная позиция в книге варианта (queue_rank/variant_live_lots),
    # ratio — цена лота к опоре варианта. Замер: pos сильнее (корреляция с
    # «продан <= 6 ч» -0.330 против -0.138), но признаки почти независимы
    # (взаимная корреляция 0.299), поэтому нужны оба.
    feature       = Column(String(8), nullable=False)
    bucket        = Column(String(16), nullable=False)
    horizon_h     = Column(SmallInteger, nullable=False)
    # Доживших АДМИНИСТРАТИВНО до горизонта: длительность аукциона переменная
    # (48 ч у 47% лотов, 12 ч у 39%, 24 ч у 11%, 6 ч у 3%), и лот с 12-часовым
    # аукционом не может быть «не проданным за 24 ч» — он туда не дожил.
    n_at_risk     = Column(Integer, nullable=False)
    n_sold        = Column(Integer, nullable=False)
    # Две границы, потому что withdrawn — почти наверняка ИНФОРМАТИВНОЕ
    # цензурирование: продавец снимает лот, который не продаётся. lo считает
    # снятый лот непроданным (консервативно), hi выкидывает его из знаменателя.
    # В UI идёт только lo: hi даёт 92-99% во всех стратах и различия стирает.
    p_sold_lo     = Column(Numeric(5, 2), nullable=False)
    p_sold_hi     = Column(Numeric(5, 2), nullable=False)
    pct_withdrawn = Column(Numeric(5, 2), nullable=False)
    # Доля продавшихся когда-либо СРЕДИ ДОЖИВШИХ ДО ГОРИЗОНТА — знаменатель
    # тот же, что у p_sold_*. Считать по всей страте нельзя: 6- и 12-часовые
    # аукционы продаются реже, и на общей популяции величина выходила МЕНЬШЕ
    # p_sold_24h во всех стратах, то есть «за сутки продалось больше, чем
    # продалось вообще». Отсюда же зависимость от горизонта.
    pct_sold_ever = Column(Numeric(5, 2))
    # От горизонта не зависит и дублируется по строкам страты намеренно:
    # сводка читается одним запросом, а таблица не превышает ~60 строк.
    median_hours  = Column(Numeric(6, 2))   # медиана срока СРЕДИ ПРОДАННЫХ
    computed_at   = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("uq_sale_survival", "class", "feature", "bucket", "horizon_h", unique=True),
    )


class ArtifactVariantStats(Base):
    """
    Статистика варианта «предмет x качество x заточка» по реальным сделкам.

    Опора скоринга ленты: вариант без ref_price/sell_options в скоринге
    пропускается (нет сделок — нет честной базы для расчёта прибыли).
    """
    __tablename__ = "artifact_variant_stats"

    id                  = Column(BigInteger, primary_key=True)
    item_id             = Column(String(50), ForeignKey("master_items.item_id"), nullable=False)
    region              = Column(String(10), nullable=False)
    qlt                 = Column(SmallInteger, nullable=False)
    ptn                 = Column(SmallInteger, nullable=False)
    ref_price           = Column(BigInteger)                 # compute_reference()["ref"]
    ref_source          = Column(String(20))                 # weighted_history / history / current_fallback
    ref_confidence      = Column(String(10))                 # high / medium / low (по эффективному числу сделок)
    ref_samples         = Column(Integer)
    median_24h          = Column(Numeric(14, 2))
    median_7d           = Column(Numeric(14, 2))
    median_30d          = Column(Numeric(14, 2))
    sales_volume_24h    = Column(Integer)
    sales_volume_7d     = Column(Integer)
    sales_volume_30d    = Column(Integer)
    sales_per_day       = Column(Numeric(10, 2))             # sales_volume_7d / 7
    volatility_7d       = Column(Numeric(6, 2))
    risk                = Column(String(10))                 # classify_risk(volatility_7d)
    trend_24h           = Column(String(10))
    trend_24h_pct       = Column(Numeric(8, 2))              # median_24h vs median_7d
    trend_7d_pct        = Column(Numeric(8, 2))              # median_7d vs median_30d
    sell_options        = Column(JSONB)                      # make_sell_options(...)
    batch_stats         = Column(JSONB)
    avg_sell_time_hours = Column(Numeric(8, 2))
    calculated_at       = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("uq_artifact_variant", "item_id", "region", "qlt", "ptn", unique=True),
        Index("ix_avs_item", "item_id", "region"),
    )

