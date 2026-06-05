import { create } from 'zustand'
import api from '../api/client'

export interface FeedLotItem {
  buyout_price: number
  amount: number
  start_time: string | null
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
}

export interface FeedWatchlistEntry {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  region: string
  quality_filter: number | null
  enchant_filter: number | null
  is_active: boolean
  last_successful_check: string | null
  error_status: string | null
  tracked_batch_sizes: number[]
}

export interface FeedSellOption {
  label: 'fast' | 'normal' | 'premium'
  price_per_unit: number
}

export interface FeedMarketStats {
  median_price_7d: number | null
  sell_options: FeedSellOption[] | null
  [key: string]: unknown
}

export const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран',  4: 'Мастер',   5: 'Легендарный',
}

export const FEED_COMMISSION = 0.05

export interface FeedItem {
  entry: FeedWatchlistEntry
  count: number
  latest_lot_time: string | null
}

interface FeedState {
  watchlist:          FeedWatchlistEntry[]
  stats:              Record<number, FeedMarketStats>
  lotsMap:            Record<number, FeedLotItem[] | undefined>
  lastLotRefresh:     Date | null
  profitableItemIds:  number[]
  feedItems:          FeedItem[]
  initialized:        boolean

  loadWatchlistAndStats: (silent?: boolean) => Promise<void>
  loadAllLots:           () => Promise<void>
  removeEntry:           (id: number) => void
}

export const useFeedStore = create<FeedState>((set, get) => ({
  watchlist:         [],
  stats:             {},
  lotsMap:           {},
  lastLotRefresh:    null,
  profitableItemIds: [],
  feedItems:         [],
  initialized:       false,

  loadWatchlistAndStats: async (silent = false) => {
    try {
      const { data } = await api.get('/watchlist/')
      const watchlist: FeedWatchlistEntry[] = data
      const pairs = await Promise.all(
        watchlist.map(async (entry) => {
          try {
            const params: Record<string, string> = { region: entry.region }
            if (entry.quality_filter !== null) params.quality_filter = String(entry.quality_filter)
            if (entry.enchant_filter !== null) params.enchant_filter = String(entry.enchant_filter)
            const { data: s } = await api.get(`/monitoring/item/${entry.item_id}`, { params })
            return [entry.id, s] as [number, FeedMarketStats]
          } catch { return [entry.id, null] as [number, null] }
        })
      )
      set({
        watchlist,
        stats: Object.fromEntries(
          pairs.filter((p): p is [number, FeedMarketStats] => p[1] !== null)
        ) as Record<number, FeedMarketStats>,
        initialized: true,
      })
    } catch { /* keep previous */ }
    void silent
  },

  loadAllLots: async () => {
    const { watchlist } = get()
    if (watchlist.length === 0) return
    await Promise.all(watchlist.map(async (entry) => {
      const params: Record<string, string | number> = { region: entry.region }
      if (entry.quality_filter !== null) params.quality_filter = entry.quality_filter
      if (entry.enchant_filter !== null) params.enchant_filter = entry.enchant_filter
      try {
        const { data } = await api.get(`/lots/${entry.item_id}`, { params })
        set(state => ({ lotsMap: { ...state.lotsMap, [entry.id]: data.lots ?? [] } }))
      } catch { /* keep previous */ }
    }))
    // Вычисляем выгодные позиции и feedItems атомарно
    const { stats, lotsMap, watchlist: wl } = get()
    const profitableItemIds = wl.filter(entry => {
      const s = stats[entry.id]
      const lots = lotsMap[entry.id]
      if (!s?.sell_options || !lots || lots.length === 0) return false
      const normal = s.sell_options.find(o => o.label === 'normal')
      if (!normal) return false
      return lots.some(l => {
        if (l.is_expiring || l.buyout_price <= 0) return false
        if (entry.quality_filter !== null && l.quality_name !== QLT_NAMES[entry.quality_filter]) return false
        if (entry.enchant_filter !== null && l.enchant_level !== entry.enchant_filter) return false
        return Math.round(normal.price_per_unit * (1 - FEED_COMMISSION) - Math.floor(l.buyout_price / l.amount)) > 0
      })
    }).map(e => e.id)

    const feedItems: FeedItem[] = wl
      .filter(entry => profitableItemIds.includes(entry.id))
      .flatMap(entry => {
        const s    = stats[entry.id]
        const lots = lotsMap[entry.id]
        if (!s?.sell_options || !lots) return []
        const normal = s.sell_options.find(o => o.label === 'normal')
        if (!normal) return []
        const profitableLots = lots.filter(l => {
          if (l.is_expiring || l.buyout_price <= 0) return false
          if (entry.quality_filter !== null && l.quality_name !== QLT_NAMES[entry.quality_filter]) return false
          if (entry.enchant_filter !== null && l.enchant_level !== entry.enchant_filter) return false
          return Math.round(normal.price_per_unit * (1 - FEED_COMMISSION) - Math.floor(l.buyout_price / l.amount)) > 0
        })
        const count = profitableLots.length
        if (count === 0) return []
        const latest_lot_time = profitableLots.reduce<string | null>((max, l) => {
          if (!l.start_time) return max
          return max === null || l.start_time > max ? l.start_time : max
        }, null)
        return [{ entry, count, latest_lot_time }]
      })
      .sort((a, b) => b.count - a.count)

    set({ lastLotRefresh: new Date(), profitableItemIds, feedItems })
  },

  removeEntry: (id) => set(state => ({
    watchlist:         state.watchlist.filter(e => e.id !== id),
    lotsMap:           Object.fromEntries(Object.entries(state.lotsMap).filter(([k]) => Number(k) !== id)),
    stats:             Object.fromEntries(Object.entries(state.stats).filter(([k]) => Number(k) !== id)),
    profitableItemIds: state.profitableItemIds.filter(i => i !== id),
    feedItems:         state.feedItems.filter(fi => fi.entry.id !== id),
  })),
}))
