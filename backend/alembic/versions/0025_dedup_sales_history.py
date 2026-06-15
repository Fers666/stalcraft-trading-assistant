"""dedup sales_history and add unique index

Revision ID: 0025
Revises: 0024
Create Date: 2026-06-15

_collect_history_for_item иногда вставлял одну и ту же продажу несколько раз
за один запуск (API /history в редких случаях возвращал её повторно в одном
ответе, а проверка на дубликаты сравнивала только с уже сохранёнными в БД
записями, не с теми, что добавляются в этом же проходе). Это раздувало
sales_volume_24h/7d/30d и смещало avg/median price.

Чистим существующие дубликаты (оставляем запись с заполненным additional_info,
при равенстве — с наименьшим id) и добавляем уникальный индекс
(item_id, region, sale_time, total_price, amount) как защиту на уровне БД —
INSERT теперь идёт через ON CONFLICT DO NOTHING.
"""
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        DELETE FROM sales_history
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY item_id, region, sale_time, total_price, amount
                           ORDER BY (additional_info ? 'qlt') DESC, id ASC
                       ) AS rn
                FROM sales_history
            ) ranked
            WHERE rn > 1
        )
    """)
    op.create_index(
        "uq_sales_history_sale",
        "sales_history",
        ["item_id", "region", "sale_time", "total_price", "amount"],
        unique=True,
    )


def downgrade():
    op.drop_index("uq_sales_history_sale", table_name="sales_history")
