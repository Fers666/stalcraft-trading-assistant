"""add index on sales_history (item_id, region, sale_time)

Revision ID: 0016
Revises: 0015
Create Date: 2026-06-06
"""
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_sales_item_region_time",
        "sales_history",
        ["item_id", "region", "sale_time"],
    )


def downgrade():
    op.drop_index("ix_sales_item_region_time", table_name="sales_history")
