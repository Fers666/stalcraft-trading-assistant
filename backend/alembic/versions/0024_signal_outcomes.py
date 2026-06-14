"""add signal_outcomes table

Revision ID: 0024
Revises: 0023
Create Date: 2026-06-14

Лог предсказаний по выгодным лотам (предсказанная цена/время продажи/профит)
для будущей калибровки констант алгоритма по фактическим результатам продаж.
"""
from alembic import op
import sqlalchemy as sa

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "signal_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.String(50), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("quality_filter", sa.Integer(), nullable=True),
        sa.Column("enchant_filter", sa.Integer(), nullable=True),
        sa.Column("lot_start_time", sa.String(50), nullable=False),
        sa.Column("buyout_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("ref_price", sa.BigInteger(), nullable=False),
        sa.Column("predicted_sell_price", sa.BigInteger(), nullable=False),
        sa.Column("predicted_hours", sa.Numeric(8, 2), nullable=True),
        sa.Column("predicted_profit_pct", sa.Numeric(6, 2), nullable=True),
        sa.Column("trend", sa.String(10), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("realized_price", sa.BigInteger(), nullable=True),
        sa.Column("realized_hours", sa.Numeric(8, 2), nullable=True),
        sa.Column("outcome", sa.String(20), nullable=True),
    )
    op.create_index(
        "uq_signal_outcome", "signal_outcomes",
        ["item_id", "region", "lot_start_time"], unique=True,
    )
    op.create_index(
        "ix_signal_outcome_pending", "signal_outcomes", ["evaluated_at"],
    )


def downgrade():
    op.drop_index("ix_signal_outcome_pending", table_name="signal_outcomes")
    op.drop_index("uq_signal_outcome", table_name="signal_outcomes")
    op.drop_table("signal_outcomes")
