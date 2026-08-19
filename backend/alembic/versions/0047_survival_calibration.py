"""survival_calibration: сверка публикуемых вероятностей с фактом

Revision ID: 0047
Revises: 0046
Create Date: 2026-08-19

signal_outcomes задумывался как петля калибровки, но измерял не то: исход
считался по ЛЮБОЙ продаже предмета в полосе +-15 % от предсказанной цены, а не
по судьбе конкретного лота. Отсюда 99.6 % «продано» на 110 688 строках. Читать
эту таблицу к тому же было некому — ни одного потребителя в API и UI.

Здесь измеряется ровно то, что показывается пользователю: p_sold_lo по страте.
Обучающий период и проверочный НЕ ПЕРЕСЕКАЮТСЯ во времени — иначе это подгонка,
а не калибровка.

Повод завести таблицу — замер 2026-08-19. Кривая, обученная на 16-17 августа,
промахнулась на проверке 18-19 августа по ВСЕМ семи стратам в одну сторону, на
4.7-16.4 п.п. Смешивание классов исключено (снаряжение — 4.9 % периода и
продаётся лучше), незрелость окна тоже (перекос там обратный). Артефакты сами
по себе просели с 50.94 % до 39.16 %. Сокращение окна обучения не помогает:
средняя ошибка 10.3 п.п. на двух сутках против 9.7 на одних — то есть это
смена режима, которую прошлое не предсказывает.

Порядок страт при этом устойчив, поэтому ранжирование (ev_profit) не задето, а
публикуемые проценты — задеты. Знать об этом надо непрерывно, а не разово.
"""
from alembic import op
import sqlalchemy as sa

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "survival_calibration",
        sa.Column("id", sa.Integer(), primary_key=True),
        # Что проверяли: та же координата, что у sale_survival
        sa.Column("class", sa.String(8), nullable=False),
        sa.Column("feature", sa.String(8), nullable=False),
        sa.Column("bucket", sa.String(16), nullable=False),
        sa.Column("horizon_h", sa.SmallInteger(), nullable=False),
        # Границы проверочного окна: без них строку нельзя перепроверить
        sa.Column("window_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_to", sa.DateTime(timezone=True), nullable=False),
        sa.Column("n", sa.Integer(), nullable=False),
        # Публиковалось (p_sold_lo страты) против того, что случилось на самом деле
        sa.Column("predicted", sa.Numeric(5, 2), nullable=False),
        sa.Column("realized", sa.Numeric(5, 2), nullable=False),
        # realized - predicted. Отрицательное = мы обещали больше, чем вышло.
        sa.Column("error_pp", sa.Numeric(6, 2), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    # Одна строка на страту на прогон: повторный прогон за те же сутки заменяет.
    op.create_index(
        "uq_survival_calibration",
        "survival_calibration",
        ["class", "feature", "bucket", "horizon_h", "window_from"],
        unique=True,
    )
    op.create_index(
        "ix_survival_calibration_computed",
        "survival_calibration",
        ["computed_at"],
    )


def downgrade():
    op.drop_index("ix_survival_calibration_computed", table_name="survival_calibration")
    op.drop_index("uq_survival_calibration", table_name="survival_calibration")
    op.drop_table("survival_calibration")
