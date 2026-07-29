import { Box } from '@mui/material'
import { useLayoutMode } from '../../hooks/useLayoutMode'
import type { LayoutOverride } from '../../store/layoutStore'
import { tokens, fs } from '../../theme'

// Переключатель версии интерфейса — три явных состояния (реш. пользователя):
// «Авто (по ширине)» / «Полная» / «Мобильная». Читает/пишет layoutStore
// (localStorage sc_layout_mode). Сегмент по контракту .tabs/.seg (mobile.css).
const OPTIONS: { value: LayoutOverride; label: string }[] = [
  { value: 'auto',    label: 'Авто' },
  { value: 'desktop', label: 'Полная' },
  { value: 'mobile',  label: 'Мобильная' },
]

export interface LayoutSwitchControlProps {
  /** Киккер над сегментом (напр. «Версия интерфейса»). */
  label?: string
  /** Компактный размер для футера SysBar. */
  size?: 'sm' | 'md'
}

export default function LayoutSwitchControl({ label, size = 'md' }: LayoutSwitchControlProps) {
  const { override, setOverride } = useLayoutMode()
  const minHeight = size === 'sm' ? 28 : 44

  return (
    <Box>
      {label && (
        <Box
          sx={{
            fontFamily: tokens.fontHead,
            fontWeight: 600,
            fontSize: fs.f10,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: tokens.text2,
            mb: '8px',
          }}
        >
          {label}
        </Box>
      )}
      <Box
        role="group"
        aria-label="Версия интерфейса"
        sx={{
          display: 'flex',
          gap: '1px',
          background: tokens.border,
          border: `1px solid ${tokens.border}`,
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        {OPTIONS.map((o) => {
          const on = override === o.value
          return (
            <Box
              key={o.value}
              component="button"
              type="button"
              aria-pressed={on}
              onClick={() => setOverride(o.value)}
              sx={{
                flex: 1,
                minHeight,
                px: '8px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: tokens.fontHead,
                fontWeight: on ? 700 : 600,
                fontSize: fs.f11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                border: 0,
                color: on ? tokens.goldAccent : tokens.text2,
                background: on ? tokens.goldDim : tokens.bg2,
                transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                '&:hover': on ? {} : { color: tokens.text1 },
              }}
            >
              {o.label}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
