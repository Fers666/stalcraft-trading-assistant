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

const { purple: P, purpleBright: PB, purpleSoft: PS, bg1: BG1, text2: T2, border: BORDER } = tokens

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon sx={{ fontSize: 14 }} /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    sx={{ fontSize: 14 }} /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      sx={{ fontSize: 14 }} /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  sx={{ fontSize: 14 }} /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   sx={{ fontSize: 14 }} /> },
]

// Шестиугольный логотип
function HexLogo() {
  return (
    <Box sx={{
      width: 32, height: 32, position: 'relative', flexShrink: 0,
      '&::before': {
        content: '""', position: 'absolute', inset: 0,
        background: `linear-gradient(135deg, ${PB} 0%, ${P} 100%)`,
        clipPath: 'polygon(50% 0%, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)',
        boxShadow: `0 0 16px ${alpha(P, 0.6)}`,
      },
    }}>
      <Typography sx={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"Rajdhani", sans-serif',
        fontWeight: 700, fontSize: '0.65rem', color: '#fff',
        letterSpacing: '0.05em', zIndex: 1,
      }}>
        SC
      </Typography>
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
          <HexLogo />
          <Box>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif',
              fontWeight: 700, fontSize: '1.1rem',
              color: '#F2F2F5', letterSpacing: '0.06em',
              lineHeight: 1,
            }}>
              SC TRADING
            </Typography>
            <Typography sx={{ fontSize: '0.55rem', color: T2, letterSpacing: '0.12em', lineHeight: 1 }}>
              ZONE MARKET TERMINAL
            </Typography>
          </Box>
        </Box>

        {/* Тонкий разделитель */}
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
                  color: active ? PS : T2,
                  px: 1.5,
                  height: 34,
                  borderRadius: '10px',
                  background: active ? alpha(P, 0.12) : 'transparent',
                  border: active ? `1px solid ${alpha(P, 0.3)}` : '1px solid transparent',
                  transition: 'all 0.2s',
                  boxShadow: active ? `0 0 12px ${alpha(P, 0.2)}` : 'none',
                  '& .MuiButton-startIcon': { mr: '4px', opacity: active ? 1 : 0.6 },
                  '&:hover': {
                    color: '#B6B2C7',
                    background: alpha(P, 0.06),
                    border: `1px solid ${alpha(P, 0.15)}`,
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
              <Typography sx={{ fontSize: '0.72rem', color: T2, letterSpacing: '0.05em' }}>
                {user.username}
              </Typography>
            </Box>
            <Tooltip title="Настройки">
              <IconButton size="small" onClick={() => navigate('/app/settings')}
                sx={{ color: T2, borderRadius: '8px', '&:hover': { color: PS, background: alpha(P, 0.1) } }}>
                <SettingsIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Выйти">
              <IconButton size="small" onClick={() => { logout(); navigate('/') }}
                sx={{ color: T2, borderRadius: '8px', '&:hover': { color: '#FF5C72', background: alpha('#FF5C72', 0.1) } }}>
                <LogoutIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
