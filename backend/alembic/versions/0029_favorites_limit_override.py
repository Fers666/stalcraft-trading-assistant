"""add favorites_limit_override to users

Revision ID: 0029
Revises: 0028
Create Date: 2026-06-28

Ручной override лимита избранного (watchlist) вне тарифа. NULL = нет
override, лимит = тариф пользователя без изменений. Не-NULL значение
заменяет лимит тарифа целиком (не складывается с ним) — см.
docs/tasks/favorites-limit-override.md и effective_watchlist_limit()
в backend/app/core/tiers.py.
"""
from alembic import op
import sqlalchemy as sa

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("favorites_limit_override", sa.Integer(), nullable=True))


def downgrade():
    op.drop_column("users", "favorites_limit_override")
