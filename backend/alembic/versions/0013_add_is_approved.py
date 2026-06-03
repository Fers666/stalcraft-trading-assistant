"""add is_approved to users

Revision ID: 0013
Revises: 0012
Create Date: 2026-06-03

Существующие пользователи получают is_approved=True (не теряют доступ).
Новые регистрации создаются с is_approved=False — требуют подтверждения админа.
"""
from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("is_approved", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade():
    op.drop_column("users", "is_approved")
