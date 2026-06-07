"""add quality/enchant columns to global_item_scan

Revision ID: 0020
Revises: 0019
Create Date: 2026-06-07

Лоты разной заточки/качества — разные товары с разной ценой. Сканер теперь
пишет отдельную строку на каждый встреченный вариант (qlt, ptn) предмета,
вместо одной усреднённой по базовому варианту.
"""
from alembic import op
import sqlalchemy as sa

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("global_item_scan", sa.Column("quality", sa.Integer(), nullable=True))
    op.add_column("global_item_scan", sa.Column("enchant", sa.Integer(), nullable=True))
    op.create_index(
        "ix_global_scan_variant",
        "global_item_scan",
        ["item_id", "region", "quality", "enchant", "scanned_at"],
    )


def downgrade():
    op.drop_index("ix_global_scan_variant", table_name="global_item_scan")
    op.drop_column("global_item_scan", "enchant")
    op.drop_column("global_item_scan", "quality")
