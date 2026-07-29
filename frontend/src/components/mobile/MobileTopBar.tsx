import { useNavigate } from 'react-router-dom'
import { Box } from '@mui/material'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../../store/authStore'
import { tokens, fs } from '../../theme'
import { TIER_LABELS, type Tier } from '../../constants/tiers'
import DiamondLogo from '../ui/DiamondLogo'
import MobileEmission from './MobileEmission'

// Верхний минибар — контракт .mtop (mobile.css). Бренд слева; справа —
// индикатор выброса, бейдж тарифа, Настройки, Выход. Fixed, тач-цели ≥44px.
const MTOP_H = 52 // --mtop-h

// .ibtn — иконочная кнопка, тач-цель 44×44 (глиф 18px, хит-область паддингом)
const iconBtnSx = {
  width: 44,
  height: 44,
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  border: '1px solid transparent',
  borderRadius: '2px',
  color: tokens.text2,
  cursor: 'pointer',
  transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
  '&:hover, &:active': { color: tokens.goldAccent, background: tokens.bg2, borderColor: tokens.borderHi },
} as const

export default function MobileTopBar() {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()

  const tierLabel = user && !user.is_admin ? TIER_LABELS[user.tier as Tier] : undefined

  return (
    <Box
      component="header"
      sx={{
        position: 'fixed',
        inset: '0 0 auto 0',
        zIndex: tokens.z.nav,
        height: `calc(${MTOP_H}px + env(safe-area-inset-top))`,
        paddingTop: 'env(safe-area-inset-top)',
        px: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: tokens.bg1,
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      {/* .mbrand */}
      <Box
        onClick={() => navigate('/app/monitoring')}
        sx={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', cursor: 'pointer' }}
      >
        <DiamondLogo size={24} />
        <Box
          component="b"
          sx={{
            fontFamily: tokens.fontHead,
            fontWeight: 700,
            fontSize: fs.f15,
            letterSpacing: '0.07em',
            color: tokens.text0,
            whiteSpace: 'nowrap',
          }}
        >
          SC TRADING
        </Box>
      </Box>

      {/* .mtop-r */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <MobileEmission />

        {tierLabel && (
          <Box
            sx={{
              fontFamily: tokens.fontHead,
              fontWeight: 700,
              fontSize: fs.f10,
              letterSpacing: '0.09em',
              color: tokens.goldAccent,
              border: `1px solid ${tokens.goldLine}`,
              background: tokens.goldDim,
              padding: '3px 7px',
              borderRadius: '2px',
              whiteSpace: 'nowrap',
            }}
          >
            {tierLabel}
          </Box>
        )}

        <Box component="button" type="button" aria-label="Настройки" onClick={() => navigate('/app/settings')} sx={iconBtnSx}>
          <SettingsOutlinedIcon sx={{ fontSize: 20 }} />
        </Box>
        <Box component="button" type="button" aria-label="Выход" onClick={() => { logout(); navigate('/') }} sx={iconBtnSx}>
          <LogoutIcon sx={{ fontSize: 20 }} />
        </Box>
      </Box>
    </Box>
  )
}
