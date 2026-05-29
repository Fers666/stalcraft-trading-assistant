"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-05-29
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # ── users ────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(50), nullable=False, unique=True),
        sa.Column("email", sa.String(100), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("telegram_username", sa.String(50)),
        sa.Column("telegram_chat_id", sa.BigInteger()),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # ── user_settings ─────────────────────────────────────────────────────────
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("min_profit_margin_percent", sa.Integer(), server_default="10"),
        sa.Column("exclude_less_than_amount", sa.Integer(), server_default="1"),
        sa.Column("notify_telegram", sa.Boolean(), server_default=sa.true()),
        sa.Column("notify_browser_push", sa.Boolean(), server_default=sa.true()),
        sa.Column("auto_refresh_enabled", sa.Boolean(), server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # ── master_items ──────────────────────────────────────────────────────────
    op.create_table(
        "master_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.String(50), nullable=False, unique=True),
        sa.Column("name_ru", sa.String(200)),
        sa.Column("name_en", sa.String(200)),
        sa.Column("category", sa.String(50)),
        sa.Column("can_be_batch_traded", sa.Boolean(), server_default=sa.true()),
        sa.Column("last_updated", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_master_name_ru", "master_items", ["name_ru"])
    op.create_index("ix_master_name_en", "master_items", ["name_en"])
    op.create_index("ix_master_category", "master_items", ["category"])

    # ── user_watchlist ────────────────────────────────────────────────────────
    op.create_table(
        "user_watchlist",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(10), server_default="EU"),
        sa.Column("tracked_batch_sizes", postgresql.ARRAY(sa.Integer())),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true()),
        sa.Column("last_successful_check", sa.DateTime(timezone=True)),
        sa.Column("error_status", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )
    op.create_index("ix_watchlist_active", "user_watchlist", ["user_id", "is_active", "region"])
    op.create_index("uq_watchlist_user_item_region", "user_watchlist", ["user_id", "item_id", "region"], unique=True)

    # ── collected_data ────────────────────────────────────────────────────────
    op.create_table(
        "collected_data",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("collect_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("collect_type", sa.String(20), nullable=False),
        sa.Column("total_lots", sa.Integer(), server_default="0"),
        sa.Column("total_available_amount", sa.Integer(), server_default="0"),
        sa.Column("best_price_per_unit", sa.BigInteger()),
        sa.Column("best_price_total", sa.BigInteger()),
        sa.Column("best_price_amount", sa.Integer()),
        sa.Column("best_lot_id", sa.String(100)),
        sa.Column("avg_price_per_unit", sa.Numeric(12, 2)),
        sa.Column("median_price_per_unit", sa.Numeric(12, 2)),
        sa.Column("min_price_per_unit", sa.BigInteger()),
        sa.Column("max_price_per_unit", sa.BigInteger()),
        sa.Column("best_buyout_per_unit", sa.BigInteger()),
        sa.Column("raw_lots", postgresql.JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_collected_user_item", "collected_data", ["user_id", "item_id", "collect_time"])
    op.create_index("ix_collected_time", "collected_data", ["collect_time"])

    # ── sales_history ─────────────────────────────────────────────────────────
    op.create_table(
        "sales_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("sale_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("total_price", sa.BigInteger(), nullable=False),
        sa.Column("additional_info", postgresql.JSONB()),
        sa.Column("collected_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("will_be_deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_sales_item_time", "sales_history", ["user_id", "item_id", "sale_time"])
    op.create_index("ix_sales_cleanup", "sales_history", ["will_be_deleted_at"])

    # ── market_statistics ─────────────────────────────────────────────────────
    op.create_table(
        "market_statistics",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("avg_price_24h", sa.Numeric(12, 2)),
        sa.Column("min_price_24h", sa.BigInteger()),
        sa.Column("max_price_24h", sa.BigInteger()),
        sa.Column("sales_volume_24h", sa.Integer()),
        sa.Column("avg_price_7d", sa.Numeric(12, 2)),
        sa.Column("median_price_7d", sa.Numeric(12, 2)),
        sa.Column("min_price_7d", sa.BigInteger()),
        sa.Column("max_price_7d", sa.BigInteger()),
        sa.Column("sales_volume_7d", sa.Integer()),
        sa.Column("price_volatility_7d", sa.Numeric(5, 2)),
        sa.Column("best_sell_hour", sa.Integer()),
        sa.Column("best_sell_day", sa.String(10)),
        sa.Column("weekend_bonus_percent", sa.Numeric(5, 2)),
        sa.Column("avg_sell_time_hours", sa.Numeric(8, 2)),
        sa.Column("batch_stats", postgresql.JSONB()),
        sa.Column("calculated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("uq_market_stats", "market_statistics", ["user_id", "item_id", "region"], unique=True)

    # ── purchase_recommendations ──────────────────────────────────────────────
    op.create_table(
        "purchase_recommendations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("lot_amount", sa.Integer(), nullable=False),
        sa.Column("lot_price_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("lot_total_price", sa.BigInteger(), nullable=False),
        sa.Column("lot_end_time", sa.DateTime(timezone=True)),
        sa.Column("expected_sell_price_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("expected_profit_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("expected_profit_percent", sa.Numeric(5, 2), nullable=False),
        sa.Column("confidence_score", sa.Numeric(3, 2)),
        sa.Column("recommend_sell_hour", sa.Integer()),
        sa.Column("recommend_sell_day", sa.String(10)),
        sa.Column("risk_level", sa.String(20)),
        sa.Column("is_viewed", sa.Boolean(), server_default=sa.false()),
        sa.Column("is_notified", sa.Boolean(), server_default=sa.false()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_purchase_rec", "purchase_recommendations", ["user_id", "is_viewed", "expires_at"])

    # ── user_inventory ────────────────────────────────────────────────────────
    op.create_table(
        "user_inventory",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), server_default="EU"),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("avg_buy_price_per_unit", sa.BigInteger()),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_updated", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )
    op.create_index("uq_inventory_user_item", "user_inventory", ["user_id", "item_id", "region"], unique=True)

    # ── sell_recommendations ──────────────────────────────────────────────────
    op.create_table(
        "sell_recommendations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("inventory_id", sa.Integer(), sa.ForeignKey("user_inventory.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recommended_price_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("recommended_batch_size", sa.Integer()),
        sa.Column("expected_wait_hours", sa.Numeric(8, 2)),
        sa.Column("expected_revenue", sa.BigInteger()),
        sa.Column("expected_profit", sa.BigInteger()),
        sa.Column("expected_profit_percent", sa.Numeric(5, 2)),
        sa.Column("sell_now_vs_wait_benefit", sa.Numeric(5, 2)),
        sa.Column("confidence_score", sa.Numeric(3, 2)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("is_viewed", sa.Boolean(), server_default=sa.false()),
    )

    # ── api_request_log ───────────────────────────────────────────────────────
    op.create_table(
        "api_request_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("endpoint", sa.String(200)),
        sa.Column("request_time", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("response_time_ms", sa.Integer()),
        sa.Column("status_code", sa.Integer()),
        sa.Column("tokens_used", sa.Integer()),
        sa.Column("error_message", sa.Text()),
    )

    # ── notification_queue ────────────────────────────────────────────────────
    op.create_table(
        "notification_queue",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("notification_type", sa.String(30)),
        sa.Column("channel", sa.String(20)),
        sa.Column("payload", postgresql.JSONB()),
        sa.Column("attempts", sa.Integer(), server_default="0"),
        sa.Column("max_attempts", sa.Integer(), server_default="3"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("notification_queue")
    op.drop_table("api_request_log")
    op.drop_table("sell_recommendations")
    op.drop_table("user_inventory")
    op.drop_table("purchase_recommendations")
    op.drop_table("market_statistics")
    op.drop_table("sales_history")
    op.drop_table("collected_data")
    op.drop_table("user_watchlist")
    op.drop_table("master_items")
    op.drop_table("user_settings")
    op.drop_table("users")
