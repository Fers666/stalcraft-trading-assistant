import { useNavigate, useLocation } from 'react-router-dom'
import { Box } from '@mui/material'
import { useAuthStore } from '../../store/authStore'
import { useToast } from '../ui/Toast'
import { tokens, fs } from '../../theme'
import BottomSheet from './BottomSheet'
import LayoutSwitchControl from './LayoutSwitchControl'

// Шит «Ещё» — контракт .msheet-nav (mobile.css). Разделы вне таб-бара +
// переключатель версии интерфейса. Гейтинг зеркалит AppNav; замки → Toast.
const ICONS: Record<string, React.ReactNode> = {
  feed: <path d="M4 6.5h16M4 12h16M4 17.5h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />,
  news: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 8.5h6M7 12h10M7 15.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 12l6-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.2 9.3a2.8 2.8 0 1 1 4 2.6c-.8.5-1.3 1-1.3 1.9v.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="1.1" fill="currentColor" />
    </>
  ),
  admin: (
    <>
      <path d="M12 2.5l7.5 2.7v5.5c0 4.8-3.2 8.4-7.5 10.3-4.3-1.9-7.5-5.5-7.5-10.3V5.2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  logout: (
    <>
      <path d="M15 3.5h4a.5.5 0 0 1 .5.5v16a.5.5 0 0 1-.5.5h-4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 7l-5 5 5 5M5 12h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
}

interface NavRow {
  id: string
  label: string
  icon: string
  to: string
  locked?: boolean
  lockTip?: string
  danger?: boolean
}

export default function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()
  const { showToast } = useToast()

  const radarLocked = !user?.is_admin && !user?.has_market_radar_addon

  const rows: NavRow[] = [
    { id: 'feed', label: 'Лента', icon: 'feed', to: '/app/feed' },
    { id: 'news', label: 'Новости', icon: 'news', to: '/app/news' },
    { id: 'radar', label: 'Радар рынка', icon: 'radar', to: '/app/market-radar', locked: radarLocked, lockTip: 'Доступно как отдельный аддон «Радар рынка»' },
    { id: 'settings', label: 'Настройки', icon: 'settings', to: '/app/settings' },
    { id: 'faq', label: 'Помощь / FAQ', icon: 'help', to: '/faq' },
    ...(user?.is_admin ? [{ id: 'admin', label: 'Админ', icon: 'admin', to: '/app/admin' } as NavRow] : []),
  ]

  const go = (row: NavRow) => {
    if (row.locked) { showToast(row.lockTip ?? 'Недоступно на текущем тарифе'); return }
    onClose()
    navigate(row.to)
  }

  const rowSx = (active: boolean, opts?: { danger?: boolean; locked?: boolean }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    padding: '13px 12px',
    minHeight: 48,
    borderRadius: '2px',
    cursor: 'pointer',
    border: 0,
    borderLeft: '2px solid transparent',
    textAlign: 'left' as const,
    background: active ? tokens.goldDim : 'transparent',
    borderLeftColor: active ? tokens.goldHighlight : 'transparent',
    color: opts?.danger ? tokens.danger : active ? tokens.goldAccent : opts?.locked ? tokens.text2 : tokens.text0,
    transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
    '&:active': { background: tokens.bg2 },
  })

  return (
    <BottomSheet open={open} onClose={onClose} title="Разделы">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', mx: '-4px' }}>
        {rows.map((row) => {
          const active = location.pathname.startsWith(row.to)
          return (
            <Box key={row.id} component="button" type="button" onClick={() => go(row)} aria-current={active ? 'page' : undefined} sx={rowSx(active, { locked: row.locked })}>
              <Box component="svg" width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden="true" sx={{ flex: 'none', color: active ? tokens.goldAccent : tokens.text2 }}>
                {ICONS[row.icon]}
              </Box>
              <Box component="span" sx={{ flex: 1, fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                {row.label}
              </Box>
              {row.locked && (
                <Box component="svg" width={11} height={12} viewBox="0 0 11 12" fill="none" aria-hidden="true" sx={{ flex: 'none', color: tokens.text2 }}>
                  <rect x="1" y="5" width="9" height="6" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" strokeWidth="1.5" />
                </Box>
              )}
            </Box>
          )
        })}

        {/* .msheet-sep */}
        <Box sx={{ height: '1px', background: tokens.border, mx: '12px', my: '6px' }} />

        <Box component="button" type="button" onClick={() => { onClose(); logout(); navigate('/') }} sx={rowSx(false, { danger: true })}>
          <Box component="svg" width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden="true" sx={{ flex: 'none', color: tokens.danger }}>
            {ICONS.logout}
          </Box>
          <Box component="span" sx={{ flex: 1, fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f14, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Выход
          </Box>
        </Box>
      </Box>

      {/* .msheet-sep + блок «Версия интерфейса» */}
      <Box sx={{ height: '1px', background: tokens.border, mx: '12px', my: '12px' }} />
      <LayoutSwitchControl label="Версия интерфейса" />
    </BottomSheet>
  )
}
