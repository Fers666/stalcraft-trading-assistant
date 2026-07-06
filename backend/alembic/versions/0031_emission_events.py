"""add emission_events table

Revision ID: 0031
Revises: 0030
Create Date: 2026-07-02

Таблица для хранения событий радиационного выброса.
Одна строка на событие (не на каждый опрос).
"""
from alembic import op
import sqlalchemy as sa

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "emission_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "notified",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.create_index(
        "ix_emission_region_started",
        "emission_events",
        ["region", "started_at"],
    )
    op.create_index(
        "ix_emission_active",
        "emission_events",
        ["region", "ended_at"],
    )


def downgrade():
    op.drop_index("ix_emission_active", table_name="emission_events")
    op.drop_index("ix_emission_region_started", table_name="emission_events")
    op.drop_table("emission_events")
