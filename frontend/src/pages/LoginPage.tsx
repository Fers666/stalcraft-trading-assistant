import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import { Box, Card, CardContent, TextField, Button, Typography, Alert, Link } from '@mui/material'
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
    } catch {
      setError('Неверный email или пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Card sx={{ width: 400, p: 2 }}>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 3, color: 'primary.main', fontWeight: 700 }}>
            SC Trading
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Аналитика аукциона Stalcraft X
          </Typography>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required fullWidth size="small" />
            <TextField label="Пароль" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required fullWidth size="small" />
            <Button type="submit" variant="contained" fullWidth disabled={loading} sx={{ mt: 1 }}>
              {loading ? 'Вход...' : 'Войти'}
            </Button>
          </Box>

          <Typography variant="body2" sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
            Нет аккаунта?{' '}
            <Link component={RouterLink} to="/register" color="primary">
              Зарегистрироваться
            </Link>
          </Typography>
        </CardContent>
      </Card>
    </Box>
  )
}
