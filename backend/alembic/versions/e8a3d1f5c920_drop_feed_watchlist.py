"""drop feed_watchlist

Revision ID: e8a3d1f5c920
Revises: c7bfc1ffa62c
Create Date: 2026-06-11

"Лента" (feed_watchlist) повторно признана нецелесообразной и убрана из
проекта (бэкенд-эндпоинты /feed/*, celery-коллектор, фронтенд-страница
снова стала заглушкой). Таблица больше не нужна.
"""
from alembic import op


revision = "e8a3d1f5c920"
down_revision = "c7bfc1ffa62c"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index("uq_feed_watchlist", table_name="feed_watchlist")
    op.drop_index("ix_feed_watchlist_collect", table_name="feed_watchlist")
    op.drop_table("feed_watchlist")


def downgrade():
    raise NotImplementedError(
        "Откат недоступен — фича удалена повторно, см. 0021_drop_feed_tables"
    )
