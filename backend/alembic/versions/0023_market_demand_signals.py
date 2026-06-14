"""add demand_signals to market_statistics

Revision ID: 0023
Revises: 0022
Create Date: 2026-06-14

Информационный сигнал спроса: доля объёма продаж в крупных пачках
(amount >= 10) за последние 24ч vs базовая доля за предыдущие ~29 дней.
Не влияет на расчёт sell_options/профита — только для отображения.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("market_statistics", sa.Column("demand_signals", JSONB, nullable=True))


def downgrade():
    op.drop_column("market_statistics", "demand_signals")
