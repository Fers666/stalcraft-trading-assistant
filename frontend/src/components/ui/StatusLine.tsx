import { ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .statusline + .st — полоса метрик с 1px-щелями: киккер + mono-значение.
// Варианты цвета значения: g/a/gold/r. base.css:157-166,579-580
export type StatusTone = 'default' | 'g' | 'a' | 'gold' | 'r'

export interface StatusMetric {
  /** Киккер метрики (.st .k). */
  label: ReactNode
  /** Значение (.st .v, mono). */
  value: ReactNode
  /** Единица измерения (.st .v .u, приглушённая). */
  unit?: ReactNode
  /** Цветовой тон значения. */
  tone?: StatusTone
}

export interface StatusLineProps {
  metrics: StatusMetric[]
  /** Число колонок (default = число метрик). */
  columns?: number
  sx?: SxProps<Theme>
}

const TONE_COLOR: Record<Exclude<StatusTone, 'default'>, string> = {
  g: tokens.success,
  a: tokens.warning,
  gold: tokens.goldHighlight,
  r: tokens.danger,
}

export default function StatusLine({ metrics, columns, sx }: StatusLineProps) {
  const cols = columns ?? metrics.length
  return (
    <Box
      sx={[
        {
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '1px',
          background: tokens.border,
          borderTop: `1px solid ${tokens.border}`,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {metrics.map((m, i) => {
        const tone = m.tone ?? 'default'
        return (
          <Box key={i} sx={{ background: tokens.bg2, padding: '8px 14px', minWidth: 0 }}>
            <Box
              component="span"
              sx={{
                display: 'block',
                fontFamily: tokens.fontHead,
                fontWeight: 600,
                fontSize: fs.f10,
                letterSpacing: '0.13em',
                textTransform: 'uppercase',
                color: tokens.text2,
                marginBottom: '2px',
                whiteSpace: 'nowrap',
              }}
            >
              {m.label}
            </Box>
            <Box
              component="span"
              className="mono"
              sx={{
                display: 'block',
                fontSize: fs.f14,
                fontWeight: 500,
                whiteSpace: 'nowrap',
                color: tone === 'default' ? tokens.text0 : TONE_COLOR[tone],
                ...(tone === 'gold' ? { textShadow: `0 0 14px ${tokens.goldGlow}` } : null),
              }}
            >
              {m.value}
              {m.unit != null && (
                <Box component="span" sx={{ color: tokens.text2, fontSize: fs.f11 }}>
                  {' '}
                  {m.unit}
                </Box>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
