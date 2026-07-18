import { SxProps, Theme } from '@mui/material'
import { Box } from '@mui/material'

// SC_SHELL.lockSvg — один stroke-замок. Заменяет 3 копии (LotStatCard /
// SalesHistoryCharts / Layout). Цвет — currentColor (задаётся родителем).
// shell.js:42-46 (viewBox 0 0 11 12)
export interface LockIconProps {
  /** Высота иконки в px (default 12); ширина масштабируется по соотношению 11:12. */
  size?: number
  /** Толщина обводки (default 1.4). */
  strokeWidth?: number
  sx?: SxProps<Theme>
}

export default function LockIcon({ size = 12, strokeWidth = 1.4, sx }: LockIconProps) {
  const height = size
  const width = Math.round((size * 11) / 12)
  return (
    <Box
      component="svg"
      width={width}
      height={height}
      viewBox="0 0 11 12"
      fill="none"
      aria-hidden="true"
      sx={[{ display: 'block', flex: 'none' }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      <rect x="1" y="5" width="9" height="6" stroke="currentColor" strokeWidth={strokeWidth} />
      <path
        d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
    </Box>
  )
}
