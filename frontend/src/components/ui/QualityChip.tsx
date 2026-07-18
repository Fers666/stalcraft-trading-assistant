import { ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { fs, QUALITY_COLORS } from '../../theme'

// .chip.q — чип качества: цвет из QUALITY_COLORS[color], точка .qd currentColor,
// граница ~45% прозрачности цвета (через alpha()). base.css:235-241
export interface QualityChipProps {
  /** Ключ качества из БД (поле `color`): default/newbie/stalker/veteran/master/legend. */
  color: string
  label: ReactNode
  sx?: SxProps<Theme>
}

export default function QualityChip({ color, label, sx }: QualityChipProps) {
  const qc = QUALITY_COLORS[color] ?? QUALITY_COLORS.default
  return (
    <Box
      component="span"
      sx={[
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: fs.f11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 1,
          color: qc,
          border: `1px solid ${alpha(qc, 0.45)}`,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          width: 6,
          height: 6,
          background: 'currentColor',
          boxShadow: '0 0 6px currentColor',
        }}
      />
      {label}
    </Box>
  )
}
