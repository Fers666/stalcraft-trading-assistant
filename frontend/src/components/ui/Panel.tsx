import { ReactNode } from 'react'
import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .panel + опц. .sec-h — панель (bg1, border, r2, без тени) с необязательным
// заголовком секции (h2 Rajdhani fs.f12 ls .14em). base.css:145,151-154
export interface PanelProps {
  /** Заголовок секции (.sec-h h2). Если не задан — панель без шапки. */
  title?: ReactNode
  /** Счётчик рядом с заголовком (.sec-h .cnt, зелёный). */
  count?: ReactNode
  /** Подсказка справа в шапке (.sec-h .hint). */
  hint?: ReactNode
  children?: ReactNode
  sx?: SxProps<Theme>
}

export default function Panel({ title, count, hint, children, sx }: PanelProps) {
  return (
    <Box
      sx={[
        {
          background: tokens.bg1,
          border: `1px solid ${tokens.border}`,
          borderRadius: 1,
          boxShadow: 'none',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {title != null && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minHeight: 24,
            padding: '10px 12px',
          }}
        >
          <Box
            component="h2"
            sx={{
              margin: 0,
              fontFamily: tokens.fontHead,
              fontWeight: 700,
              fontSize: fs.f12,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: tokens.text1,
            }}
          >
            {title}
          </Box>
          {count != null && (
            <Box
              component="span"
              className="mono"
              sx={{
                fontSize: fs.f11,
                color: tokens.success,
                background: tokens.successDim,
                border: `1px solid ${tokens.successLine}`,
                padding: '1px 7px',
                borderRadius: 1,
              }}
            >
              {count}
            </Box>
          )}
          {hint != null && (
            <Box component="span" sx={{ marginLeft: 'auto', fontSize: fs.f11, color: tokens.text2 }}>
              {hint}
            </Box>
          )}
        </Box>
      )}
      {children}
    </Box>
  )
}
