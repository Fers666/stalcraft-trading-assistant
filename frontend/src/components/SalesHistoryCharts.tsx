import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, ToggleButtonGroup, ToggleButton, Tooltip } from '@mui/material'
import PriceChart from './PriceChart'
import ChartFrame from './ui/ChartFrame'
import TierGate from './ui/TierGate'
import LockIcon from './ui/LockIcon'
import { useAuthStore } from '../store/authStore'
import { tokens, fs } from '../theme'

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
  /** Медиана 7д — линия-ориентир на графике. */
  median?: number
}

type WindowKey = '24h' | '48h' | '7d' | '30d'

const WINDOWS: { key: WindowKey; label: string; hours: number; tier?: string }[] = [
  { key: '24h', label: '24Ч', hours: 24 },
  { key: '48h', label: '48Ч', hours: 48,  tier: 'Продвинутая' },
  { key: '7d',  label: '7Д',  hours: 168, tier: 'Продвинутая+' },
  { key: '30d', label: '30Д', hours: 720, tier: 'Макс' },
]

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter, median }: Props) {
  const navigate = useNavigate()
  const statsWindows = useAuthStore(s => s.user?.stats_windows)

  const allows = (k: WindowKey) => statsWindows?.includes(k) ?? false
  const firstAvailable = WINDOWS.find(w => allows(w.key))?.key ?? '24h'
  const [win, setWin] = useState<WindowKey>(firstAvailable)

  const current = WINDOWS.find(w => w.key === win) ?? WINDOWS[0]
  const locked = !allows(win)

  return (
    <Box>
      {/* .sec-h — заголовок секции + табы окон */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: 24, mb: '10px' }}>
        <Box
          component="h2"
          sx={{
            m: 0, fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f12,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: tokens.text1,
          }}
        >
          Динамика цен
        </Box>
        <ToggleButtonGroup
          value={win}
          exclusive
          onChange={(_, v) => v && setWin(v)}
          size="small"
          sx={{ ml: 'auto' }}
          aria-label="Окно графика"
        >
          {WINDOWS.map(w => {
            const wLocked = !allows(w.key)
            const btn = (
              <ToggleButton key={w.key} value={w.key} sx={{ py: 0.4, px: 1.2, gap: 0.6 }}>
                {w.label}
                {wLocked && <LockIcon size={10} sx={{ color: 'inherit' }} />}
              </ToggleButton>
            )
            return wLocked
              ? <Tooltip key={w.key} title={`Доступно на тарифе ${w.tier}`}>{btn}</Tooltip>
              : btn
          })}
        </ToggleButtonGroup>
      </Box>

      {locked ? (
        <TierGate
          tierLabel={current.tier}
          kicker={`Окно ${current.label}`}
          ctaLabel="Смотреть тарифы"
          onCta={() => navigate('/app/settings')}
        >
          <ChartFrame isEmpty emptyText="" />
        </TierGate>
      ) : (
        <PriceChart
          key={`${itemId}-${win}`}
          itemId={itemId}
          region={region}
          qualityFilter={qualityFilter}
          enchantFilter={enchantFilter}
          defaultHours={current.hours}
          median={median}
          hideControls
        />
      )}
    </Box>
  )
}
