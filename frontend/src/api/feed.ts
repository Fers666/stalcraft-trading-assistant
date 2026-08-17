/**
 * API-слой раздела «Лента артефактов».
 *
 * Единственный источник типов ответа для FeedPage / MobileFeedPage /
 * ArtifactModal — форма строки лота одна, чтобы таблица и карточка
 * артефакта не могли разойтись.
 *
 * Схемы соответствуют backend/app/api/v1/endpoints/feed.py.
 */
import api from './client'

/** Строка ленты = ОДИН лот. Три выгодных лота одного варианта дают три строки. */
export interface FeedLot {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  category: string | null
  region: string
  lot_key: string
  qlt: number
  ptn: number
  quality_name: string | null
  amount: number
  buyout_price: number
  buyout_per_unit: number
  end_time: string | null
  first_seen_at: string
  seen_at: string
  ref_price: number
  sell_price_used: number
  breakeven_per_unit: number
  profit_per_unit: number
  profit_total: number
  profit_pct: number
  /** Прибыль НА ЕДИНИЦУ в час. Для колонки «Прибыль» не использовать — там база «весь лот». */
  profit_per_hour: number | null
  /** Прибыль ВСЕГО ЛОТА в час, ЕСЛИ лот продастся. Показывается в карточке. */
  profit_per_hour_total: number | null
  /**
   * ОЖИДАЕМАЯ прибыль в час: `profit_per_hour_total × P(продан ≤ 6 ч)`.
   * Величина колонки «₽/час ожид.» и ключ сортировки ленты по умолчанию.
   * null — вероятность не измерена; такие строки уходят в конец выдачи.
   */
  ev_per_hour: number | null
  est_sell_hours: number | null
  /**
   * Кривая дожития (P1-4 фаза B): доля лотов, проданных не позже 6 часов при
   * такой же позиции ПЛАНОВОЙ цены продажи в стакане варианта, %.
   * null — таблица дожития ещё не заполнена либо страта не набрала объёма;
   * выдумывать число вместо отсутствующего нельзя.
   */
  p_sold_6h: number | null
  /** Доля страты, продавшаяся когда-либо. Остаток не продаётся вовсе. */
  pct_sold_ever: number | null
  risk: string
  risk_mult: number
  volatility_7d: number | null
  trend_24h: string | null
  trend_24h_pct: number | null
  trend_7d_pct: number | null
  sales_per_day: number | null
  supply_coverage_days: number | null
  stats_confidence: string | null
  stats_samples: number | null
  hours_remaining: number | null
}

export interface FeedLotsResponse {
  lots: FeedLot[]
  total_count: number
  page: number
  page_size: number
  snapshot_at: string | null
  min_profit_pct_applied: number
  /** null = без ограничений (Макс/админ) */
  rows_limit: number | null
  total_available: number
  /** true = выдача урезана и зафиксирована: sort и фильтры проигнорированы */
  showcase: boolean
}

export interface FeedSummaryResponse {
  profitable_lots: number
  avg_profit_pct: number | null
  total_profit: number
  sales_24h: number
  items_tracked: number
  best_lot: FeedLot | null
  snapshot_at: string | null
  cached: boolean
}

export interface FeedFilterItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  category: string | null
  lots_count: number
}

export interface FeedFilterBucket {
  value: number | string
  label: string
  count: number
}

export interface FeedFiltersResponse {
  items: FeedFilterItem[]
  qualities: FeedFilterBucket[]
  enchants: FeedFilterBucket[]
  categories: FeedFilterBucket[]
  total_count: number
}

/**
 * Группы артефактов для чипов-счётчиков панели фильтров.
 *
 * Зеркало `_CATEGORY_LABELS` / `_CATEGORY_OTHER` из
 * backend/app/api/v1/endpoints/feed.py: в `FeedFiltersResponse.categories`
 * бэкенд отдаёт уже готовые ПОДПИСИ (value = label), а сырую категорию —
 * только в `items[].category`. Чтобы связать чип со списком item_id,
 * подпись приходится вычислять и на клиенте.
 */
const FEED_CATEGORY_LABELS: Record<string, string> = {
  'artefact/biochemical':     'Био',
  'artefact/gravity':         'Грав',
  'artefact/thermal':         'Терм',
  'artefact/electrophysical': 'Электро',
}
export const FEED_CATEGORY_OTHER = 'Прочие'

export function feedCategoryLabel(category: string | null): string {
  return (category && FEED_CATEGORY_LABELS[category]) || FEED_CATEGORY_OTHER
}

/** Ключи сортировки — соответствуют data-k прототипа и sort бэкенда. */
export type FeedSortKey =
  | 'ev_per_hour' | 'profit_total' | 'profit_pct' | 'profit_per_hour'
  | 'buyout_per_unit' | 'time_left' | 'volatility' | 'sales_per_day'

export interface FeedLotsParams {
  page?: number
  page_size?: number
  item_id?: string[]
  qlt?: number[]
  ptn?: number[]
  min_profit_pct?: number
  max_buyout?: number
  min_amount?: number
  risk?: string[]
  sort?: FeedSortKey
  order?: 'asc' | 'desc'
}

/**
 * indexes: null — обязательный параметр, а не украшение.
 *
 * По умолчанию axios сериализует массивы как `item_id[]=a&item_id[]=b`, а
 * FastAPI (`item_id: list[str] = Query(None)`) читает только повторяющийся
 * ключ `item_id=a&item_id=b` — иначе фильтр молча не применяется.
 */
export async function fetchFeedLots(params: FeedLotsParams = {}): Promise<FeedLotsResponse> {
  const { data } = await api.get<FeedLotsResponse>('/feed/lots', {
    params,
    paramsSerializer: { indexes: null },
  })
  return data
}

export async function fetchFeedSummary(): Promise<FeedSummaryResponse> {
  const { data } = await api.get<FeedSummaryResponse>('/feed/summary')
  return data
}

export async function fetchFeedFilters(): Promise<FeedFiltersResponse> {
  const { data } = await api.get<FeedFiltersResponse>('/feed/filters')
  return data
}

/**
 * Прибыль в час ОТ ВСЕГО ЛОТА.
 *
 * Поле profit_per_hour из ответа считается на единицу — показывать его рядом
 * с «прибыль со всего лота» нельзя: разные базы в одной ячейке читаются как
 * ошибка. Здесь база одна — весь лот.
 *
 * Приоритет у profit_per_hour_total с сервера: именно по этой колонке идёт
 * сортировка ?sort=profit_per_hour, и показанное число обязано быть тем же.
 * Локальный расчёт — та же формула, страховка для строк из кэша витрины,
 * записанных до появления поля.
 */
export function profitPerHourTotal(lot: FeedLot): number | null {
  if (lot.profit_per_hour_total != null) return lot.profit_per_hour_total
  if (!lot.est_sell_hours || lot.est_sell_hours <= 0) return null
  return lot.profit_total / lot.est_sell_hours
}

/**
 * Ожидаемая прибыль в час — то, что печатает колонка «₽/час ожид.» и по чему
 * идёт сортировка по умолчанию.
 *
 * Отличие от profitPerHourTotal ровно в одном множителе: та величина отвечает
 * «сколько получишь в час, ЕСЛИ продашь», эта домножена на вероятность того,
 * что продажа вообще состоится. Замер показал, что разница решающая: 77 %
 * строк ленты продаются реже чем в 40 % случаев за 6 ч, и именно у них
 * обещанная прибыль выше (docs/tasks/ev-ranking.md).
 *
 * Локального расчёта нет намеренно: без измеренной вероятности величины не
 * существует, и подставлять p = 1 значило бы вернуть то самое умолчание
 * «продастся обязательно».
 */
export function evPerHour(lot: FeedLot): number | null {
  return lot.ev_per_hour ?? null
}
