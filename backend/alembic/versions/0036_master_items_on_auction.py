"""master_items on_auction status

Revision ID: 0036
Revises: 0035
Create Date: 2026-07-24

Реальная торгуемость предмета по данным Stalcraft API — источник истины вместо
эвристики по bind_state. Заполняется разовой задачей audit_auction_status
(history_total>0 OR lots_total>0 → TRUE; оба 0 → FALSE; NULL = ещё не проверено).
Отладочные поля history_total/lots_total хранят последние замеры total из
/history и /lots. Индекс ix_master_on_auction — под фильтр каталога в items.py.
"""
from alembic import op
import sqlalchemy as sa

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("master_items", sa.Column("on_auction", sa.Boolean(), nullable=True))
    op.add_column("master_items", sa.Column("auction_checked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("master_items", sa.Column("history_total", sa.Integer(), nullable=True))
    op.add_column("master_items", sa.Column("lots_total", sa.Integer(), nullable=True))
    op.create_index("ix_master_on_auction", "master_items", ["on_auction"])


def downgrade():
    op.drop_index("ix_master_on_auction", table_name="master_items")
    op.drop_column("master_items", "lots_total")
    op.drop_column("master_items", "history_total")
    op.drop_column("master_items", "auction_checked_at")
    op.drop_column("master_items", "on_auction")
