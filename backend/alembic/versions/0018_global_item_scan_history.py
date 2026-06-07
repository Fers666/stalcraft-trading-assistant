"""global_item_scan: switch from upsert-snapshot to history log

Revision ID: 0018
Revises: 0017
Create Date: 2026-06-07

Раньше: одна запись на пару (item_id, region), перезаписывается при скане.
Теперь: история — строка на каждый скан, нужна для агрегации "топ
возможностей за 24ч" (просадка текущей цены от средней за период).

Убираем уникальный индекс (item_id, region), добавляем составной
(item_id, region, scanned_at) для быстрой выборки окна за 24ч.
"""
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index("uq_global_scan_item_region", table_name="global_item_scan")
    op.create_index(
        "ix_global_scan_item_region_time",
        "global_item_scan",
        ["item_id", "region", "scanned_at"],
    )


def downgrade():
    op.drop_index("ix_global_scan_item_region_time", table_name="global_item_scan")
    op.create_index(
        "uq_global_scan_item_region",
        "global_item_scan",
        ["item_id", "region"],
        unique=True,
    )
