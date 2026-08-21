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
  /**
   * Доля сделок варианта, прошедших по цене тира или выше, % (75 / 50 / 25).
   * Тир — не «скидка N %», а цена с измеренной вероятностью исполнения.
   * undefined/null — статистику ещё не пересчитали новой формулой: строку в UI
   * просто не показываем, выдумывать число нельзя.
   */
  fill_probability?: number | null
  /**
   * Кривая дожития (P1-4 фаза B): доля лотов страты, проданных не позже 6 / 24
   * часов, %. Нижняя граница — снятый продавцом лот считается непроданным.
   *
   * Отличие от fill_probability принципиально. Та считает ТОЛЬКО состоявшиеся
   * сделки и отвечает «насколько эта цена конкурентна». Эта считает все лоты,
   * включая непроданные, и отвечает «продастся ли вообще и когда».
   */
  p_sold_6h?: number | null
  p_sold_24h?: number | null
  /** Доля страты, продавшаяся когда-либо: остаток не продаётся вовсе. */
  pct_sold_ever?: number | null
  /**
   * Откуда взят срок: measured — медиана по наблюдениям за лотами;
   * item_pairs — интерполяция по реальным сделкам этого предмета;
   * heuristic — прежняя оценка по объёму продаж, ничем не проверенная.
   */
  time_source?: 'measured' | 'item_pairs' | 'heuristic' | null
  confidence: 'low' | 'medium' | 'high' | 'measured'
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
  reference_confidence: 'high' | 'medium' | 'low' | null
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
  ref_confidence: 'high' | 'medium' | 'low' | null
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
  /**
   * Цена выставления за штуку и она же за вычетом комиссии — ровно те, из
   * которых получена `perUnit`. В «Ленте» это цены ПАЧКИ (batch-фактор уже
   * применён), поэтому «Варианты продажи» показывают их, а не сырые опции:
   * иначе два блока одной карточки отвечают по-разному на один вопрос.
   * null — поправки нет (watchlist / фоллбек по /lots), показывать опции как есть.
   */
  priceUnit: number | null
  netUnit: number | null
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
  /**
   * Насколько цена пачки этого размера отличается от штучной, % (тот же
   * batch-фактор бэкенда, второй раз он нигде не считается). null — поправки
   * нет: amount = 1, нет статистики по пачкам или это не «Лента».
   */
  batchPricePct: number | null
  /** Оценка бэкенда (тир «быстро»). null — лот из фоллбека /lots, оценки нет. */
  profit: number | null
  profitPct: number | null
  tierUsed: string | null
  /** Цена продажи с нулевой прибылью после комиссии. */
  breakeven: number | null
}

/**
 * Ответ /feed/lots → форма SignalsData.
 *
 * Единственная тонкость: SignalLot.profit — прибыль НА ЕДИНИЦУ (её возвращает
 * pricing.evaluate_lot_profit), поэтому маппим profit_per_unit, а не
 * profit_total: иначе карточка соврала бы кратно количеству в лоте.
 */
function feedToSignals(data: any): SignalsData | null {
  if (!data || !Array.isArray(data.lots)) return null
  const first = data.lots[0]
  return {
    lots: data.lots.map((l: any): SignalLot => ({
      start_time:         l.lot_key,
      buyout_per_unit:    l.buyout_per_unit,
      buyout_price:       l.buyout_price,
      amount:             l.amount,
      quality_name:       l.quality_name ?? null,
      enchant:            l.ptn ?? null,
      profit:             l.profit_per_unit ?? null,
      profit_pct:         l.profit_pct ?? null,
      profit_per_hour:    l.profit_per_hour ?? null,
      // Тир, которым лот прошёл в ленту. Был захардкожен 'fast' — до
      // e497dda бэкенд иначе и не умел. С трёхтировым допуском константа
      // печатала прибыль тира premium под этикеткой «Быстро».
      tier_used:          l.tier_used ?? 'fast',
      sell_price_used:    l.sell_price_used ?? null,
      breakeven_per_unit: l.breakeven_per_unit ?? null,
    })),
    // Поля уровня варианта одинаковы у всех строк — берём из первой.
    sell_options:   null,
    volume_7d:      null,
    volatility_7d:  first?.volatility_7d ?? null,
    ref:            first?.ref_price ?? null,
    ref_source:     null,
    ref_confidence: (first?.stats_confidence as 'high' | 'medium' | 'low' | undefined) ?? null,
    ref_samples:    first?.stats_samples ?? null,
    trend:          (first?.trend_24h as SignalsData['trend']) ?? null,
    trend_pct:      first?.trend_24h_pct ?? null,
    median_7d:      null,
    risk:           first?.risk ?? null,
    computed_at:    data.snapshot_at ?? null,
  }
}

export interface UseLotStatsParams {
  itemId: string
  region: string
  qualityFilter: number | null
  enchantFilter: number | null
  minProfitMarginPercent?: number
  /** Режим цен продажи: текущие sell_options ('current') или от медианы 7д ('median'). */
  lotMode: 'current' | 'median'
  /**
   * Откуда брать «выгодные лоты».
   *
   * 'watchlist' (по умолчанию) — /monitoring/signals/{id}: ключ Redis содержит
   * user_id и пишется только по активным записям «Избранного».
   * 'feed' — /feed/lots: для «Ленты артефактов», где предмет у пользователя не
   * отслеживается и watchlist-сигналы всегда пусты, из-за чего карточка ушла бы
   * в деградированный клиентский фоллбек и разошлась бы с таблицей ленты.
   */
  signalsSource?: 'watchlist' | 'feed'
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
  signalsSource = 'watchlist',
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

    const feedParams: Record<string, string | number> = { item_id: itemId, page_size: 100 }
    if (qualityFilter !== null) feedParams.qlt = qualityFilter
    if (enchantFilter !== null) feedParams.ptn = enchantFilter

    // Статистика «Ленты» берётся из artifact_variant_stats (/feed/variant), а не
    // из /monitoring/item: та ручка отдаёт 404 на предметах вне «Избранного»
    // (её таблицы наполняет watchlist-коллектор) и считает по ПРЕДМЕТУ целиком,
    // тогда как лента считает по ВАРИАНТУ «качество × заточка». Один источник
    // на таблицу и карточку = совпадающие цифры по построению.
    const statsRequest = () => (
      signalsSource === 'feed'
        ? api.get(`/feed/variant/${itemId}`, {
            params: { region, qlt: qualityFilter ?? 0, ptn: enchantFilter ?? 0 },
          }).catch(() => null)
        : api.get(`/monitoring/item/${itemId}`, { params }).catch(() => null)
    )

    const fetchData = () => Promise.all([
      statsRequest(),
      api.get(`/lots/${itemId}`, { params }).catch(() => null),
      signalsSource === 'feed'
        ? api.get('/feed/lots', { params: feedParams }).catch(() => null)
        : api.get(`/monitoring/signals/${itemId}`, { params }).catch(() => null),
    ]).then(([statsRes, lotsRes, sigRes]) => {
      setStats(statsRes?.data ?? null)
      setLots(lotsRes?.data?.lots ?? [])
      setSignals(
        signalsSource === 'feed'
          ? feedToSignals(sigRes?.data ?? null)
          : (sigRes?.data ?? null),
      )
      setLoading(false)
    })

    setLoading(true)
    fetchData()
    // Сигналы пересчитываются на бэкенде каждые ~20 сек — синхронизируемся с этим циклом.
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [itemId, region, qualityFilter, enchantFilter, signalsSource])

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
      // Поправка на размер пачки. Бэкенд оценивал лот по цене sell_price_used,
      // которая при amount > 1 отличается от цены его тира
      // (pricing.evaluate_lot_profit + batch_stats), — без неё строка таблицы и
      // карточка расходились вплоть до смены знака. Множитель восстанавливаем
      // из самой оценки, второй формулы не заводим.
      // Только для «Ленты»: там stats и лоты приходят из ОДНОГО варианта
      // (artifact_variant_stats), поэтому базы сопоставимы; у watchlist-сигналов
      // опции карточки и оценка сигналов считаются на разных выборках.
      const tierPrice = (label: string | null | undefined) =>
        stats?.sell_options?.find(o => o.label === label)?.price_per_unit ?? null
      const isFeed = signalsSource === 'feed'

      // Бэкенд уже отобрал лоты по min_profit_margin_pct × риск-множитель от
      // цены их тира — это строго жёстче клиентского порога, повторно не
      // фильтруем.
      // Порядок бэкенда (profit_per_hour desc) значим: режем ДО пересортировки,
      // иначе из выдачи вылетают самые прибыльные лоты.
      return signals.lots
        .slice(0, MAX_PROFITABLE_LOTS)
        .map(l => {
          // Делим на цену ТОГО ЖЕ тира, которым бэкенд оценил лот. С делением на
          // fast у строки тира premium выходило PREMIUM_RATIO / FAST_RATIO =
          // 1.12766 — чистое отношение тиров, к пачке отношения не имеющее: все
          // три цены завышались на 12.8 %, а подпись обещала «пачками дороже»
          // при amount = 1 и batch_stats = NULL.
          // Корректность деления: _evaluate_at_tier считает sell_price =
          // price_per_unit(тир) × (медиана_пачки / normal_price), и второй
          // сомножитель от тира НЕ зависит (знаменатель всегда normal). Значит
          // частное — ровно поправка на пачку, и применять её ко всем трём
          // ценам по-прежнему верно. При amount = 1 множитель равен 1.
          const basePrice = tierPrice(l.tier_used)
          const factor = isFeed && basePrice && l.sell_price_used
            ? l.sell_price_used / basePrice
            : 1
          // Отклонение цены пачки от штучной для подписи в UI — то же число,
          // формулы не прибавилось. Меньше 0.1% — округлилось бы в «0 %».
          const pct = Math.round((factor - 1) * 1000) / 10
          return {
            buyout_price: l.buyout_price,
            amount: l.amount,
            quality_name: l.quality_name,
            enchant_level: l.enchant ?? null,
            buyPerUnit: l.buyout_per_unit,
            profits: opts.map(sp => {
              const net = sp.price * factor * (1 - COMMISSION) - l.buyout_per_unit
              // Тир, по которому лот оценил САМ бэкенд, показываем его числом:
              // клиентское округление иначе даёт расхождение со строкой ленты
              // на единицы рублей на ровном месте. Только в «Неделе»: оценка
              // бэкенда считана от опорной цены 7д, рядом с ценами «Сейчас» она
              // дала бы «получишь» выше цены выставления и плюс там, где what-if
              // от текущего минимума в минусе.
              const fromBackend = isFeed && lotMode === 'median' && sp.label === l.tier_used && l.profit != null
              const perUnit = fromBackend ? (l.profit as number) : Math.round(net)
              return {
                label: sp.label, label_ru: sp.label_ru,
                // Цены, из которых получена perUnit. «Получишь» восстанавливаем из
                // самой прибыли (perUnit + цена покупки): тогда в «Вариантах продажи»
                // «получишь − цена покупки» даёт ровно показанную прибыль, включая
                // тир, посчитанный бэкендом.
                priceUnit: isFeed ? Math.round(sp.price * factor) : null,
                netUnit:   isFeed ? perUnit + l.buyout_per_unit : null,
                perUnit,
                total: fromBackend ? perUnit * l.amount : Math.round(net * l.amount),
              }
            }),
            batchPricePct: isFeed && Math.abs(pct) >= 0.1 ? pct : null,
            profit: l.profit ?? null,
            profitPct: l.profit_pct ?? null,
            tierUsed: l.tier_used ?? null,
            breakeven: l.breakeven_per_unit ?? null,
          }
        })
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
            // Поправки на пачку нет — «Варианты продажи» показывают сырые опции
            priceUnit: null,
            netUnit:   null,
            perUnit:  Math.round(sp.price * (1 - COMMISSION) - buyPerUnit),
            total:    Math.round((sp.price * (1 - COMMISSION) - buyPerUnit) * l.amount),
          })),
          batchPricePct: null,
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
  }, [
    signals, sellPrices, stats?.sell_options, signalsSource, lotMode,
    lots, qualityFilter, enchantFilter, minProfitMarginPercent,
  ])

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
