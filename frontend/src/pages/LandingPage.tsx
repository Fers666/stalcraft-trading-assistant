import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Stack, alpha } from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'

const VIOLET = '#7c3aed'
const BG     = '#080b18'
const CARD   = '#0d1129'
const BORDER = '#1e2445'

const stats = [
  { value: '5 мин',  label: 'интервал обновления' },
  { value: '2 236',  label: 'предметов в каталоге' },
  { value: '3',      label: 'варианта цены продажи' },
]

const features = [
  {
    icon: <MonitorHeartIcon sx={{ color: '#a78bfa' }} />,
    title: 'Мониторинг',
    desc: 'Снэпшоты цен каждые 5 минут. Детектирование выкупов между снэпшотами.',
  },
  {
    icon: <TrendingUpIcon sx={{ color: '#34d399' }} />,
    title: 'Аналитика',
    desc: 'Прогноз времени продажи при разных ценах. Лучший час и день для выставления.',
  },
  {
    icon: <AccessTimeIcon sx={{ color: '#fbbf24' }} />,
    title: 'Лента',
    desc: 'Популярные предметы по скору торгуемости. Находи возможности раньше других.',
  },
]

export default function LandingPage() {
  const navigate   = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: BG }}>

      {/* Navbar */}
      <Box sx={{ px: 4, py: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${BORDER}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{
            width: 30, height: 30, borderRadius: '8px',
            background: `linear-gradient(135deg, ${VIOLET} 0%, #5b21b6 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 14px ${alpha(VIOLET, 0.5)}`,
          }}>
            <Typography sx={{ fontWeight: 900, fontSize: '0.75rem', color: '#fff' }}>SC</Typography>
          </Box>
          <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', color: '#e2e8f0' }}>Trading</Typography>
        </Box>
        {!isLoggedIn && (
          <Button variant="outlined" size="small" onClick={() => navigate('/login')}
            sx={{ borderRadius: '8px', fontSize: '0.8rem' }}>
            Войти
          </Button>
        )}
      </Box>

      {/* Hero */}
      <Box sx={{ textAlign: 'center', pt: 10, pb: 8, px: 4 }}>
        {/* Glow */}
        <Box sx={{
          position: 'absolute', left: '50%', top: '140px',
          transform: 'translateX(-50%)',
          width: 600, height: 300,
          background: `radial-gradient(ellipse, ${alpha(VIOLET, 0.15)} 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />

        <Typography variant="h3" sx={{ fontSize: { xs: '2.2rem', md: '3.5rem' }, mb: 2, position: 'relative' }}>
          Аналитика аукциона
          <Box component="span" sx={{
            display: 'block',
            background: `linear-gradient(90deg, ${VIOLET} 0%, #a78bfa 50%, ${VIOLET} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            Stalcraft X
          </Box>
        </Typography>

        <Typography color="text.secondary" sx={{ mb: 5, maxWidth: 480, mx: 'auto', lineHeight: 1.7 }}>
          Мониторинг цен, прогноз времени продажи и лента торгуемых предметов.
          Доступ по приглашению.
        </Typography>

        {isLoggedIn ? (
          <Button variant="contained" size="large" onClick={() => navigate('/app/monitoring')}
            sx={{ px: 5, py: 1.5, borderRadius: '10px', fontSize: '0.95rem' }}>
            Открыть приложение
          </Button>
        ) : (
          <Stack direction="row" spacing={2} justifyContent="center">
            <Button variant="contained" size="large" onClick={() => navigate('/login')}
              sx={{ px: 5, py: 1.5, borderRadius: '10px', fontSize: '0.95rem' }}>
              Войти
            </Button>
            <Button variant="outlined" size="large" onClick={() => navigate('/register')}
              sx={{ px: 5, py: 1.5, borderRadius: '10px', fontSize: '0.95rem' }}>
              Регистрация
            </Button>
          </Stack>
        )}
      </Box>

      {/* Статистика */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 4, mb: 8, px: 4, flexWrap: 'wrap' }}>
        {stats.map((s) => (
          <Box key={s.value} sx={{ textAlign: 'center' }}>
            <Typography sx={{ fontSize: '2rem', fontWeight: 800, color: '#e2e8f0', lineHeight: 1 }}>{s.value}</Typography>
            <Typography variant="caption" color="text.secondary">{s.label}</Typography>
          </Box>
        ))}
      </Box>

      {/* Фичи */}
      <Box sx={{ maxWidth: 900, mx: 'auto', px: 4, pb: 10 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {features.map((f) => (
            <Box
              key={f.title}
              sx={{
                flex: 1,
                p: 3,
                borderRadius: '12px',
                background: CARD,
                border: `1px solid ${BORDER}`,
                transition: 'border-color 0.2s',
                '&:hover': { borderColor: alpha(VIOLET, 0.5) },
              }}
            >
              <Box sx={{ mb: 1.5 }}>{f.icon}</Box>
              <Typography variant="subtitle1" sx={{ mb: 0.5 }}>{f.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{f.desc}</Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* Footer */}
      <Box sx={{ textAlign: 'center', py: 3, borderTop: `1px solid ${BORDER}` }}>
        <Typography variant="caption" color="text.disabled">
          Stalcraft Trading Assistant — не аффилирован с EXBO Studio
        </Typography>
      </Box>
    </Box>
  )
}
