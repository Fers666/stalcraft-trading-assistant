"""add price_volatility_30d to market_statistics

Revision ID: 0014
Revises: 0013
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "market_statistics",
        sa.Column("price_volatility_30d", sa.Numeric(5, 2), nullable=True),
    )


def downgrade():
    op.drop_column("market_statistics", "price_volatility_30d")
