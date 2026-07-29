"""market_statistics: median_price_24h + reference_price

Revision ID: 0037
Revises: 0036
Create Date: 2026-07-27

Опорная цена для sell_options — взвешенная по свежести медиана продаж за 7д
вместо плоской median_price_7d (та на трендовом рынке отражает цену
~3.5-дневной давности и обещает прибыль, которой уже нет).

median_price_24h уже вычислялся в market_stats.safe_stats и просто
выбрасывался — теперь сохраняется как краткосрочный ориентир и база тренда.

Бэкфилл не нужен: часовой calculate_market_stats заполнит обе колонки при
первом же пересчёте, до этого потребители падают на median_price_7d.
"""
from alembic import op
import sqlalchemy as sa

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("market_statistics", sa.Column("median_price_24h", sa.Numeric(12, 2), nullable=True))
    op.add_column("market_statistics", sa.Column("reference_price", sa.BigInteger(), nullable=True))


def downgrade():
    op.drop_column("market_statistics", "reference_price")
    op.drop_column("market_statistics", "median_price_24h")
