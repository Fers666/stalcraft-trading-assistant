import { Box, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../../theme'

// Карточка-из-строки — ключевой мобильный приём (.dcard, mobile.css). Замена
// широких таблиц на узком экране: иконка + имя/подпись + правое значение, опц.
// чипы, kv-строки и футер. Кликабельна (button) при onClick, иначе div.
export type DCardKvTone = 'default' | 'pos' | 'neg' | 'gold' | 'dim'

export interface DCardKv {
  label: React.ReactNode
  value: React.ReactNode
  tone?: DCardKvTone
}

export interface DCardProps {
  /** Содержимое .dc-ico (img/фолбэк-глиф). */
  icon?: React.ReactNode
  name: React.ReactNode
  sub?: React.ReactNode
  /** Правый блок .dc-right (цена + подпись). */
  right?: React.ReactNode
  chips?: React.ReactNode
  kv?: DCardKv[]
  footer?: React.ReactNode
  /** Выбранная карточка (.on) — золотая подложка + левый маркер. */
  selected?: boolean
  /** «Горит» (.lit) — золотая рамка + левый маркер, без подложки. */
  lit?: boolean
  onClick?: () => void
  sx?: SxProps<Theme>
}

const KV_COLOR: Record<DCardKvTone, string> = {
  default: tokens.text0,
  pos:     tokens.success,
  neg:     tokens.danger,
  gold:    tokens.goldHighlight,
  dim:     tokens.text2,
}

export default function DCard({
  icon, name, sub, right, chips, kv, footer, selected, lit, onClick, sx,
}: DCardProps) {
  const interactive = typeof onClick === 'function'

  const rootSx = [
    {
      display: 'block',
      width: '100%',
      textAlign: 'left' as const,
      background: selected ? tokens.goldDim : tokens.bg2,
      border: `1px solid ${selected || lit ? tokens.goldLine : tokens.border}`,
      borderRadius: '2px',
      boxShadow: selected || lit ? `inset 2px 0 0 ${tokens.goldHighlight}` : 'none',
      padding: '11px 12px',
      color: 'inherit',
      transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
      // Подсветка нажатия живёт на корне, а сама кнопка — внутри (см. ниже).
      '&:has(> button:active)': interactive ? { background: tokens.bg3 } : undefined,
    },
    ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
  ]

  // Кликабельная зона — тело карточки, а НЕ корень: кнопки футера не могут
  // быть потомками <button> (validateDOMNesting, двойное срабатывание тапа).
  const hitSx = {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    background: 'transparent',
    border: 0,
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    // Дубль подсветки корня — фолбэк для браузеров без :has (цвет тот же).
    '&:active': { background: tokens.bg3 },
    '&:focus-visible': { outline: `1px solid ${tokens.goldLine}`, outlineOffset: '2px' },
  }

  const body = (
    <>
      {/* .dc-top */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        {icon != null && (
          <Box
            sx={{
              width: 38,
              height: 38,
              flex: 'none',
              position: 'relative',
              background: tokens.bg1,
              border: `1px solid ${tokens.border}`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {icon}
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              fontSize: fs.f14,
              fontWeight: 600,
              color: tokens.text0,
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </Box>
          {sub != null && (
            <Box className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
              {sub}
            </Box>
          )}
        </Box>
        {right != null && (
          <Box className="mono" sx={{ flex: 'none', textAlign: 'right' }}>
            {right}
          </Box>
        )}
      </Box>

      {chips != null && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', mt: '9px' }}>
          {chips}
        </Box>
      )}

      {kv && kv.length > 0 && (
        <Box
          component="dl"
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '5px 10px',
            m: 0,
            mt: '10px',
            pt: '10px',
            borderTop: `1px solid ${tokens.border}`,
          }}
        >
          {kv.map((row, i) => (
            <Box key={i} sx={{ display: 'contents' }}>
              <Box component="dt" sx={{ fontSize: fs.f11, color: tokens.text2, whiteSpace: 'nowrap' }}>
                {row.label}
              </Box>
              <Box
                component="dd"
                className="mono"
                sx={{ m: 0, fontSize: fs.f125, textAlign: 'right', color: KV_COLOR[row.tone ?? 'default'] }}
              >
                {row.value}
              </Box>
            </Box>
          ))}
        </Box>
      )}

    </>
  )

  return (
    <Box sx={rootSx}>
      {interactive
        ? <Box component="button" type="button" onClick={onClick} sx={hitSx}>{body}</Box>
        : body}
      {footer != null && (
        <Box sx={{ display: 'flex', gap: '8px', mt: '11px', '& > *': { flex: 1 } }}>{footer}</Box>
      )}
    </Box>
  )
}
