"""sale_survival: измерение «класс предмета» (artefact / gear)

Revision ID: 0046
Revises: 0045
Create Date: 2026-08-17

Лента расширяется с артефактов на снаряжение высоких рангов, части предметов,
премиум и сезонные пропуска (docs/tasks/feed-gear-expansion.md §3.3).

Кривая дожития у снаряжения своя: качество является свойством ПРЕДМЕТА, а не
лота, высокие тиры чаще получают апгрейдом, чем покупают, и заимствовать
артефактную кривую снаряжению нельзя — это было бы измеренным числом с чужого
рынка, то есть хуже отсутствия числа.

Классов ровно два. Дробить мельче (по категориям) нельзя: страты не наберут
MIN_STRATUM_N = 200 наблюдений и не будут публиковаться вовсе.

Бэкфилла данных здесь нет и не нужно: существующие строки посчитаны по
наблюдениям за артефактами и получают class = 'artefact'. Gear-страты появятся
сами по мере накопления наблюдений — пока их нет, потребитель деградирует так
же, как артефакты до первого пересчёта (get() возвращает None).
"""
from alembic import op
import sqlalchemy as sa

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade():
    # server_default нужен ровно на время заполнения существующих строк: все
    # они посчитаны по артефактам. Дальше умолчание снимается — строку без
    # явного класса пишет только ошибка, и падать она обязана громко.
    op.add_column(
        "sale_survival",
        sa.Column("class", sa.String(8), nullable=False, server_default="artefact"),
    )
    op.alter_column("sale_survival", "class", server_default=None)

    # Ключ страты теперь включает класс: одна и та же страта позиции у
    # артефактов и у снаряжения — две разные строки.
    op.drop_index("uq_sale_survival", table_name="sale_survival")
    op.create_index(
        "uq_sale_survival", "sale_survival",
        ["class", "feature", "bucket", "horizon_h"], unique=True,
    )


def downgrade():
    # Строки gear удаляются: без измерения класса они неотличимы от
    # артефактных и сделали бы уникальный ключ противоречивым.
    op.execute("DELETE FROM sale_survival WHERE class <> 'artefact'")
    op.drop_index("uq_sale_survival", table_name="sale_survival")
    op.create_index(
        "uq_sale_survival", "sale_survival",
        ["feature", "bucket", "horizon_h"], unique=True,
    )
    op.drop_column("sale_survival", "class")
