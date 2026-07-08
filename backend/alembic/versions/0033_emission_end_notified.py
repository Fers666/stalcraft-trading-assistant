"""add emission_events.end_notified

Revision ID: 0033
Revises: 0032
Create Date: 2026-07-08

Рассылка Telegram-уведомлений о выбросе перенесена из Celery worker в
telegram_bot: notified = «уведомление о старте отправлено», end_notified =
«уведомление о завершении отправлено». Флаги ставит бот только после
успешной отправки (дедупликация через БД).

Backfill: все существующие строки помечаются end_notified = TRUE, чтобы
бот после деплоя не разослал уведомления по исторических событиям.
"""
import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "emission_events",
        sa.Column("end_notified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("UPDATE emission_events SET end_notified = TRUE")


def downgrade():
    op.drop_column("emission_events", "end_notified")
