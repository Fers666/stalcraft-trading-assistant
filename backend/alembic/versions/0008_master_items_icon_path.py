"""add icon_path to master_items

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-01

Иконки берутся из listing.json репозитория EXBO-Studio/stalcraft-database.
Путь вида "/icons/medicine/9mmq.png".
Полный URL: https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru{icon_path}
"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("master_items", sa.Column("icon_path", sa.String(200), nullable=True))


def downgrade():
    op.drop_column("master_items", "icon_path")
