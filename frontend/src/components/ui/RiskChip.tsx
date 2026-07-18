import { ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .risk.lo/.md/.hi — статус-чип уровня риска (mono значение + Rajdhani-тег).
// base.css:244-248
export type RiskLevel = 'lo' | 'md' | 'hi'

export interface RiskChipProps {
  /** Уровень риска. */
  level: RiskLevel
  /** Текстовая подпись уровня (default: низкий/средний/высокий). */
  label?: ReactNode
  /** Необязательное числовое значение риска (mono). */
  value?: ReactNode
  sx?: SxProps<Theme>
}

const RISK_STYLE: Record<RiskLevel, { color: string; dim: string; line: string }> = {
  lo: { color: tokens.success, dim: tokens.successDim, line: tokens.successLine },
  md: { color: tokens.warning, dim: tokens.warningDim, line: tokens.warningLine },
  hi: { color: tokens.danger, dim: tokens.dangerDim, line: tokens.dangerLine },
}

const DEFAULT_LABEL: Record<RiskLevel, string> = {
  lo: 'низкий',
  md: 'средний',
  hi: 'высокий',
}

export default function RiskChip({ level, label, value, sx }: RiskChipProps) {
  const s = RISK_STYLE[level]
  return (
    <Box
      component="span"
      className="mono"
      sx={[
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: fs.f11,
          padding: '2px 8px',
          borderRadius: 1,
          color: s.color,
          background: s.dim,
          border: `1px solid ${s.line}`,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box
        component="b"
        sx={{
          fontFamily: tokens.fontHead,
          fontWeight: 700,
          fontSize: fs.f10,
          letterSpacing: '0.1em',
        }}
      >
        {label ?? DEFAULT_LABEL[level]}
      </Box>
      {value != null && <span>{value}</span>}
    </Box>
  )
}
