"""
Статистика вариантов артефактов «предмет × регион × качество × заточка».

Опора скоринга «Ленты артефактов» (ТЗ: docs/tasks/artifact-feed.md §2.1).
Сравнение всегда в рамках одинакового товара: «Мастер +15» и «Мастер +10» —
разные товары с разными ценами, поэтому вариант, а не предмет, является
единицей расчёта.

Формулы НЕ форкаются: последовательность вызовов — та же, что в
profitable_lots.compute_signals_for_entry (ветка с фильтрами качества/заточки):
  weighted_reference -> compute_reference -> make_sell_options -> classify_risk.
Отличие одно: живых лотов здесь нет, поэтому median_now/current_min в
compute_reference не передаются — опора считается только по реальным сделкам.
"""

import logging
import statistics
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import ArtifactVariantStats, MasterItem, SalesHistory
from app.services.analytics.market_stats import (
    MIN_SALES_FOR_VOLATILITY,
    COVERAGE_MEDIUM,
    _avg_sell_time_from_buyouts,
    _calculate_batch_stats,
    _clamp_pct,
    extract_time_price_pairs,
)
from app.services.analytics.pricing import (
    MIN_BATCH_SAMPLES,
    classify_risk,
    compute_reference,
    make_sell_options,
    weighted_reference,
)

logger = logging.getLogger(__name__)

# Окно, за которое читаются продажи (совпадает с окном market_statistics).
STATS_WINDOW_DAYS = 30

# Размер батча апсерта вариантов.
UPSERT_CHUNK = 500


def variant_key(additional_info: dict | None) -> tuple[int, int]:
    """
    (qlt, ptn) варианта из additional_info продажи.

    Та же трактовка, что pricing._lot_quality_enchant для артефактов:
    отсутствующее поле = 0 («Обычный» / «Не точёный»), а не NULL — иначе
    продажи одного и того же товара разъехались бы по двум вариантам.
    """
    info = additional_info or {}

    def _as_int(value) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    return _as_int(info.get("qlt")), _as_int(info.get("ptn"))


def trend_7d_pct(median_7d: float | None, median_30d: float | None) -> float | None:
    """Недельный тренд: медиана 7д против медианы 30д. Только метка, не поправка к цене."""
    if not median_7d or not median_30d:
        return None
    return round((median_7d / median_30d - 1) * 100, 2)


def _volatility(prices: list[int]) -> float | None:
    """stdev/mean × 100 при >= MIN_SALES_FOR_VOLATILITY сделках, иначе число бессмысленно."""
    if len(prices) < MIN_SALES_FOR_VOLATILITY:
        return None
    mean = statistics.mean(prices)
    if mean <= 0:
        return None
    return round(statistics.stdev(prices) / mean * 100, 2)


def compute_variant(sales_30d: list, now: datetime, survival=None) -> dict:
    """
    Метрики одного варианта по его продажам за 30 дней.

    sales_30d — строки с полями sale_time / price_per_unit / amount /
    additional_info (Row из SELECT либо ORM-сущность).

    ref_price = None означает «опоры нет» — такой вариант в скоринге ленты
    пропускается целиком. Так же трактуется опора ниже пола по данным
    (below_floor): показывать прибыль, за которой стоит меньше
    MIN_REF_WEIGHT эффективных сделок, лента не должна.
    """
    cutoff_7d  = now - timedelta(days=7)
    cutoff_24h = now - timedelta(hours=24)

    sales_7d  = [s for s in sales_30d if s.sale_time >= cutoff_7d]
    sales_24h = [s for s in sales_7d  if s.sale_time >= cutoff_24h]

    prices_30d = [s.price_per_unit for s in sales_30d]
    prices_7d  = [s.price_per_unit for s in sales_7d]
    prices_24h = [s.price_per_unit for s in sales_24h]

    median_30d = float(statistics.median(prices_30d)) if prices_30d else None
    median_7d  = float(statistics.median(prices_7d))  if prices_7d  else None
    median_24h = float(statistics.median(prices_24h)) if prices_24h else None

    wr = weighted_reference([(s.sale_time, s.price_per_unit) for s in sales_7d], now)
    ref_info = compute_reference(
        weighted_hist=wr["ref"] if wr else None,
        median_hist=median_7d,
        sample_count=len(prices_7d),
        median_24h=median_24h,
        sample_count_24h=len(prices_24h),
        weight=wr["weight"] if wr else 0.0,
    )
    # Опора ниже пола по данным — не сигнал: цену и цены продажи не публикуем,
    # но source/confidence/samples сохраняем, иначе не отличить «мало данных»
    # от «сделок не было вовсе».
    below_floor = ref_info is not None and ref_info["below_floor"]

    volatility = _volatility(prices_7d)

    # Пары «часы на рынке → цена» передаём make_sell_options по тому же правилу,
    # что и market_stats._calculate_sell_options: иначе прогноз времени продажи
    # в ленте и в карточке считался бы по разным правилам.
    pairs = extract_time_price_pairs(sales_30d)
    coverage = len(pairs) / len(sales_30d) if sales_30d else 0.0
    pairs_for_options = (
        pairs if (coverage >= COVERAGE_MEDIUM and len(pairs) >= MIN_BATCH_SAMPLES) else None
    )

    sell_options = (
        make_sell_options(ref_info["ref"], len(prices_7d), pairs_for_options, survival)
        if ref_info is not None and not below_floor else None
    )

    return {
        "ref_price":        ref_info["ref"] if ref_info and not below_floor else None,
        "ref_source":       ref_info["source"] if ref_info else None,
        "ref_confidence":   ref_info["confidence"] if ref_info else None,
        "ref_samples":      ref_info["samples"] if ref_info else None,
        "median_24h":       median_24h,
        "median_7d":        median_7d,
        "median_30d":       median_30d,
        "sales_volume_24h": len(sales_24h),
        "sales_volume_7d":  len(sales_7d),
        "sales_volume_30d": len(sales_30d),
        "sales_per_day":    round(len(sales_7d) / 7, 2),
        "volatility_7d":    _clamp_pct(volatility),
        "risk":             classify_risk(volatility),
        "trend_24h":        ref_info["trend"] if ref_info else None,
        "trend_24h_pct":    _clamp_pct(ref_info["trend_pct"]) if ref_info else None,
        "trend_7d_pct":     _clamp_pct(trend_7d_pct(median_7d, median_30d)),
        "sell_options":     sell_options,
        "batch_stats":      _calculate_batch_stats(sales_30d),
        "avg_sell_time_hours": _avg_sell_time_from_buyouts(sales_30d),
    }


async def calculate_artifact_variant_stats(
    db: AsyncSession, region: str, now: datetime | None = None,
) -> dict:
    """
    Пересчитывает artifact_variant_stats по всем вариантам всех артефактов.

    Один SELECT на все продажи артефактов за 30 дней, группировка в Python,
    один апсерт-батч. Варианты, по которым за 30 дней не было ни одной сделки,
    удаляются: срез должен отражать текущий рынок, а не историю.

    Возвращает {"variants": N, "items": M, "elapsed_sec": X}.
    """
    started = time.monotonic()
    now = now or datetime.now(timezone.utc)
    cutoff_30d = now - timedelta(days=STATS_WINDOW_DAYS)

    rows = (await db.execute(
        select(
            SalesHistory.item_id,
            SalesHistory.sale_time,
            SalesHistory.price_per_unit,
            SalesHistory.amount,
            SalesHistory.total_price,
            SalesHistory.additional_info,
        )
        .join(MasterItem, MasterItem.item_id == SalesHistory.item_id)
        .where(
            MasterItem.category.like("artefact%"),
            SalesHistory.region == region,
            SalesHistory.sale_time >= cutoff_30d,
        )
    )).all()

    groups: dict[tuple[str, int, int], list] = {}
    for row in rows:
        qlt, ptn = variant_key(row.additional_info)
        groups.setdefault((row.item_id, qlt, ptn), []).append(row)

    # Таблица дожития читается ОДИН раз на весь пересчёт: она общая для всех
    # вариантов (страты по признакам, а не по варианту) и меняется раз в сутки.
    from app.services.analytics.survival import load_survival
    survival = await load_survival(db, now)

    values: list[dict] = []
    for (item_id, qlt, ptn), sales in groups.items():
        values.append({
            "item_id": item_id, "region": region, "qlt": qlt, "ptn": ptn,
            "calculated_at": now,
            **compute_variant(sales, now, survival),
        })

    # Батчами: у 103 артефактов набирается несколько тысяч вариантов, каждый с
    # двумя JSONB-полями — один гигантский INSERT незачем.
    for start in range(0, len(values), UPSERT_CHUNK):
        stmt = pg_insert(ArtifactVariantStats).values(values[start:start + UPSERT_CHUNK])
        updatable = {
            col.name: stmt.excluded[col.name]
            for col in ArtifactVariantStats.__table__.columns
            if col.name not in ("id", "item_id", "region", "qlt", "ptn")
        }
        await db.execute(stmt.on_conflict_do_update(
            index_elements=["item_id", "region", "qlt", "ptn"], set_=updatable,
        ))

    # Вариант, не попавший в этот прогон, не имеет сделок за 30 дней — его
    # calculated_at остался от прошлого раза.
    stale = await db.execute(
        delete(ArtifactVariantStats).where(
            ArtifactVariantStats.region == region,
            ArtifactVariantStats.calculated_at < now,
        )
    )
    await db.commit()

    result = {
        "variants": len(values),
        "items":    len({item_id for item_id, _, _ in groups}),
        "elapsed_sec": round(time.monotonic() - started, 2),
    }
    logger.info(
        "artifact variant stats: region=%s variants=%s items=%s sales=%s "
        "removed=%s elapsed=%ss",
        region, result["variants"], result["items"], len(rows),
        stale.rowcount or 0, result["elapsed_sec"],
    )
    return result
