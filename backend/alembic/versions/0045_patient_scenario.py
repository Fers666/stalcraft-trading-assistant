"""feed_lots: сценарий «подождать и продать дороже» вместо ₽/час

Revision ID: 0045
Revises: 0044
Create Date: 2026-08-17

Лента показывала прибыль ТОЛЬКО по нижней цене (тир fast) и прятала апсайд
целиком. Замер на проде: продажа по верхней цене (premium, ref * 1.06) даёт
в среднем **+451 %** прибыли, у 139 строк из 188 — больше чем вдвое, у лидера
539 000 -> 3 161 000. Причина арифметическая: прибыль это разность
«цена продажи минус закупка», поэтому при тонкой марже +12.8 % к цене
умножают прибыль в разы. Платится за это ~17 п.п. вероятности продажи.

Пользователю нужны две вещи (его формулировка): сколько лот будет продаваться
и какую прибыль он получит, в том числе если готов подождать и продать дороже.
Отсюда три колонки сценария ожидания и отказ от ₽/час.

ev_per_hour удаляется. Она прожила один деплой и была неверна по единице
измерения: «417 829 ₽/час» подразумевает поток одинаковых лотов, которого нет —
заработок случится ОДИН раз. Делитель на часы к тому же почти не влиял на
порядок (ранговая корреляция с версией без него 0.967), а срок принимает всего
5 различных значений — по числу страт позиции в стакане.

Взамен ev_profit — ожидаемая прибыль В РУБЛЯХ, максимум по двум сценариям:
рациональный выбор стратегии для каждого лота.
"""
from alembic import op
import sqlalchemy as sa

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade():
    # Сценарий «подождать»: цена premium (ref * 1.06), своя позиция в стакане и
    # потому свои срок и вероятность — считаются тем же аппаратом, что и для
    # быстрой цены (variant_ladders + rank_for_price -> страта pos).
    op.add_column("feed_lots", sa.Column("profit_total_slow", sa.BigInteger()))
    op.add_column("feed_lots", sa.Column("est_sell_hours_slow", sa.Numeric(8, 2)))
    op.add_column("feed_lots", sa.Column("p_sold_6h_slow", sa.Numeric(5, 2)))
    # Ожидаемая прибыль в рублях — ключ сортировки по умолчанию.
    op.add_column("feed_lots", sa.Column("ev_profit", sa.BigInteger()))

    op.drop_column("feed_lots", "ev_per_hour")


def downgrade():
    op.add_column("feed_lots", sa.Column("ev_per_hour", sa.Numeric(14, 2)))
    op.drop_column("feed_lots", "ev_profit")
    op.drop_column("feed_lots", "p_sold_6h_slow")
    op.drop_column("feed_lots", "est_sell_hours_slow")
    op.drop_column("feed_lots", "profit_total_slow")
