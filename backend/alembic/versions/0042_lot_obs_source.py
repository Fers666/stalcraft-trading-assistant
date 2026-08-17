"""lot_observations.source: происхождение наблюдения (live / snapshot)

Revision ID: 0042
Revises: 0041
Create Date: 2026-08-16

Подготовка к восстановлению жизни лотов из снапшотов
(docs/tasks/history-lot-reconstruction.md §2.3, скрипт
app/scripts/reconstruct_lot_history.py).

1. source — откуда взято наблюдение. live: записано сборщиком ленты в момент
   события. snapshot: восстановлено задним числом из collected_data.raw_lots.
   Смещения у источников разные (набор предметов, шаг обхода, левое усечение,
   доля цензурированных), и фаза B обязана уметь их разделять — без пометки
   две выборки перемешиваются необратимо.

2. Оба уникальных индекса расширяются на source, и это не косметика:

   uq_lot_obs_lot — в окне пересечения (с 2026-08-16 работают оба источника)
   один и тот же лот виден и живому сборщику, и восстановлению. С прежним
   ключом (item_id, region, lot_key) вставка восстановления попадала бы в
   ON CONFLICT DO UPDATE живой строки и затирала бы её last_seen_at, а сверка
   §5.2 — где живой источник служит эталоном — стала бы невозможна в принципе.

   uq_lot_obs_matched_sale — «одна сделка закрывает максимум одно наблюдение»
   остаётся инвариантом, но ВНУТРИ источника. Глобальная уникальность значила
   бы, что восстановление отбирает сделку у живого наблюдения того же лота:
   живая строка не нашла бы свободной сделки и ушла бы в withdrawn. Два
   источника — две независимые выборки одного рынка, и каждая считает продажи
   своим счётом.

Бэкфилла нет: server_default 'live' помечает все накопленные строки как живые,
что и есть правда — на момент миграции другого источника не существовало.
"""
from alembic import op
import sqlalchemy as sa

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "lot_observations",
        sa.Column("source", sa.String(12), nullable=False, server_default="live"),
    )

    op.drop_index("uq_lot_obs_lot", table_name="lot_observations")
    op.create_index(
        "uq_lot_obs_lot", "lot_observations",
        ["source", "item_id", "region", "lot_key"], unique=True,
    )

    op.drop_index("uq_lot_obs_matched_sale", table_name="lot_observations")
    op.create_index(
        "uq_lot_obs_matched_sale", "lot_observations", ["source", "matched_sale_id"],
        unique=True, postgresql_where=sa.text("matched_sale_id IS NOT NULL"),
    )


def downgrade():
    # Откат возможен, только пока нет восстановленных строк: сузить ключ до
    # (item_id, region, lot_key) при двух источниках — гарантированный конфликт
    # на лотах, которые видели оба. Поэтому сначала уборка snapshot-строк.
    op.execute("DELETE FROM lot_observations WHERE source <> 'live'")

    op.drop_index("uq_lot_obs_matched_sale", table_name="lot_observations")
    op.create_index(
        "uq_lot_obs_matched_sale", "lot_observations", ["matched_sale_id"],
        unique=True, postgresql_where=sa.text("matched_sale_id IS NOT NULL"),
    )

    op.drop_index("uq_lot_obs_lot", table_name="lot_observations")
    op.create_index(
        "uq_lot_obs_lot", "lot_observations", ["item_id", "region", "lot_key"], unique=True,
    )

    op.drop_column("lot_observations", "source")
