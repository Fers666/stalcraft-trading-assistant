"""sale_survival: кривая дожития лота (P1-4 фаза B)

Revision ID: 0043
Revises: 0042
Create Date: 2026-08-17

Таблица заменяет выдуманные сроки продажи в make_sell_options измеренными:
множители 0.4/1.0/2.5 и лестницу 2/8/24...72/168/336 часов (pricing.py) никто
никогда не проверял. Источник — lot_observations, единственный в системе, кто
видит НЕПРОДАННЫЕ лоты (docs/tasks/sale-survival-curve.md).

Таблица маленькая (~60 строк) и пересчитывается целиком раз в сутки, поэтому
ни партиционирования, ни инкрементальности здесь нет и не нужно.

Пустая таблица — рабочее состояние: первый пересчёт происходит через сутки
после деплоя, до него все потребители обязаны деградировать к прежнему
поведению. Поэтому бэкфилла в миграции нет.
"""
from alembic import op
import sqlalchemy as sa

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "sale_survival",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("feature", sa.String(8), nullable=False),
        sa.Column("bucket", sa.String(16), nullable=False),
        sa.Column("horizon_h", sa.SmallInteger(), nullable=False),
        sa.Column("n_at_risk", sa.Integer(), nullable=False),
        sa.Column("n_sold", sa.Integer(), nullable=False),
        sa.Column("p_sold_lo", sa.Numeric(5, 2), nullable=False),
        sa.Column("p_sold_hi", sa.Numeric(5, 2), nullable=False),
        sa.Column("pct_withdrawn", sa.Numeric(5, 2), nullable=False),
        sa.Column("pct_sold_ever", sa.Numeric(5, 2)),
        sa.Column("median_hours", sa.Numeric(6, 2)),
        sa.Column("computed_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "uq_sale_survival", "sale_survival",
        ["feature", "bucket", "horizon_h"], unique=True,
    )

    # Материализуем результат кривой в ленте: строка feed_lots уже несёт
    # est_sell_hours, и вероятность продажи обязана лежать рядом — иначе UI
    # печатает срок без единого указания, чем этот срок обеспечен.
    # NULL допустим и является рабочим состоянием (страта не набрана).
    op.add_column("feed_lots", sa.Column("p_sold_6h", sa.Numeric(5, 2)))
    op.add_column("feed_lots", sa.Column("pct_sold_ever", sa.Numeric(5, 2)))


def downgrade():
    op.drop_column("feed_lots", "pct_sold_ever")
    op.drop_column("feed_lots", "p_sold_6h")
    # Безопасно: таблица — производная от lot_observations, пересчитывается
    # одной задачей за секунды. Ничего невосстановимого здесь не лежит.
    op.drop_index("uq_sale_survival", table_name="sale_survival")
    op.drop_table("sale_survival")
