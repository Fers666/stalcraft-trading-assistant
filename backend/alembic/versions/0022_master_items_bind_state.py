"""add bind_state to master_items

Revision ID: 0022
Revises: e8a3d1f5c920
Create Date: 2026-06-14

status.state из listing.json (EXBO-Studio/stalcraft-database) описывает
привязку предмета. PERSONAL_ON_GET и PERSONAL_DROP_ON_GET означают, что
предмет привязывается в момент получения и никогда не появляется на
аукционе (подтверждено: history_total=0 и lots_total=0 для всех таких
предметов через реальный Stalcraft API).
"""
from alembic import op
import sqlalchemy as sa

revision = "0022"
down_revision = "e8a3d1f5c920"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("master_items", sa.Column("bind_state", sa.String(30), nullable=True))


def downgrade():
    op.drop_column("master_items", "bind_state")
