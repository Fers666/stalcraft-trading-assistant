"""add sell_options to market_statistics

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "market_statistics",
        sa.Column("sell_options", postgresql.JSONB(), nullable=True),
    )


def downgrade():
    op.drop_column("market_statistics", "sell_options")
