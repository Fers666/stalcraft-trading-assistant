"""drop global_item_scan and user_feed_exclusion tables

Revision ID: 0021
Revises: 0020
Create Date: 2026-06-07

"Лента возможностей" признана неудачным решением (метрика "купи дешевле
средней" вводит в заблуждение — средняя цена ВЫСТАВЛЕННЫХ лотов ≠ цена
реальной продажи) и убрана из проекта вместе со всем конвейером данных
(сканер, /feed эндпоинты, фронтенд). Таблицы больше не нужны.
"""
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_table("user_feed_exclusion")
    op.drop_table("global_item_scan")


def downgrade():
    raise NotImplementedError(
        "Откат недоступен — фича удалена безвозвратно, история сканов не сохранена"
    )
