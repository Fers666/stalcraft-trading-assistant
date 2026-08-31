import { useState } from 'react'
import { Box } from '@mui/material'
import { tokens, fs } from '../../theme'

// .sig-ico — иконка предмета в полосе сигналов: img c фолбэком на первую букву
// названия в цвете качества. Фолбэк нужен и на битый src: иконки приходят с
// внешнего CDN, и без onError недоступный хост оставлял пустую рамку навсегда.
export interface SignalIconProps {
  src?: string
  /** Подпись сигнала — из неё берётся фолбэк-буква. */
  label: string
  /** Цвет качества для фолбэк-буквы. */
  color: string
  /** Сторона контейнера в px. */
  size: number
}

export default function SignalIcon({ src, label, color, size }: SignalIconProps) {
  const [failed, setFailed] = useState(false)

  return (
    <Box
      sx={{
        width: size,
        height: size,
        flex: 'none',
        position: 'relative',
        background: tokens.bg2,
        border: `1px solid ${tokens.border}`,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {src && !failed ? (
        <Box
          component="img"
          src={src}
          alt=""
          onError={() => setFailed(true)}
          sx={{ width: size - 4, height: size - 4, objectFit: 'contain' }}
        />
      ) : (
        <Box component="span" sx={{ fontSize: fs.f13, fontWeight: 700, color }}>
          {label[0] ?? '?'}
        </Box>
      )}
    </Box>
  )
}
