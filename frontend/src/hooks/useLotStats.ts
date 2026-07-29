import { useState, useMemo, useEffect } from 'react'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'

// Единый дата-слой карточки предмета (Избранное). Извлечён из LotStatCard без
// изменения логики: сетевой useEffect (/monitoring/item, /lots, /monitoring/signals,
// интервал 30с) + производные useMemo (sellPrices, profitableLots, totalFilteredLots,
// cheapestBuy, risk). Комиссия и формулы прибыли/маржи — единый источник ЗДЕСЬ.
// Десктопный LotStatCard и мобильный MobileLotStatCard делят этот хук → расчёт
// прибыли/сигналов/риска идентичен. Частота опроса (30с) не меняется.

export const COMMISSION = 0.05
export const MAX_PROFITABLE_LOTS = 10
// Минимум сделок за 24ч, чтобы суточная медиана считалась уровнем рынка,
// а не выбросом. Зеркалит pricing.MIN_REF_SAMPLES на бэкенде.
export const MIN_24H_SAMPLES = 3

export const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

export type RiskTone = 'success' | 'warning' | 'error'
export type RiskKey = 'low' | 'medium' | 'high'

export const RISK_LABELS: Record<RiskKey, { label: string; tone: RiskTone }> = {
  low:    { label: 'низкий риск',    tone: 'success' },
  medium: { label: 'умеренный риск', tone: 'warning' },
  high:   { label: 'высокий риск',   tone: 'error'   },
}

export function volatilityRisk(v: number | null): RiskKey | null {
  if (v == null) return null
  if (v > 30) return 'high'
  if (v > 15) return 'medium'
  return 'low'
}

export interface SellOption {
  label: 'fast' | 'normal' | 'premium'
  label_ru: string
  price_per_unit: number
  net_price_per_unit: number
  estimated_hours: number
  estimated_hours_display: string
  confidence: 'low' | 'medium' | 'high'
  data_points: number
}

export interface MarketStats {
  avg_price_7d: number | null
  median_price_7d: number | null
  median_price_24h: number | null
  sales_volume_24h: number | null
  sales_volume_7d: number | null
  sales_volume_30d: number | null
  avg_sell_time_hours: number | null
  best_sell_hour: number | null
  best_sell_day: string | null
  best_buy_hour: number | null
  best_buy_day: string | null
  sell_hours_by_day: Record<string, number> | null
  buy_hours_by_day: Record<string, number> | null
  price_volatility_7d: number | null
  price_volatility_30d: number | null
  sell_options: SellOption[] | null
  /** Цены продажи от ТЕКУЩЕГО минимума лотов — режим «Сейчас». */
  sell_options_now: SellOption[] | null
  current_min_price: number | null
  /** Опорная цена sell_options: взвешенная по свежести медиана продаж 7д. */
  reference_price: number | null
  reference_source: string | null
  reference_confidence: 'high' | 'low' | null
  reference_samples: number | null
  trend: 'falling' | 'stable' | 'rising' | 'unknown' | null
  trend_pct: number | null
  batch_stats: {
    by_size: Record<string, { label: string; count: number; share_pct: number; avg_price_per_unit: number; median_price_per_unit: number }>
    median_amount: number
    bulk_discount_pct: number | null
    batch_ratio_pct: number
    most_popular_bucket: string
    total_analyzed: number
  } | null
  calculated_at: string | null
}

export interface LotItem {
  buyout_price: number
  amount: number
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
}

interface SignalLot {
  start_time: string
  buyout_per_unit: number
  buyout_price: number
  amount: number
  quality_name: string | null
  enchant: number | null
  // Оценка бэкенда (pricing.evaluate_lot_profit): учитывает риск-множитель
  // и поправку на размер пачки, которых нет в клиентском what-if.
  profit: number | null
  profit_pct: number | null
  profit_per_hour: number | null
  tier_used: string | null
  sell_price_used: number | null
  breakeven_per_unit: number | null
}

interface SignalsData {
  lots: SignalLot[]
  sell_options: SellOption[] | null
  volume_7d: number | null
  volatility_7d: number | null
  ref: number | null
  ref_source: string | null
  ref_confidence: 'high' | 'low' | null
  ref_samples: number | null
  trend: 'falling' | 'stable' | 'rising' | 'unknown' | null
  trend_pct: number | null
  median_7d: number | null
  risk: string | null
  computed_at: string | null
}

export type TrendDirection = 'falling' | 'stable' | 'rising' | 'unknown'

export interface MarketTrend {
  direction: TrendDirection
  /** Отклонение медианы сделок за 24ч от медианы за 7д, %. null — считать не по чему. */
  pct: number | null
  tone: RiskTone | null
}

export interface SellPrice {
  label: string
  label_ru: string
  price: number
}

export interface LotProfit {
  label: string
  label_ru: string
  perUnit: number
  total: number
}

export interface ProfitableLot {
  buyout_price: number
  amount: number
  quality_name: string | null
  enchant_level: number | null
  buyPerUnit: number
  /** What-if по трём тирам от текущих sellPrices — считается на клиенте. */
  profits: LotProfit[]
  /** Оценка бэкенда (тир «быстро»). null — лот из фоллбека /lots, оценки нет. */
  profit: number | null
  profitPct: number | null
  tierUsed: string | null
  /** Цена продажи с нулевой прибылью после комиссии. */
  breakeven: number | null
}

export interface UseLotStatsParams {
  itemId: string
  region: string
  qualityFilter: number | null
  enchantFilter: number | null
  minProfitMarginPercent?: number
  /** Режим цен продажи: текущие sell_options ('current') или от медианы 7д ('median'). */
  lotMode: 'current' | 'median'
}

export interface UseLotStatsResult {
  stats: MarketStats | null
  lots: LotItem[]
  loading: boolean
  /** Опции текущего режима (lotMode) — единый источник для таблицы и «Вариантов продажи». */
  sellOptions: SellOption[] | null
  sellOptionsAreCurrent: boolean
  sellPrices: SellPrice[] | null
  trend: MarketTrend | null
  /** Медиана 24ч, если сделок >= MIN_24H_SAMPLES. Иначе null — ориентира нет. */
  median24h: number | null
  profitableLots: ProfitableLot[]
  totalFilteredLots: number
  cheapestBuy: number | null
  riskKey: RiskKey | null
  riskKey30: RiskKey | null
  risk: { label: string; tone: RiskTone } | null
  risk30: { label: string; tone: RiskTone } | null
  lastUpdated: string | null
  sellOptionsLocked: boolean
  risk30Locked: boolean
}

export function useLotStats({
  itemId, region, qualityFilter, enchantFilter, minProfitMarginPercent = 0, lotMode,
}: UseLotStatsParams): UseLotStatsResult {
  const [stats, setStats]     = useState<MarketStats | null>(null)
  const [lots, setLots]       = useState<LotItem[]>([])
  const [signals, setSignals] = useState<SignalsData | null>(null)
  const [loading, setLoading] = useState(true)

  const statsWindows = useAuthStore(s => s.user?.stats_windows)
  const sellOptionsLocked = !statsWindows?.includes('7d')
  const risk30Locked = !statsWindows?.includes('30d')

  useEffect(() => {
    if (!itemId) return
    const params: Record<string, string | number> = { region }
    if (qualityFilter !== null) params.quality_filter = qualityFilter
    if (enchantFilter !== null) params.enchant_filter = enchantFilter

    const fetchData = () => Promise.all([
      api.get(`/monitoring/item/${itemId}`, { params }).catch(() => null),
      api.get(`/lots/${itemId}`, { params }).catch(() => null),
      api.get(`/monitoring/signals/${itemId}`, { params }).catch(() => null),
    ]).then(([statsRes, lotsRes, sigRes]) => {
      setStats(statsRes?.data ?? null)
      setLots(lotsRes?.data?.lots ?? [])
      setSignals(sigRes?.data ?? null)
      setLoading(false)
    })

    setLoading(true)
    fetchData()
    // Сигналы пересчитываются на бэкенде каждые ~20 сек — синхронизируемся с этим циклом.
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [itemId, region, qualityFilter, enchantFilter])

  const lastUpdated = signals?.computed_at ?? stats?.calculated_at ?? null

  const riskKey   = stats ? volatilityRisk(stats.price_volatility_7d)  : null
  const riskKey30 = stats ? volatilityRisk(stats.price_volatility_30d) : null
  const risk   = riskKey   ? RISK_LABELS[riskKey]   : null
  const risk30 = riskKey30 ? RISK_LABELS[riskKey30] : null

  // Обе ветки — готовые опции с бэкенда: «Неделя» от опорной цены (взвешенная
  // медиана продаж 7д), «Сейчас» от текущего минимума лотов. Клиент цены больше
  // не считает — иначе коэффициенты тиров расходятся с бэкендом.
  const sellOptions = useMemo<SellOption[] | null>(() => (
    lotMode === 'current'
      ? (stats?.sell_options_now ?? stats?.sell_options ?? null)
      : (stats?.sell_options ?? null)
  ), [stats?.sell_options, stats?.sell_options_now, lotMode])

  /** В режиме «Сейчас» показаны действительно текущие цены, а не опорные за неделю. */
  const sellOptionsAreCurrent = lotMode === 'current' && !!stats?.sell_options_now

  const sellPrices = useMemo<SellPrice[] | null>(() => (
    sellOptions?.map(o => ({ label: o.label, label_ru: o.label_ru, price: o.price_per_unit })) ?? null
  ), [sellOptions])

  // Суточная медиана как ориентир — только если сделок достаточно. На одной-двух
  // это выброс: линия уезжает за облако точек, и вся покраска инвертируется.
  const median24h = useMemo<number | null>(() => (
    (stats?.sales_volume_24h ?? 0) >= MIN_24H_SAMPLES ? stats?.median_price_24h ?? null : null
  ), [stats?.median_price_24h, stats?.sales_volume_24h])

  const trend = useMemo<MarketTrend | null>(() => {
    // signals свежее stats (~20с против часа), поэтому приоритет у них
    const direction = signals?.trend ?? stats?.trend ?? null
    const pct = signals?.trend_pct ?? stats?.trend_pct ?? null
    if (!direction || direction === 'unknown') return null
    return {
      direction,
      pct,
      tone: direction === 'falling' ? 'error' : direction === 'rising' ? 'success' : null,
    }
  }, [signals?.trend, signals?.trend_pct, stats?.trend, stats?.trend_pct])

  const profitableLots = useMemo<ProfitableLot[]>(() => {
    if (signals?.lots?.length) {
      const opts = sellPrices ?? []
      // Бэкенд уже отобрал лоты по min_profit_margin_pct × риск-множитель от тира
      // «быстро» — это строго жёстче клиентского порога, повторно не фильтруем.
      // Порядок бэкенда (profit_per_hour desc) значим: режем ДО пересортировки,
      // иначе из выдачи вылетают самые прибыльные лоты.
      return signals.lots
        .slice(0, MAX_PROFITABLE_LOTS)
        .map(l => ({
          buyout_price: l.buyout_price,
          amount: l.amount,
          quality_name: l.quality_name,
          enchant_level: l.enchant ?? null,
          buyPerUnit: l.buyout_per_unit,
          profits: opts.map(sp => ({
            label: sp.label, label_ru: sp.label_ru,
            perUnit: Math.round(sp.price * (1 - COMMISSION) - l.buyout_per_unit),
            total: Math.round((sp.price * (1 - COMMISSION) - l.buyout_per_unit) * l.amount),
          })),
          profit: l.profit ?? null,
          profitPct: l.profit_pct ?? null,
          tierUsed: l.tier_used ?? null,
          breakeven: l.breakeven_per_unit ?? null,
        }))
        .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
    }
    if (!sellPrices || lots.length === 0) return []
    const normalPrice = sellPrices.find(p => p.label === 'normal')?.price
    if (!normalPrice) return []
    return lots
      .filter(l => {
        if (l.is_expiring || l.buyout_price <= 0) return false
        if (qualityFilter !== null && l.quality_name !== QLT_NAMES[qualityFilter]) return false
        if (enchantFilter !== null && l.enchant_level !== enchantFilter) return false
        return true
      })
      .map(l => {
        const buyPerUnit = Math.floor(l.buyout_price / l.amount)
        return {
          buyout_price: l.buyout_price,
          amount: l.amount,
          quality_name: l.quality_name,
          enchant_level: l.enchant_level,
          buyPerUnit,
          profits: sellPrices.map(sp => ({
            label: sp.label, label_ru: sp.label_ru,
            perUnit:  Math.round(sp.price * (1 - COMMISSION) - buyPerUnit),
            total:    Math.round((sp.price * (1 - COMMISSION) - buyPerUnit) * l.amount),
          })),
          // Фоллбек по /lots: оценки бэкенда нет, есть только клиентский what-if
          profit: null,
          profitPct: null,
          tierUsed: null,
          breakeven: Math.round(buyPerUnit / (1 - COMMISSION)),
        }
      })
      .filter(l => {
        const normalProfit = l.profits.find(p => p.label === 'normal')?.perUnit ?? -1
        if (normalProfit <= 0) return false
        if (minProfitMarginPercent > 0) {
          const pct = (normalProfit / l.buyPerUnit) * 100
          if (pct < minProfitMarginPercent) return false
        }
        return true
      })
      .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
      .slice(0, MAX_PROFITABLE_LOTS)
  }, [signals, sellPrices, lots, qualityFilter, enchantFilter, minProfitMarginPercent])

  const totalFilteredLots = useMemo(() => lots.filter(l => {
    if (l.is_expiring) return false
    if (qualityFilter !== null && l.quality_name !== QLT_NAMES[qualityFilter]) return false
    if (enchantFilter !== null && l.enchant_level !== enchantFilter) return false
    return true
  }).length, [lots, qualityFilter, enchantFilter])

  const cheapestBuy = lots
    .filter(l => !l.is_expiring && l.buyout_price > 0)
    .filter(l => qualityFilter === null || l.quality_name === QLT_NAMES[qualityFilter])
    .filter(l => enchantFilter === null || l.enchant_level === enchantFilter)
    .reduce<number | null>((min, l) => {
      const p = Math.floor(l.buyout_price / l.amount)
      return min === null || p < min ? p : min
    }, null)

  return {
    stats, lots, loading,
    sellOptions, sellOptionsAreCurrent, sellPrices, trend, median24h,
    profitableLots, totalFilteredLots, cheapestBuy,
    riskKey, riskKey30, risk, risk30,
    lastUpdated, sellOptionsLocked, risk30Locked,
  }
}
