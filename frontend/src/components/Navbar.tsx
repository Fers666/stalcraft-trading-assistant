import { useNavigate, useLocation } from 'react-router-dom'
import { AppBar, Toolbar, Box, Button, IconButton, Tooltip, Typography, alpha } from '@mui/material'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../store/authStore'
import { tokens } from '../theme'

const { gold: G2, goldAccent: G3, text1: T1, text2: T2, border: BORDER } = tokens

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon sx={{ fontSize: 14 }} /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    sx={{ fontSize: 14 }} /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      sx={{ fontSize: 14 }} /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  sx={{ fontSize: 14 }} /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   sx={{ fontSize: 14 }} /> },
]

// Diamond logo with 4 ascending bars — anomaly crater forming a market chart
function DiamondLogo() {
  return (
    <Box sx={{ width: 34, height: 34, flexShrink: 0 }}>
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="nl-gold" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#B78A2A" />
            <stop offset="55%" stopColor="#D9AF37" />
            <stop offset="100%" stopColor="#F2C94C" />
          </linearGradient>
          <clipPath id="nl-diamond">
            <polygon points="17,1 33,17 17,33 1,17" />
          </clipPath>
        </defs>
        <polygon points="17,1 33,17 17,33 1,17" stroke="url(#nl-gold)" strokeWidth="1.5" fill="none" />
        <g clipPath="url(#nl-diamond)">
          <rect x="6" y="22" width="4" height="9" fill="url(#nl-gold)" opacity="0.55" />
          <rect x="11.5" y="18" width="4" height="13" fill="url(#nl-gold)" opacity="0.7" />
          <rect x="17" y="13" width="4" height="18" fill="url(#nl-gold)" opacity="0.85" />
          <rect x="22.5" y="8" width="4" height="23" fill="url(#nl-gold)" />
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
    <AppBar position="fixed" elevation={0} color="inherit">
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
              color: '#F5F5F5', letterSpacing: '0.08em',
              lineHeight: 1,
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
                // inline style guarantees color wins over any MUI class cascade
                style={{ color: active ? G3 : T1 }}
                sx={{
                  fontFamily: '"Rajdhani", sans-serif',
                  fontWeight: active ? 700 : 500,
                  fontSize: '0.8rem',
                  letterSpacing: '0.06em',
                  px: 1.5,
                  height: 34,
                  borderRadius: '8px',
                  background: active ? alpha(G2, 0.1) : 'transparent',
                  border: active ? `1px solid ${alpha(G2, 0.25)}` : '1px solid transparent',
                  transition: 'all 0.2s',
                  '& .MuiButton-startIcon': { mr: '4px', color: active ? G3 : T1 },
                  '&:hover': {
                    color: '#F5F5F5',
                    background: alpha(G2, 0.05),
                    border: `1px solid ${alpha(G2, 0.1)}`,
                  },
                }}
              >
                {item.label}
              </Button>
            )
          })}
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
              <Typography style={{ color: T2 }} sx={{ fontSize: '0.72rem', letterSpacing: '0.05em' }}>
                {user.username}
              </Typography>
            </Box>
            <Tooltip title="Настройки">
              <IconButton size="small" onClick={() => navigate('/app/settings')}
                style={{ color: T2 }}
                sx={{ borderRadius: '8px', '&:hover': { color: G3, background: alpha(G2, 0.08) } }}>
                <SettingsIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Выйти">
              <IconButton size="small" onClick={() => { logout(); navigate('/') }}
                style={{ color: T2 }}
                sx={{ borderRadius: '8px', '&:hover': { color: '#FF5A5A', background: alpha('#FF5A5A', 0.1) } }}>
                <LogoutIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
