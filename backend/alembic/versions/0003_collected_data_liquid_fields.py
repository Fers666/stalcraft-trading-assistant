"""add liquid lot tracking fields to collected_data

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("collected_data", sa.Column("liquid_lots_count", sa.Integer(), nullable=True))
    op.add_column("collected_data", sa.Column("expiring_lots_count", sa.Integer(), nullable=True))
    op.add_column("collected_data", sa.Column("detected_buyouts_count", sa.Integer(), nullable=True))
    op.add_column("collected_data", sa.Column("best_liquid_price_per_unit", sa.BigInteger(), nullable=True))


def downgrade():
    op.drop_column("collected_data", "best_liquid_price_per_unit")
    op.drop_column("collected_data", "detected_buyouts_count")
    op.drop_column("collected_data", "expiring_lots_count")
    op.drop_column("collected_data", "liquid_lots_count")
