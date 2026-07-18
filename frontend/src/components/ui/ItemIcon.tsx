import { useState } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens, QUALITY_COLORS } from '../../theme'

// .t-ico + .fb (SC_APP.iconHtml) — иконка предмета: img c alt={name} + фолбэк-
// буква на цвете качества (A11Y-03). base.css:31-34,394-396, app.js:97-104
export interface ItemIconProps {
  src?: string
  /** Имя предмета — идёт в alt и в фолбэк-букву. */
  name: string
  /** Ключ качества из БД (поле `color`). */
  quality?: string
  /** Сторона контейнера в px (default 26). */
  size?: number
  sx?: SxProps<Theme>
}

const firstLetter = (name: string): string =>
  name.replace(/[«»"]/g, '').charAt(0).toUpperCase() || '?'

export default function ItemIcon({ src, name, quality = 'default', size = 26, sx }: ItemIconProps) {
  const [failed, setFailed] = useState(false)
  const qc = QUALITY_COLORS[quality] ?? QUALITY_COLORS.default
  const showImg = Boolean(src) && !failed
  const inner = Math.round(size * (22 / 26))

  return (
    <Box
      sx={[
        {
          width: size,
          height: size,
          flex: 'none',
          position: 'relative',
          background: tokens.bg2,
          border: `1px solid ${tokens.border}`,
          display: 'grid',
          placeItems: 'center',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {showImg ? (
        <Box
          component="img"
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{ width: inner, height: inner, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: '100%',
            height: '100%',
            fontFamily: tokens.fontHead,
            fontWeight: 700,
            fontSize: Math.round(size * 0.46),
            color: tokens.bg0,
            background: qc,
          }}
        >
          {firstLetter(name)}
        </Box>
      )}
    </Box>
  )
}
