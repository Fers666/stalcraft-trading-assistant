"""add tier fields to users

Revision ID: 0026
Revises: 0025
Create Date: 2026-06-28

Вводит систему тарифов (Phase 0 роадмапа): tier/tier_expires_at для лимитов
watchlist/доступа к аукциону/Telegram-уведомлений/окон статистики,
last_seen для онлайн-индикатора в админке, has_market_radar_addon — поле под
будущую фазу (аддон "Радар рынка", без логики в этой миграции).

Существующие is_admin=True пользователи получают tier='advanced_max' —
косметика для отображения в админке (админы обходят лимиты по is_admin
независимо от tier).
"""
from alembic import op
import sqlalchemy as sa

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("tier", sa.String(20), nullable=False, server_default="base"))
    op.add_column("users", sa.Column("tier_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("has_market_radar_addon", sa.Boolean(), nullable=False, server_default="false"))
    op.execute("UPDATE users SET tier = 'advanced_max' WHERE is_admin = true")


def downgrade():
    op.drop_column("users", "has_market_radar_addon")
    op.drop_column("users", "last_seen")
    op.drop_column("users", "tier_expires_at")
    op.drop_column("users", "tier")
