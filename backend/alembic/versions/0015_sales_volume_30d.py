"""add sales_volume_30d to market_statistics

Revision ID: 0015
Revises: 0014
Create Date: 2026-06-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "market_statistics",
        sa.Column("sales_volume_30d", sa.Integer(), nullable=True),
    )


def downgrade():
    op.drop_column("market_statistics", "sales_volume_30d")
