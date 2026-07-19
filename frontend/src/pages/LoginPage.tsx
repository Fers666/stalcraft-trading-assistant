import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Button, Alert } from '@mui/material'
import { useAuthStore } from '../store/authStore'
import { tokens, fs } from '../theme'
import DiamondLogo from '../components/ui/DiamondLogo'

const T = tokens

// .kick — киккер-лейбл над инпутом (base.css:37). Прямой <label> ради htmlFor.
const kickSx = {
  display: 'block', mb: '5px', fontFamily: T.fontHead, fontWeight: 600, fontSize: fs.f10,
  letterSpacing: '0.16em', textTransform: 'uppercase', color: T.text2,
} as const

// .input — инпут формы (bg2, border, r2, фокус → золотая рамка). base.css:255-260
const inputSx = {
  height: 36, width: '100%', px: '9px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 1,
  color: T.text0, font: 'inherit', fontSize: fs.f125,
  transition: `border-color ${T.motion.fast}ms ${T.motion.ease}`,
  '&::placeholder': { color: T.text2 },
  '&:hover': { borderColor: T.borderHi },
  '&:focus': { outline: 'none', borderColor: T.goldLine },
} as const

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
      const ax = err as { response?: { status?: number } }
      if (!ax.response) {
        // нет ответа сервера — сетевая ошибка (offline / таймаут / CORS / 5xx без тела)
        setError('Нет связи с сервером — проверь подключение и попробуй снова')
      } else if (ax.response.status === 403) {
        setError('Аккаунт ожидает подтверждения администратора')
      } else if (ax.response.status === 401 || ax.response.status === 400) {
        setError('Неверный email или пароль')
      } else {
        setError('Ошибка сервера — попробуй позже')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: T.bg0, position: 'relative' }}>

      {/* ── фоновый слой .pub-bg: ромб-сетка + верхнее золотое свечение ──────── */}
      <Box aria-hidden="true" sx={{
        position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none',
        background: [
          `radial-gradient(ellipse 62% 44% at 50% -14%, ${T.goldDim}, transparent 68%)`,
          `repeating-linear-gradient(45deg, ${T.grid} 0 1px, transparent 1px 44px)`,
          `repeating-linear-gradient(-45deg, ${T.grid} 0 1px, transparent 1px 44px)`,
        ].join(','),
      }} />

      {/* ── .lg-wrap: центрированная карточка + системная строка ─────────────── */}
      <Box component="main" sx={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '14px', p: '48px 16px', position: 'relative',
      }}>
        <Box sx={{ width: 440, maxWidth: '100%', background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 1, overflow: 'hidden' }}>
          {/* золотая акцентная полоса .lg-bar */}
          <Box aria-hidden="true" sx={{ height: 2, background: `linear-gradient(90deg, ${T.goldSoft}, ${T.gold} 50%, ${T.goldAccent})` }} />

          <Box sx={{ p: '26px 28px 24px' }}>
            {/* бренд .lg-brand */}
            <Box
              component="a" href="/" aria-label="SC Trading — на главную"
              onClick={(e: React.MouseEvent) => { e.preventDefault(); navigate('/') }}
              sx={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', mb: '22px' }}
            >
              <DiamondLogo size={30} />
              <Box sx={{ lineHeight: 1.02, display: 'flex', flexDirection: 'column' }}>
                <Box component="b" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f15, letterSpacing: '0.08em', color: T.text0 }}>SC TRADING</Box>
                <Box component="i" sx={{ fontStyle: 'normal', fontFamily: T.fontHead, fontWeight: 600, fontSize: fs.f10, letterSpacing: '0.24em', color: T.text2, textTransform: 'uppercase' }}>Zone Terminal</Box>
              </Box>
            </Box>

            <Box component="h1" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.04em', lineHeight: 1.05, color: T.text0, mb: '20px' }}>
              Вход в систему
            </Box>

            {error && <Alert severity="error" sx={{ mb: '14px' }}>{error}</Alert>}

            {/* форма .lg-form (без питч-абзаца и без демо-автозаполнения) */}
            <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <Box>
                <Box component="label" htmlFor="lg-email" sx={kickSx}>Email</Box>
                <Box
                  component="input" id="lg-email" type="email" required
                  autoComplete="username" spellCheck={false}
                  value={email} onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setEmail(ev.target.value)}
                  sx={inputSx}
                />
              </Box>
              <Box>
                <Box component="label" htmlFor="lg-pass" sx={kickSx}>Пароль</Box>
                <Box
                  component="input" id="lg-pass" type="password" required
                  autoComplete="current-password"
                  value={password} onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setPassword(ev.target.value)}
                  sx={inputSx}
                />
              </Box>
              <Button type="submit" variant="contained" fullWidth disabled={loading} sx={{ mt: '4px', height: 40 }}>
                {loading ? 'Подключение…' : 'Войти'}
              </Button>
            </Box>

            {/* альтернатива .lg-alt */}
            <Box sx={{ mt: '20px', pt: '16px', borderTop: `1px solid ${T.border}`, textAlign: 'center', fontSize: fs.f125, color: T.text1 }}>
              Нет аккаунта?{' '}
              <Box
                component="a" href="/register"
                onClick={(ev: React.MouseEvent) => { ev.preventDefault(); navigate('/register') }}
                sx={{ color: T.goldAccent, textDecoration: 'none', borderBottom: `1px solid ${T.goldLine}`, transition: `color ${T.motion.fast}ms ${T.motion.ease}, border-color ${T.motion.fast}ms ${T.motion.ease}`, '&:hover': { color: T.goldHighlight, borderColor: T.goldHighlight } }}
              >
                Зарегистрироваться
              </Box>
            </Box>
          </Box>
        </Box>

        {/* системная строка .lg-sys */}
        <Box component="p" className="mono" sx={{ m: 0, fontSize: fs.f105, letterSpacing: '0.06em', color: T.text2 }}>
          SC TRADING TERMINAL · защищённое соединение
        </Box>
      </Box>
    </Box>
  )
}
