import { create } from 'zustand'
import api from '../api/client'
import { useFeedStore } from './feedStore'

interface User {
  id: number
  username: string
  email: string
  telegram_username: string | null
  is_admin: boolean
  is_approved: boolean
  tier: string
  tier_expires_at: string | null
  watchlist_limit: number | null
  favorites_limit_override: number | null
  telegram_notifications: boolean
  stats_windows: string[]
  auction_access: boolean
  has_market_radar_addon: boolean
}

interface AuthState {
  user: User | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string) => Promise<void>
  logout: () => void
  fetchMe: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,

  login: async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password })
    localStorage.setItem('access_token', data.access_token)
    localStorage.setItem('refresh_token', data.refresh_token)
    const me = await api.get('/auth/me')
    set({ user: me.data })
  },

  register: async (username, email, password) => {
    await api.post('/auth/register', { username, email, password })
    // Регистрация не выдаёт токен — пользователь ждёт подтверждения админа
  },

  logout: () => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    set({ user: null })
    useFeedStore.getState().reset()
  },

  fetchMe: async () => {
    const token = localStorage.getItem('access_token')
    if (!token) return
    try {
      const { data } = await api.get('/auth/me')
      set({ user: data })
    } catch {
      localStorage.removeItem('access_token')
      set({ user: null })
    }
  },
}))
