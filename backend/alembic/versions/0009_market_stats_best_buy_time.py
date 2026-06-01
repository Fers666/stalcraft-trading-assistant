"""add best_buy_hour and best_buy_day to market_statistics

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-01

Лучшее время для покупки товара — когда минимальная цена лотов
на аукционе исторически наименьшая.
Рассчитывается из снэпшотов collected_data (каждые 5 минут).
"""
from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("market_statistics",
        sa.Column("best_buy_hour", sa.Integer(), nullable=True))
    op.add_column("market_statistics",
        sa.Column("best_buy_day", sa.String(10), nullable=True))


def downgrade():
    op.drop_column("market_statistics", "best_buy_day")
    op.drop_column("market_statistics", "best_buy_hour")
