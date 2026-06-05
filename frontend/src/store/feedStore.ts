import { create } from 'zustand'
import api from '../api/client'

export interface FeedLotItem {
  buyout_price: number
  amount: number
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

interface FeedState {
  watchlist:          FeedWatchlistEntry[]
  stats:              Record<number, FeedMarketStats>
  lotsMap:            Record<number, FeedLotItem[] | undefined>
  lastLotRefresh:     Date | null
  profitableItemIds:  number[]
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
        stats: Object.fromEntries(pairs.filter(([, v]) => v !== null)),
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
    // Вычисляем выгодные позиции после загрузки всех лотов
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
    set({ lastLotRefresh: new Date(), profitableItemIds })
  },

  removeEntry: (id) => set(state => ({
    watchlist:         state.watchlist.filter(e => e.id !== id),
    lotsMap:           Object.fromEntries(Object.entries(state.lotsMap).filter(([k]) => Number(k) !== id)),
    stats:             Object.fromEntries(Object.entries(state.stats).filter(([k]) => Number(k) !== id)),
    profitableItemIds: state.profitableItemIds.filter(i => i !== id),
  })),
}))
