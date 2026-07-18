import { Children, ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens } from '../../theme'

// .grid-2 + .cell — сетка панелей с 1px-щелями: контейнер background = border,
// gap 1px; ячейки непрозрачные bg1 (щель проступает как линия). base.css:148-150
export interface CompartmentGridProps {
  /** Число колонок (default 2). */
  columns?: number
  /** Дополнительные sx для каждой ячейки (.cell). */
  cellSx?: SxProps<Theme>
  children: ReactNode
  sx?: SxProps<Theme>
}

export default function CompartmentGrid({ columns = 2, cellSx, children, sx }: CompartmentGridProps) {
  return (
    <Box
      sx={[
        {
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: '1px',
          background: tokens.border,
          borderTop: `1px solid ${tokens.border}`,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {Children.map(children, (child) => (
        <Box
          sx={[
            {
              background: tokens.bg1,
              padding: '12px 16px 16px',
              minWidth: 0,
            },
            ...(Array.isArray(cellSx) ? cellSx : cellSx ? [cellSx] : []),
          ]}
        >
          {child}
        </Box>
      ))}
    </Box>
  )
}
