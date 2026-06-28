"""create registration_settings table

Revision ID: 0028
Revises: 0027
Create Date: 2026-06-28

Синглтон-таблица настроек авто-подтверждения регистрации (id=1, единственная
строка). По умолчанию авто-подтверждение выключено — текущее поведение
(ручной approve_user) не меняется до явной настройки админом.
"""
from alembic import op
import sqlalchemy as sa

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "registration_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("auto_approve_enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("default_tier", sa.String(20), nullable=False, server_default="base"),
        sa.Column("default_tier_duration_days", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )
    op.execute("INSERT INTO registration_settings (id, auto_approve_enabled, default_tier) VALUES (1, false, 'base')")


def downgrade():
    op.drop_table("registration_settings")
