"""
Восстановление жизни лотов из истории снапшотов (P1-4, стартовый набор фазы B).

ТЗ: docs/tasks/history-lot-reconstruction.md. Обоснование и внешняя практика:
docs/tasks/sale-time-prediction-research.md.

Зачем. Кривой дожития нужны и продавшиеся, и НЕ продавшиеся лоты. Живой
сборщик (feed_collector, lot_observations) даёт и тех и других, но копит с
2026-08-16. История же уже лежит в collected_data.raw_lots: лот появился в
снапшоте — начало наблюдения, пропал — конец. Скрипт наполняет ТУ ЖЕ таблицу
lot_observations строками с source = 'snapshot'.

Почему снапшотам вообще можно верить. collectors.py:413 обрезает raw_lots до
200 самых дешёвых лотов, и в обрезанном срезе «продан» неотличим от «вытеснен
более дешёвым». Поэтому берутся ТОЛЬКО снапшоты, где обрезка не сработала
(< 200 лотов), и проверяется это НА КАЖДОМ снапшоте, а не по предмету целиком:
предмет переходит границу туда-обратно (замер на стенде: qoq6 — 44 % срезов
обрезаны, wg53 — 20 %), и смешивать обрезанные срезы с полными нельзя.

Чего скрипт НЕ делает:
  * ref_price_at_seen не восстанавливает (§2.4 ТЗ) — опора считалась по окну,
    которого уже нет; artifact_variant_stats хранит только текущее значение.
    Остаётся NULL, пересчёт по sales_history — работа фазы B;
  * в beat не добавляется, расписания нет — запуск только руками;
  * API не трогает вовсе: работа исключительно с накопленной БД.

Запуск (сначала обязательно сверка с живым источником, она ничего не пишет):

    docker compose exec backend python -m app.scripts.reconstruct_lot_history --verify
    docker compose exec backend python -m app.scripts.reconstruct_lot_history --days 7 --dry-run
    docker compose exec backend python -m app.scripts.reconstruct_lot_history --days 30

Идемпотентность: апсерт по (source, item_id, region, lot_key), first_seen_at
берётся как LEAST(сохранённое, новое) — повторный прогон не плодит дубли и не
сдвигает момент появления вперёд. Прогон на более широком окне может только
удревнить first_seen_at (и тогда же переписывает состояние стакана, снятое на
новом, более раннем первом наблюдении).
"""
import argparse
import asyncio
import logging
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("reconstruct_lot_history")

# collectors.py:413 — raw_lots = sorted(lots, key=lot_price_per_unit)[:200].
# Срез ровно с 200 лотами неотличим от обрезанного, поэтому «полный» = строго
# меньше 200.
SNAPSHOT_LOT_LIMIT = 200

# Разрыв между двумя ПОДРЯД ИДУЩИМИ пригодными снапшотами, после которого
# исчезновение лота перестаёт быть наблюдением (§4.3 ТЗ). Сбор встаёт от
# рестартов, 429 и парковки предметов; без этого правила каждая пауза
# превратилась бы в пачку фальшивых «снятий», а доля withdrawn — в артефакт
# инфраструктуры. Шаг обхода watchlist — около минуты, 15 мин перекрывают его
# с запасом и при этом составляют 0.5 % от 48-часовой жизни лота.
MAX_GAP_MINUTES = 15

# §4.5 ТЗ: хронически обрезанные предметы исключаются ЦЕЛИКОМ, а не частично.
# У такого предмета пригодные срезы редки и разбросаны, между ними почти всегда
# дыра больше MAX_GAP — толку от него нет, а смешение двух режимов сбора в
# одной выборке есть. Порог — граница между «изредка перешагнул 200» (такие
# срезы просто пропускаются) и «живёт за границей».
MAX_TRUNCATED_SHARE = 0.10

# Неполный срез: сбор вернул заметно меньше лотов, чем минуту назад. Замер на
# стенде (jkq7, 2026-07-17 18:36): 102 -> 50 -> 102 лота за две минуты — сбоит
# пагинация /lots, и в базу ложится ПОДМНОЖЕСТВО рынка. Формально такой срез не
# обрезан (< 200 лотов), но выводить из него исчезновение лота нельзя ровно по
# той же причине, что из обрезанного: лота нет в списке, а на рынке он есть.
# Срез целиком выбрасывается из хронологии — получается дырка на один шаг
# обхода, которую разбирает общее правило MAX_GAP.
DEFECT_RATIO = 0.7          # упал больше чем на 30% за шаг -> срез неполный
DEFECT_MIN_LOTS = 20        # на мелких стаканах такой перепад — обычное дело

SNAPSHOT_CHUNK = 200        # снапшотов за один запрос при стриминге
ARTEFACT_CATEGORY = "artefact%"

# Состояние наблюдения к моменту записи.
STATE_RESOLVABLE = "resolvable"   # лот исчез при живом сборе -> исход считаем
STATE_GAP        = "gap"          # исчез на дыре в сборе -> цензурируем
STATE_OPEN       = "open"         # дожил до конца окна -> цензурируем


# ─── Восстановление по одной паре (item_id, region) ──────────────────────────

@dataclass
class ItemReport:
    """Счётчики смещений §4 ТЗ по одной паре (item_id, region)."""
    snapshots: int = 0
    partial_skipped: int = 0
    lots: int = 0
    left_truncated: int = 0
    censored_gap: int = 0
    censored_admin: int = 0
    resurrected: int = 0
    gaps: int = 0
    intervals: list = field(default_factory=list)          # секунды между срезами
    outcomes: Counter = field(default_factory=Counter)


class LotHistoryReconstructor:
    """
    Разворачивает поток снапшотов одной пары (item_id, region) в наблюдения.

    Состояние намеренно крошечное: словарь лотов и множество живых ключей.
    Снапшоты подаются по одному (push) и тут же забываются — 6.57 млн срезов
    по ~150 лотов в лоб не поместятся никуда (§3 ТЗ).

    Разбор одного снапшота:
      * ключ есть сейчас, не было раньше — новое наблюдение, first_seen_at =
        collect_time этого среза, состояние стакана считается по нему же;
      * ключ был и есть — продлеваем last_seen_at, ОСТАЛЬНОЕ не трогаем:
        queue_rank и соседи — снимок условий, в которых лот был выставлен;
      * ключ был, сейчас нет — наблюдение закрывается на ПРЕДЫДУЩЕМ срезе.
        Если до него дыра больше max_gap, исход не считается: лот мог исчезнуть
        не с рынка, а из сбора;
      * ключ вернулся после исчезновения — то же наблюдение продолжается
        (lot_key содержит startTime с точностью до секунды, цену и количество:
        «другой лот с тем же ключом» практически невозможен, а вот пропуск лота
        в одном срезе — вполне). Считаем такие случаи отдельно: это мера
        надёжности источника.

    Лоты, дожившие до последнего среза окна, цензурируются административно
    (§2.1.4 ТЗ) — outcome остаётся NULL, «снятыми» они не объявляются.
    """

    def __init__(self, item_id: str, region: str, max_gap: timedelta):
        from app.tasks.feed_collector import LOT_OBS_SOURCE_SNAPSHOT

        self.item_id = item_id
        self.region = region
        self.max_gap = max_gap
        self.source = LOT_OBS_SOURCE_SNAPSHOT

        self.lots: dict[str, dict] = {}     # lot_key -> строка наблюдения
        self.open: set[str] = set()         # ключи, живые на последнем срезе
        self.prev_time: datetime | None = None
        self.prev_count: int | None = None  # размер последнего ПРИНЯТОГО среза
        self.pending_small: int | None = None
        self.report = ItemReport()

    def push(self, collect_time: datetime, raw_lots: list) -> None:
        from app.tasks.feed_collector import observation_rows

        lots = raw_lots or []
        gap = None if self.prev_time is None else collect_time - self.prev_time

        if self._is_partial(len(lots), gap):
            # Срез не входит в хронологию вовсе: prev_time не двигаем, поэтому
            # следующий шаг измерится от последнего полноценного среза.
            self.report.partial_skipped += 1
            self.pending_small = len(lots)
            return
        self.pending_small = None

        # variants={} — ref_price_at_seen осознанно NULL (§2.4 ТЗ): опору на
        # момент наблюдения задним числом не восстановить.
        current = {
            row["lot_key"]: row
            for row in observation_rows(self.item_id, self.region, lots, {}, collect_time)
        }

        if gap is not None:
            self.report.intervals.append(gap.total_seconds())
        censoring_gap = gap is not None and gap > self.max_gap
        if censoring_gap:
            self.report.gaps += 1

        for key in list(self.open):
            if key in current:
                continue
            self.open.discard(key)
            # last_seen_at строки уже стоит на предыдущем срезе — там лот и
            # видели в последний раз.
            self.lots[key]["_state"] = STATE_GAP if censoring_gap else STATE_RESOLVABLE
            if censoring_gap:
                self.report.censored_gap += 1

        for key, row in current.items():
            known = self.lots.get(key)
            if known is None:
                row["source"] = self.source
                row["_state"] = STATE_OPEN
                self.lots[key] = row
                self.open.add(key)
                self.report.lots += 1
                if self._left_truncated(row):
                    self.report.left_truncated += 1
                continue

            known["last_seen_at"] = collect_time
            if key not in self.open:
                # Лот вернулся: прошлое исчезновение было ложным — вместе с
                # состоянием откатывается и счётчик цензурирования, иначе
                # отчёт припишет дырам то, чего не было.
                if known["_state"] == STATE_GAP:
                    self.report.censored_gap -= 1
                self.open.add(key)
                known["_state"] = STATE_OPEN
                self.report.resurrected += 1

        self.prev_time = collect_time
        self.prev_count = len(lots)
        self.report.snapshots += 1

    def _is_partial(self, count: int, gap: timedelta | None) -> bool:
        """
        Срез отдаёт заметно меньше лотов, чем предыдущий, — сбой пагинации.

        Проверка односторонняя (только провал вниз) и работает лишь на коротком
        шаге: после дыры в сборе стакан имеет полное право измениться, и там
        решение принимает MAX_GAP. Настоящий обвал рынка от сбоя отличается
        повторением: если следующий срез такой же маленький, он принимается как
        новая норма, и потеряна оказывается ровно одна точка обхода.
        """
        if self.prev_count is None or gap is None or gap > self.max_gap:
            return False
        if self.prev_count < DEFECT_MIN_LOTS:
            return False
        if count >= DEFECT_RATIO * self.prev_count:
            return False
        return self.pending_small is None or count < DEFECT_RATIO * self.pending_small

    def close(self) -> None:
        """Конец окна: всё, что ещё живо, цензурируется административно."""
        self.report.censored_admin = len(self.open)
        for key in self.open:
            self.lots[key]["_state"] = STATE_OPEN
        self.open.clear()

    def _left_truncated(self, row: dict) -> bool:
        """
        Лот, впервые увиденный сильно позже выставления, вошёл в выборку в
        середине жизни (§4.2 ТЗ). Порог — max_gap: при исправном сборе соседние
        пригодные срезы ближе, значит лот, чей startTime не старше max_gap,
        увиден практически от рождения. Колонки под флаг нет намеренно —
        признак считается из first_seen_at и start_time одним и тем же
        правилом и в отчёте скрипта, и в фазе B.
        """
        start = row.get("start_time")
        return start is None or (row["first_seen_at"] - start) > self.max_gap

    @property
    def rows(self) -> list[dict]:
        return list(self.lots.values())


def classify_rows(
    rows: list[dict],
    sales_by_variant: dict,
    used_sale_ids: set,
    resolved_at: datetime,
) -> Counter:
    """
    Исходы восстановленных наблюдений — ТЕМ ЖЕ матчером, что у живого резолвера.

    Второго матчера здесь нет и быть не должно: resolve_batch расходует сделки
    (одна сделка закрывает максимум одно наблюдение) и раздаёт их
    детерминированно — наблюдения от старейшего, сделки от ранней. Без расхода
    одна продажа помечала sold все неразличимые лоты варианта; ровно этот баг
    чинили в живом сборе (миграция 0041), воспроизводить его в истории незачем.

    В матчинг идут ТОЛЬКО наблюдения с состоянием resolvable. Цензурированные
    (дыра в сборе, конец окна) сделок не потребляют: мы не знаем их судьбы, а
    занятая ими сделка не досталась бы тому, чья судьба известна.

    Суррогатный id — не индекс в списке, а место в порядке (first_seen_at,
    start_time, lot_key). resolve_batch разрешает равенство first_seen_at по
    id, а у восстановления оно массовое: все лоты одного среза увидены в одну
    секунду. С id «по порядку в raw_lots» сделка доставалась бы лоту в
    зависимости от сортировки JSON-массива, и один и тот же вход давал бы
    разные исходы. Тай-брейк по start_time содержателен: старшая заявка на
    сделку — у того, кто выставлен раньше.
    """
    from app.tasks.feed_collector import resolve_batch

    candidates = sorted(
        (row for row in rows if row["_state"] == STATE_RESOLVABLE),
        key=lambda row: (row["first_seen_at"], row["start_time"] or row["first_seen_at"], row["lot_key"]),
    )
    observations = [SimpleNamespace(id=i, **row) for i, row in enumerate(candidates)]
    outcomes = resolve_batch(observations, sales_by_variant, used_sale_ids)

    stats: Counter = Counter()
    for i, row in enumerate(candidates):
        outcome, sale_id = outcomes[i]
        row["outcome"] = outcome
        row["matched_sale_id"] = sale_id
        stats[outcome] += 1

    for row in rows:
        row.setdefault("outcome", None)
        row.setdefault("matched_sale_id", None)
        # resolved_at ставится и цензурированным: для восстановленной строки он
        # означает «скрипт с ней разобрался». Иначе цензурированные строки
        # никогда не попадут под ретеншен delete_old_data (он идёт по
        # resolved_at), а живой резолвер их и так не увидит — он работает
        # только с source='live'.
        row["resolved_at"] = resolved_at
        if row["outcome"] is None:
            stats["censored"] += 1

    return stats


# ─── Доступ к БД ─────────────────────────────────────────────────────────────

async def select_pairs(db, since: datetime, until: datetime) -> list[SimpleNamespace]:
    """
    Пары (item_id, region) артефактов со снапшотами в окне + статистика обрезки.

    Только глобальные автоснапшоты (user_id IS NULL): ручной refresh
    пользователя даёт внеочередной срез той же пары и в хронологию сбора не
    ложится.
    """
    from sqlalchemy import func, select
    from app.models.models import CollectedData, MasterItem

    truncated = func.count().filter(
        func.jsonb_array_length(CollectedData.raw_lots) >= SNAPSHOT_LOT_LIMIT
    )
    rows = (await db.execute(
        select(
            CollectedData.item_id, CollectedData.region,
            func.count().label("snapshots"), truncated.label("truncated"),
        )
        .join(MasterItem, MasterItem.item_id == CollectedData.item_id)
        .where(
            CollectedData.user_id.is_(None),
            MasterItem.category.like(ARTEFACT_CATEGORY),
            CollectedData.raw_lots.is_not(None),
            CollectedData.collect_time >= since,
            CollectedData.collect_time < until,
        )
        .group_by(CollectedData.item_id, CollectedData.region)
        .order_by(CollectedData.item_id, CollectedData.region)
    )).all()

    return [
        SimpleNamespace(
            item_id=row.item_id, region=row.region,
            snapshots=row.snapshots, truncated=row.truncated,
            share=row.truncated / row.snapshots if row.snapshots else 1.0,
        )
        for row in rows
    ]


async def iter_snapshots(db, item_id: str, region: str, since: datetime, until: datetime):
    """
    Пригодные снапшоты пары по возрастанию времени, порциями.

    Обрезанные срезы отсекаются здесь же — в Python они не попадают вовсе, а
    оставшаяся от них дыра во времени разбирается общим правилом MAX_GAP.
    Курсор по (collect_time, id): OFFSET на десятках тысяч строк заставил бы
    Postgres перечитывать хвост на каждой порции.
    """
    from sqlalchemy import and_, func, or_, select
    from app.models.models import CollectedData

    cursor_time, cursor_id = since, -1
    while True:
        chunk = (await db.execute(
            select(CollectedData.id, CollectedData.collect_time, CollectedData.raw_lots)
            .where(
                CollectedData.user_id.is_(None),
                CollectedData.item_id == item_id,
                CollectedData.region == region,
                CollectedData.collect_time < until,
                CollectedData.raw_lots.is_not(None),
                func.jsonb_array_length(CollectedData.raw_lots) < SNAPSHOT_LOT_LIMIT,
                or_(
                    CollectedData.collect_time > cursor_time,
                    and_(
                        CollectedData.collect_time == cursor_time,
                        CollectedData.id > cursor_id,
                    ),
                ),
            )
            .order_by(CollectedData.collect_time, CollectedData.id)
            .limit(SNAPSHOT_CHUNK)
        )).all()

        if not chunk:
            return
        for row in chunk:
            yield row
        cursor_time, cursor_id = chunk[-1].collect_time, chunk[-1].id


async def load_sales(db, item_id: str, region: str, since: datetime, until: datetime) -> dict:
    """Сделки предмета в окне, разложенные по варианту — вход resolve_batch."""
    from sqlalchemy import select
    from app.models.models import SalesHistory
    from app.services.analytics.variant_stats import variant_key
    from app.tasks.feed_collector import LOT_OBS_RESOLVE_DELAY_HOURS

    rows = (await db.execute(
        select(
            SalesHistory.id, SalesHistory.sale_time, SalesHistory.total_price,
            SalesHistory.amount, SalesHistory.additional_info,
        ).where(
            SalesHistory.item_id == item_id,
            SalesHistory.region == region,
            SalesHistory.sale_time >= since,
            # Продажа могла случиться уже после того, как лот пропал из среза —
            # та же верхняя граница окна, что у sale_matches.
            SalesHistory.sale_time <= until + timedelta(hours=LOT_OBS_RESOLVE_DELAY_HOURS),
        )
    )).all()

    by_variant: dict = {}
    for sale in rows:
        qlt, ptn = variant_key(sale.additional_info)
        by_variant.setdefault((item_id, region, qlt, ptn), []).append(
            (sale.sale_time, sale.id, sale.total_price, sale.amount)
        )
    return by_variant


async def load_used_sales(db, item_id: str, region: str, keys: set) -> set:
    """
    Сделки, занятые ПРОШЛЫМИ прогонами за пределами нынешнего набора строк.

    Свои строки (их ключи в keys) прогон переписывает целиком, поэтому их
    сделки снова свободны. А вот наблюдение, оставшееся от более широкого окна,
    свою сделку удерживает — отдать её второй раз нельзя.
    """
    from sqlalchemy import select
    from app.models.models import LotObservation
    from app.tasks.feed_collector import LOT_OBS_SOURCE_SNAPSHOT

    rows = (await db.execute(
        select(LotObservation.lot_key, LotObservation.matched_sale_id).where(
            LotObservation.source == LOT_OBS_SOURCE_SNAPSHOT,
            LotObservation.item_id == item_id,
            LotObservation.region == region,
            LotObservation.matched_sale_id.is_not(None),
        )
    )).all()
    return {row.matched_sale_id for row in rows if row.lot_key not in keys}


def upsert_statement(chunk: list[dict]):
    """
    INSERT ... ON CONFLICT для порции наблюдений (вынесено ради тестируемости).

    first_seen_at — LEAST: повторный прогон не сдвигает момент появления
    вперёд, а прогон на более широком окне может только удревнить его
    (требование идемпотентности, §3 ТЗ). Состояние стакана переписывается
    ровно тогда, когда first_seen_at удревнился: иначе в строке осталась бы
    очередь, снятая на другом — более позднем — первом наблюдении.

    matched_sale_id в INSERT не идёт и обнуляется при конфликте: раздача сделок
    могла измениться, и «сделка 77 переезжает со строки A на строку B» внутри
    одного оператора — гарантированное нарушение уникального индекса. Ссылки
    проставляются отдельным UPDATE после того, как все строки записаны.
    """
    from sqlalchemy import case, func, literal_column, null
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.models import LotObservation

    payload = [
        {key: value for key, value in row.items()
         if not key.startswith("_") and key != "matched_sale_id"}
        for row in chunk
    ]
    stmt = pg_insert(LotObservation).values(payload)
    earlier = stmt.excluded.first_seen_at < LotObservation.first_seen_at

    return stmt.on_conflict_do_update(
        index_elements=["source", "item_id", "region", "lot_key"],
        set_={
            "first_seen_at": func.least(LotObservation.first_seen_at, stmt.excluded.first_seen_at),
            "last_seen_at":  stmt.excluded.last_seen_at,
            "outcome":       stmt.excluded.outcome,
            "resolved_at":   stmt.excluded.resolved_at,
            "matched_sale_id": null(),
            "queue_rank":    case((earlier, stmt.excluded.queue_rank), else_=LotObservation.queue_rank),
            "cheaper_units": case((earlier, stmt.excluded.cheaper_units), else_=LotObservation.cheaper_units),
            "variant_live_lots": case(
                (earlier, stmt.excluded.variant_live_lots), else_=LotObservation.variant_live_lots,
            ),
        },
    ).returning(
        LotObservation.id, LotObservation.lot_key,
        literal_column("(xmax = 0)").label("is_insert"),
    )


async def write_rows(db, rows: list[dict]) -> tuple[int, int]:
    """Запись наблюдений пары одной транзакцией. Возвращает (вставлено, обновлено)."""
    from sqlalchemy import update
    from app.models.models import LotObservation
    from app.tasks.feed_collector import LOT_OBS_UPSERT_CHUNK

    if not rows:
        return 0, 0

    inserted = updated = 0
    ids: dict[str, int] = {}
    for start in range(0, len(rows), LOT_OBS_UPSERT_CHUNK):
        chunk = rows[start:start + LOT_OBS_UPSERT_CHUNK]
        for row in (await db.execute(upsert_statement(chunk))).all():
            ids[row.lot_key] = row.id
            if row.is_insert:
                inserted += 1
            else:
                updated += 1

    matched = [
        {"id": ids[row["lot_key"]], "matched_sale_id": row["matched_sale_id"]}
        for row in rows if row.get("matched_sale_id") is not None
    ]
    if matched:
        await db.execute(
            update(LotObservation).execution_options(synchronize_session=None), matched,
        )

    await db.commit()
    return inserted, updated


# ─── Сводка и сверка с живым источником (§5.2 ТЗ) ────────────────────────────

def summarize(rows: list[dict]) -> dict:
    """
    Одна и та же сводка для восстановленных и живых наблюдений.

    Доли исходов считаются от ЗАКРЫТЫХ строк: у живого источника хвост окна
    всегда не резолвлен (RESOLVE_DELAY = 2 ч), у восстановления хвост
    цензурирован административно — сравнивать их с открытыми в знаменателе
    значит сравнивать возраст выборок, а не рынок.
    """
    closed = [row for row in rows if row.get("outcome")]
    counts = Counter(row["outcome"] for row in closed)
    sold = [row for row in closed if row["outcome"] == "sold"]
    total = len(closed)

    def _median_hours(items, field_name):
        values = [
            (row["last_seen_at"] - row[field_name]).total_seconds() / 3600
            for row in items if row.get(field_name)
        ]
        return round(statistics.median(values), 2) if values else None

    summary = {
        "rows": len(rows),
        "closed": total,
        "censored": len(rows) - total,
        "sold_median_observed_h": _median_hours(sold, "first_seen_at"),
        "sold_median_full_h": _median_hours(sold, "start_time"),
    }
    for outcome in ("sold", "expired", "withdrawn"):
        summary[outcome] = counts[outcome]
        summary[f"{outcome}_pct"] = round(100 * counts[outcome] / total, 1) if total else None
    return summary


async def load_live_rows(db, pairs: list, since: datetime, until: datetime) -> list[dict]:
    """Живые наблюдения тех же пар в том же окне — эталон сверки §5.2."""
    from sqlalchemy import or_, and_, select
    from app.models.models import LotObservation
    from app.tasks.feed_collector import LOT_OBS_SOURCE_LIVE

    if not pairs:
        return []

    rows = (await db.execute(
        select(
            LotObservation.lot_key, LotObservation.start_time, LotObservation.first_seen_at,
            LotObservation.last_seen_at, LotObservation.outcome,
        ).where(
            LotObservation.source == LOT_OBS_SOURCE_LIVE,
            LotObservation.first_seen_at >= since,
            LotObservation.first_seen_at < until,
            or_(*[
                and_(LotObservation.item_id == pair.item_id, LotObservation.region == pair.region)
                for pair in pairs
            ]),
        )
    )).all()
    return [dict(row._mapping) for row in rows]


async def live_window(db, pairs: list) -> tuple[datetime | None, datetime | None]:
    """Границы окна, где живой источник вообще что-то видел."""
    from sqlalchemy import and_, func, or_, select
    from app.models.models import LotObservation
    from app.tasks.feed_collector import LOT_OBS_SOURCE_LIVE

    if not pairs:
        return None, None

    row = (await db.execute(
        select(func.min(LotObservation.first_seen_at), func.max(LotObservation.last_seen_at))
        .where(
            LotObservation.source == LOT_OBS_SOURCE_LIVE,
            or_(*[
                and_(LotObservation.item_id == pair.item_id, LotObservation.region == pair.region)
                for pair in pairs
            ]),
        )
    )).first()
    return row[0], row[1]


def print_comparison(restored: list[dict], live: list[dict]) -> bool:
    """
    Печатает сверку восстановления с живым источником и возвращает вердикт.

    Порог «в разы» из ТЗ переведён в числа: доли исходов — не дальше 10 п.п.,
    медиана времени жизни проданных — не дальше двух раз. Расхождение больше
    означает ошибку восстановления, а не свойство рынка: оба источника смотрят
    на один и тот же рынок в одно и то же время.
    """
    left, right = summarize(restored), summarize(live)
    keys = {row["lot_key"] for row in restored} & {row["lot_key"] for row in live}

    print("\n=== §5.2 Сверка с живым источником ===")
    print(f"{'метрика':<34}{'snapshot':>14}{'live':>14}{'расхождение':>16}")
    verdict = True
    for label, key, unit in (
        ("наблюдений всего", "rows", ""),
        ("закрыто", "closed", ""),
        ("цензурировано", "censored", ""),
    ):
        print(f"{label:<34}{left[key]:>14}{right[key]:>14}{'':>16}")

    for label, key in (
        ("доля sold, %", "sold_pct"),
        ("доля expired, %", "expired_pct"),
        ("доля withdrawn, %", "withdrawn_pct"),
    ):
        a, b = left[key], right[key]
        if a is None or b is None:
            print(f"{label:<34}{str(a):>14}{str(b):>14}{'нет данных':>16}")
            verdict = False
            continue
        delta = round(a - b, 1)
        if abs(delta) > 10:
            verdict = False
        print(f"{label:<34}{a:>14}{b:>14}{delta:>+15} п.п.")

    for label, key in (
        ("медиана жизни sold (набл.), ч", "sold_median_observed_h"),
        ("медиана жизни sold (от start), ч", "sold_median_full_h"),
    ):
        a, b = left[key], right[key]
        if a is None or b is None:
            print(f"{label:<34}{str(a):>14}{str(b):>14}{'нет данных':>16}")
            verdict = False
            continue
        ratio = a / b if b else None
        if ratio is not None and not 0.5 <= ratio <= 2.0:
            verdict = False
        print(f"{label:<34}{a:>14}{b:>14}{('x%.2f' % ratio) if ratio else '—':>16}")

    print(f"{'лотов увидели оба источника':<34}{len(keys):>14}")
    print(
        "\nВЕРДИКТ: восстановление СОГЛАСУЕТСЯ с живым источником."
        if verdict else
        "\nВЕРДИКТ: расхождение выше допустимого — таблицу НЕ наполнять, разбираться."
    )
    return verdict


# ─── Общий отчёт (§4 ТЗ) ─────────────────────────────────────────────────────

@dataclass
class Report:
    since: datetime
    until: datetime
    max_gap: timedelta
    max_truncated_share: float
    pairs_total: int = 0
    taken: list = field(default_factory=list)
    dropped: list = field(default_factory=list)
    snapshots_total: int = 0
    snapshots_truncated: int = 0
    snapshots_used: int = 0
    intervals: list = field(default_factory=list)
    gaps: int = 0
    lots: int = 0
    left_truncated: int = 0
    censored_gap: int = 0
    censored_admin: int = 0
    resurrected: int = 0
    outcomes: Counter = field(default_factory=Counter)
    inserted: int = 0
    updated: int = 0

    snapshots_partial: int = 0

    def absorb(self, item: ItemReport) -> None:
        self.snapshots_used += item.snapshots
        self.snapshots_partial += item.partial_skipped
        self.intervals.extend(item.intervals)
        self.gaps += item.gaps
        self.lots += item.lots
        self.left_truncated += item.left_truncated
        self.censored_gap += item.censored_gap
        self.censored_admin += item.censored_admin
        self.resurrected += item.resurrected
        self.outcomes.update(item.outcomes)


def _pct(part: int, whole: int) -> str:
    return f"{100 * part / whole:.1f}%" if whole else "—"


def print_report(report: Report, dry_run: bool) -> None:
    print("\n=== Восстановление жизни лотов из снапшотов ===")
    print(f"Окно: {report.since:%Y-%m-%d %H:%M} .. {report.until:%Y-%m-%d %H:%M}"
          f" | MAX_GAP {int(report.max_gap.total_seconds() // 60)} мин"
          f" | порог обрезки {report.max_truncated_share:.0%}"
          f"{' | DRY-RUN, ничего не записано' if dry_run else ''}")

    print("\n§4.1 Отбор предметов (смещение: наблюдаемы только предметы чьего-то watchlist)")
    print(f"  пар (item_id, region) с артефактами в окне: {report.pairs_total}")
    print(f"  взято: {len(report.taken)}   отброшено: {len(report.dropped)}")
    for pair, reason in report.dropped:
        print(f"    - {pair.item_id}/{pair.region}: {reason} "
              f"(срезов {pair.snapshots}, обрезано {pair.truncated}, {pair.share:.1%})")

    print("\n§4.5 Обрезка стакана (снапшоты взятых пар)")
    print(f"  снапшотов всего: {report.snapshots_total}, "
          f"обрезанных пропущено: {report.snapshots_truncated} "
          f"({_pct(report.snapshots_truncated, report.snapshots_total)}), "
          f"неполных (сбой пагинации) пропущено: {report.snapshots_partial} "
          f"({_pct(report.snapshots_partial, report.snapshots_total)}), "
          f"использовано: {report.snapshots_used}")

    print("\n§4.4 Шаг обхода (точность момента исчезновения)")
    if report.intervals:
        ordered = sorted(report.intervals)
        p90 = ordered[min(len(ordered) - 1, int(0.9 * len(ordered)))]
        print(f"  медиана {statistics.median(ordered):.0f} с, p90 {p90:.0f} с, "
              f"максимум {ordered[-1] / 60:.0f} мин")
    else:
        print("  интервалов нет")

    print("\n§4.3 Дыры в сборе")
    print(f"  разрывов больше MAX_GAP: {report.gaps}")
    print(f"  наблюдений цензурировано по дырам: {report.censored_gap} "
          f"({_pct(report.censored_gap, report.lots)} от всех)")

    print("\n§4.2 Левое усечение")
    print(f"  наблюдений всего: {report.lots}")
    print(f"  левоусечённых (first_seen_at - start_time > MAX_GAP): {report.left_truncated} "
          f"({_pct(report.left_truncated, report.lots)})")

    closed = sum(report.outcomes[key] for key in ("sold", "expired", "withdrawn"))
    print("\nИсходы")
    print(f"  закрыто: {closed}")
    for outcome in ("sold", "expired", "withdrawn"):
        print(f"    {outcome:<10} {report.outcomes[outcome]:>8}  {_pct(report.outcomes[outcome], closed)}")
    print(f"  цензурировано: {report.outcomes['censored']} "
          f"(по дырам {report.censored_gap}, административно {report.censored_admin})")
    print(f"  возвратов лота после ложного исчезновения: {report.resurrected}")

    if not dry_run:
        print(f"\nЗапись: вставлено {report.inserted}, обновлено {report.updated}")


# ─── Прогон ──────────────────────────────────────────────────────────────────

async def reconstruct_pair(db, pair, since, until, max_gap, now, dry_run):
    """Полный цикл по одной паре: стриминг -> исходы -> запись."""
    worker = LotHistoryReconstructor(pair.item_id, pair.region, max_gap)
    async for snapshot in iter_snapshots(db, pair.item_id, pair.region, since, until):
        worker.push(snapshot.collect_time, snapshot.raw_lots)
    worker.close()

    rows = worker.rows
    if not rows:
        return worker.report, [], (0, 0)

    sales = await load_sales(db, pair.item_id, pair.region, since, until)
    used = await load_used_sales(db, pair.item_id, pair.region, {row["lot_key"] for row in rows})
    worker.report.outcomes = classify_rows(rows, sales, used, now)

    written = (0, 0) if dry_run else await write_rows(db, rows)
    return worker.report, rows, written


def split_pairs(pairs: list, args) -> tuple[list, list]:
    """Отбор §4.1 + §4.5: что берём и что отбрасываем, с причиной."""
    if args.items:
        wanted = set(args.items.split(","))
        pairs = [pair for pair in pairs if pair.item_id in wanted]
    if args.region:
        pairs = [pair for pair in pairs if pair.region == args.region]

    taken, dropped = [], []
    for pair in pairs:
        if pair.snapshots == pair.truncated:
            dropped.append((pair, "нет ни одного полного среза"))
        elif pair.share > args.max_truncated_share:
            dropped.append((pair, "хронически обрезан"))
        else:
            taken.append(pair)
    return taken, dropped


async def run(args) -> int:
    from app.db.session import get_celery_db_session as get_db_session

    now = datetime.now(timezone.utc)
    max_gap = timedelta(minutes=args.max_gap_min)
    # --until нужен, чтобы мерить на окне, где сбор шёл плотно: у прерывистой
    # истории доля withdrawn завышена не рынком, а простоем сборщика.
    until = args.until or now
    since = until - timedelta(days=args.days)
    dry_run = args.dry_run or args.verify

    async with get_db_session() as db:
        taken, dropped = split_pairs(await select_pairs(db, since, until), args)

        if args.verify:
            # Сверка идёт по окну, где живой источник вообще существует, иначе
            # восстановление сравнивалось бы с пустотой. Набор пар после
            # сужения окна пересчитывается: доля обрезки за сутки и за месяц —
            # разные числа, а сравнивать надо ровно то, что восстанавливаем.
            live_since, live_until = await live_window(db, taken)
            if live_since is None:
                print("Живых наблюдений по взятым парам нет — сверять не с чем.")
                return 2
            since, until = live_since, live_until
            logger.info("Сверка на окне живого источника: %s .. %s", since, until)
            taken, dropped = split_pairs(await select_pairs(db, since, until), args)

        report = Report(since, until, max_gap, args.max_truncated_share)
        report.taken, report.dropped = taken, dropped
        report.pairs_total = len(taken) + len(dropped)
        for pair in report.taken:
            report.snapshots_total += pair.snapshots
            report.snapshots_truncated += pair.truncated

        restored: list[dict] = []
        for i, pair in enumerate(report.taken, start=1):
            item_report, rows, (inserted, updated) = await reconstruct_pair(
                db, pair, since, until, max_gap, now, dry_run,
            )
            report.absorb(item_report)
            report.inserted += inserted
            report.updated += updated
            if args.verify:
                restored.extend(rows)
            logger.info(
                "[%s/%s] %s/%s: срезов %s, лотов %s, закрыто %s, цензурировано %s "
                "(дыры %s, конец окна %s)%s",
                i, len(report.taken), pair.item_id, pair.region, item_report.snapshots,
                item_report.lots,
                sum(item_report.outcomes[key] for key in ("sold", "expired", "withdrawn")),
                item_report.outcomes["censored"], item_report.censored_gap,
                item_report.censored_admin,
                "" if dry_run else f", записано {inserted}+{updated}",
            )

        print_report(report, dry_run)

        if args.verify:
            live = await load_live_rows(db, report.taken, since, until)
            if not live:
                print("Живых наблюдений в окне не нашлось — сверка невозможна.")
                return 2
            return 0 if print_comparison(restored, live) else 1

    return 0


def _iso_utc(value: str) -> datetime:
    """Дата/время из аргумента; без указанной зоны считаем UTC."""
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def main():
    parser = argparse.ArgumentParser(
        description="Восстановление жизни лотов из collected_data в lot_observations.",
    )
    parser.add_argument("--days", type=int, default=30, help="Глубина окна в днях (default: 30)")
    parser.add_argument(
        "--until", type=_iso_utc,
        help="Правая граница окна, ISO (по умолчанию — сейчас). Левая = until - days",
    )
    parser.add_argument("--items", help="Ограничить набор: item_id через запятую")
    parser.add_argument("--region", help="Ограничить регион")
    parser.add_argument(
        "--max-gap-min", type=int, default=MAX_GAP_MINUTES,
        help=f"Разрыв в сборе, после которого лот цензурируется (default: {MAX_GAP_MINUTES})",
    )
    parser.add_argument(
        "--max-truncated-share", type=float, default=MAX_TRUNCATED_SHARE,
        help=f"Доля обрезанных срезов, выше которой предмет отбрасывается целиком "
             f"(default: {MAX_TRUNCATED_SHARE})",
    )
    parser.add_argument("--dry-run", action="store_true", help="Ничего не писать, только отчёт")
    parser.add_argument(
        "--verify", action="store_true",
        help="Сверка с живым источником на окне пересечения (§5.2 ТЗ). Подразумевает --dry-run",
    )
    args = parser.parse_args()

    if args.days <= 0:
        print("--days должен быть положительным числом", file=sys.stderr)
        sys.exit(1)

    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
