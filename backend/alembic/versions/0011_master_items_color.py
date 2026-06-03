"""add color column to master_items

Revision ID: 0011
Revises: 0010
Create Date: 2026-06-01

color — строковый код цвета из репозитория stalcraft-database:
  gray/grey → Обычный
  green     → Необычный
  blue      → Особый
  violet    → Ветеран
  yellow    → Мастер
  red       → Уникальный
"""
from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("master_items",
        sa.Column("color", sa.String(20), nullable=True))


def downgrade():
    op.drop_column("master_items", "color")
