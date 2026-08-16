"""lot_observations: наблюдения за жизнью лотов

Revision ID: 0040
Revises: 0039
Create Date: 2026-08-16

Шаг 3 ревизии алгоритмов выгодности (docs/tasks/lot-observations.md, P1-4,
фаза A — только сбор). Сырьё для кривой дожития: одна строка = один лот, от
первого наблюдения до исхода (sold / expired / withdrawn).

Отдельная таблица нужна потому, что накопленных данных для survival-анализа в
системе нет и получить их неоткуда: collected_data.raw_lots обрезаны до 200
самых дешёвых лотов (вытеснение неотличимо от продажи), строки feed_lots
удаляются ровно в момент исчезновения лота — то есть в момент события, которое
и надо зафиксировать, а восстановление lot_start идёт от продаж и по
построению видит только проданное.

Бэкфилла нет и быть не может: наблюдение — это событие, его нельзя досчитать
задним числом. Таблица наполняется свипом ленты с первого же цикла.
"""
from alembic import op
import sqlalchemy as sa

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "lot_observations",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("item_id", sa.String(50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("qlt", sa.SmallInteger(), nullable=False),
        sa.Column("ptn", sa.SmallInteger(), nullable=False),
        # Идентичность лота — та же, что у feed_lots (feed_collector.lot_identity_key):
        # startTime|qlt|ptn|buyoutPrice|amount.
        sa.Column("lot_key", sa.String(128), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("buyout_price", sa.BigInteger(), nullable=False),
        sa.Column("buyout_per_unit", sa.BigInteger(), nullable=False),
        # Опора варианта НА МОМЕНТ ПЕРВОГО НАБЛЮДЕНИЯ: artifact_variant_stats
        # перезаписывается каждый час, задним числом её не восстановить, а без
        # неё фаза B не свяжет цену лота с вероятностью продажи. NULL = у
        # варианта опоры не было (нет сделок либо ниже пола по данным, P0-2).
        sa.Column("ref_price_at_seen", sa.BigInteger(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        # NULL пока лот жив; sold / expired / withdrawn после резолвера.
        # Три значения, а не флаг: expired — полное наблюдение «не продался»,
        # withdrawn — цензурированное (пропал раньше end_time).
        sa.Column("outcome", sa.String(12), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_lot_obs_lot", "lot_observations", ["item_id", "region", "lot_key"], unique=True,
    )
    # Выборка резолвера: outcome IS NULL AND last_seen_at < now - 2ч
    op.create_index("ix_lot_obs_pending", "lot_observations", ["outcome", "last_seen_at"])
    # Фаза B: кривая строится по варианту
    op.create_index(
        "ix_lot_obs_variant", "lot_observations", ["item_id", "region", "qlt", "ptn"],
    )


def downgrade():
    # Данные восстановлению не подлежат: наблюдение — событие, а не расчёт.
    op.drop_table("lot_observations")
