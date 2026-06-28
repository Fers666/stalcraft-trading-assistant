"""add 48h window to market_statistics

Revision ID: 0027
Revises: 0026
Create Date: 2026-06-28

Добавляет 48-часовое окно статистики (между 24ч и 7д) — нужно тарифам
advanced/advanced_plus/advanced_max (см. backend/app/core/tiers.py).
Бэкафилл не требуется отдельным скриптом: sales_history хранит 120 дней,
обычный часовой пересчёт (calculate_all_market_stats) заполнит поля для
всех активных watchlist-пар.
"""
from alembic import op
import sqlalchemy as sa

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("market_statistics", sa.Column("avg_price_48h", sa.Numeric(12, 2), nullable=True))
    op.add_column("market_statistics", sa.Column("min_price_48h", sa.BigInteger(), nullable=True))
    op.add_column("market_statistics", sa.Column("max_price_48h", sa.BigInteger(), nullable=True))
    op.add_column("market_statistics", sa.Column("sales_volume_48h", sa.Integer(), nullable=True))


def downgrade():
    op.drop_column("market_statistics", "sales_volume_48h")
    op.drop_column("market_statistics", "max_price_48h")
    op.drop_column("market_statistics", "min_price_48h")
    op.drop_column("market_statistics", "avg_price_48h")
