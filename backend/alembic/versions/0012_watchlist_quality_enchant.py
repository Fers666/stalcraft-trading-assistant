"""add quality_filter and enchant_filter to user_watchlist

Revision ID: 0012
Revises: 0011
Create Date: 2026-06-01

quality_filter — qlt артефакта (0-5) или NULL (показывать все качества)
enchant_filter — уровень заточки (1-15) или NULL (показывать все уровни)

Уникальный составной индекс по (user_id, item_id, region) удаляется —
дубли теперь проверяются на уровне приложения с учётом фильтров.
"""
from alembic import op
import sqlalchemy as sa

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("user_watchlist", sa.Column("quality_filter", sa.Integer(), nullable=True))
    op.add_column("user_watchlist", sa.Column("enchant_filter", sa.Integer(), nullable=True))
    op.drop_index("uq_watchlist_user_item_region", table_name="user_watchlist")


def downgrade():
    op.drop_column("user_watchlist", "quality_filter")
    op.drop_column("user_watchlist", "enchant_filter")
    op.create_index(
        "uq_watchlist_user_item_region",
        "user_watchlist",
        ["user_id", "item_id", "region"],
        unique=True,
    )
