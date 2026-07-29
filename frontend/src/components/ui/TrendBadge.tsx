import { Box, Tooltip } from '@mui/material'
import { tokens, fs } from '../../theme'
import { fmtP } from '../../utils/format'
import type { MarketTrend } from '../../hooks/useLotStats'

// Расхождение свежего уровня рынка (медиана сделок за 24ч) с медианой за 7д.
// На падающем рынке медиана 7д отражает цену ~3.5-дневной давности — бейдж
// показывает этот разрыв рядом с ней, чтобы число не читалось как «цена сейчас».

const TONE = {
  error:   { color: tokens.danger,  dim: tokens.dangerDim,  line: tokens.dangerLine  },
  success: { color: tokens.success, dim: tokens.successDim, line: tokens.successLine },
} as const

interface Props {
  trend: MarketTrend | null
  median7d?: number | null
  median24h?: number | null
}

export default function TrendBadge({ trend, median7d, median24h }: Props) {
  // «Стабильно» не показываем: бейдж существует, чтобы отметить расхождение
  if (!trend?.tone || trend.pct == null) return null

  const tone = TONE[trend.tone as keyof typeof TONE]
  if (!tone) return null

  const sign = trend.pct > 0 ? '+' : '−'
  const title = median24h != null && median7d != null
    ? `медиана 24ч ${fmtP(median24h)} · 7д ${fmtP(median7d)}`
    : 'отклонение медианы сделок за 24ч от медианы за 7д'

  return (
    <Tooltip title={title}>
      <Box
        component="span"
        className="mono"
        sx={{
          display: 'inline-block', mt: '6px', cursor: 'help',
          fontSize: fs.f11, color: tone.color, background: tone.dim,
          border: `1px solid ${tone.line}`,
          px: 0.875, py: '1px', borderRadius: `${tokens.radiusLg / 2}px`,
          whiteSpace: 'nowrap',
        }}
      >
        рынок {sign}{Math.abs(trend.pct).toFixed(1)}% за 24ч
      </Box>
    </Tooltip>
  )
}
