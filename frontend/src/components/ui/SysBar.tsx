import { Box, SxProps, Theme } from '@mui/material'
import { useFeedStore } from '../../store/feedStore'
import { useAuthStore } from '../../store/authStore'
import { tokens, fs } from '../../theme'
import { TIER_LABELS, type Tier } from '../../constants/tiers'

// Футер-строка терминала — контракт .sysbar (base.css:337-342).
// «SC TRADING TERMINAL · срез данных HH:MM · регион RU · тариф N».
// Срез — реальное время последнего обновления ленты (feedStore).
export interface SysBarProps {
  sx?: SxProps<Theme>
}

const hhmm = (d: Date | null): string =>
  d ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'

export default function SysBar({ sx }: SysBarProps) {
  const lastLotRefresh = useFeedStore(s => s.lastLotRefresh)
  const user           = useAuthStore(s => s.user)

  const tierLabel = user?.is_admin
    ? 'Админ'
    : user
      ? (TIER_LABELS[user.tier as Tier] ?? user.tier)
      : '—'
  const radarSuffix = user?.has_market_radar_addon ? ' + Радар' : ''

  const dot = (
    <Box component="span" aria-hidden sx={{ color: tokens.text2 }}>·</Box>
  )
  const Val = ({ children }: { children: React.ReactNode }) => (
    <Box component="b" sx={{ color: tokens.text1, fontWeight: 500 }}>{children}</Box>
  )

  return (
    <Box
      component="footer"
      className="mono"
      sx={[
        {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '10px',
          mt: '24px',
          padding: '6px 12px',
          background: tokens.bg1,
          border: `1px solid ${tokens.border}`,
          borderRadius: '2px',
          fontSize: fs.f105,
          letterSpacing: '0.04em',
          color: tokens.text2,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box component="span"><Val>SC TRADING TERMINAL</Val></Box>
      {dot}
      <Box component="span">срез данных <Val>{hhmm(lastLotRefresh)}</Val></Box>
      {dot}
      <Box component="span">регион <Val>RU</Val></Box>
      {dot}
      <Box component="span">тариф <Val>{tierLabel}{radarSuffix}</Val></Box>
    </Box>
  )
}
