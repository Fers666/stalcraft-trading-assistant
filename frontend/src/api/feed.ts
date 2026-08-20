/**
 * API-слой раздела «Лента» (артефакты, снаряжение, части, пропуска).
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
   * ОЖИДАЕМАЯ прибыль в рублях — ключ сортировки ленты по умолчанию.
   * Максимум по двум сценариям (быстро / дороже): рациональный игрок выбирает
   * лучшую стратегию для каждого лота. В рублях, а не в ₽/час: часовая ставка
   * подразумевала бы поток одинаковых лотов, которого на рынке нет.
   * null — вероятность не измерена; такие строки уходят в конец выдачи.
   */
  ev_profit: number | null
  /**
   * Сценарий «подождать и продать дороже» — цена тира premium (опора × 1.06).
   * Замер: даёт в среднем +451 % прибыли ценой ~17 п.п. вероятности, потому
   * что прибыль это РАЗНОСТЬ «продажа минус закупка».
   */
  profit_total_slow: number | null
  est_sell_hours_slow: number | null
  p_sold_6h_slow: number | null
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
  /**
   * Момент последнего настоящего нового лота, если аукцион отдаёт застывший
   * снимок (поломка на стороне EXBO, см. market_frozen_for). null = данные
   * живые. Лоты из снимка в игре, скорее всего, давно выкуплены.
   */
  market_frozen_since: string | null
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
 * Группы набора «Ленты» — чипы фильтра.
 *
 * Зеркало `FEED_GROUPS` / `FEED_GROUP_LABELS` из
 * backend/app/services/feed/scope.py. Ключ группы уходит обратно параметром
 * `category` в /feed/lots, значение вне списка ручка отклоняет 422 — поэтому
 * список обязан совпадать с серверным.
 *
 * Порядок здесь — ПОРЯДОК ЧИПОВ, а не серверный приоритет классификации:
 * /feed/filters отдаёт группы отсортированными по счётчику, и на живых данных
 * чипы менялись бы местами между обновлениями раз в 30 секунд. Артефакты
 * первыми — на них у ленты есть измеренная вероятность продажи.
 */
export const FEED_GROUPS = [
  'artefact', 'weapon', 'attachment', 'armor', 'backpacks', 'parts', 'pass',
] as const
export type FeedGroup = (typeof FEED_GROUPS)[number]

export const FEED_GROUP_LABELS: Record<FeedGroup, string> = {
  artefact:   'Артефакты',
  weapon:     'Оружие',
  attachment: 'Обвесы',
  armor:      'Броня',
  backpacks:  'Рюкзаки',
  parts:      'Части',
  pass:       'Пропуска и премиум',
}

/** Подпись группы. Фолбэк на ключ: новая группа на сервере не должна ломать UI. */
export function feedGroupLabel(group: string): string {
  return FEED_GROUP_LABELS[group as FeedGroup] ?? group
}

/** Позиция группы в канонической раскладке чипов; неизвестные — в хвост. */
export function feedGroupOrder(group: string): number {
  const i = (FEED_GROUPS as readonly string[]).indexOf(group)
  return i === -1 ? FEED_GROUPS.length : i
}

/** Ключи сортировки — соответствуют data-k прототипа и sort бэкенда. */
export type FeedSortKey =
  | 'ev_profit' | 'profit_total' | 'profit_pct' | 'profit_per_hour'
  | 'buyout_per_unit' | 'time_left' | 'volatility' | 'sales_per_day'

export interface FeedLotsParams {
  page?: number
  page_size?: number
  item_id?: string[]
  /** Ключи групп набора (FEED_GROUPS). Серверный фильтр чипов. */
  category?: string[]
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
 * Срок продажи словами: «~53 мин», «~1,2 ч».
 *
 * Тот же порог, что у бэкенда (pricing.format_hours с precise=True): ниже
 * часа — минуты, до двух часов — десятые. Мельче не печатаем: срок берётся из
 * страты, а их всего пять, и лишние знаки изобразили бы точность, которой нет.
 */
export function fmtSellTime(hours: number | null): string {
  if (hours === null || hours <= 0) return '—'
  if (hours < 1) return `~${Math.round(hours * 60)} мин`
  if (hours < 2) return `~${hours.toFixed(1).replace('.', ',')} ч`
  if (hours < 24) return `~${Math.round(hours)} ч`
  return `~${Math.round(hours / 24)} дн`
}
