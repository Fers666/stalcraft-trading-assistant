"""lot_observations: расход сделок и состояние стакана при первом наблюдении

Revision ID: 0041
Revises: 0040
Create Date: 2026-08-16

Две правки фазы A (docs/tasks/sale-time-prediction-research.md).

1. matched_sale_id — какая именно сделка закрыла наблюдение. Резолвер искал
   ЛЮБУЮ подходящую сделку, поэтому одна продажа помечала sold все
   неразличимые наблюдения (item_id/qlt/ptn/buyout_price/amount совпадают).
   Замер на проде: 47.5% строк sold (1104 из 2326) лежали в таких группах,
   худшая группа — 42 наблюдения. Значит доля sold была завышенной верхней
   границей, а expired/withdrawn — заниженными. Уникальный частичный индекс
   делает правило «одна сделка = максимум одно наблюдение» инвариантом схемы,
   а не соглашением кода.

2. queue_rank / cheaper_units / variant_live_lots — позиция лота в очереди по
   цене на момент ПЕРВОГО наблюдения. Во внешней практике позиция в стакане и
   цена относительно опоры — главные предикторы срока продажи. Задним числом
   позицию не восстановить (нужен весь срез варианта на тот момент), а сборщик
   держит стакан в памяти в том же проходе — там это считается бесплатно.

Бэкфилла нет: у старых строк останется NULL. Обе величины — снимок состояния,
досчитать их постфактум нечем.
"""
from alembic import op
import sqlalchemy as sa

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "lot_observations", sa.Column("matched_sale_id", sa.BigInteger(), nullable=True),
    )
    # ON DELETE SET NULL: sales_history живёт 120 дней и чистится в том же
    # delete_old_data РАНЬШЕ наблюдений (30 дней) — ссылка не должна ронять
    # уборку. Исход строки при этом сохраняется, теряется только указатель.
    op.create_foreign_key(
        "fk_lot_obs_matched_sale", "lot_observations", "sales_history",
        ["matched_sale_id"], ["id"], ondelete="SET NULL",
    )
    # Частичный: без предиката индекс покрывал бы все живые и незакрытые
    # строки (там NULL), а конфликтовать они всё равно не могут.
    op.create_index(
        "uq_lot_obs_matched_sale", "lot_observations", ["matched_sale_id"],
        unique=True, postgresql_where=sa.text("matched_sale_id IS NOT NULL"),
    )

    # Состояние стакана ВАРИАНТА (item_id, qlt, ptn), не предмета: агрегат по
    # предмету смешал бы разные по цене товары. NULL = лот на момент
    # наблюдения был неликвиден (< 2 ч до конца) и в очереди не стоял.
    op.add_column("lot_observations", sa.Column("queue_rank", sa.Integer(), nullable=True))
    op.add_column("lot_observations", sa.Column("cheaper_units", sa.Integer(), nullable=True))
    op.add_column("lot_observations", sa.Column("variant_live_lots", sa.Integer(), nullable=True))


def downgrade():
    # drop_column снимает и зависимый индекс, и внешний ключ.
    op.drop_column("lot_observations", "variant_live_lots")
    op.drop_column("lot_observations", "cheaper_units")
    op.drop_column("lot_observations", "queue_rank")
    op.drop_column("lot_observations", "matched_sale_id")
