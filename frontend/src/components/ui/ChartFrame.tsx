import { ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// §3.3.1: .chart-wrap + .c-meta + .chart-empty — обёртка графика: строка меты
// сверху (mono fs.f11 + легенда-свотчи), рамка border + фон bg2 (min-height 236),
// empty-текст по центру, слот под TierGate/recharts. base.css:277-297
export type ChartSwatch = 'g' | 'gd' | 'band' | 'line'

export interface ChartLegendItem {
  label: ReactNode
  /** Тип свотча: g (зелёный), gd (золото), band (коридор), line (средняя). */
  variant: ChartSwatch
}

export interface ChartFrameProps {
  /** Строка меты (например «сделок 42 · мин 1 200 · сред 3 400»), mono. */
  meta?: ReactNode
  /** Легенда графика (свотчи справа в строке меты). */
  legend?: ChartLegendItem[]
  /** Пусто ли (показать empty-текст вместо содержимого). */
  isEmpty?: boolean
  /** Текст пустого состояния (default «Нет данных»). */
  emptyText?: ReactNode
  /** Минимальная высота рамки (default 236). */
  minHeight?: number
  /** Содержимое (recharts / TierGate). */
  children?: ReactNode
  sx?: SxProps<Theme>
}

function swatchSx(variant: ChartSwatch) {
  switch (variant) {
    case 'g':
      return { width: 8, height: 8, background: tokens.success }
    case 'gd':
      return { width: 8, height: 8, background: tokens.gold }
    case 'band':
      return {
        width: 8,
        height: 8,
        background: tokens.goldLineSoft,
        border: `1px solid ${tokens.goldLine}`,
      }
    case 'line':
      return { width: 8, height: 2, background: tokens.goldAccent }
  }
}

export default function ChartFrame({
  meta,
  legend,
  isEmpty = false,
  emptyText = 'Нет данных',
  minHeight = 236,
  children,
  sx,
}: ChartFrameProps) {
  const hasMeta = meta != null || (legend != null && legend.length > 0)

  return (
    <Box sx={[...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>
      {hasMeta && (
        <Box
          className="mono"
          sx={{
            display: 'flex',
            gap: '14px',
            flexWrap: 'wrap',
            alignItems: 'center',
            fontSize: fs.f11,
            color: tokens.text2,
            marginBottom: '6px',
          }}
        >
          {meta != null && <span>{meta}</span>}
          {legend?.map((lg, i) => (
            <Box key={i} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Box component="span" sx={{ flex: 'none', ...swatchSx(lg.variant) }} />
              {lg.label}
            </Box>
          ))}
        </Box>
      )}

      <Box
        sx={{
          position: 'relative',
          border: `1px solid ${tokens.border}`,
          background: tokens.bg2,
          minHeight,
        }}
      >
        {isEmpty ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: tokens.text2,
              fontSize: fs.f12,
            }}
          >
            {emptyText}
          </Box>
        ) : (
          children
        )}
      </Box>
    </Box>
  )
}
