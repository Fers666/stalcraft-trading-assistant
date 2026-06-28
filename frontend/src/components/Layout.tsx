import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Box, IconButton, Tooltip, Typography, alpha } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../store/authStore'
import { useFeedStore } from '../store/feedStore'
import { tokens } from '../theme'
import GlobalFeed, { FEED_HEIGHT } from './GlobalFeed'

const { gold: G2, goldAccent: G3, text2: T2, border: BORDER } = tokens

const NAV_ITEMS = [
  {
    label: 'Избранное', to: '/app/monitoring',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 12h3l2 4 4-8 2 4h2"/></svg>,
  },
  {
    label: 'Каталог', to: '/app/catalog',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><path d="M4 4h7v16H4z"/><path d="M13 4h7v16h-7z"/></svg>,
  },
  {
    label: 'Лоты', to: '/app/lots', gated: true,
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>,
    lockSvg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  },
  {
    label: 'Лента', to: '/app/feed',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><path d="M5 9l4 4-4 4M5 5h2l9 14h3"/></svg>,
  },
  {
    label: 'Склад', to: '/app/inventory',
    svg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><rect x="3" y="7" width="18" height="13" rx="1"/><path d="M3 7l2-3h14l2 3"/></svg>,
  },
]

function AppNav() {
  const navigate   = useNavigate()
  const { user, logout } = useAuthStore()

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: 56,
      background: 'rgba(17,21,26,0.92)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      borderBottom: `1px solid ${BORDER}`,
      display: 'flex', alignItems: 'center',
      padding: '0 24px', gap: 8,
      zIndex: 1300,
    }}>

      {/* Логотип */}
      <div
        onClick={() => navigate('/app/monitoring')}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexShrink: 0, marginRight: 4 }}
      >
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <defs>
            <linearGradient id="nav-g" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#B78A2A" />
              <stop offset="55%" stopColor="#D9AF37" />
              <stop offset="100%" stopColor="#F2C94C" />
            </linearGradient>
            <clipPath id="nav-c">
              <polygon points="16,1 31,16 16,31 1,16" />
            </clipPath>
          </defs>
          <polygon points="16,1 31,16 16,31 1,16" stroke="url(#nav-g)" strokeWidth="1.5" fill="none" />
          <g clipPath="url(#nav-c)">
            <rect x="5"  y="21" width="4" height="9"  fill="url(#nav-g)" opacity="0.55" />
            <rect x="11" y="17" width="4" height="13" fill="url(#nav-g)" opacity="0.7"  />
            <rect x="16" y="12" width="4" height="18" fill="url(#nav-g)" opacity="0.85" />
            <rect x="21" y="7"  width="4" height="23" fill="url(#nav-g)" />
          </g>
        </svg>
        <div>
          <div style={{
            fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
            fontSize: 16, color: '#F5F5F5', letterSpacing: '0.08em', lineHeight: 1,
          }}>
            SC TRADING
          </div>
          <div style={{ fontSize: 8, color: '#7C7C7C', letterSpacing: '0.14em', lineHeight: 1 }}>
            ZONE MARKET TERMINAL
          </div>
        </div>
      </div>

      {/* Разделитель */}
      <div style={{ width: 1, height: 24, background: BORDER, flexShrink: 0, marginRight: 4 }} />

      {/* Навигационные ссылки */}
      <div style={{ display: 'flex', flexGrow: 1, gap: 4 }}>
        {NAV_ITEMS.map(({ label, to, svg, gated, lockSvg }) => {
          const locked = !!gated && !user?.is_admin && user?.auction_access === false
          if (locked) {
            return (
              <Tooltip key={to} title="Доступно на тарифах Продвинутая Плюс/Макс">
                <div
                  onClick={(e) => e.preventDefault()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontFamily: '"Rajdhani", sans-serif',
                    fontWeight: 500,
                    fontSize: 13, letterSpacing: '0.06em',
                    color: T2,
                    cursor: 'not-allowed',
                    padding: '0 12px', height: 34, borderRadius: 8,
                    border: '1px solid transparent',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ color: T2, display: 'flex', alignItems: 'center' }}>{lockSvg ?? svg}</span>
                  {label}
                </div>
              </Tooltip>
            )
          }
          return (
            <NavLink
              key={to}
              to={to}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: '"Rajdhani", sans-serif',
                fontWeight: isActive ? 700 : 500,
                fontSize: 13, letterSpacing: '0.06em',
                color: isActive ? G3 : '#B8B8B8',
                textDecoration: 'none',
                padding: '0 12px', height: 34, borderRadius: 8,
                background: isActive ? alpha(G2, 0.12) : 'transparent',
                border: isActive
                  ? `1px solid ${alpha(G2, 0.3)}`
                  : '1px solid transparent',
                transition: 'all 0.2s',
                flexShrink: 0,
              })}
            >
              {({ isActive }) => (
                <>
                  <span style={{ color: isActive ? G3 : '#B8B8B8', display: 'flex', alignItems: 'center' }}>{svg}</span>
                  {label}
                </>
              )}
            </NavLink>
          )
        })}
      </div>

      {/* Кнопка Админ — только для is_admin */}
      {user?.is_admin && (
        <NavLink
          to="/app/admin"
          style={({ isActive }) => ({
            display: 'flex', alignItems: 'center', gap: 4,
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: isActive ? 700 : 500,
            fontSize: 13, letterSpacing: '0.06em',
            color: isActive ? G3 : G2,
            textDecoration: 'none',
            padding: '0 12px', height: 34, borderRadius: 8,
            background: isActive ? alpha(G2, 0.12) : 'transparent',
            border: `1px solid ${alpha(G2, 0.3)}`,
            transition: 'all 0.2s',
            flexShrink: 0,
          })}
        >
          {() => 'Админ'}
        </NavLink>
      )}

      {/* Пользователь */}
      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <div style={{
            padding: '3px 10px',
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.02)',
            marginRight: 4,
          }}>
            <Typography sx={{ fontSize: '0.72rem', color: T2, letterSpacing: '0.05em' }}>
              {user.username}
            </Typography>
          </div>
          <Tooltip title="Настройки">
            <IconButton size="small" onClick={() => navigate('/app/settings')}
              sx={{ color: T2, borderRadius: '8px', '&:hover': { color: G3, background: alpha(G2, 0.1) } }}>
              <SettingsIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Выйти">
            <IconButton size="small" onClick={() => { logout(); navigate('/') }}
              sx={{ color: T2, borderRadius: '8px', '&:hover': { color: '#FF5A5A', background: alpha('#FF5A5A', 0.1) } }}>
              <LogoutIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const { watchlist, initialized, feedItems, lastLotRefresh } = useFeedStore()
  const feedShown = initialized && watchlist.length > 0 &&
    (lastLotRefresh === null || feedItems.length > 0)
  const topOffset   = 56 + (feedShown ? FEED_HEIGHT : 0)

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppNav />
      <GlobalFeed />
      <Box component="main" sx={{ flexGrow: 1, p: 3, mt: `${topOffset}px`, transition: 'margin-top 0.2s' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
