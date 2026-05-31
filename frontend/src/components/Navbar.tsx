import { useNavigate, useLocation } from 'react-router-dom'
import { AppBar, Toolbar, Typography, Button, Box, IconButton, Tooltip } from '@mui/material'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import { useAuthStore } from '../store/authStore'

const navItems = [
  { label: 'Избранное', path: '/app/monitoring', icon: <MonitorHeartIcon sx={{ fontSize: 16 }} /> },
  { label: 'Каталог',   path: '/app/catalog',    icon: <MenuBookIcon    sx={{ fontSize: 16 }} /> },
  { label: 'Лоты',      path: '/app/lots',       icon: <SearchIcon      sx={{ fontSize: 16 }} /> },
  { label: 'Лента',     path: '/app/feed',       icon: <TrendingUpIcon  sx={{ fontSize: 16 }} /> },
  { label: 'Склад',     path: '/app/inventory',  icon: <InventoryIcon   sx={{ fontSize: 16 }} /> },
]

export default function Navbar() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const { user, logout } = useAuthStore()

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  return (
    <AppBar position="fixed" elevation={0}>
      <Toolbar sx={{ minHeight: '56px !important', px: 3 }}>

        {/* Логотип */}
        <Box
          onClick={() => navigate('/app/monitoring')}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, mr: 5, cursor: 'pointer' }}
        >
          {/* Иконка-ромб */}
          <Box sx={{
            width: 22, height: 22,
            background: 'linear-gradient(135deg, #c9922a 0%, #a0731a 100%)',
            clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
          }} />
          <Typography sx={{
            fontWeight: 800,
            fontSize: '0.95rem',
            letterSpacing: '0.12em',
            color: '#f0f0f0',
            textTransform: 'uppercase',
          }}>
            SC Trading
          </Typography>
        </Box>

        {/* Навигация */}
        <Box sx={{ display: 'flex', flexGrow: 1 }}>
          {navItems.map((item) => {
            const active = location.pathname === item.path
            return (
              <Button
                key={item.path}
                startIcon={item.icon}
                onClick={() => navigate(item.path)}
                disableRipple={!active}
                sx={{
                  color: active ? '#c9922a' : '#555555',
                  fontSize: '0.75rem',
                  fontWeight: active ? 600 : 400,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  px: 1.5,
                  py: 0,
                  minHeight: 56,
                  borderRadius: 0,
                  borderBottom: active ? '2px solid #c9922a' : '2px solid transparent',
                  transition: 'color 0.2s, border-color 0.2s',
                  '&:hover': {
                    color: '#888',
                    background: 'transparent',
                    borderBottomColor: '#333',
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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: '0.75rem', color: '#444', mr: 1, letterSpacing: '0.05em' }}>
              {user.username}
            </Typography>
            <Tooltip title="Настройки">
              <IconButton
                size="small"
                onClick={() => navigate('/app/settings')}
                sx={{ color: '#444', '&:hover': { color: '#c9922a' } }}
              >
                <SettingsIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Выйти">
              <IconButton
                size="small"
                onClick={handleLogout}
                sx={{ color: '#444', '&:hover': { color: '#c0392b' } }}
              >
                <LogoutIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  )
}
