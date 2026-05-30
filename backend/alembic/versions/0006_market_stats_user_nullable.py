"""market_statistics.user_id nullable for global stats

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-31

Смысл: глобальная статистика (user_id=NULL) читается всеми пользователями.
Персонализация применяется на уровне API, а не хранилища.
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    # Уникальный индекс нужно пересоздать — он включает user_id
    op.drop_index("uq_market_stats", table_name="market_statistics")
    op.alter_column("market_statistics", "user_id", nullable=True)
    op.create_index(
        "uq_market_stats",
        "market_statistics",
        ["item_id", "region"],
        unique=True,
    )


def downgrade():
    op.drop_index("uq_market_stats", table_name="market_statistics")
    op.execute("DELETE FROM market_statistics WHERE user_id IS NULL")
    op.alter_column("market_statistics", "user_id", nullable=False)
    op.create_index(
        "uq_market_stats",
        "market_statistics",
        ["user_id", "item_id", "region"],
        unique=True,
    )
