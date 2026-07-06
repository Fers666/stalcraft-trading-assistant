import { create } from 'zustand'
import api from '../api/client'

interface EmissionState {
  isActive: boolean
  startedAt: string | null       // ISO UTC
  durationMin: number | null
  secondsSinceLast: number | null
  loading: boolean
  fetch: () => Promise<void>
}

export const useEmissionStore = create<EmissionState>((set) => ({
  isActive: false,
  startedAt: null,
  durationMin: null,
  secondsSinceLast: null,
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const { data } = await api.get('/emission/current')
      set({
        isActive: data.is_active,
        startedAt: data.started_at,
        durationMin: data.duration_min,
        secondsSinceLast: data.seconds_since_last,
        loading: false,
      })
    } catch {
      set({ loading: false })
    }
  },
}))
