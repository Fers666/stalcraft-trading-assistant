import { Box, BoxProps } from '@mui/material'
import { tokens, fs } from '../../theme'

// .kick — киккер: Rajdhani 600, fs.f10, uppercase, ls .16em, text2 (base.css:37)
export type KickProps = BoxProps

export default function Kick({ sx, ...rest }: KickProps) {
  return (
    <Box
      component="span"
      sx={[
        {
          fontFamily: tokens.fontHead,
          fontWeight: 600,
          fontSize: fs.f10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: tokens.text2,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
      {...rest}
    />
  )
}
