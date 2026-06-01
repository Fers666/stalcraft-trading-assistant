import { Outlet, NavLink } from 'react-router-dom'
import { Box } from '@mui/material'
import Navbar from './Navbar'

const NAV_LINKS = [
  { label: 'Избранное', to: '/app/monitoring' },
  { label: 'Каталог',   to: '/app/catalog'    },
  { label: 'Лоты',      to: '/app/lots'       },
  { label: 'Лента',     to: '/app/feed'        },
  { label: 'Склад',     to: '/app/inventory'   },
]

function SimpleNav() {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: 56,
      background: '#11151A', borderBottom: '1px solid rgba(255,255,255,0.08)',
      display: 'flex', alignItems: 'center', padding: '0 24px', gap: 8,
      zIndex: 1300,
    }}>
      {/* Логотип */}
      <span style={{
        fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
        fontSize: 16, color: '#F5F5F5', letterSpacing: '0.08em',
        marginRight: 16, flexShrink: 0,
      }}>
        SC TRADING
      </span>

      <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.08)', marginRight: 8 }} />

      {/* Ссылки */}
      {NAV_LINKS.map(({ label, to }) => (
        <NavLink
          key={to}
          to={to}
          style={({ isActive }) => ({
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: isActive ? 700 : 500,
            fontSize: 13, letterSpacing: '0.06em',
            color: isActive ? '#F2C94C' : '#B8B8B8',
            textDecoration: 'none',
            padding: '6px 12px',
            borderRadius: 8,
            background: isActive ? 'rgba(217,175,55,0.12)' : 'transparent',
            border: isActive ? '1px solid rgba(217,175,55,0.25)' : '1px solid transparent',
            transition: 'all 0.2s',
          })}
        >
          {label}
        </NavLink>
      ))}
    </div>
  )
}

export default function Layout() {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <SimpleNav />
      <Box component="main" sx={{ flexGrow: 1, p: 3, mt: '56px' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
