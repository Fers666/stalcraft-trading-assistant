"""collected_data.user_id nullable for global collection

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-31

Смысл: переход к глобальному сбору данных.
user_id = NULL означает глобальный снэпшот (один на пару item_id/region).
user_id = <id> означает ручной refresh конкретного пользователя.
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("collected_data", "user_id", nullable=True)


def downgrade():
    # Сначала удалим глобальные записи чтобы не нарушить NOT NULL
    op.execute("DELETE FROM collected_data WHERE user_id IS NULL")
    op.alter_column("collected_data", "user_id", nullable=False)
