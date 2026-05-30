"""create global_item_scan table

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-31

Лёгкая таблица для скользящего глобального скана предметов вне watchlist.
Хранит только агрегированные метрики — без raw_lots JSON.
Одна запись на пару (item_id, region), перезаписывается при каждом скане.
"""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "global_item_scan",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.String(50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("scanned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lot_count", sa.Integer()),
        sa.Column("liquid_lot_count", sa.Integer()),
        sa.Column("best_price", sa.BigInteger()),
        sa.Column("avg_price", sa.Numeric(12, 2)),
        sa.Column("total_volume", sa.Integer()),
        sa.Column("prev_best_price", sa.BigInteger()),
        sa.Column("price_change_pct", sa.Numeric(5, 2)),
        sa.Column("tradability_score", sa.Numeric(8, 2)),
    )
    op.create_index(
        "uq_global_scan_item_region",
        "global_item_scan",
        ["item_id", "region"],
        unique=True,
    )
    op.create_index("ix_global_scan_score", "global_item_scan", ["tradability_score"])
    op.create_index("ix_global_scan_scanned_at", "global_item_scan", ["scanned_at"])


def downgrade():
    op.drop_table("global_item_scan")
