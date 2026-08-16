"""market_statistics: reference_weight

Revision ID: 0039
Revises: 0038
Create Date: 2026-08-16

Шаг 1 ревизии алгоритмов выгодности (docs/tasks/ref-quality-floor.md, P0-2):
уверенность опоры и пол по данным считаются по ЭФФЕКТИВНОМУ числу сделок —
сумме весов 0.5 ** (age/48), а не по сырому count за 7д.

Карточка предмета без фильтров берёт опору из этой таблицы (живой пересчёт на
каждый поллинг в 30с потребовал бы читать всю историю за 7д), поэтому вес надо
хранить рядом с ценой — вывести его из reference_price / sales_volume_7d нельзя.

Бэкфилл не нужен: часовой calculate_market_stats заполнит колонку при первом же
пересчёте. До этого reference_weight = NULL, и карточка честно показывает
уверенность "low" вместо завышенной по сырому count.
"""
from alembic import op
import sqlalchemy as sa

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "market_statistics",
        sa.Column("reference_weight", sa.Numeric(10, 2), nullable=True),
    )


def downgrade():
    op.drop_column("market_statistics", "reference_weight")
