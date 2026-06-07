"""add user_feed_exclusion table

Revision ID: 0019
Revises: 0018
Create Date: 2026-06-07

Таблица для скрытых пользователем предметов из "Ленты возможностей" —
позволяет исключить неинтересный товар из выборки и вернуть его обратно.
"""
from alembic import op
import sqlalchemy as sa

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_feed_exclusion",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(length=50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(length=10), nullable=False, server_default="RU"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "item_id", "region", name="uq_feed_exclusion_user_item_region"),
    )
    op.create_index(
        "ix_feed_exclusion_user_region",
        "user_feed_exclusion",
        ["user_id", "region"],
    )


def downgrade():
    op.drop_index("ix_feed_exclusion_user_region", table_name="user_feed_exclusion")
    op.drop_table("user_feed_exclusion")
