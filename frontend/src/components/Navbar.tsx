import { useNavigate, useLocation } from 'react-router-dom'
import { AppBar, Toolbar, Typography, Button, Box, IconButton, Tooltip, alpha } from '@mui/material'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../store/authStore'

const VIOLET = '#7c3aed'
const V_LIGHT = '#a78bfa'

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon sx={{ fontSize: 15 }} /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    sx={{ fontSize: 15 }} /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      sx={{ fontSize: 15 }} /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  sx={{ fontSize: 15 }} /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   sx={{ fontSize: 15 }} /> },
]

export default function Navbar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()

  return (
    <AppBar position="fixed" elevation={0}>
      <Toolbar sx={{ minHeight: '56px !important', px: 3 }}>

        {/* Логотип */}
        <Box
          onClick={() => navigate('/app/monitoring')}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mr: 4, cursor: 'pointer', flexShrink: 0 }}
        >
          <Box sx={{
            width: 28, height: 28, borderRadius: '8px',
            background: `linear-gradient(135deg, ${VIOLET} 0%, #5b21b6 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 12px ${alpha(VIOLET, 0.5)}`,
          }}>
            <Typography sx={{ fontWeight: 900, fontSize: '0.7rem', color: '#fff', letterSpacing: '-0.02em' }}>SC</Typography>
          </Box>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            Trading
          </Typography>
        </Box>

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
                sx={{
                  color: active ? V_LIGHT : '#475569',
                  fontSize: '0.8rem',
                  fontWeight: active ? 600 : 400,
                  px: 1.5,
                  py: 0.5,
                  borderRadius: '8px',
                  background: active ? alpha(VIOLET, 0.12) : 'transparent',
                  border: active ? `1px solid ${alpha(VIOLET, 0.3)}` : '1px solid transparent',
                  transition: 'all 0.2s',
                  '&:hover': {
                    background: alpha(VIOLET, 0.08),
                    color: '#94a3b8',
                    border: `1px solid ${alpha(VIOLET, 0.15)}`,
                  },
                  '& .MuiButton-startIcon': { marginRight: '4px' },
                }}
              >
                {item.label}
              </Button>
            )
          })}
        </Box>

        {/* Пользователь */}
        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{
              fontSize: '0.78rem', color: '#475569', mr: 1,
              px: 1.5, py: 0.5,
              border: '1px solid #1e2445',
              borderRadius: '6px',
            }}>
              {user.username}
            </Typography>
            <Tooltip title="Настройки">
              <IconButton size="small" onClick={() => navigate('/app/settings')}
                sx={{ color: '#334155', '&:hover': { color: V_LIGHT, background: alpha(VIOLET, 0.1) } }}>
                <SettingsIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Выйти">
              <IconButton size="small" onClick={() => { logout(); navigate('/') }}
                sx={{ color: '#334155', '&:hover': { color: '#f87171', background: alpha('#ef4444', 0.1) } }}>
                <LogoutIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
