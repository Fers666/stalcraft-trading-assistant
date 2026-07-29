import { useMediaQuery, useTheme } from '@mui/material'
import { useLayoutStore, type LayoutOverride } from '../store/layoutStore'

// Эффективный режим раскладки: комбинирует медиа-запрос (<900px = мобайл) и
// ручной override из layoutStore. Override перебивает авто-ширину.
export function useLayoutMode(): {
  mode: 'mobile' | 'desktop'
  override: LayoutOverride
  setOverride: (o: LayoutOverride) => void
} {
  const theme = useTheme()
  // MUI md по умолчанию = 900px → down('md') = max-width 899.95px = мобайл.
  const isNarrow = useMediaQuery(theme.breakpoints.down('md'))
  const override = useLayoutStore((s) => s.override)
  const setOverride = useLayoutStore((s) => s.setOverride)

  const mode = override === 'auto' ? (isNarrow ? 'mobile' : 'desktop') : override
  return { mode, override, setOverride }
}
