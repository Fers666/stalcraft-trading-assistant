import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Stack, alpha } from '@mui/material'
import { tokens } from '../theme'

const { purple: P, purpleBright: PB, purpleSoft: PS, purpleDark: PD,
        bg0: BG0, bg1: BG1, bg2: BG2, bg3: BG3,
        text1: T1, text2: T2, border: BORDER, glow: GLOW,
        success: SUCCESS } = tokens

const stats = [
  { value: '5',      unit: 'МИН', label: 'интервал сбора данных' },
  { value: '2 236',  unit: '+',   label: 'предметов в каталоге'  },
  { value: '3',      unit: 'RX',  label: 'варианта цены продажи' },
]

const features = [
  {
    tag: '01 // MONITOR',
    title: 'Рыночный мониторинг',
    desc: 'Снэпшоты цен каждые 5 минут. Детектирование выкупов между снэпшотами. Разделение ликвидных и истекающих лотов.',
    color: PS,
  },
  {
    tag: '02 // ANALYZE',
    title: 'Аналитика продаж',
    desc: 'Прогноз времени продажи при трёх ценовых стратегиях. Лучший час и день для выставления. Уверенность растёт с данными.',
    color: SUCCESS,
  },
  {
    tag: '03 // DISCOVER',
    title: 'Лента торговли',
    desc: 'Топ предметов по скору торгуемости вне твоего Избранного. Находи возможности прежде чем их найдут другие.',
    color: '#53B7FF',
  },
]

// Шестиугольный орнамент
function HexPattern() {
  return (
    <Box sx={{
      position: 'absolute', right: -100, top: '50%', transform: 'translateY(-50%)',
      width: 500, height: 500, opacity: 0.04, pointerEvents: 'none',
      backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='52' viewBox='0 0 60 52' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M30 0L60 17.3V34.6L30 52L0 34.6V17.3Z' fill='none' stroke='%23ffffff' stroke-width='1'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'repeat',
    }} />
  )
}

export default function LandingPage() {
  const navigate   = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: BG0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>

      {/* Фоновый градиент — anomaly glow */}
      <Box sx={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: `
          radial-gradient(ellipse 70% 60% at 20% 0%, ${alpha(P, 0.18)} 0%, transparent 60%),
          radial-gradient(ellipse 50% 40% at 80% 100%, ${alpha(PD, 0.12)} 0%, transparent 60%)
        `,
      }} />

      {/* Шестиугольная текстура */}
      <HexPattern />

      {/* Header */}
      <Box sx={{
        px: 5, py: 2.5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${BORDER}`,
        backdropFilter: 'blur(12px)',
        background: alpha(BG1, 0.6),
        position: 'relative', zIndex: 1,
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{
            width: 34, height: 34,
            clipPath: 'polygon(50% 0%, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)',
            background: `linear-gradient(135deg, ${PB} 0%, ${P} 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 20px ${alpha(P, 0.5)}`,
          }}>
            <Typography sx={{ fontFamily: '"Rajdhani", sans-serif', fontWeight: 700, fontSize: '0.7rem', color: '#fff' }}>
              SC
            </Typography>
          </Box>
          <Box>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
              fontSize: '1.05rem', color: '#F2F2F5', letterSpacing: '0.08em', lineHeight: 1,
            }}>SC TRADING</Typography>
            <Typography sx={{ fontSize: '0.5rem', color: T2, letterSpacing: '0.15em', lineHeight: 1 }}>
              ZONE MARKET TERMINAL v0.1
            </Typography>
          </Box>
        </Box>
        {!isLoggedIn && (
          <Button variant="outlined" size="small" onClick={() => navigate('/login')}>
            Войти в систему
          </Button>
        )}
      </Box>

      {/* Hero */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', px: 4, py: 8, position: 'relative', zIndex: 1 }}>

        {/* Пре-тег */}
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 1, mb: 3,
          px: 2, py: 0.75,
          border: `1px solid ${alpha(P, 0.3)}`,
          borderRadius: '20px',
          background: alpha(P, 0.08),
        }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: SUCCESS, boxShadow: `0 0 6px ${SUCCESS}`, animation: 'anomaly-pulse 2s ease-in-out infinite' }} />
          <Typography sx={{ fontSize: '0.7rem', color: PS, letterSpacing: '0.1em', fontWeight: 600 }}>
            СИСТЕМА АКТИВНА // РЕГИОН RU
          </Typography>
        </Box>

        <Typography
          sx={{
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: 700,
            fontSize: { xs: '3rem', md: '5rem' },
            lineHeight: 1,
            letterSpacing: '0.04em',
            textAlign: 'center',
            color: '#F2F2F5',
            mb: 1,
          }}
        >
          ТОРГОВЫЙ ТЕРМИНАЛ
        </Typography>
        <Typography
          sx={{
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: 700,
            fontSize: { xs: '3rem', md: '5rem' },
            lineHeight: 1,
            letterSpacing: '0.04em',
            textAlign: 'center',
            background: `linear-gradient(90deg, ${PB} 0%, ${PS} 50%, ${PB} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            mb: 4,
          }}
        >
          ЗОНЫ АУКЦИОНА
        </Typography>

        <Typography color="text.secondary" sx={{ textAlign: 'center', maxWidth: 520, mb: 6, lineHeight: 1.7 }}>
          Аналитика цен, детектирование выкупов и прогноз времени продажи для аукциона Stalcraft X.
          Доступ строго по приглашению администратора.
        </Typography>

        {isLoggedIn ? (
          <Button variant="contained" size="large" onClick={() => navigate('/app/monitoring')}
            sx={{ px: 6, borderRadius: '18px' }}>
            Войти в терминал
          </Button>
        ) : (
          <Stack direction="row" spacing={2}>
            <Button variant="contained" size="large" onClick={() => navigate('/login')}
              sx={{ px: 6, borderRadius: '18px' }}>
              Войти
            </Button>
            <Button variant="outlined" size="large" onClick={() => navigate('/register')}
              sx={{ px: 6, borderRadius: '18px' }}>
              Регистрация
            </Button>
          </Stack>
        )}

        {/* Статистика */}
        <Stack direction="row" spacing={0} sx={{ mt: 8, border: `1px solid ${BORDER}`, borderRadius: '18px', overflow: 'hidden', background: alpha(BG2, 0.5), backdropFilter: 'blur(12px)' }}>
          {stats.map((s, i) => (
            <Box key={s.value} sx={{
              px: 4, py: 2.5, textAlign: 'center',
              borderRight: i < stats.length - 1 ? `1px solid ${BORDER}` : 'none',
            }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, justifyContent: 'center' }}>
                <Typography sx={{ fontFamily: '"Rajdhani", sans-serif', fontWeight: 700, fontSize: '1.8rem', color: '#F2F2F5', lineHeight: 1 }}>
                  {s.value}
                </Typography>
                <Typography sx={{ fontSize: '0.7rem', color: PS, fontWeight: 700 }}>{s.unit}</Typography>
              </Box>
              <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.05em', mt: 0.5 }}>{s.label}</Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* Фичи */}
      <Box sx={{ px: 5, pb: 8, position: 'relative', zIndex: 1 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {features.map((f) => (
            <Box
              key={f.title}
              sx={{
                flex: 1, p: 3,
                borderRadius: '18px',
                background: alpha(BG3, 0.7),
                border: `1px solid ${BORDER}`,
                backdropFilter: 'blur(12px)',
                transition: 'border-color 0.3s, box-shadow 0.3s',
                '&:hover': {
                  borderColor: alpha(P, 0.35),
                  boxShadow: `0 0 32px ${alpha(P, 0.12)}`,
                },
              }}
            >
              <Typography sx={{ fontSize: '0.62rem', color: T2, letterSpacing: '0.12em', mb: 1.5, fontWeight: 600 }}>
                {f.tag}
              </Typography>
              <Typography sx={{ fontFamily: '"Rajdhani", sans-serif', fontWeight: 700, fontSize: '1.2rem', color: f.color, mb: 1, letterSpacing: '0.03em' }}>
                {f.title}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
                {f.desc}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* Footer */}
      <Box sx={{ px: 5, py: 2.5, borderTop: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1 }}>
        <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em' }}>
          SC TRADING // ZONE MARKET TERMINAL
        </Typography>
        <Typography sx={{ fontSize: '0.68rem', color: T2 }}>
          не аффилирован с EXBO Studio
        </Typography>
      </Box>
    </Box>
  )
}
