import { ReactNode } from 'react'
import { Box, ButtonBase, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .thb + .si — заголовок-кнопка колонки: <button> внутри <th aria-sort>,
// один индикатор ▲/▼ 9px золотой (SORT-01 + A11Y-01). base.css:170-179
export type SortDirection = 'asc' | 'desc'

export interface SortHeaderProps {
  label: ReactNode
  /** Активна ли сортировка по этой колонке. */
  active: boolean
  /** Текущее направление сортировки. */
  direction: SortDirection
  /** Клик по заголовку (переключение сортировки). */
  onSort: () => void
  /** Выравнивание содержимого (default 'right' — как в таблицах данных). */
  align?: 'left' | 'right'
  sx?: SxProps<Theme>
}

export default function SortHeader({
  label,
  active,
  direction,
  onSort,
  align = 'right',
  sx,
}: SortHeaderProps) {
  return (
    <Box
      component="th"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      sx={[
        {
          padding: 0,
          background: tokens.bg2,
          borderBottom: `1px solid ${tokens.borderHi}`,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <ButtonBase
        type="button"
        onClick={onSort}
        disableRipple
        sx={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
          gap: '4px',
          padding: '6px',
          fontFamily: tokens.fontHead,
          fontWeight: 600,
          fontSize: fs.f105,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          color: active ? tokens.goldAccent : tokens.text2,
          transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
          '&:hover': { color: active ? tokens.goldAccent : tokens.text1 },
        }}
      >
        {label}
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            fontSize: '9px',
            lineHeight: 1,
            width: '9px',
            flex: 'none',
            color: tokens.goldHighlight,
          }}
        >
          {active ? (direction === 'asc' ? '▲' : '▼') : ''}
        </Box>
      </ButtonBase>
    </Box>
  )
}
