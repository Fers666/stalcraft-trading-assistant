import { create } from 'zustand'
import api from '../api/client'

export interface FeedPageItem {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  region: string
  quality_filter: number | null
  enchant_filter: number | null
  is_active: boolean
  created_at: string | null
  last_collected_at: string | null
  sales_7d: number
  sales_24h: number
  profitable_lots_count: number
  avg_profit: number
}

export type SortField = 'sales_7d' | 'sales_24h' | 'profitable_lots_count' | 'avg_profit' | 'name_ru'

interface FeedPageState {
  items: FeedPageItem[]
  loading: boolean
  error: string | null
  sortBy: SortField
  sortOrder: 'asc' | 'desc'

  fetchItems: () => Promise<void>
  addItem: (payload: {
    item_id: string
    region: string
    quality_filter?: number | null
    enchant_filter?: number | null
  }) => Promise<void>
  addBatch: (payload: {
    category: string
    region: string
    quality_filter?: number | null
    enchant_filter?: number | null
  }) => Promise<{ added: number; skipped: number }>
  removeItem: (id: number) => Promise<void>
  promoteItem: (id: number) => Promise<void>
  setSortBy: (field: SortField) => void
  setSortOrder: (order: 'asc' | 'desc') => void
  sortedItems: () => FeedPageItem[]
}

export const useFeedPageStore = create<FeedPageState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  sortBy: 'sales_7d',
  sortOrder: 'desc',

  fetchItems: async () => {
    set({ loading: true, error: null })
    try {
      const { data } = await api.get<FeedPageItem[]>('/feed/items')
      set({ items: data })
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      set({ error: msg || 'Не удалось загрузить Ленту' })
    } finally {
      set({ loading: false })
    }
  },

  addItem: async (payload) => {
    const { data } = await api.post<FeedPageItem>('/feed/items', payload)
    set((s) => ({ items: [data, ...s.items] }))
  },

  addBatch: async (payload) => {
    const { data } = await api.post<{ added: number; skipped: number; total_in_category: number }>(
      '/feed/items/batch',
      payload
    )
    await get().fetchItems()
    return { added: data.added, skipped: data.skipped }
  },

  removeItem: async (id) => {
    await api.delete(`/feed/items/${id}`)
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
  },

  promoteItem: async (id) => {
    await api.post(`/feed/items/${id}/promote`)
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
  },

  setSortBy: (field) => set({ sortBy: field }),
  setSortOrder: (order) => set({ sortOrder: order }),

  sortedItems: () => {
    const { items, sortBy, sortOrder } = get()
    return [...items].sort((a, b) => {
      let va: string | number = a[sortBy] ?? 0
      let vb: string | number = b[sortBy] ?? 0
      if (sortBy === 'name_ru') {
        va = (a.name_ru || '').toLowerCase()
        vb = (b.name_ru || '').toLowerCase()
      }
      if (va < vb) return sortOrder === 'asc' ? -1 : 1
      if (va > vb) return sortOrder === 'asc' ? 1 : -1
      return 0
    })
  },
}))
