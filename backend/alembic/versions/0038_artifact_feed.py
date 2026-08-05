"""Лента артефактов: feed_lots, artifact_variant_stats, глобальная история

Revision ID: 0038
Revises: 0037
Create Date: 2026-08-03

Фаза 1 задачи docs/tasks/artifact-feed.md.

feed_lots — живой отскоренный срез ТОЛЬКО выгодных лотов (переписывается
каждым циклом сбора), artifact_variant_stats — статистика варианта
«предмет x качество x заточка».

sales_history.user_id -> nullable: историю по всем 103 артефактам собирает
глобальная задача (не watchlist-пара), пишет с user_id = NULL — та же
конвенция, что у collected_data.user_id и market_statistics.user_id.
Легаси-индекс ix_sales_item_time (user_id, item_id, sale_time) оставлен:
ни один сервис по user_id не фильтрует, дедуп работает через
uq_sales_history_sale из 0025.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "feed_lots",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("item_id", sa.String(50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        # Идентичность лота на аукционе: startTime|qlt|ptn|buyoutPrice|amount
        # (feed_collector.lot_identity_key). Один startTime ключом быть не может:
        # точность API — секунды, и у предмета регулярно висят разные лоты с
        # одинаковым startTime — дубль в батче апсерта роняет весь цикл сбора.
        # 128 при реалистичном максимуме ~58 символов: переполнение строки
        # роняет запись предмета целиком, а запас здесь ничего не стоит.
        sa.Column("lot_key", sa.String(128), nullable=False),
        sa.Column("qlt", sa.SmallInteger(), nullable=False),
        sa.Column("ptn", sa.SmallInteger(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("buyout_price", sa.BigInteger(), nullable=False),
        sa.Column("buyout_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
        # скоринг — всё из pricing.evaluate_lot_profit / artifact_variant_stats
        sa.Column("ref_price", sa.BigInteger(), nullable=False),
        sa.Column("sell_price_used", sa.BigInteger(), nullable=False),
        sa.Column("breakeven_per_unit", sa.BigInteger(), nullable=False),
        sa.Column("profit_per_unit", sa.BigInteger(), nullable=False),
        # profit_per_unit * amount — колонка сортировки по умолчанию, материализована
        sa.Column("profit_total", sa.BigInteger(), nullable=False),
        sa.Column("profit_pct", sa.Numeric(8, 2), nullable=False),
        # profit_pct / risk_mult: sargable-форма фильтра
        # profit_pct >= user_min * risk_mult (см. ТЗ, «уточнение реализации»)
        sa.Column("margin_adj_pct", sa.Numeric(8, 2), nullable=False),
        # profit_per_hour — НА ЕДИНИЦУ (pricing.evaluate_lot_profit);
        # profit_per_hour_total — profit_total / est_sell_hours, т.е. ровно то
        # число, которое UI печатает в колонке «₽/час». Материализовано, потому
        # что сортировка обязана идти по показанной величине: при amount > 1
        # «на единицу» и «со всего лота» расходятся в amount раз и сортировка
        # по первой инвертировала выдачу относительно второй.
        sa.Column("profit_per_hour", sa.Numeric(14, 2), nullable=True),
        sa.Column("profit_per_hour_total", sa.Numeric(14, 2), nullable=True),
        sa.Column("est_sell_hours", sa.Numeric(8, 2), nullable=True),
        sa.Column("risk", sa.String(10), nullable=False),
        sa.Column("risk_mult", sa.Numeric(3, 2), nullable=False),
        sa.Column("volatility_7d", sa.Numeric(6, 2), nullable=True),
        sa.Column("trend_24h", sa.String(10), nullable=True),
        sa.Column("trend_24h_pct", sa.Numeric(8, 2), nullable=True),
        sa.Column("trend_7d_pct", sa.Numeric(8, 2), nullable=True),
        sa.Column("sales_per_day", sa.Numeric(10, 2), nullable=True),
        sa.Column("supply_coverage_days", sa.Numeric(10, 2), nullable=True),
        sa.Column("stats_confidence", sa.String(10), nullable=True),
        sa.Column("stats_samples", sa.Integer(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("uq_feed_lots_lot", "feed_lots", ["item_id", "region", "lot_key"], unique=True)
    op.create_index("ix_feed_lots_profit_total", "feed_lots", [sa.text("profit_total DESC")])
    op.create_index("ix_feed_lots_profit_pct", "feed_lots", [sa.text("profit_pct DESC")])
    op.create_index("ix_feed_lots_margin_adj", "feed_lots", [sa.text("margin_adj_pct DESC")])
    op.create_index("ix_feed_lots_item", "feed_lots", ["item_id"])
    op.create_index("ix_feed_lots_variant", "feed_lots", ["qlt", "ptn"])
    op.create_index("ix_feed_lots_end_time", "feed_lots", ["end_time"])
    op.create_index("ix_feed_lots_seen_at", "feed_lots", ["seen_at"])

    op.create_table(
        "artifact_variant_stats",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("item_id", sa.String(50), sa.ForeignKey("master_items.item_id"), nullable=False),
        sa.Column("region", sa.String(10), nullable=False),
        sa.Column("qlt", sa.SmallInteger(), nullable=False),
        sa.Column("ptn", sa.SmallInteger(), nullable=False),
        # опорная цена варианта — pricing.compute_reference()["ref"]
        sa.Column("ref_price", sa.BigInteger(), nullable=True),
        sa.Column("ref_source", sa.String(20), nullable=True),
        sa.Column("ref_confidence", sa.String(10), nullable=True),
        sa.Column("ref_samples", sa.Integer(), nullable=True),
        sa.Column("median_24h", sa.Numeric(14, 2), nullable=True),
        sa.Column("median_7d", sa.Numeric(14, 2), nullable=True),
        sa.Column("median_30d", sa.Numeric(14, 2), nullable=True),
        sa.Column("sales_volume_24h", sa.Integer(), nullable=True),
        sa.Column("sales_volume_7d", sa.Integer(), nullable=True),
        sa.Column("sales_volume_30d", sa.Integer(), nullable=True),
        sa.Column("sales_per_day", sa.Numeric(10, 2), nullable=True),
        sa.Column("volatility_7d", sa.Numeric(6, 2), nullable=True),
        sa.Column("risk", sa.String(10), nullable=True),
        sa.Column("trend_24h", sa.String(10), nullable=True),
        sa.Column("trend_24h_pct", sa.Numeric(8, 2), nullable=True),
        sa.Column("trend_7d_pct", sa.Numeric(8, 2), nullable=True),
        sa.Column("sell_options", JSONB, nullable=True),
        sa.Column("batch_stats", JSONB, nullable=True),
        sa.Column("avg_sell_time_hours", sa.Numeric(8, 2), nullable=True),
        sa.Column("calculated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "uq_artifact_variant", "artifact_variant_stats",
        ["item_id", "region", "qlt", "ptn"], unique=True,
    )
    op.create_index("ix_avs_item", "artifact_variant_stats", ["item_id", "region"])

    op.alter_column("sales_history", "user_id", existing_type=sa.Integer(), nullable=True)


def downgrade():
    # ВНИМАНИЕ: откат УНИЧТОЖАЕТ весь глобальный пласт истории продаж
    # (user_id IS NULL) — иначе NOT NULL не восстановить. Восстановление
    # возможно только повторным бэкфиллом и только на ту глубину, которую
    # ещё отдаёт /history: всё, что старше, теряется безвозвратно, а вместе с
    # ним — опорные цены вариантов. Перед downgrade делать дамп sales_history.
    op.execute("DELETE FROM sales_history WHERE user_id IS NULL")
    op.alter_column("sales_history", "user_id", existing_type=sa.Integer(), nullable=False)

    op.drop_index("ix_avs_item", table_name="artifact_variant_stats")
    op.drop_index("uq_artifact_variant", table_name="artifact_variant_stats")
    op.drop_table("artifact_variant_stats")

    op.drop_index("ix_feed_lots_seen_at", table_name="feed_lots")
    op.drop_index("ix_feed_lots_end_time", table_name="feed_lots")
    op.drop_index("ix_feed_lots_variant", table_name="feed_lots")
    op.drop_index("ix_feed_lots_item", table_name="feed_lots")
    op.drop_index("ix_feed_lots_margin_adj", table_name="feed_lots")
    op.drop_index("ix_feed_lots_profit_pct", table_name="feed_lots")
    op.drop_index("ix_feed_lots_profit_total", table_name="feed_lots")
    op.drop_index("uq_feed_lots_lot", table_name="feed_lots")
    op.drop_table("feed_lots")
