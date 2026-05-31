import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Stack } from '@mui/material'

const features = [
  { label: 'Мониторинг',  desc: 'Цены в реальном времени — снэпшоты каждые 5 минут' },
  { label: 'Аналитика',   desc: 'Прогноз времени продажи: быстро / рыночная / выгодно' },
  { label: 'Торгуемость', desc: 'Лента популярных предметов по активности рынка' },
]

export default function LandingPage() {
  const navigate   = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>

      {/* Минималистичный header */}
      <Box sx={{ px: 4, py: 2.5, display: 'flex', alignItems: 'center', borderBottom: '1px solid #1e1e1e' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{
            width: 20, height: 20,
            background: 'linear-gradient(135deg, #c9922a 0%, #a0731a 100%)',
            clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
          }} />
          <Typography sx={{ fontWeight: 800, fontSize: '0.85rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            SC Trading
          </Typography>
        </Box>
      </Box>

      {/* Hero */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', px: 4 }}>
        <Box sx={{ maxWidth: 640, textAlign: 'center' }}>

          <Typography
            variant="h3"
            sx={{
              fontSize: { xs: '2.5rem', md: '4rem' },
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
              mb: 1,
            }}
          >
            АУКЦИОН
          </Typography>
          <Typography
            variant="h3"
            sx={{
              fontSize: { xs: '2.5rem', md: '4rem' },
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
              background: 'linear-gradient(90deg, #c9922a 0%, #e8b84b 50%, #c9922a 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              mb: 4,
            }}
          >
            STALCRAFT X
          </Typography>

          <Typography variant="body1" color="text.secondary" sx={{ mb: 6, lineHeight: 1.7 }}>
            Аналитика цен, прогноз времени продажи и лента торгуемых предметов.<br />
            Доступ по приглашению администратора.
          </Typography>

          {/* Фичи */}
          <Stack direction="row" spacing={0} sx={{ mb: 8, borderTop: '1px solid #1e1e1e', borderLeft: '1px solid #1e1e1e' }}>
            {features.map((f) => (
              <Box
                key={f.label}
                sx={{
                  flex: 1,
                  p: 2.5,
                  borderRight: '1px solid #1e1e1e',
                  borderBottom: '1px solid #1e1e1e',
                  textAlign: 'left',
                }}
              >
                <Typography sx={{ fontSize: '0.65rem', letterSpacing: '0.1em', color: '#c9922a', fontWeight: 700, textTransform: 'uppercase', mb: 0.5 }}>
                  {f.label}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                  {f.desc}
                </Typography>
              </Box>
            ))}
          </Stack>

          {/* Кнопки */}
          {isLoggedIn ? (
            <Button variant="contained" size="large" onClick={() => navigate('/app/monitoring')}
              sx={{ px: 5, py: 1.5, fontSize: '0.85rem', letterSpacing: '0.1em' }}>
              ОТКРЫТЬ ПРИЛОЖЕНИЕ
            </Button>
          ) : (
            <Stack direction="row" spacing={2} justifyContent="center">
              <Button variant="contained" size="large" onClick={() => navigate('/login')}
                sx={{ px: 5, py: 1.5, fontSize: '0.85rem', letterSpacing: '0.1em' }}>
                ВОЙТИ
              </Button>
              <Button variant="outlined" size="large" onClick={() => navigate('/register')}
                sx={{ px: 5, py: 1.5, fontSize: '0.85rem', letterSpacing: '0.1em' }}>
                РЕГИСТРАЦИЯ
              </Button>
            </Stack>
          )}
        </Box>
      </Box>

      {/* Footer */}
      <Box sx={{ px: 4, py: 2, borderTop: '1px solid #1e1e1e', display: 'flex', justifyContent: 'center' }}>
        <Typography variant="caption" color="text.disabled" sx={{ letterSpacing: '0.05em' }}>
          STALCRAFT TRADING ASSISTANT — не аффилирован с EXBO Studio
        </Typography>
      </Box>
    </Box>
  )
}
