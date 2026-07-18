import { Box, SxProps, Theme } from '@mui/material'
import { tokens } from '../../theme'

// Ромб-логотип SC Trading (stroke gold). Заменяет 4+ инлайн-копии
// (Layout / LoginPage / LandingPage / Navbar). shell.js:82-85
export interface DiamondLogoProps {
  /** Сторона SVG в px (default 26). */
  size?: number
  sx?: SxProps<Theme>
}

export default function DiamondLogo({ size = 26, sx }: DiamondLogoProps) {
  return (
    <Box
      component="svg"
      width={size}
      height={size}
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
      sx={[{ display: 'block', flex: 'none' }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      <path
        d="M13 1.5 L24.5 13 L13 24.5 L1.5 13 Z"
        stroke={tokens.gold}
        strokeWidth={1.6}
      />
      <path
        d="M13 6.5 L19.5 13 L13 19.5 L6.5 13 Z"
        fill={tokens.gold}
        fillOpacity={0.22}
        stroke={tokens.goldAccent}
        strokeWidth={1}
      />
    </Box>
  )
}
