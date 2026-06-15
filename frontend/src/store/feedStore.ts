import { create } from 'zustand'
import api from '../api/client'

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

export const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран',  4: 'Мастер',   5: 'Легендарный',
}

interface SignalLot {
  start_time: string
}

export interface FeedItem {
  entry: FeedWatchlistEntry
  count: number
  latest_lot_time: string | null
}

interface FeedState {
  watchlist:              FeedWatchlistEntry[]
  lastLotRefresh:         Date | null
  profitableItemIds:      number[]
  feedItems:              FeedItem[]
  initialized:            boolean
  minProfitMarginPercent: number

  loadWatchlistAndStats: (silent?: boolean) => Promise<void>
  loadAllLots:           () => Promise<void>
  removeEntry:           (id: number) => void
  reset:                 () => void
}

export const useFeedStore = create<FeedState>((set, get) => ({
  watchlist:              [],
  lastLotRefresh:         null,
  profitableItemIds:      [],
  feedItems:              [],
  initialized:            false,
  minProfitMarginPercent: 0,

  loadWatchlistAndStats: async (silent = false) => {
    try {
      const [watchlistResp, settingsResp] = await Promise.all([
        api.get('/watchlist/'),
        api.get('/settings').catch(() => ({ data: { min_profit_margin_percent: 0 } })),
      ])
      set({
        watchlist:              watchlistResp.data,
        minProfitMarginPercent: settingsResp.data.min_profit_margin_percent ?? 0,
        initialized:            true,
      })
    } catch { /* keep previous */ }
    void silent
  },

  // Берём предвычисленные сигналы из Redis (/monitoring/signals) — та же
  // логика и тот же ref/risk-margin/trend-guard, что у Telegram-бота и
  // LotStatCard. Раньше лента считала "выгодность" по своей формуле
  // (median_price_7d × 0.95) и могла показать карточку, по которой бот
  // не пришлёт уведомление — рассинхрон устранён переходом на общий источник.
  loadAllLots: async () => {
    const { watchlist } = get()
    if (watchlist.length === 0) return

    const pairs = await Promise.all(watchlist.map(async (entry) => {
      const params: Record<string, string | number> = { region: entry.region }
      if (entry.quality_filter !== null) params.quality_filter = entry.quality_filter
      if (entry.enchant_filter !== null) params.enchant_filter = entry.enchant_filter
      try {
        const { data } = await api.get(`/monitoring/signals/${entry.item_id}`, { params })
        return [entry.id, (data.lots ?? []) as SignalLot[]] as [number, SignalLot[]]
      } catch {
        return [entry.id, [] as SignalLot[]] as [number, SignalLot[]]
      }
    }))

    const { watchlist: wl } = get()
    const byId = new Map(wl.map(e => [e.id, e]))

    const profitableItemIds: number[] = []
    const feedItems: FeedItem[] = []

    for (const [id, lots] of pairs) {
      if (lots.length === 0) continue
      const entry = byId.get(id)
      if (!entry) continue

      profitableItemIds.push(id)
      const latest_lot_time = lots.reduce<string | null>((max, l) => {
        if (!l.start_time) return max
        return max === null || l.start_time > max ? l.start_time : max
      }, null)
      feedItems.push({ entry, count: lots.length, latest_lot_time })
    }

    feedItems.sort((a, b) => b.count - a.count)

    set({ lastLotRefresh: new Date(), profitableItemIds, feedItems })
  },

  removeEntry: (id) => set(state => ({
    watchlist:         state.watchlist.filter(e => e.id !== id),
    profitableItemIds: state.profitableItemIds.filter(i => i !== id),
    feedItems:         state.feedItems.filter(fi => fi.entry.id !== id),
  })),

  reset: () => set({
    watchlist:              [],
    lastLotRefresh:         null,
    profitableItemIds:      [],
    feedItems:              [],
    initialized:            false,
    minProfitMarginPercent: 0,
  }),
}))
