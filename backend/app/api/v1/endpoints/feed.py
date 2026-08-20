"""
API «Ленты артефактов» (ТЗ: docs/tasks/artifact-feed.md §2.2 + Ревизия 2 §Р2.3).

Четыре ручки:
  GET /feed/lots     — без гейта, ветвится по тарифу: полная лента (фильтры,
                       сортировка, пагинация) либо фиксированная витрина из
                       feed_rows_limit строк;
  GET /feed/variant  — без гейта, статистика варианта для карточки артефакта;
  GET /feed/summary  — гейт feed_access, сводка 24 ч;
  GET /feed/filters  — гейт feed_access, счётчики для чипов фильтров.

ТРЕБОВАНИЕ БЕЗОПАСНОСТИ (не оптимизация): все негейтированные ручки читают
только готовые таблицы (feed_lots + master_items, artifact_variant_stats).
Никаких вызовов stalcraft_client, пересчёта статистики вариантов/рынка,
api_cache.get_or_fetch_* — негейтированный эндпоинт, способный запустить
тяжёлый пересчёт, это DoS-вектор (прямой урок get_watchlist_suggestions,
docs/BUSINESS_LOGIC.md §17). На пустой таблице — пустой ответ, ничего
не пересчитываем.

Персональный порог видимости берётся из user_settings.min_profit_margin_percent
и применяется как margin_adj_pct >= порог — это ровно profit_pct >= порог ×
RISK_MARGIN_MULT[risk], только в sargable-форме (см. миграцию 0038).

Пользовательский фильтр min_profit_pct — другое: он сравнивается с фактической
прибылью (profit_pct), без поправки на риск. Иначе выбранные в UI «20 %»
означали бы 20 × risk_mult и давали пустую выдачу там, где прибыль 29 %.
"""

import json
import logging
import math
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, computed_field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints.monitoring import MonitoringItemResponse, _mask_stats_windows
from app.core.config import settings as app_settings
from app.core.dependencies import get_current_user
from app.core.tiers import effective_feed_rows_limit, get_tier_limits
from app.db.session import get_db
from app.models.models import (
    ArtifactVariantStats, FeedLot, MasterItem, SalesHistory, User, UserSettings,
)
from app.services.analytics.pricing import _QLT_NAMES
from app.services.feed.scope import (
    FEED_GROUPS, FEED_GROUP_LABELS, feed_groups_clause, feed_item_group, feed_scope_clause,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feed", tags=["Feed"])

# Ниже этого числа выгодных лотов перцентили вырождаются (на 1–3 строках
# 25-й и 75-й схлопываются и отсекают всё) — ценовая полоса не применяется,
# витрина деградирует в простой топ-N по прибыли.
FEED_BAND_MIN_ROWS = 4

PAGE_SIZES = (25, 50, 100)

SHOWCASE_CACHE_TTL = 30
SUMMARY_CACHE_TTL  = 60

# Порог витрины квантуется вниз шагом FEED_SHOWCASE_MIN_STEP: он входит и в
# WHERE, и в ключ кэша, поэтому произвольное значение = свой набор строк и свой
# ключ. Без квантования лимитированный тариф перебором порога собирает ленту по
# строке, а каждый новый ключ ещё и обходит TTL 30 с, считая percentile_cont
# заново.
FEED_SHOWCASE_MIN_STEP = 5

# Потолок значений в списочных фильтрах: IN (...) без границы принимает
# сколько угодно элементов одним запросом.
FEED_MAX_LIST_VALUES = 50

# Группы чипов — из scope-модуля (Артефакты · Оружие · Обвесы · Броня ·
# Рюкзаки · Части · Пропуска и премиум). Прежняя таксономия по подкатегориям
# артефактов (Био / Грав / Терм / Электро) больше не описывает набор: в ленте
# 382 предмета семи групп, а не 103 артефакта.

_SORT_COLUMNS = {
    # Умолчание. profit_total отвечает на вопрос «сколько заработаю, ЕСЛИ
    # продам»; ev_profit домножает его на вероятность того, что продажа
    # вообще состоится. Прежние ключи сохранены все — валовая прибыль
    # выбирается явно (docs/tasks/ev-ranking.md).
    "ev_profit":       FeedLot.ev_profit,
    "profit_total":    FeedLot.profit_total,
    "profit_pct":      FeedLot.profit_pct,
    # Именно profit_per_hour_total: в таблице напечатана прибыль ВСЕГО лота за
    # час (profit_total / est_sell_hours), а profit_per_hour — прибыль на
    # единицу. Сортировка по «на единицу» при amount > 1 расходилась с
    # показанным числом ровно в amount раз и выдавала обратный порядок.
    "profit_per_hour": FeedLot.profit_per_hour_total,
    "buyout_per_unit": FeedLot.buyout_per_unit,
    "time_left":       FeedLot.end_time,
    "volatility":      FeedLot.volatility_7d,
    "sales_per_day":   FeedLot.sales_per_day,
}


def band_bounds(n: int, lo, hi) -> tuple | None:
    """
    Границы ценовой полосы витрины или None, если полосу применять нельзя.

    На 1–3 строках 25-й и 75-й перцентили схлопываются и могут отсечь всё —
    витрина обязана деградировать в простой топ-N, а не пустеть.
    """
    if n < FEED_BAND_MIN_ROWS or lo is None or hi is None:
        return None
    return lo, hi


def showcase_threshold(user_min: float) -> float:
    """
    Порог витрины: персональный порог, округлённый ВНИЗ до кратного
    FEED_SHOWCASE_MIN_STEP.

    Вниз, а не вверх: округление вверх скрыло бы строки, на которые
    пользователь имеет право по собственной настройке. Обратная сторона —
    витрина может показать строку на несколько п.п. ниже порога; это
    сознательный размен на конечное (21 вместо 101) число вариантов выдачи
    и рабочий кэш.
    """
    step = FEED_SHOWCASE_MIN_STEP
    return float(max(0, math.floor(max(user_min, 0) / step) * step))


def _require_access(user: User) -> None:
    if not get_tier_limits(user).feed_access:
        raise HTTPException(status_code=403, detail="Лента артефактов доступна на тарифе «Макс»")


async def _redis() -> aioredis.Redis:
    return aioredis.from_url(app_settings.redis_url, encoding="utf-8", decode_responses=True)


async def _cache_get(key: str) -> dict | None:
    r = await _redis()
    try:
        cached = await r.get(key)
        return json.loads(cached) if cached is not None else None
    except Exception as e:
        logger.warning(f"feed cache read error ({key}): {e}")
        return None
    finally:
        await r.aclose()


async def _cache_set(key: str, payload: dict, ttl: int) -> None:
    r = await _redis()
    try:
        await r.setex(key, ttl, json.dumps(payload))
    except Exception as e:
        logger.warning(f"feed cache write error ({key}): {e}")
    finally:
        await r.aclose()


async def _user_min_margin(db: AsyncSession, user: User) -> float:
    """Персональный порог выгодности («Критерий выгодности» настроек)."""
    value = (await db.execute(
        select(UserSettings.min_profit_margin_percent).where(UserSettings.user_id == user.id)
    )).scalar_one_or_none()
    return float(value or 0)


# ─── Схемы ────────────────────────────────────────────────────────────────────

class FeedLotOut(BaseModel):
    id: int
    item_id: str
    name_ru: str | None = None
    name_en: str | None = None
    icon_path: str | None = None
    category: str | None = None
    region: str
    lot_key: str
    qlt: int
    ptn: int
    quality_name: str | None = None
    amount: int
    buyout_price: int
    buyout_per_unit: int
    # lot_key больше не равен startTime (составной ключ, см. lot_identity_key),
    # поэтому время выставления лота отдаётся отдельным полем.
    start_time: datetime | None = None
    end_time: datetime | None = None
    first_seen_at: datetime
    seen_at: datetime
    ref_price: int
    sell_price_used: int
    breakeven_per_unit: int
    profit_per_unit: int
    profit_total: int
    profit_pct: float
    profit_per_hour: float | None = None        # НА ЕДИНИЦУ
    # profit_total / est_sell_hours — величина колонки «₽/час» и ключ её
    # сортировки. Optional: строка из Redis-кэша витрины, записанного до
    # появления поля, валидируется как None, а не падает.
    profit_per_hour_total: float | None = None
    est_sell_hours: float | None = None
    # Ожидаемая прибыль в рублях — ключ сортировки по умолчанию, максимум по
    # двум сценариям. Optional: строка из Redis-кэша витрины, записанного до
    # появления поля, валидируется как None, а не падает.
    ev_profit: int | None = None
    # Сценарий «подождать и продать дороже» — то, чего в ленте не было вовсе.
    profit_total_slow: int | None = None
    est_sell_hours_slow: float | None = None
    p_sold_6h_slow: float | None = None
    # Кривая дожития (P1-4 фаза B): P(продан <= 6 ч) по позиции плановой цены
    # продажи в стакане и доля страты, продавшаяся когда-либо. Второе поле
    # важнее первого: до фазы B система вообще не знала, что часть лотов не
    # продаётся никогда, и печатала срок так, будто продажа гарантирована.
    p_sold_6h: float | None = None
    pct_sold_ever: float | None = None
    risk: str
    risk_mult: float
    volatility_7d: float | None = None
    trend_24h: str | None = None
    trend_24h_pct: float | None = None
    trend_7d_pct: float | None = None
    sales_per_day: float | None = None
    supply_coverage_days: float | None = None
    stats_confidence: str | None = None
    stats_samples: int | None = None

    @computed_field
    @property
    def hours_remaining(self) -> float | None:
        """Сколько часов лот ещё живёт (лот на аукционе живёт максимум 48 ч)."""
        if self.end_time is None:
            return None
        end = self.end_time
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return round((end - datetime.now(timezone.utc)).total_seconds() / 3600, 2)


class FeedLotsResponse(BaseModel):
    lots: list[FeedLotOut]
    total_count: int
    page: int
    page_size: int
    snapshot_at: datetime | None = None
    min_profit_pct_applied: float
    rows_limit: int | None = None       # None = без ограничений
    total_available: int                # всего выгодных лотов при пороге пользователя
    showcase: bool                      # True = выдача урезана и зафиксирована
    # Момент последнего настоящего нового лота, если аукцион отдаёт застывший
    # снимок. None = данные живые. Показывается предупреждением над лентой:
    # лоты из снимка в игре давно выкуплены, покупать по ним нельзя.
    market_frozen_since: datetime | None = None


class FeedSummaryResponse(BaseModel):
    profitable_lots: int
    avg_profit_pct: float | None = None
    total_profit: int
    sales_24h: int
    items_tracked: int
    best_lot: FeedLotOut | None = None
    snapshot_at: datetime | None = None
    cached: bool = False


class FeedFilterItem(BaseModel):
    item_id: str
    name_ru: str | None = None
    name_en: str | None = None
    icon_path: str | None = None
    category: str | None = None
    lots_count: int


class FeedFilterBucket(BaseModel):
    value: int | str
    label: str
    count: int


class FeedFiltersResponse(BaseModel):
    items: list[FeedFilterItem]
    qualities: list[FeedFilterBucket]
    enchants: list[FeedFilterBucket]
    categories: list[FeedFilterBucket]
    total_count: int


# ─── Общие части выборки ──────────────────────────────────────────────────────

def _to_out(lot: FeedLot, master: MasterItem | None) -> FeedLotOut:
    return FeedLotOut(
        id=lot.id,
        item_id=lot.item_id,
        name_ru=master.name_ru if master else None,
        name_en=master.name_en if master else None,
        icon_path=master.icon_path if master else None,
        category=master.category if master else None,
        region=lot.region,
        lot_key=lot.lot_key,
        qlt=lot.qlt,
        ptn=lot.ptn,
        quality_name=_QLT_NAMES.get(lot.qlt),
        amount=lot.amount,
        buyout_price=lot.buyout_price,
        buyout_per_unit=lot.buyout_per_unit,
        start_time=lot.start_time,
        end_time=lot.end_time,
        first_seen_at=lot.first_seen_at,
        seen_at=lot.seen_at,
        ref_price=lot.ref_price,
        sell_price_used=lot.sell_price_used,
        breakeven_per_unit=lot.breakeven_per_unit,
        profit_per_unit=lot.profit_per_unit,
        profit_total=lot.profit_total,
        profit_pct=float(lot.profit_pct),
        profit_per_hour=float(lot.profit_per_hour) if lot.profit_per_hour is not None else None,
        profit_per_hour_total=(
            float(lot.profit_per_hour_total) if lot.profit_per_hour_total is not None else None
        ),
        est_sell_hours=float(lot.est_sell_hours) if lot.est_sell_hours is not None else None,
        ev_profit=int(lot.ev_profit) if lot.ev_profit is not None else None,
        profit_total_slow=(
            int(lot.profit_total_slow) if lot.profit_total_slow is not None else None
        ),
        est_sell_hours_slow=(
            float(lot.est_sell_hours_slow) if lot.est_sell_hours_slow is not None else None
        ),
        p_sold_6h_slow=(
            float(lot.p_sold_6h_slow) if lot.p_sold_6h_slow is not None else None
        ),
        p_sold_6h=float(lot.p_sold_6h) if lot.p_sold_6h is not None else None,
        pct_sold_ever=float(lot.pct_sold_ever) if lot.pct_sold_ever is not None else None,
        risk=lot.risk,
        risk_mult=float(lot.risk_mult),
        volatility_7d=float(lot.volatility_7d) if lot.volatility_7d is not None else None,
        trend_24h=lot.trend_24h,
        trend_24h_pct=float(lot.trend_24h_pct) if lot.trend_24h_pct is not None else None,
        trend_7d_pct=float(lot.trend_7d_pct) if lot.trend_7d_pct is not None else None,
        sales_per_day=float(lot.sales_per_day) if lot.sales_per_day is not None else None,
        supply_coverage_days=(
            float(lot.supply_coverage_days) if lot.supply_coverage_days is not None else None
        ),
        stats_confidence=lot.stats_confidence,
        stats_samples=lot.stats_samples,
    )


def _rows_to_out(rows) -> list[FeedLotOut]:
    return [_to_out(lot, master) for lot, master in rows]


def _joined(*conds):
    """feed_lots ⋈ master_items — все витринные поля денормализованы, других join нет."""
    return (
        select(FeedLot, MasterItem)
        .join(MasterItem, MasterItem.item_id == FeedLot.item_id)
        .where(*conds)
    )


async def _total_available(db: AsyncSession, region: str, user_min: float) -> int:
    """Сколько всего выгодных лотов при пороге пользователя — крючок для CTA «Макс»."""
    return (await db.execute(
        select(func.count()).where(
            FeedLot.region == region, FeedLot.margin_adj_pct >= user_min,
        )
    )).scalar_one()


async def _showcase_rows(
    db: AsyncSession, region: str, threshold: float, rows_limit: int,
) -> tuple[list[FeedLotOut], int, datetime | None]:
    """
    Витрина лимитированного тарифа (§Р2.2): выгодные по порогу пользователя ->
    ценовая полоса между 25-м и 75-м перцентилем buyout_price -> топ-N по прибыли.

    Полоса делает витрину одновременно доступной по деньгам (нет лотов за
    миллионы) и осмысленной по заработку (нет пограничного шума у дна).
    threshold — уже квантованный порог (см. showcase_threshold).
    Возвращает (строки, total_available, snapshot_at).
    """
    base = [FeedLot.region == region, FeedLot.margin_adj_pct >= threshold]

    band = (await db.execute(
        select(
            func.count().label("n"),
            func.percentile_cont(0.25).within_group(FeedLot.buyout_price.asc()).label("lo"),
            func.percentile_cont(0.75).within_group(FeedLot.buyout_price.asc()).label("hi"),
            func.max(FeedLot.seen_at).label("snapshot_at"),
        ).where(*base)
    )).one()

    if not band.n:
        return [], 0, None

    query = _joined(*base)
    bounds = band_bounds(int(band.n), band.lo, band.hi)
    if bounds is not None:
        query = query.where(FeedLot.buyout_price.between(*bounds))

    rows = (await db.execute(
        query.order_by(
            FeedLot.ev_profit.desc().nulls_last(),
            FeedLot.profit_total.desc(), FeedLot.id,
        ).limit(rows_limit)
    )).all()

    return _rows_to_out(rows), int(band.n), band.snapshot_at


async def _cached_showcase(
    db: AsyncSession, region: str, user_min: float, rows_limit: int,
) -> tuple[list[FeedLotOut], int, datetime | None, float]:
    """
    Витрина с Redis-кэшем TTL 30 с — общая для всех с тем же порогом и тарифом.

    Порог квантуется ЗДЕСЬ, в единственной точке: и запрос, и ключ кэша
    считаются от showcase_threshold(user_min). Возвращает
    (строки, total_available, snapshot_at, применённый порог).
    """
    threshold = showcase_threshold(user_min)
    key = f"feed:showcase:{region}:{int(threshold)}:{rows_limit}"

    cached = await _cache_get(key)
    if cached is not None:
        return (
            [FeedLotOut.model_validate(row) for row in cached["lots"]],
            cached["total_available"],
            datetime.fromisoformat(cached["snapshot_at"]) if cached["snapshot_at"] else None,
            threshold,
        )

    lots, total_available, snapshot_at = await _showcase_rows(db, region, threshold, rows_limit)
    await _cache_set(key, {
        "lots": [lot.model_dump(mode="json") for lot in lots],
        "total_available": total_available,
        "snapshot_at": snapshot_at.isoformat() if snapshot_at else None,
    }, SHOWCASE_CACHE_TTL)
    return lots, total_available, snapshot_at, threshold


# ─── GET /feed/lots ───────────────────────────────────────────────────────────

@router.get("/lots", response_model=FeedLotsResponse)
async def list_feed_lots(
    page: int = Query(1, ge=1),
    page_size: int = Query(25),
    item_id: list[str] | None = Query(None),
    category: list[str] | None = Query(None),
    qlt: list[int] | None = Query(None),
    ptn: list[int] | None = Query(None),
    min_profit_pct: float | None = Query(None),
    max_buyout: int | None = Query(None),
    min_amount: int | None = Query(None),
    risk: list[str] | None = Query(None),
    sort: str = Query("ev_profit"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if page_size not in PAGE_SIZES:
        raise HTTPException(status_code=422, detail=f"page_size должен быть одним из {PAGE_SIZES}")
    if sort not in _SORT_COLUMNS:
        raise HTTPException(status_code=422, detail=f"sort должен быть одним из {list(_SORT_COLUMNS)}")
    for name, values in (
        ("item_id", item_id), ("category", category),
        ("qlt", qlt), ("ptn", ptn), ("risk", risk),
    ):
        if values is not None and len(values) > FEED_MAX_LIST_VALUES:
            raise HTTPException(
                status_code=422,
                detail=f"{name}: не больше {FEED_MAX_LIST_VALUES} значений в фильтре",
            )
    unknown = set(category or ()) - set(FEED_GROUPS)
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"category: неизвестные группы {sorted(unknown)}; допустимы {list(FEED_GROUPS)}",
        )

    region     = app_settings.stalcraft_region
    user_min   = await _user_min_margin(db, current_user)
    rows_limit = effective_feed_rows_limit(current_user)

    # Достоверность входа проверяется тем же правилом, что и у сборщика, а не
    # второй его копией: разойдись они — лента молчала бы там, где резолвер уже
    # выбросил данные из выборки.
    from app.tasks.feed_collector import market_frozen_for

    now = datetime.now(timezone.utc)
    try:
        frozen_for = await market_frozen_for(db, now)
        frozen_since = now - timedelta(minutes=frozen_for) if frozen_for is not None else None
    except Exception as e:
        # Плашка — сведения о качестве данных, а не сама выдача. Уронить из-за
        # неё ленту было бы обменом важного на второстепенное.
        logger.warning(f"feed: не удалось проверить свежесть данных аукциона: {e}")
        frozen_since = None

    # Витрина: sort / фильтры / page / page_size игнорируются — иначе лимит
    # обходится перебором сортировок.
    if rows_limit is not None:
        lots, total_available, snapshot_at, threshold = await _cached_showcase(
            db, region, user_min, rows_limit,
        )
        return FeedLotsResponse(
            lots=lots, total_count=len(lots), page=1, page_size=page_size,
            snapshot_at=snapshot_at, min_profit_pct_applied=threshold,
            rows_limit=rows_limit, total_available=total_available, showcase=True,
            market_frozen_since=frozen_since,
        )

    conds = [FeedLot.region == region, FeedLot.margin_adj_pct >= user_min]
    if min_profit_pct is not None:
        # Пользовательский фильтр «Мин. профит» сравнивается с ФАКТИЧЕСКОЙ
        # прибылью — ровно то, что написано на подписи. Риск-скорректированной
        # остаётся только базовая персональная планка (margin_adj_pct >=
        # min_profit_margin_percent): она про риск, а не про «сколько я хочу».
        conds.append(FeedLot.profit_pct >= min_profit_pct)
    if item_id:
        conds.append(FeedLot.item_id.in_(item_id))
    if category:
        # Подзапросом, а не join: те же conds уходят и в агрегат (count + max),
        # и в выдачу, а лишний join в агрегате изменил бы total_count. Набор
        # предметов маленький (сотни), подзапрос по ix_master_category дешёвый.
        conds.append(FeedLot.item_id.in_(
            select(MasterItem.item_id).where(feed_groups_clause(category))
        ))
    if qlt:
        conds.append(FeedLot.qlt.in_(qlt))
    if ptn:
        conds.append(FeedLot.ptn.in_(ptn))
    if max_buyout is not None:
        conds.append(FeedLot.buyout_price <= max_buyout)
    if min_amount is not None:
        conds.append(FeedLot.amount >= min_amount)
    if risk:
        conds.append(FeedLot.risk.in_(risk))

    agg = (await db.execute(
        select(func.count(), func.max(FeedLot.seen_at)).where(*conds)
    )).one()

    column = _SORT_COLUMNS[sort]
    # Вторичный ключ всегда id: без него страницы серверной пагинации
    # перекрываются на одинаковых значениях колонки сортировки.
    ordering = column.desc().nulls_last() if order == "desc" else column.asc().nulls_last()

    rows = (await db.execute(
        _joined(*conds)
        # profit_total вторичным ключом: когда сортировка идёт по ev_profit,
        # а вероятность не измерена ни у одной строки (пустая sale_survival —
        # рабочее состояние первых суток), выдача обязана выродиться в прежний
        # порядок, а не в произвольный по id.
        .order_by(ordering, FeedLot.profit_total.desc(), FeedLot.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )).all()

    return FeedLotsResponse(
        lots=_rows_to_out(rows),
        total_count=agg[0],
        page=page,
        page_size=page_size,
        snapshot_at=agg[1],
        # Персональная планка видимости; фильтр min_profit_pct живёт отдельно и
        # применяется к profit_pct, поэтому в это поле не подмешивается.
        min_profit_pct_applied=user_min,
        rows_limit=None,
        total_available=await _total_available(db, region, user_min),
        showcase=False,
        market_frozen_since=frozen_since,
    )


# ─── GET /feed/variant/{item_id} ──────────────────────────────────────────────

def variant_row_out(row: ArtifactVariantStats) -> MonitoringItemResponse:
    """
    Строка artifact_variant_stats -> ответ карточки предмета.

    Форма ответа — MonitoringItemResponse, тот же контракт, что у
    /monitoring/item: карточка (LotStatCard / MobileLotStatCard) одна на
    «Избранное» и «Ленту», второй схемы под неё не заводим.

    Ничего не считается: все значения уже посчитаны задачей
    calculate_artifact_variant_stats через те же pricing-формулы, что и
    скоринг ленты. Поэтому цифры карточки совпадают со строкой таблицы по
    построению, а не по совпадению: sell_options здесь — ровно тот список,
    по которому evaluate_lot_profit оценивал лоты этого варианта.

    Чего у варианта нет и не будет null-ами:
      * best_sell_hour / best_buy_hour / weekend_bonus — почасовая раскладка
        считается по предмету целиком в calculate_market_stats и на уровне
        варианта не хранится;
      * price_volatility_30d — вариант меряет волатильность за 7 дней
        (classify_risk работает от неё же);
      * sell_options_now / current_min_price — «Сейчас» строится от снапшота
        collected_data, которого у предметов вне «Избранного» нет. Карточка
        в этом режиме честно показывает недельные цены (см. LotStatCard).
    """
    return MonitoringItemResponse(
        item_id=row.item_id,
        region=row.region,
        median_price_24h=float(row.median_24h) if row.median_24h is not None else None,
        sales_volume_24h=row.sales_volume_24h,
        avg_price_7d=None,
        median_price_7d=float(row.median_7d) if row.median_7d is not None else None,
        min_price_7d=None,
        max_price_7d=None,
        sales_volume_7d=row.sales_volume_7d,
        sales_volume_30d=row.sales_volume_30d,
        price_volatility_7d=float(row.volatility_7d) if row.volatility_7d is not None else None,
        price_volatility_30d=None,
        best_sell_hour=None,
        best_sell_day=None,
        best_buy_hour=None,
        best_buy_day=None,
        sell_hours_by_day=None,
        buy_hours_by_day=None,
        weekend_bonus_percent=None,
        avg_sell_time_hours=(
            float(row.avg_sell_time_hours) if row.avg_sell_time_hours is not None else None
        ),
        sell_options=row.sell_options,
        sell_options_now=None,
        current_min_price=None,
        reference_price=int(row.ref_price) if row.ref_price is not None else None,
        reference_source=row.ref_source,
        reference_confidence=row.ref_confidence,
        reference_samples=row.ref_samples,
        trend=row.trend_24h,
        trend_pct=float(row.trend_24h_pct) if row.trend_24h_pct is not None else None,
        batch_stats=row.batch_stats,
        demand_signals=None,
        risk_level=row.risk,
        calculated_at=row.calculated_at,
    )


@router.get("/variant/{item_id}", response_model=MonitoringItemResponse)
async def feed_variant(
    item_id: str,
    qlt: int = Query(..., ge=0, le=5),
    ptn: int = Query(..., ge=0, le=15),
    region: str | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Статистика варианта «предмет × качество × заточка» для карточки артефакта.

    Почему отдельная ручка, а не /monitoring/item: та отдаёт 404, если нет
    MarketStatistics или CollectedData с user_id IS NULL, а их наполняет
    watchlist-коллектор — лента же по определению про предметы ВНЕ «Избранного»
    (замер QA: 56 из 66 предметов ленты давали пустую карточку). Плюс уровень
    расчёта: /monitoring/item считает по предмету целиком, лента — по варианту,
    из-за чего прогноз времени продажи расходился в разы (2.0 ч против 0.3 ч
    на одном и том же лоте).

    Гейта feed_access нет — как и у /feed/lots: витрину лимитированных тарифов
    можно открыть карточкой. Тарифные окна статистики режет _mask_stats_windows,
    ровно как в /monitoring/item.

    Дешёвое чтение: одна строка по уникальному индексу uq_artifact_variant,
    ни пересчёта, ни похода во внешний API.
    """
    row = (await db.execute(
        select(ArtifactVariantStats).where(
            ArtifactVariantStats.item_id == item_id,
            ArtifactVariantStats.region == (region or app_settings.stalcraft_region).upper(),
            ArtifactVariantStats.qlt == qlt,
            ArtifactVariantStats.ptn == ptn,
        )
    )).scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="Нет статистики по этому варианту")

    return _mask_stats_windows(variant_row_out(row), get_tier_limits(current_user).stats_windows)


# ─── GET /feed/summary ────────────────────────────────────────────────────────

@router.get("/summary", response_model=FeedSummaryResponse)
async def feed_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_access(current_user)

    region   = app_settings.stalcraft_region
    user_min = await _user_min_margin(db, current_user)

    key = f"feed:summary:{region}:{int(user_min)}"
    cached = await _cache_get(key)
    if cached is not None:
        return FeedSummaryResponse.model_validate({**cached, "cached": True})

    conds = [FeedLot.region == region, FeedLot.margin_adj_pct >= user_min]

    agg = (await db.execute(
        select(
            func.count(),
            func.avg(FeedLot.profit_pct),
            func.coalesce(func.sum(FeedLot.profit_total), 0),
            func.max(FeedLot.seen_at),
        ).where(*conds)
    )).one()

    best_row = (await db.execute(
        _joined(*conds).order_by(
            FeedLot.ev_profit.desc().nulls_last(),
            FeedLot.profit_total.desc(), FeedLot.id,
        ).limit(1)
    )).first()

    sales_24h = (await db.execute(
        select(func.count())
        .select_from(SalesHistory)
        .join(MasterItem, MasterItem.item_id == SalesHistory.item_id)
        .where(
            feed_scope_clause(),
            SalesHistory.region == region,
            SalesHistory.sale_time >= datetime.now(timezone.utc) - timedelta(hours=24),
        )
    )).scalar_one()

    items_tracked = (await db.execute(
        select(func.count()).select_from(MasterItem).where(feed_scope_clause())
    )).scalar_one()

    response = FeedSummaryResponse(
        profitable_lots=agg[0],
        avg_profit_pct=round(float(agg[1]), 2) if agg[1] is not None else None,
        total_profit=int(agg[2]),
        sales_24h=sales_24h,
        items_tracked=items_tracked,
        best_lot=_to_out(*best_row) if best_row else None,
        snapshot_at=agg[3],
        cached=False,
    )
    await _cache_set(key, response.model_dump(mode="json"), SUMMARY_CACHE_TTL)
    return response


# ─── GET /feed/filters ────────────────────────────────────────────────────────

@router.get("/filters", response_model=FeedFiltersResponse)
async def feed_filters(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Счётчики для чипов фильтров — все с учётом персонального порога, иначе
    чипы обещали бы строки, которых пользователь не увидит.
    """
    _require_access(current_user)

    region   = app_settings.stalcraft_region
    user_min = await _user_min_margin(db, current_user)
    conds = [FeedLot.region == region, FeedLot.margin_adj_pct >= user_min]

    item_rows = (await db.execute(
        select(
            FeedLot.item_id, MasterItem.name_ru, MasterItem.name_en,
            MasterItem.icon_path, MasterItem.category, func.count().label("lots_count"),
        )
        .join(MasterItem, MasterItem.item_id == FeedLot.item_id)
        .where(*conds)
        .group_by(
            FeedLot.item_id, MasterItem.name_ru, MasterItem.name_en,
            MasterItem.icon_path, MasterItem.category,
        )
        .order_by(func.count().desc(), FeedLot.item_id)
    )).all()

    qlt_rows = (await db.execute(
        select(FeedLot.qlt, func.count()).where(*conds).group_by(FeedLot.qlt).order_by(FeedLot.qlt)
    )).all()
    ptn_rows = (await db.execute(
        select(FeedLot.ptn, func.count()).where(*conds).group_by(FeedLot.ptn).order_by(FeedLot.ptn)
    )).all()

    # Счётчики по группам набора. Ключ чипа — group, он же уходит обратно
    # параметром category в /feed/lots: подпись и фильтр обязаны считаться по
    # одному правилу, иначе чип обещает строки, которых фильтр не покажет.
    #
    # Строка вне групп в чипы не идёт: это предмет, выпавший из набора (снят с
    # торгов, удалён из каталога), его строки живут не дольше часа —
    # _finish_sweep_if_complete их убирает. Чип «Прочие» под такую строку был бы
    # некликабельным: значения вне FEED_GROUPS ручка /feed/lots отклоняет.
    categories: dict[str, int] = {}
    for row in item_rows:
        group = feed_item_group(row.category, row.name_ru)
        if group is None:
            continue
        categories[group] = categories.get(group, 0) + row.lots_count

    return FeedFiltersResponse(
        items=[
            FeedFilterItem(
                item_id=row.item_id, name_ru=row.name_ru, name_en=row.name_en,
                icon_path=row.icon_path, category=row.category, lots_count=row.lots_count,
            )
            for row in item_rows
        ],
        qualities=[
            FeedFilterBucket(value=value, label=_QLT_NAMES.get(value, str(value)), count=count)
            for value, count in qlt_rows
        ],
        enchants=[
            FeedFilterBucket(
                value=value, label="Без заточки" if value == 0 else f"+{value}", count=count,
            )
            for value, count in ptn_rows
        ],
        categories=[
            FeedFilterBucket(
                value=group, label=FEED_GROUP_LABELS.get(group, group), count=count,
            )
            for group, count in sorted(categories.items(), key=lambda kv: -kv[1])
        ],
        total_count=sum(row.lots_count for row in item_rows),
    )
