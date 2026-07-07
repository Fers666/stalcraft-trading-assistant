"""add index on sales_history.collected_at

Revision ID: 0032
Revises: 0031
Create Date: 2026-07-07

Индекс для дифф-пропуска в calculate_market_stats_batch: запрос ищет пары
с продажами, собранными (collected_at) позже последнего расчёта статистики,
в окне последних 26 часов. Без индекса — скан всей 120-дневной таблицы.
"""
from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_sales_collected_at",
        "sales_history",
        ["collected_at"],
    )


def downgrade():
    op.drop_index("ix_sales_collected_at", table_name="sales_history")
