import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Stack, Divider, Chip } from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart'
import AccessTimeIcon from '@mui/icons-material/AccessTime'

const features = [
  { icon: <MonitorHeartIcon color="primary" />, text: 'Мониторинг цен в реальном времени — данные каждые 5 минут' },
  { icon: <TrendingUpIcon sx={{ color: '#4caf84' }} />, text: 'Прогноз времени продажи: быстро / рыночная / выгодно' },
  { icon: <AccessTimeIcon color="primary" />, text: 'Лучшее время выставления лота по часу и дню недели' },
]

export default function LandingPage() {
  const navigate  = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
      }}
    >
      <Box sx={{ maxWidth: 520, textAlign: 'center' }}>
        {/* Логотип */}
        <Typography variant="h3" fontWeight={800} color="primary.main" sx={{ mb: 1, letterSpacing: 1 }}>
          SC Trading
        </Typography>
        <Typography variant="h6" color="text.secondary" sx={{ mb: 4 }}>
          Аналитика аукциона Stalcraft X
        </Typography>

        {/* Фичи */}
        <Stack spacing={2} sx={{ mb: 4, textAlign: 'left' }}>
          {features.map((f, i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {f.icon}
              <Typography variant="body2" color="text.secondary">{f.text}</Typography>
            </Box>
          ))}
        </Stack>

        <Divider sx={{ mb: 3 }} />

        {/* Доступ по апруву */}
        <Chip
          label="Доступ по приглашению администратора"
          size="small"
          variant="outlined"
          sx={{ mb: 3, color: 'text.disabled' }}
        />

        {/* Кнопки */}
        {isLoggedIn ? (
          <Button variant="contained" size="large" onClick={() => navigate('/app/monitoring')}>
            Перейти в приложение
          </Button>
        ) : (
          <Stack direction="row" spacing={2} justifyContent="center">
            <Button variant="contained" size="large" onClick={() => navigate('/login')}>
              Войти
            </Button>
            <Button variant="outlined" size="large" onClick={() => navigate('/register')}>
              Зарегистрироваться
            </Button>
          </Stack>
        )}
      </Box>
    </Box>
  )
}
