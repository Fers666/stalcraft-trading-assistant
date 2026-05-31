import { useNavigate, useLocation } from 'react-router-dom'
import {
  AppBar, Toolbar, Typography, Button, Box, Chip, IconButton, Tooltip,
} from '@mui/material'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../store/authStore'

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon fontSize="small" /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    fontSize="small" /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      fontSize="small" /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  fontSize="small" /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   fontSize="small" /> },
]

export default function Navbar() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const { user, logout } = useAuthStore()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <AppBar position="fixed" sx={{ bgcolor: 'background.paper', borderBottom: '1px solid #2a2d3a' }} elevation={0}>
      <Toolbar>
        {/* Логотип */}
        <Typography
          variant="h6"
          sx={{ mr: 4, color: 'primary.main', fontWeight: 700, cursor: 'pointer', letterSpacing: 0.5 }}
          onClick={() => navigate('/monitoring')}
        >
          SC Trading
        </Typography>

        {/* Навигация */}
        <Box sx={{ display: 'flex', gap: 0.5, flexGrow: 1 }}>
          {navItems.map((item) => (
            <Button
              key={item.path}
              startIcon={item.icon}
              onClick={() => navigate(item.path)}
              size="small"
              sx={{
                color: location.pathname === item.path ? 'primary.main' : 'text.secondary',
                borderBottom: location.pathname === item.path ? '2px solid' : '2px solid transparent',
                borderRadius: 0,
                px: 2,
              }}
            >
              {item.label}
            </Button>
          ))}
        </Box>

        {/* Пользователь */}
        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip label={user.username} size="small" variant="outlined" sx={{ color: 'text.secondary' }} />
            <Tooltip title="Настройки">
              <IconButton size="small" onClick={() => navigate('/settings')} sx={{ color: 'text.secondary' }}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Выйти">
              <IconButton size="small" onClick={handleLogout} sx={{ color: 'text.secondary' }}>
                <LogoutIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
