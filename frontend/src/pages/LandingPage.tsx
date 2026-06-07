import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Stack, alpha } from '@mui/material'
import { tokens } from '../theme'

const {
  gold: G2, goldAccent: G3, goldSoft: G1,
  bg0: BG0, bg1: BG1, bg2: BG2,
  text2: T2, border: BORDER,
  success: SUCCESS,
} = tokens

const stats = [
  { value: '5',      unit: 'МИН', label: 'интервал обновления данных' },
  { value: '2 236',  unit: '+',   label: 'предметов в каталоге'       },
  { value: '3',      unit: 'RX',  label: 'варианта ценовой стратегии' },
]

const features = [
  {
    tag: '01 // MONITOR',
    title: 'Рыночный мониторинг',
    desc: 'Снэпшоты цен каждые 5 минут. Детектирование выкупов между снэпшотами. Разделение ликвидных и истекающих лотов.',
    accent: G3,
  },
  {
    tag: '02 // ANALYZE',
    title: 'Аналитика продаж',
    desc: 'Прогноз времени продажи при трёх ценовых стратегиях. Лучший час и день для выставления. Уверенность растёт с данными.',
    accent: SUCCESS,
  },
  {
    tag: '03 // DISCOVER',
    title: 'Лента возможностей',
    desc: 'Предметы вне твоего Избранного, которые прямо сейчас продаются заметно дешевле своей средней цены. Подсказка, что добавить в Избранное и на чём заработать.',
    accent: '#53B7FF',
  },
]

// Subtle diamond grid background texture
function DiamondPattern() {
  return (
    <Box sx={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      opacity: 0.025,
      backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20 1L39 20L20 39L1 20Z' fill='none' stroke='%23ffffff' stroke-width='0.8'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'repeat',
    }} />
  )
}

// Landing page logo — larger diamond with ascending bars
function HeroLogo() {
  return (
    <Box sx={{ width: 64, height: 64, flexShrink: 0 }}>
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="hero-gold" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#B78A2A" />
            <stop offset="55%" stopColor="#D9AF37" />
            <stop offset="100%" stopColor="#F2C94C" />
          </linearGradient>
          <clipPath id="hero-diamond">
            <polygon points="32,2 62,32 32,62 2,32" />
          </clipPath>
        </defs>
        <polygon points="32,2 62,32 32,62 2,32" stroke="url(#hero-gold)" strokeWidth="1.5" fill="none" />
        <g clipPath="url(#hero-diamond)">
          <rect x="12" y="41" width="7" height="18" fill="url(#hero-gold)" opacity="0.5" />
          <rect x="21" y="33" width="7" height="26" fill="url(#hero-gold)" opacity="0.65" />
          <rect x="30" y="24" width="7" height="35" fill="url(#hero-gold)" opacity="0.8" />
          <rect x="39" y="15" width="7" height="44" fill="url(#hero-gold)" />
        </g>
      </svg>
    </Box>
  )
}

export default function LandingPage() {
  const navigate    = useNavigate()
  const featuresRef = useRef<HTMLDivElement>(null)
  const isLoggedIn  = !!localStorage.getItem('access_token')

  const scrollToFeatures = () =>
    featuresRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <Box sx={{
      minHeight: '100vh', bgcolor: BG0,
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
    }}>

      {/* Very subtle gold top-edge glow */}
      <Box sx={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 320,
        pointerEvents: 'none',
        background: `radial-gradient(ellipse 60% 40% at 50% -10%, ${alpha(G2, 0.07)} 0%, transparent 70%)`,
      }} />

      <DiamondPattern />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Box sx={{
        px: 5, py: 2.5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${BORDER}`,
        backdropFilter: 'blur(12px)',
        background: alpha(BG1, 0.7),
        position: 'relative', zIndex: 1,
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {/* Navbar-sized diamond logo */}
          <Box sx={{ width: 34, height: 34 }}>
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <defs>
                <linearGradient id="hdr-gold" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0%" stopColor="#B78A2A" />
                  <stop offset="55%" stopColor="#D9AF37" />
                  <stop offset="100%" stopColor="#F2C94C" />
                </linearGradient>
                <clipPath id="hdr-diamond">
                  <polygon points="17,1 33,17 17,33 1,17" />
                </clipPath>
              </defs>
              <polygon points="17,1 33,17 17,33 1,17" stroke="url(#hdr-gold)" strokeWidth="1.5" fill="none" />
              <g clipPath="url(#hdr-diamond)">
                <rect x="6" y="22" width="4" height="9" fill="url(#hdr-gold)" opacity="0.55" />
                <rect x="11.5" y="18" width="4" height="13" fill="url(#hdr-gold)" opacity="0.7" />
                <rect x="17" y="13" width="4" height="18" fill="url(#hdr-gold)" opacity="0.85" />
                <rect x="22.5" y="8" width="4" height="23" fill="url(#hdr-gold)" />
              </g>
            </svg>
          </Box>
          <Box>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
              fontSize: '1.05rem', color: '#F5F5F5', letterSpacing: '0.08em', lineHeight: 1,
            }}>
              SC TRADING
            </Typography>
            <Typography sx={{ fontSize: '0.5rem', color: T2, letterSpacing: '0.15em', lineHeight: 1 }}>
              ZONE MARKET TERMINAL v0.1
            </Typography>
          </Box>
        </Box>
        {isLoggedIn ? (
          <Button variant="outlined" size="small" onClick={() => navigate('/app/monitoring')}>
            Войти в терминал
          </Button>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button variant="text" size="small" onClick={() => navigate('/register')}
              sx={{ color: T2, '&:hover': { color: '#F5F5F5' } }}>
              Регистрация
            </Button>
            <Button variant="outlined" size="small" onClick={() => navigate('/login')}>
              Войти
            </Button>
          </Stack>
        )}
      </Box>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <Box sx={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        px: 4, py: 8, position: 'relative', zIndex: 1,
      }}>

        {/* Status badge */}
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 1, mb: 4,
          px: 2, py: 0.75,
          border: `1px solid ${alpha(G2, 0.2)}`,
          borderRadius: '20px',
          background: alpha(G2, 0.05),
        }}>
          <Box sx={{
            width: 6, height: 6, borderRadius: '50%',
            bgcolor: SUCCESS,
            animation: 'anomaly-pulse 2s ease-in-out infinite',
          }} />
          <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.12em', fontWeight: 600 }}>
            СИСТЕМА АКТИВНА // РЕГИОН RU
          </Typography>
        </Box>

        {/* Large logo */}
        <Box sx={{ mb: 4 }}>
          <HeroLogo />
        </Box>

        {/* Main headline */}
        <Typography sx={{
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 700,
          fontSize: { xs: '3.2rem', md: '5.5rem' },
          lineHeight: 1,
          letterSpacing: '0.06em',
          textAlign: 'center',
          color: '#F5F5F5',
          mb: 1,
        }}>
          TRADE THE ZONE.
        </Typography>

        {/* Gold gradient sub-headline */}
        <Typography sx={{
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 600,
          fontSize: { xs: '1rem', md: '1.25rem' },
          letterSpacing: '0.1em',
          textAlign: 'center',
          background: `linear-gradient(90deg, ${G1} 0%, ${G2} 40%, ${G3} 70%, ${G2} 100%)`,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          mb: 3,
        }}>
          ANOMALY → DATA → PROFIT
        </Typography>

        <Typography color="text.secondary" sx={{
          textAlign: 'center', maxWidth: 480, mb: 6, lineHeight: 1.75, fontSize: '0.95rem',
        }}>
          Аналитика цен, детектирование выкупов и прогноз времени продажи для аукциона Stalcraft X.
          Доступ строго по приглашению.
        </Typography>

        {/* CTA buttons */}
        {isLoggedIn ? (
          <Button variant="contained" size="large" onClick={() => navigate('/app/monitoring')} sx={{ px: 6 }}>
            Войти в терминал
          </Button>
        ) : (
          <Stack direction="row" spacing={2} alignItems="center">
            <Button variant="contained" size="large" onClick={() => navigate('/login')} sx={{ px: 6 }}>
              Войти
            </Button>
            <Button variant="outlined" size="large" onClick={() => navigate('/register')} sx={{ px: 4 }}>
              Регистрация
            </Button>
            <Button variant="text" size="large" onClick={scrollToFeatures}
              sx={{ px: 2, color: T2, '&:hover': { color: '#F5F5F5', background: 'transparent' } }}>
              Посмотреть ↓
            </Button>
          </Stack>
        )}

        {/* Stats bar */}
        <Stack
          direction="row"
          spacing={0}
          sx={{
            mt: 8,
            border: `1px solid ${BORDER}`,
            borderRadius: '12px',
            overflow: 'hidden',
            background: alpha(BG2, 0.6),
            backdropFilter: 'blur(12px)',
          }}
        >
          {stats.map((s, i) => (
            <Box
              key={s.value}
              sx={{
                px: 4, py: 2.5, textAlign: 'center',
                borderRight: i < stats.length - 1 ? `1px solid ${BORDER}` : 'none',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, justifyContent: 'center' }}>
                <Typography sx={{
                  fontFamily: '"Rajdhani", sans-serif',
                  fontWeight: 700, fontSize: '1.8rem', color: '#F5F5F5', lineHeight: 1,
                }}>
                  {s.value}
                </Typography>
                <Typography sx={{ fontSize: '0.68rem', color: G3, fontWeight: 700 }}>
                  {s.unit}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: '0.65rem', color: T2, letterSpacing: '0.05em', mt: 0.5 }}>
                {s.label}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* ── Features ───────────────────────────────────────────────────────── */}
      <Box ref={featuresRef} sx={{ px: 5, pb: 8, position: 'relative', zIndex: 1 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {features.map((f) => (
            <Box
              key={f.title}
              sx={{
                flex: 1, p: 3,
                borderRadius: '18px',
                background: alpha(BG2, 0.65),
                border: `1px solid ${BORDER}`,
                backdropFilter: 'blur(12px)',
                transition: 'border-color 0.3s',
                '&:hover': {
                  borderColor: alpha(G2, 0.2),
                },
              }}
            >
              <Typography sx={{
                fontSize: '0.6rem', color: T2,
                letterSpacing: '0.14em', mb: 1.5, fontWeight: 600,
              }}>
                {f.tag}
              </Typography>
              <Typography sx={{
                fontFamily: '"Rajdhani", sans-serif',
                fontWeight: 700, fontSize: '1.2rem',
                color: f.accent, mb: 1, letterSpacing: '0.04em',
              }}>
                {f.title}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
                {f.desc}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <Box sx={{
        px: 5, py: 2.5,
        borderTop: `1px solid ${BORDER}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'relative', zIndex: 1,
      }}>
        <Typography sx={{ fontSize: '0.65rem', color: T2, letterSpacing: '0.08em' }}>
          SC TRADING // ZONE MARKET TERMINAL
        </Typography>
        <Typography sx={{ fontSize: '0.65rem', color: T2 }}>
          не аффилирован с EXBO Studio
        </Typography>
      </Box>
    </Box>
  )
}
