import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import { Box, Card, CardContent, TextField, Button, Typography, Alert, Link, alpha } from '@mui/material'
import { useAuthStore } from '../store/authStore'

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/app/monitoring')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 403) {
        setError('Аккаунт ожидает подтверждения администратора')
      } else {
        setError('Неверный email или пароль')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box sx={{
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      minHeight: '100vh', bgcolor: 'background.default', position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle gold top glow */}
      <Box sx={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 280,
        pointerEvents: 'none',
        background: 'radial-gradient(ellipse 50% 40% at 50% -10%, rgba(217,175,55,0.06) 0%, transparent 70%)',
      }} />

      <Card sx={{ width: 400, p: 1, position: 'relative', zIndex: 1 }}>
        {/* Gold accent bar */}
        <Box sx={{
          height: 2,
          background: 'linear-gradient(90deg, #B78A2A 0%, #D9AF37 50%, #F2C94C 100%)',
          borderRadius: '18px 18px 0 0',
          mx: -1, mt: -1, mb: 0,
        }} />

        <CardContent sx={{ pt: 3 }}>
          {/* Logo */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
            <Box sx={{ width: 34, height: 34 }}>
              <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
                <defs>
                  <linearGradient id="login-gold" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#B78A2A" />
                    <stop offset="55%" stopColor="#D9AF37" />
                    <stop offset="100%" stopColor="#F2C94C" />
                  </linearGradient>
                  <clipPath id="login-diamond">
                    <polygon points="17,1 33,17 17,33 1,17" />
                  </clipPath>
                </defs>
                <polygon points="17,1 33,17 17,33 1,17" stroke="url(#login-gold)" strokeWidth="1.5" fill="none" />
                <g clipPath="url(#login-diamond)">
                  <rect x="6" y="22" width="4" height="9" fill="url(#login-gold)" opacity="0.55" />
                  <rect x="11.5" y="18" width="4" height="13" fill="url(#login-gold)" opacity="0.7" />
                  <rect x="17" y="13" width="4" height="18" fill="url(#login-gold)" opacity="0.85" />
                  <rect x="22.5" y="8" width="4" height="23" fill="url(#login-gold)" />
                </g>
              </svg>
            </Box>
            <Box>
              <Typography sx={{
                fontFamily: '"Rajdhani", sans-serif',
                fontWeight: 700, fontSize: '1.1rem',
                color: '#F5F5F5', letterSpacing: '0.08em', lineHeight: 1,
              }}>
                SC TRADING
              </Typography>
              <Typography sx={{ fontSize: '0.5rem', color: '#7C7C7C', letterSpacing: '0.14em', lineHeight: 1 }}>
                ZONE MARKET TERMINAL
              </Typography>
            </Box>
          </Box>

          <Typography sx={{
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: 700, fontSize: '1.35rem', letterSpacing: '0.04em',
            color: '#F5F5F5', mb: 0.5,
          }}>
            Вход в систему
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Аналитика аукциона Stalcraft X
          </Typography>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Email" type="email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              required fullWidth
            />
            <TextField
              label="Пароль" type="password"
              value={password} onChange={(e) => setPassword(e.target.value)}
              required fullWidth
            />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={loading} sx={{ mt: 0.5 }}>
              {loading ? 'Вход...' : 'Войти'}
            </Button>
          </Box>

          <Box sx={{
            mt: 2.5, pt: 2, borderTop: '1px solid rgba(255,255,255,0.06)',
            textAlign: 'center',
          }}>
            <Typography variant="body2" color="text.secondary">
              Нет аккаунта?{' '}
              <Link component={RouterLink} to="/register" sx={{ color: 'primary.light', textDecorationColor: alpha('#F2C94C', 0.4) }}>
                Зарегистрироваться
              </Link>
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  )
}
