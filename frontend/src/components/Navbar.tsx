import { useNavigate, useLocation } from 'react-router-dom'
import { AppBar, Toolbar, Box, Button, IconButton, Tooltip, Typography, alpha } from '@mui/material'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import { useAuthStore } from '../store/authStore'
import { tokens } from '../theme'

const { gold: G2, goldAccent: G3, goldSoft: G1, text1: T1, text2: T2, border: BORDER } = tokens

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon sx={{ fontSize: 14 }} /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    sx={{ fontSize: 14 }} /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      sx={{ fontSize: 14 }} /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  sx={{ fontSize: 14 }} /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   sx={{ fontSize: 14 }} /> },
]

function DiamondLogo() {
  return (
    <Box sx={{ width: 32, height: 32, position: 'relative', flexShrink: 0 }}>
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="nav-gold" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#B78A2A" />
            <stop offset="55%" stopColor="#D9AF37" />
            <stop offset="100%" stopColor="#F2C94C" />
          </linearGradient>
          <clipPath id="nav-clip">
            <polygon points="16,1 31,16 16,31 1,16" />
          </clipPath>
        </defs>
        <polygon points="16,1 31,16 16,31 1,16" stroke="url(#nav-gold)" strokeWidth="1.5" fill="none" />
        <g clipPath="url(#nav-clip)">
          <rect x="5"  y="21" width="4" height="9"  fill="url(#nav-gold)" opacity="0.55" />
          <rect x="11" y="17" width="4" height="13" fill="url(#nav-gold)" opacity="0.7"  />
          <rect x="16" y="12" width="4" height="18" fill="url(#nav-gold)" opacity="0.85" />
          <rect x="21" y="7"  width="4" height="23" fill="url(#nav-gold)" />
        </g>
      </svg>
    </Box>
  )
}

export default function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()

  return (
    <AppBar position="fixed" elevation={0}>
      <Toolbar sx={{ minHeight: '56px !important', px: 3, gap: 2 }}>

        {/* Логотип */}
        <Box
          onClick={() => navigate('/app/monitoring')}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, cursor: 'pointer', flexShrink: 0 }}
        >
          <DiamondLogo />
          <Box>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif',
              fontWeight: 700, fontSize: '1.1rem',
              color: '#F5F5F5', letterSpacing: '0.08em', lineHeight: 1,
            }}>
              SC TRADING
            </Typography>
            <Typography sx={{ fontSize: '0.5rem', color: T2, letterSpacing: '0.14em', lineHeight: 1 }}>
              ZONE MARKET TERMINAL
            </Typography>
          </Box>
        </Box>

        {/* Разделитель */}
        <Box sx={{ width: 1, height: 24, bgcolor: BORDER, flexShrink: 0 }} />

        {/* Навигация */}
        <Box sx={{ display: 'flex', flexGrow: 1, gap: 0.5 }}>
          {navItems.map((item) => {
            const active = location.pathname === item.path
            return (
              <Button
                key={item.path}
                startIcon={item.icon}
                onClick={() => navigate(item.path)}
                size="small"
                disableRipple={!active}
                sx={{
                  fontFamily: '"Rajdhani", sans-serif',
                  fontWeight: active ? 700 : 500,
                  fontSize: '0.8rem',
                  letterSpacing: '0.06em',
                  color: active ? G3 : T1,
                  px: 1.5,
                  height: 34,
                  borderRadius: '8px',
                  background: active ? alpha(G2, 0.12) : 'transparent',
                  border: active ? `1px solid ${alpha(G2, 0.3)}` : '1px solid transparent',
                  transition: 'all 0.2s',
                  '& .MuiButton-startIcon': { mr: '4px', opacity: active ? 1 : 0.7 },
                  '&:hover': {
                    color: '#F5F5F5',
                    background: alpha(G2, 0.07),
                    border: `1px solid ${alpha(G2, 0.15)}`,
                  },
                }}
              >
                {item.label}
              </Button>
            )
          })}
          {user?.is_admin && (
            <Button
              startIcon={<AdminPanelSettingsIcon sx={{ fontSize: 14 }} />}
              onClick={() => navigate('/app/admin')}
              size="small"
              sx={{
                fontFamily: '"Rajdhani", sans-serif',
                fontWeight: location.pathname === '/app/admin' ? 700 : 500,
                fontSize: '0.8rem',
                letterSpacing: '0.06em',
                color: location.pathname === '/app/admin' ? G3 : G2,
                px: 1.5,
                height: 34,
                borderRadius: '8px',
                background: location.pathname === '/app/admin' ? alpha(G2, 0.12) : 'transparent',
                border: `1px solid ${alpha(G2, 0.3)}`,
                transition: 'all 0.2s',
                '& .MuiButton-startIcon': { mr: '4px' },
                '&:hover': { color: G3, background: alpha(G2, 0.1), border: `1px solid ${alpha(G2, 0.5)}` },
              }}
            >
              Админ
            </Button>
          )}
        </Box>

        {/* Пользователь */}
        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
            <Box sx={{
              px: 1.5, py: 0.5, mr: 0.5,
              border: `1px solid ${BORDER}`,
              borderRadius: '8px',
              background: alpha('#fff', 0.02),
            }}>
              <Typography sx={{ fontSize: '0.72rem', color: T2, letterSpacing: '0.05em' }}>
                {user.username}
              </Typography>
            </Box>
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
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
