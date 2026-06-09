"""add feed_watchlist

Revision ID: c7bfc1ffa62c
Revises: 0021
Create Date: 2026-06-09 20:17:56.288208

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7bfc1ffa62c'
down_revision: Union[str, None] = '0021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('feed_watchlist',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('item_id', sa.String(length=50), nullable=False),
    sa.Column('region', sa.String(length=10), nullable=True),
    sa.Column('quality_filter', sa.Integer(), nullable=True),
    sa.Column('enchant_filter', sa.Integer(), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
    sa.Column('last_collected_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('sales_7d', sa.Integer(), nullable=True),
    sa.Column('sales_24h', sa.Integer(), nullable=True),
    sa.Column('profitable_lots_count', sa.Integer(), nullable=True),
    sa.Column('avg_profit', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['item_id'], ['master_items.item_id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_feed_watchlist_collect', 'feed_watchlist', ['is_active', 'last_collected_at'], unique=False)
    op.create_index('uq_feed_watchlist', 'feed_watchlist', ['user_id', 'item_id', 'region', 'quality_filter', 'enchant_filter'], unique=True)


def downgrade() -> None:
    op.drop_index('uq_feed_watchlist', table_name='feed_watchlist')
    op.drop_index('ix_feed_watchlist_collect', table_name='feed_watchlist')
    op.drop_table('feed_watchlist')
