import { Box } from '@mui/material'
import { useFeedStore } from '../../store/feedStore'
import { useAuthStore } from '../../store/authStore'
import { tokens, fs } from '../../theme'
import { TIER_LABELS, type Tier } from '../../constants/tiers'

// Футер-строка мобильной оболочки — контракт .sysbar (mobile.css).
// «SC TRADING TERMINAL · mobile · срез HH:MM · регион RU · тариф N (+ Радар)».
const hhmm = (d: Date | null): string =>
  d ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'

export default function MobileSysBar() {
  const lastLotRefresh = useFeedStore((s) => s.lastLotRefresh)
  const user = useAuthStore((s) => s.user)

  const tierLabel = user?.is_admin
    ? 'Админ'
    : user
      ? (TIER_LABELS[user.tier as Tier] ?? user.tier)
      : '—'
  const radarSuffix = user?.has_market_radar_addon ? ' + Радар' : ''

  const Val = ({ children }: { children: React.ReactNode }) => (
    <Box component="b" sx={{ color: tokens.text1, fontWeight: 500 }}>{children}</Box>
  )

  return (
    <Box
      component="footer"
      className="mono"
      sx={{
        mt: '16px',
        padding: '10px 12px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 14px',
        background: tokens.bg1,
        border: `1px solid ${tokens.border}`,
        borderRadius: '2px',
        fontSize: fs.f105,
        color: tokens.text2,
      }}
    >
      <Box component="span"><Val>SC TRADING TERMINAL</Val> · mobile</Box>
      <Box component="span">срез: <Val>{hhmm(lastLotRefresh)}</Val></Box>
      <Box component="span">регион: <Val>RU</Val></Box>
      <Box component="span">тариф: <Val>{tierLabel}{radarSuffix}</Val></Box>
    </Box>
  )
}
