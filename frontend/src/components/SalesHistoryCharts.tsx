import { Box, Typography, Tooltip } from '@mui/material'
import PriceChart from './PriceChart'
import { useAuthStore } from '../store/authStore'
import { tokens } from '../theme'

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
}

type WindowKey = '24h' | '48h' | '7d' | '30d'

const PERIODS: { label: string; value: number; windowKey: WindowKey }[] = [
  { label: '24 часа',  value: 24,  windowKey: '24h' },
  { label: '48 часов', value: 48,  windowKey: '48h' },
  { label: '7 дней',   value: 168, windowKey: '7d'  },
  { label: '30 дней',  value: 720, windowKey: '30d' },
]

const TIER_HINTS: Partial<Record<WindowKey, string>> = {
  '48h': 'Доступно на тарифах Продвинутая и выше',
  '7d':  'Доступно на тарифах Продвинутая Плюс и выше',
  '30d': 'Доступно на тарифе Продвинутая Макс',
}

const LockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 20, height: 20 }}>
    <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
  </svg>
)

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter }: Props) {
  const statsWindows = useAuthStore(s => s.user?.stats_windows)

  return (
    <Box>
      <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em', mb: 1.5, textTransform: 'uppercase' }}>
        История продаж
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        {PERIODS.map(p => {
          const locked = !statsWindows?.includes(p.windowKey)
          return (
            <Box
              key={p.value}
              sx={{
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '12px',
                p: 1.5,
                bgcolor: 'rgba(255,255,255,0.02)',
              }}
            >
              <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'text.disabled', mb: 1, textTransform: 'uppercase' }}>
                {p.label}
              </Typography>
              {locked ? (
                <Tooltip title={TIER_HINTS[p.windowKey]}>
                  <Box sx={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 0.75, py: 3, color: tokens.text2, cursor: 'not-allowed',
                  }}>
                    <LockIcon />
                    <Typography sx={{ fontSize: '0.65rem', color: tokens.text2 }}>Недоступно на тарифе</Typography>
                  </Box>
                </Tooltip>
              ) : (
                <PriceChart
                  key={`${itemId}-${p.value}`}
                  itemId={itemId}
                  region={region}
                  qualityFilter={qualityFilter}
                  enchantFilter={enchantFilter}
                  defaultHours={p.value}
                  hideControls
                />
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
