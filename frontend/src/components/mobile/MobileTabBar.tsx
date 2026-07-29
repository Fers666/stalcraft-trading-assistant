import { useNavigate, useLocation } from 'react-router-dom'
import { Box } from '@mui/material'
import { useAuthStore } from '../../store/authStore'
import { useToast } from '../ui/Toast'
import { tokens, fs } from '../../theme'
import { TIER_LABELS } from '../../constants/tiers'

// Нижний таб-бар — контракт .mtab (mobile.css). 5 слотов, fixed, grid 5×1fr.
// Гейтинг зеркалит десктопный AppNav; замок на недоступном слоте → Toast.
const MTAB_H = 58 // --mtab-h

type GateKey = 'auction_access' | 'buy_sniper'

const GATE_TOOLTIP: Record<GateKey, string> = {
  auction_access: `Доступно на тарифе ${TIER_LABELS.advanced_plus}`,
  buy_sniper: `Доступно на тарифах ${TIER_LABELS.advanced} / ${TIER_LABELS.advanced_plus} / ${TIER_LABELS.advanced_max}`,
}

// stroke-иконки (mshell.js I.fav / I.catalog / I.lots / I.buy / I.more)
const ICONS: Record<string, React.ReactNode> = {
  fav: (
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  ),
  catalog: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  lots: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),
  buy: (
    <>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
    </>
  ),
}

function LockGlyph() {
  return (
    <Box
      component="svg"
      width={9}
      height={10}
      viewBox="0 0 11 12"
      fill="none"
      aria-hidden="true"
      sx={{ position: 'absolute', top: 8, right: 'calc(50% - 20px)', color: tokens.text2 }}
    >
      <rect x="1" y="5" width="9" height="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" strokeWidth="1.6" />
    </Box>
  )
}

interface TabItem {
  id: string
  label: string
  icon: string
  to?: string
  gateKey?: GateKey
  more?: boolean
}

const TABS: TabItem[] = [
  { id: 'favorites', label: 'Избранное', icon: 'fav', to: '/app/monitoring' },
  { id: 'catalog', label: 'Каталог', icon: 'catalog', to: '/app/catalog' },
  { id: 'lots', label: 'Лоты', icon: 'lots', to: '/app/lots', gateKey: 'auction_access' },
  { id: 'buy-sniper', label: 'Закупки', icon: 'buy', to: '/app/buy-sniper', gateKey: 'buy_sniper' },
  { id: 'more', label: 'Ещё', icon: 'more', more: true },
]

// Разделы, живущие в шите «Ещё» → слот «Ещё» подсвечен активным.
const SHEET_PATHS = ['/app/feed', '/app/news', '/app/market-radar', '/app/settings', '/app/admin']

export default function MobileTabBar({ onMore }: { onMore: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const { showToast } = useToast()

  const moreActive = SHEET_PATHS.some((p) => location.pathname.startsWith(p)) || location.pathname === '/faq'

  return (
    <Box
      component="nav"
      aria-label="Основная навигация"
      sx={{
        position: 'fixed',
        inset: 'auto 0 0 0',
        zIndex: tokens.z.nav + 1,
        height: `calc(${MTAB_H}px + env(safe-area-inset-bottom))`,
        paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        background: tokens.bg1,
        borderTop: `1px solid ${tokens.border}`,
      }}
    >
      {TABS.map((tab) => {
        const locked = !!tab.gateKey && !user?.is_admin && (
          tab.gateKey === 'buy_sniper'
            ? user?.buy_sniper_access === false
            : user?.auction_access === false
        )
        const active = tab.more ? moreActive : location.pathname === tab.to

        const onClick = () => {
          if (tab.more) { onMore(); return }
          if (locked) { showToast(GATE_TOOLTIP[tab.gateKey!]); return }
          if (tab.to) navigate(tab.to)
        }

        return (
          <Box
            key={tab.id}
            component="button"
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            sx={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              minHeight: 44,
              cursor: 'pointer',
              border: 0,
              background: 'transparent',
              color: active ? tokens.goldAccent : tokens.text2,
              transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
              '&:active': { color: tokens.text1 },
              // .mtab a[aria-current] — верхнее 2px-подчёркивание
              '&[aria-current="page"]::before': {
                content: '""',
                position: 'absolute',
                top: 0,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 26,
                height: 2,
                background: tokens.goldHighlight,
                boxShadow: `0 0 10px ${tokens.goldGlow}`,
              },
            }}
          >
            <Box component="svg" width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden="true" sx={{ display: 'block', color: active ? tokens.goldAccent : tokens.text2 }}>
              {ICONS[tab.icon]}
            </Box>
            {locked && <LockGlyph />}
            <Box
              component="span"
              sx={{
                fontFamily: tokens.fontHead,
                fontWeight: 600,
                fontSize: fs.f10,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}
            >
              {tab.label}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
