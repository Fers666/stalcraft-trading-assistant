import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../../theme'

// Статус-сетка 2/3 колонки — контракт .statusgrid (mobile.css). Замена
// десктопной StatusLine на узком экране: 1px-щели, ячейки bg2, ключ Rajdhani
// caps, значение JetBrains Mono. Тон значения — по семантической роли статуса.
export type StatusTone = 'default' | 'success' | 'warning' | 'danger' | 'gold'

export interface StatusItem {
  k: React.ReactNode
  v: React.ReactNode
  /** Единица (.u) — приглушённая приписка к значению. */
  unit?: React.ReactNode
  tone?: StatusTone
}

const TONE_COLOR: Record<StatusTone, string> = {
  default: tokens.text0,
  success: tokens.success,
  warning: tokens.warning,
  danger:  tokens.danger,
  gold:    tokens.goldHighlight,
}

export interface StatusGridProps {
  items: StatusItem[]
  cols?: 2 | 3
  sx?: SxProps<Theme>
}

export default function StatusGrid({ items, cols = 2, sx }: StatusGridProps) {
  return (
    <Box
      sx={[
        {
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '1px',
          background: tokens.border,
          border: `1px solid ${tokens.border}`,
          borderRadius: '2px',
          overflow: 'hidden',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {items.map((it, i) => (
        <Box key={i} sx={{ background: tokens.bg2, padding: '9px 11px', minWidth: 0 }}>
          <Box
            sx={{
              fontFamily: tokens.fontHead,
              fontWeight: 600,
              fontSize: fs.f10,
              letterSpacing: '0.13em',
              textTransform: 'uppercase',
              color: tokens.text2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {it.k}
          </Box>
          <Box
            className="mono"
            sx={{
              fontSize: fs.f14,
              color: TONE_COLOR[it.tone ?? 'default'],
              textShadow: it.tone === 'gold' ? `0 0 14px ${tokens.goldGlow}` : 'none',
              mt: '3px',
            }}
          >
            {it.v}
            {it.unit != null && (
              <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2, ml: '3px' }}>
                {it.unit}
              </Box>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
