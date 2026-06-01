"""add sell/buy hours breakdown by day of week

Revision ID: 0010
Revises: 0009
Create Date: 2026-06-01

sell_hours_by_day — лучший час продажи для каждого дня недели
buy_hours_by_day  — лучший час покупки для каждого дня недели

Формат: {"Monday": 20, "Tuesday": 19, ...}
Используется для фильтра "Сегодня" в карточке Избранного.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("market_statistics",
        sa.Column("sell_hours_by_day", postgresql.JSONB(), nullable=True))
    op.add_column("market_statistics",
        sa.Column("buy_hours_by_day", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("market_statistics", "buy_hours_by_day")
    op.drop_column("market_statistics", "sell_hours_by_day")
