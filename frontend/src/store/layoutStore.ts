import { create } from 'zustand'

// Ручной выбор раскладки (десктоп/мобайл) поверх авто-детекции по ширине.
// Персист в localStorage (ключ sc_layout_mode). 'auto' → режим считается по ширине.
export type LayoutOverride = 'auto' | 'desktop' | 'mobile'

const STORAGE_KEY = 'sc_layout_mode'

function readOverride(): LayoutOverride {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'auto' || v === 'desktop' || v === 'mobile') return v
  } catch { /* localStorage недоступен — fallback ниже */ }
  return 'auto'
}

interface LayoutState {
  override: LayoutOverride
  setOverride: (o: LayoutOverride) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  // Синхронная инициализация из localStorage — без «мигания» раскладки.
  override: readOverride(),
  setOverride: (o) => {
    try { localStorage.setItem(STORAGE_KEY, o) } catch { /* игнорируем */ }
    set({ override: o })
  },
}))
