import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Box, IconButton, Tooltip, Typography, alpha } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import LogoutIcon from '@mui/icons-material/Logout'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import SearchIcon from '@mui/icons-material/Search'
import InventoryIcon from '@mui/icons-material/Inventory'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import { useAuthStore } from '../store/authStore'
import { tokens } from '../theme'

const { gold: G2, goldAccent: G3, text2: T2, border: BORDER } = tokens

const NAV_ITEMS = [
  { label: 'Избранное', to: '/app/monitoring', Icon: MonitorHeartIcon },
  { label: 'Каталог',   to: '/app/catalog',    Icon: MenuBookIcon    },
  { label: 'Лоты',      to: '/app/lots',       Icon: SearchIcon      },
  { label: 'Лента',     to: '/app/feed',       Icon: TrendingUpIcon  },
  { label: 'Склад',     to: '/app/inventory',  Icon: InventoryIcon   },
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
        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', flexShrink: 0, marginRight: 4 }}
      >
        <img src="/logo.png" alt="SC Trading" style={{ height: 38, width: 'auto' }} />
      </div>

      {/* Разделитель */}
      <div style={{ width: 1, height: 24, background: BORDER, flexShrink: 0, marginRight: 4 }} />

      {/* Навигационные ссылки */}
      <div style={{ display: 'flex', flexGrow: 1, gap: 4 }}>
        {NAV_ITEMS.map(({ label, to, Icon }) => (
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
                <Icon style={{ fontSize: 14, color: isActive ? G3 : '#B8B8B8' }} />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </div>

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
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppNav />
      <Box component="main" sx={{ flexGrow: 1, p: 3, mt: '56px' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
