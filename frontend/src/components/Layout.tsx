import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Box, IconButton, Tooltip } from '@mui/material'
import { useAuthStore } from '../store/authStore'
import { useFeedStore } from '../store/feedStore'
import { tokens, fs } from '../theme'
import { TIER_LABELS, type Tier } from '../constants/tiers'
import DiamondLogo from './ui/DiamondLogo'
import LockIcon from './ui/LockIcon'
import SysBar from './ui/SysBar'
import GlobalFeed, { FEED_HEIGHT } from './GlobalFeed'
import { EmissionWidget } from './EmissionWidget'

const NAV_H = tokens.navH // 48

type GateKey = 'auction_access' | 'market_radar'

interface NavItem {
  label: string
  to: string
  gateKey?: GateKey
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Избранное',   to: '/app/monitoring' },
  { label: 'Каталог',     to: '/app/catalog' },
  { label: 'Лоты',        to: '/app/lots', gateKey: 'auction_access' },
  { label: 'Лента',       to: '/app/feed' },
  { label: 'Склад',       to: '/app/inventory' },
  { label: 'Новости',     to: '/app/news' },
  { label: 'Радар рынка', to: '/app/market-radar', gateKey: 'market_radar' },
]

const GATE_TOOLTIP: Record<GateKey, string> = {
  auction_access: `Доступно на тарифе ${TIER_LABELS.advanced_plus}`,
  market_radar:   'Доступно как отдельный аддон «Радар рынка»',
}

// stroke-иконки .ibtn (shell.js:101-106)
const ICON_SX = { width: 15, height: 15 } as const

const HelpSvg = (
  <Box component="svg" viewBox="0 0 15 15" fill="none" aria-hidden="true" sx={ICON_SX}>
    <circle cx="7.5" cy="7.5" r="6.4" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.7 5.8a1.8 1.8 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.2v.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="7.5" cy="11" r=".9" fill="currentColor" />
  </Box>
)
const GearSvg = (
  <Box component="svg" viewBox="0 0 15 15" fill="none" aria-hidden="true" sx={ICON_SX}>
    <circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M2.9 2.9l1.4 1.4M10.7 10.7l1.4 1.4M12.1 2.9l-1.4 1.4M4.3 10.7l-1.4 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Box>
)
const LogoutSvg = (
  <Box component="svg" viewBox="0 0 15 15" fill="none" aria-hidden="true" sx={ICON_SX}>
    <path d="M9.5 1.5H13a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5H9.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6.5 4.5 3.5 7.5l3 3M3.5 7.5H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </Box>
)

// общий стиль nav-ссылки (.nav a) — активная = золотое подчёркивание, НЕ pill
const navLinkSx = (active: boolean) => ({
  position: 'relative' as const,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  height: '100%',
  padding: '0 13px',
  fontFamily: tokens.fontHead,
  fontWeight: 600,
  fontSize: fs.f125,
  letterSpacing: '0.07em',
  textTransform: 'uppercase' as const,
  textDecoration: 'none',
  borderBottom: '2px solid transparent',
  transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
  color: active ? tokens.goldAccent : tokens.text1,
  borderBottomColor: active ? tokens.goldHighlight : 'transparent',
  textShadow: active ? `0 0 14px ${tokens.goldGlow}` : 'none',
  '&:hover': active ? {} : { color: tokens.text0, background: tokens.bg2 },
  '&:active': { background: tokens.bg3 },
})

function AppNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()

  const settingsActive = location.pathname === '/app/settings'

  return (
    <Box
      component="header"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: `${NAV_H}px`,
        zIndex: 1300,
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        px: '16px',
        background: tokens.bg1,
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      {/* Бренд */}
      <Box
        onClick={() => navigate('/app/monitoring')}
        sx={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 'none' }}
      >
        <DiamondLogo size={26} />
        <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1.02 }}>
          <Box component="b" sx={{
            fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f15,
            letterSpacing: '0.08em', color: tokens.text0,
          }}>
            SC TRADING
          </Box>
          <Box component="span" sx={{
            fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f10,
            letterSpacing: '0.24em', textTransform: 'uppercase', color: tokens.text2,
          }}>
            Zone Terminal
          </Box>
        </Box>
      </Box>

      {/* Навигация */}
      <Box component="nav" aria-label="Основная навигация" sx={{ display: 'flex', alignItems: 'stretch', height: '100%' }}>
        {NAV_ITEMS.map(({ label, to, gateKey }) => {
          const locked = !!gateKey && !user?.is_admin && (
            gateKey === 'market_radar'
              ? !user?.has_market_radar_addon
              : user?.auction_access === false
          )

          if (locked) {
            return (
              <Tooltip key={to} title={GATE_TOOLTIP[gateKey!]}>
                <Box
                  aria-disabled="true"
                  sx={{ ...navLinkSx(false), color: tokens.text2, cursor: 'not-allowed', '&:hover': { color: tokens.text1 } }}
                >
                  {label}
                  <Box component="span" sx={{ display: 'flex', color: tokens.text2, opacity: 0.8 }}>
                    <LockIcon size={12} />
                  </Box>
                </Box>
              </Tooltip>
            )
          }

          return (
            <NavLink key={to} to={to} style={{ height: '100%', textDecoration: 'none', color: 'inherit' }}>
              {({ isActive }) => <Box sx={navLinkSx(isActive)}>{label}</Box>}
            </NavLink>
          )
        })}

        {user?.is_admin && (
          <NavLink to="/app/admin" style={{ height: '100%', textDecoration: 'none', color: 'inherit' }}>
            {({ isActive }) => <Box sx={navLinkSx(isActive)}>Админ</Box>}
          </NavLink>
        )}
      </Box>

      {/* Правый блок (.tb-r) */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: '14px' }}>
        <EmissionWidget />

        {user && (
          <>
            <Box component="span" className="mono" sx={{ fontSize: fs.f12, color: tokens.text1 }}>
              {user.username}
            </Box>

            {!user.is_admin && TIER_LABELS[user.tier as Tier] && (
              <Box
                component="span"
                sx={{
                  fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f11,
                  letterSpacing: '0.1em', whiteSpace: 'nowrap',
                  color: tokens.goldAccent,
                  border: `1px solid ${tokens.goldLine}`,
                  background: tokens.goldDim,
                  padding: '3px 9px', borderRadius: '2px',
                }}
              >
                {TIER_LABELS[user.tier as Tier]}
              </Box>
            )}

            <Box sx={{ display: 'flex', gap: '2px' }}>
              <Tooltip title="Помощь">
                <IconButton aria-label="Помощь" onClick={() => navigate('/faq')}>
                  {HelpSvg}
                </IconButton>
              </Tooltip>
              <Tooltip title="Настройки">
                <IconButton
                  aria-label="Настройки"
                  aria-current={settingsActive ? 'page' : undefined}
                  onClick={() => navigate('/app/settings')}
                  sx={settingsActive ? {
                    color: tokens.goldAccent,
                    borderColor: tokens.goldLine,
                    background: tokens.goldDim,
                  } : undefined}
                >
                  {GearSvg}
                </IconButton>
              </Tooltip>
              <Tooltip title="Выйти">
                <IconButton
                  aria-label="Выход"
                  onClick={() => { logout(); navigate('/') }}
                  sx={{ '&:hover': { color: tokens.danger, borderColor: tokens.dangerLine, background: tokens.dangerDim } }}
                >
                  {LogoutSvg}
                </IconButton>
              </Tooltip>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}

export default function Layout() {
  const { watchlist, initialized, feedItems, lastLotRefresh } = useFeedStore()
  const feedShown = initialized && watchlist.length > 0 &&
    (lastLotRefresh === null || feedItems.length > 0)
  const topOffset = NAV_H + (feedShown ? FEED_HEIGHT : 0)

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        bgcolor: 'background.default',
        // LAY-01 — страницы читают отсюда вместо магических 156px
        '--sc-top-offset': `${topOffset}px`,
      }}
    >
      <AppNav />
      <GlobalFeed />
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          p: 3,
          mt: `${topOffset}px`,
          transition: `margin-top ${tokens.motion.fast}ms ${tokens.motion.ease}`,
        }}
      >
        <Box sx={{ flexGrow: 1 }}>
          <Outlet />
        </Box>
        <SysBar />
      </Box>
    </Box>
  )
}
