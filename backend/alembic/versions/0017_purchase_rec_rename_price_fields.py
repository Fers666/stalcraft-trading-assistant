"""rename expected_sell_price_per_unit → expected_listing/net_revenue in purchase_recommendations

Revision ID: 0017
Revises: 0016
Create Date: 2026-06-06

Разделяем одно поле expected_sell_price_per_unit на два:
  - expected_listing_price_per_unit  (за сколько выставить лот, до комиссии)
  - expected_net_revenue_per_unit    (получишь на руки = listing * 0.95)
Это устраняет семантическую путаницу при формировании уведомлений.
"""
from alembic import op
import sqlalchemy as sa

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    # Переименовываем старое поле → listing price
    op.alter_column(
        "purchase_recommendations",
        "expected_sell_price_per_unit",
        new_column_name="expected_listing_price_per_unit",
    )
    # Добавляем новое поле net_revenue; заполняем из listing * 0.95 для существующих строк
    op.add_column(
        "purchase_recommendations",
        sa.Column("expected_net_revenue_per_unit", sa.BigInteger(), nullable=True),
    )
    op.execute(
        "UPDATE purchase_recommendations "
        "SET expected_net_revenue_per_unit = (expected_listing_price_per_unit * 0.95)::bigint"
    )
    op.alter_column(
        "purchase_recommendations",
        "expected_net_revenue_per_unit",
        nullable=False,
    )


def downgrade():
    op.drop_column("purchase_recommendations", "expected_net_revenue_per_unit")
    op.alter_column(
        "purchase_recommendations",
        "expected_listing_price_per_unit",
        new_column_name="expected_sell_price_per_unit",
    )
