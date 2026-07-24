"""
Сервис «Радар рынка» — кросс-юзерная агрегация watchlist (аддон, не тариф).

Источник данных: user_watchlist (счётчики GROUP BY item_id, quality_filter,
enchant_filter), без новой Celery-задачи и без новой таблицы — on-the-fly
SQL-запрос с коротким Redis-кэшем (TTL 60 сек), см. docs/tasks/market-radar.md
(включая ревизии «группировка по качеству/заточке» и «метрика выгодных
предложений» в конце файла).

Уникальная строка топа = (item_id, quality_filter, enchant_filter) — один
физический предмет может занять несколько строк топ-20 одновременно, если
watcher'ы отслеживают его с разными фильтрами.

Метрики на строку:
  - watchers_count        — COUNT(DISTINCT user_id) среди активных watchlist-записей
  - new_watchers_24h       — из них добавили предмет за последние 24ч
  - avg_price_24h/sales_volume_24h/bulk_spike:
      * бакет quality_filter IS NULL AND enchant_filter IS NULL — из
        market_statistics (глобальная запись, user_id IS NULL), price_window="24h".
      * любой бакет с заданным фильтром — медиана SalesHistory.price_per_unit
        за 7 дней (все регионы вместе) через _build_sales_filter,
        price_window="7d". Пустой список цен -> null (ожидаемо при низком
        покрытии qlt/ptn в additional_info, не баг).
  - profitable_offers_count — число выгодных лотов (не watcher'ов!) в текущем
        снэпшоте аукциона для бакета, дедуплицированное по физическим лотам.
        Источник: последний глобальный CollectedData (user_id IS NULL) по
        каждому региону, где есть активные watcher'ы item_id бакета (без
        фильтра quality/enchant — снэпшот общий для всех бакетов item_id).
        sell_options считаются один раз на бакет из avg_price/sales_volume
        (та же ref-логика, что уже посчитана выше для avg_price_24h/
        sales_volume_24h — не пересчитываем параллельно). None, если
        avg_price бакета None (нет ориентира цены — тот же принцип, что у
        avg_price_24h).

Phase 1 не вводит порог анонимности — топ-20 показывает все строки
независимо от числа watcher'ов (подтверждено пользователем).

Ревизия 3 (пагинация + сортировка по выгодным лотам, см.
docs/tasks/market-radar-sort-pagination.md): список бакетов больше не
обрезается топ-20 по watchers_count на уровне SQL — считается
profitable_offers_count для ВСЕХ активных бакетов (с safety-cap
MAX_BUCKETS на исходном запросе, страховка от аномального роста watchlist,
сейчас 18 бакетов), затем весь список сортируется по profitable_offers_count
убыв. (None трактуется как 0). Кэшируется в Redis весь отсортированный
список (TTL не изменился), пагинация (page/page_size, по 20) — срез уже
закэшированного списка, без SQL LIMIT/OFFSET.
"""

import json
import logging
import statistics as _statistics
from datetime import datetime, timezone, timedelta

import redis.asyncio as aioredis
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.models import UserWatchlist, MasterItem, MarketStatistics, SalesHistory, CollectedData
from app.services.analytics.pricing import (
    _build_sales_filter, _lot_quality_enchant, _is_artefact, _is_liquid,
    make_sell_options, evaluate_lot_profit,
)

logger = logging.getLogger(__name__)

CACHE_KEY = "market_radar:aggregate"
CACHE_TTL = 60  # секунд

PAGE_SIZE = 20

MAX_BUCKETS = 500  # safety-cap количества бакетов в исходном SQL-запросе

SALES_WINDOW_DAYS = 7

SUGGEST_POPULAR_MIN_WATCHERS = 2  # порог мягкого флага «Популярное» в подсказках


async def _redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)


async def _count_profitable_offers(
    db: AsyncSession,
    item_id: str,
    quality_filter: int | None,
    enchant_filter: int | None,
    master: MasterItem | None,
    sell_options: list[dict],
) -> int:
    """
    Считает число выгодных физических лотов в текущем снэпшоте аукциона для
    бакета (item_id, quality_filter, enchant_filter), суммируя across все
    регионы, где есть активные watcher'ы item_id (без фильтра quality/enchant
    самого watcher'а — снэпшот общий для item_id, см. ревизию 2 п.2 ТЗ).

    Не зависит от watchers_count — каждый снэпшот региона проходится один раз
    независимо от того, сколько пользователей отслеживает бакет.
    """
    if master is None:
        return 0

    region_rows = (await db.execute(
        select(UserWatchlist.region)
        .where(UserWatchlist.item_id == item_id, UserWatchlist.is_active == True)
        .distinct()
    )).scalars().all()

    if not region_rows:
        return 0

    now = datetime.now(timezone.utc)
    is_art = _is_artefact(master.category)
    count = 0

    for region in region_rows:
        snap = (await db.execute(
            select(CollectedData)
            .where(
                CollectedData.item_id == item_id,
                CollectedData.region == region,
                CollectedData.user_id.is_(None),
            )
            .order_by(CollectedData.collect_time.desc())
            .limit(1)
        )).scalars().first()

        if snap is None or not snap.raw_lots:
            continue

        for lot in snap.raw_lots:
            buyout = lot.get("buyoutPrice", 0)
            amount = lot.get("amount", 1)
            if buyout <= 0 or amount <= 0:
                continue
            if not _is_liquid(lot, now):
                continue

            qlt_val, enchant = _lot_quality_enchant(lot, master, is_art)
            if quality_filter is not None and qlt_val != quality_filter:
                continue
            if enchant_filter is not None and enchant != enchant_filter:
                continue

            buyout_per_unit = buyout // amount

            evaluated = evaluate_lot_profit(
                buyout_per_unit, amount, sell_options,
                risk="low", min_margin_pct=0.0,
            )
            if evaluated is not None:
                count += 1

    return count


async def _read_cached_aggregate() -> dict | None:
    """Только чтение кэша агрегата (без пересчёта). None = кэш пуст/недоступен."""
    r = await _redis()
    try:
        cached = await r.get(CACHE_KEY)
        return json.loads(cached) if cached is not None else None
    except Exception as e:
        logger.warning(f"market_radar cache read error: {e}")
        return None
    finally:
        await r.aclose()


async def _get_cached_aggregate(db: AsyncSession) -> dict:
    """
    Полный агрегат Радара с Redis-кэшем (TTL CACHE_TTL). Источник для
    get_market_radar_aggregate (пагинация) — считаем не чаще раза в CACHE_TTL
    секунд. Прогрев кэша делает только этот (платный) путь; подсказки
    онбординга кэш НЕ греют (cache-read-only, см. get_watchlist_suggestions).
    """
    full = await _read_cached_aggregate()

    if full is None:
        full = await _calculate_market_radar_aggregate(db)

        r = await _redis()
        try:
            await r.setex(CACHE_KEY, CACHE_TTL, json.dumps(full))
        except Exception as e:
            logger.warning(f"market_radar cache write error: {e}")
        finally:
            await r.aclose()

    return full


async def get_market_radar_aggregate(db: AsyncSession, page: int = 1, page_size: int = PAGE_SIZE) -> dict:
    """
    Возвращает агрегат «Радара рынка»: все бакеты (item_id, quality_filter,
    enchant_filter), отсортированные по profitable_offers_count убыв.
    (None как 0) + прирост за 24ч + контекст цены/объёма. Полный отсортированный
    список кэшируется в Redis на CACHE_TTL секунд, пагинация — срез уже
    закэшированного списка (page/page_size), без повторного пересчёта.
    """
    full = await _get_cached_aggregate(db)

    total_count = len(full["top_items"])
    start = (page - 1) * page_size
    end = start + page_size
    page_items = full["top_items"][start:end]

    return {
        **full,
        "top_items": page_items,
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
    }


async def get_watchlist_suggestions(
    exclude_item_ids: set[str],
    limit: int = 6,
) -> list[dict]:
    """
    Обезличенные подсказки для пустого «Избранного»: топ предметов из уже
    закэшированного агрегата Радара, дедуплицированный по item_id.

    Cache-read-only: читает ТОЛЬКО готовый кэш и на промахе возвращает []
    (тяжёлый пересчёт агрегата НЕ запускается — иначе любой одобренный
    пользователь мог бы триггерить его через этот негейтированный эндпоинт,
    расширяя DoS-вектор; кэш греет только платный /market-radar).

    Возвращает slim-DTO БЕЗ числовых счётчиков (watchers/profit) — только
    мягкие флаги has_profitable / is_popular, чтобы не подрывать ценность
    платного Радара. Ранжирование: сначала предметы с выгодными лотами
    сейчас, затем по популярности. Если выгодных лотов сейчас нет ни у кого
    — has_profitable=False у всех, список ранжируется по популярности
    (пользователь добавляет предмет ради будущих сигналов, а не лота прямо
    сейчас). Пустой список — валиден (холодный старт / пустой кэш).
    """
    full = await _read_cached_aggregate()
    if full is None:
        return []

    # Дедуп по item_id: предмет может занимать несколько бакетов (разные
    # qlt/enchant) — берём максимум по каждой метрике.
    by_item: dict[str, dict] = {}
    for it in full["top_items"]:
        iid = it["item_id"]
        if iid in exclude_item_ids:
            continue
        # Пропускаем предметы без master-записи — их не показать (нет имени/иконки).
        if it.get("name_ru") is None and it.get("name_en") is None:
            continue
        prof = it.get("profitable_offers_count") or 0
        watchers = it.get("watchers_count") or 0
        cur = by_item.get(iid)
        if cur is None:
            by_item[iid] = {
                "item_id": iid,
                "name_ru": it.get("name_ru"),
                "name_en": it.get("name_en"),
                "icon_path": it.get("icon_path"),
                "_profit": prof,
                "_watchers": watchers,
            }
        else:
            cur["_profit"] = max(cur["_profit"], prof)
            cur["_watchers"] = max(cur["_watchers"], watchers)

    items = sorted(
        by_item.values(),
        key=lambda x: (x["_profit"] > 0, x["_profit"], x["_watchers"]),
        reverse=True,
    )[:limit]

    return [
        {
            "item_id": x["item_id"],
            "name_ru": x["name_ru"],
            "name_en": x["name_en"],
            "icon_path": x["icon_path"],
            "has_profitable": x["_profit"] > 0,
            "is_popular": x["_watchers"] >= SUGGEST_POPULAR_MIN_WATCHERS,
        }
        for x in items
    ]


async def _calculate_market_radar_aggregate(db: AsyncSession) -> dict:
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=SALES_WINDOW_DAYS)

    # ── 1. Все бакеты (item_id, quality_filter, enchant_filter) активного
    #       watchlist, с safety-cap MAX_BUCKETS (страховка от аномального
    #       роста — финальная сортировка по profitable_offers_count ниже,
    #       не по watchers_count) ─────────────────────────────────────────
    rows = (await db.execute(
        select(
            UserWatchlist.item_id,
            UserWatchlist.quality_filter,
            UserWatchlist.enchant_filter,
            func.count(func.distinct(UserWatchlist.user_id)).label("watchers_count"),
            func.count(func.distinct(UserWatchlist.user_id)).filter(
                UserWatchlist.created_at >= cutoff_24h
            ).label("new_watchers_24h"),
        )
        .where(UserWatchlist.is_active == True)
        .group_by(UserWatchlist.item_id, UserWatchlist.quality_filter, UserWatchlist.enchant_filter)
        .limit(MAX_BUCKETS)
    )).all()

    item_ids = [row.item_id for row in rows]

    # ── 2. Имена/иконки из master_items ────────────────────────────────────────
    items_by_id: dict[str, MasterItem] = {}
    if item_ids:
        master_rows = (await db.execute(
            select(MasterItem).where(MasterItem.item_id.in_(item_ids))
        )).scalars().all()
        items_by_id = {m.item_id: m for m in master_rows}

    # ── 3. Контекст цены/объёма для бакета NULL/NULL — из глобальной
    #       market_statistics (price_window="24h") ─────────────────────────────
    stats_by_id: dict[str, MarketStatistics] = {}
    if item_ids:
        stats_rows = (await db.execute(
            select(MarketStatistics).where(
                MarketStatistics.item_id.in_(item_ids),
                MarketStatistics.user_id.is_(None),
            )
        )).scalars().all()
        stats_by_id = {s.item_id: s for s in stats_rows}

    top_items = []
    for row in rows:
        master = items_by_id.get(row.item_id)
        has_filter = row.quality_filter is not None or row.enchant_filter is not None

        if not has_filter:
            stats = stats_by_id.get(row.item_id)
            avg_price = float(stats.avg_price_24h) if stats and stats.avg_price_24h is not None else None
            sales_volume = stats.sales_volume_24h if stats else None
            bulk_spike = (stats.demand_signals or {}).get("bulk_spike") if stats and stats.demand_signals else None
            price_window = "24h"
        else:
            extra_conds = _build_sales_filter(row.quality_filter, row.enchant_filter)
            prices = (await db.execute(
                select(SalesHistory.price_per_unit).where(
                    SalesHistory.item_id == row.item_id,
                    SalesHistory.sale_time >= cutoff_7d,
                    *extra_conds,
                )
            )).scalars().all()
            avg_price = float(_statistics.median(prices)) if prices else None
            sales_volume = len(prices) if prices else None
            bulk_spike = None
            price_window = "7d"

        if avg_price is None:
            profitable_offers_count = None
        else:
            sell_options = make_sell_options(int(avg_price), sales_volume)
            profitable_offers_count = await _count_profitable_offers(
                db, row.item_id, row.quality_filter, row.enchant_filter,
                master, sell_options,
            )

        top_items.append({
            "item_id": row.item_id,
            "quality_filter": row.quality_filter,
            "enchant_filter": row.enchant_filter,
            "name_ru": master.name_ru if master else None,
            "name_en": master.name_en if master else None,
            "icon_path": master.icon_path if master else None,
            "watchers_count": row.watchers_count,
            "new_watchers_24h": row.new_watchers_24h,
            "avg_price_24h": avg_price,
            "sales_volume_24h": sales_volume,
            "bulk_spike": bulk_spike,
            "price_window": price_window,
            "profitable_offers_count": profitable_offers_count,
        })

    # ── 3b. Финальная сортировка по profitable_offers_count убыв.
    #        (None трактуется как 0, см. docs/tasks/market-radar-sort-pagination.md) ──
    top_items.sort(
        key=lambda x: (x["profitable_offers_count"] or 0),
        reverse=True,
    )

    # ── 4. Сводная метрика ──────────────────────────────────────────────────
    total_active_entries = (await db.execute(
        select(func.count()).select_from(UserWatchlist).where(UserWatchlist.is_active == True)
    )).scalar_one()

    unique_items_subq = (
        select(UserWatchlist.item_id)
        .where(UserWatchlist.is_active == True)
        .distinct()
        .subquery()
    )
    unique_items_count = (await db.execute(
        select(func.count()).select_from(unique_items_subq)
    )).scalar_one()

    return {
        "top_items": top_items,
        "total_active_watchers": total_active_entries,
        "unique_items_tracked": unique_items_count,
        "calculated_at": now.isoformat(),
    }
