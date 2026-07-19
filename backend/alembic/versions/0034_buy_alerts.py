"""buy_alerts table (Buy Sniper), drop legacy inventory

Revision ID: 0034
Revises: 0033
Create Date: 2026-07-19

Раздел «Склад» (user_inventory + sell_recommendations) заменён на «Закупки //
Buy Sniper». Дропаем неиспользуемые таблицы склада (sell_recommendations
первой — зависит по FK от user_inventory), создаём buy_alerts: одна закупка =
одна запись Избранного (UNIQUE watchlist_id), порог target_price ₽/шт.
"""
from alembic import op
import sqlalchemy as sa

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_table("sell_recommendations")
    op.drop_table("user_inventory")

    op.create_table(
        "buy_alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "watchlist_id",
            sa.Integer(),
            sa.ForeignKey("user_watchlist.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("target_price", sa.BigInteger(), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_buy_alerts_user_id", "buy_alerts", ["user_id"])


def downgrade():
    op.drop_index("ix_buy_alerts_user_id", table_name="buy_alerts")
    op.drop_table("buy_alerts")

    op.create_table(
        "user_inventory",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), server_default="EU"),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("avg_buy_price_per_unit", sa.BigInteger(), nullable=True),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column("last_updated", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_inventory_user_item",
        "user_inventory",
        ["user_id", "item_id", "region"],
        unique=True,
    )

    op.create_table(
        "sell_recommendations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "inventory_id",
            sa.Integer(),
            sa.ForeignKey("user_inventory.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("recommended_price_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("recommended_batch_size", sa.Integer(), nullable=True),
        sa.Column("expected_wait_hours", sa.Numeric(8, 2), nullable=True),
        sa.Column("expected_revenue", sa.BigInteger(), nullable=True),
        sa.Column("expected_profit", sa.BigInteger(), nullable=True),
        sa.Column("expected_profit_percent", sa.Numeric(5, 2), nullable=True),
        sa.Column("sell_now_vs_wait_benefit", sa.Numeric(5, 2), nullable=True),
        sa.Column("confidence_score", sa.Numeric(3, 2), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column("is_viewed", sa.Boolean(), server_default="false"),
    )
