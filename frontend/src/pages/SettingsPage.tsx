import { useState, useEffect, useCallback } from 'react'
import {
  Box, Typography, Card, CardContent, TextField, Switch,
  FormControlLabel, Button, Alert, Divider, CircularProgress,
  Chip, IconButton, Tooltip,
} from '@mui/material'
import TelegramIcon from '@mui/icons-material/Telegram'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import api from '../api/client'

interface Settings {
  min_profit_margin_percent: number
  exclude_less_than_amount: number
  notify_telegram: boolean
  notify_browser_push: boolean
  auto_refresh_enabled: boolean
}

interface TelegramStatus {
  is_linked: boolean
  telegram_username: string | null
}

interface LinkCode {
  code: string
  ttl_seconds: number
  bot_username: string
  instruction: string
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Telegram
  const [tgStatus, setTgStatus]       = useState<TelegramStatus | null>(null)
  const [linkCode, setLinkCode]       = useState<LinkCode | null>(null)
  const [codeTimer, setCodeTimer]     = useState(0)
  const [codeLoading, setCodeLoading] = useState(false)
  const [unlinkLoading, setUnlinkLoading] = useState(false)
  const [copied, setCopied]           = useState(false)

  const loadTgStatus = useCallback(async () => {
    try {
      const { data } = await api.get<TelegramStatus>('/telegram/status')
      setTgStatus(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    Promise.all([
      api.get('/settings').then(({ data }) => setSettings(data)),
      loadTgStatus(),
    ])
      .catch(() => setError('Не удалось загрузить настройки'))
      .finally(() => setLoading(false))
  }, [loadTgStatus])

  // Таймер обратного отсчёта для кода привязки
  useEffect(() => {
    if (codeTimer <= 0) {
      if (codeTimer === 0 && linkCode) {
        setLinkCode(null)  // код истёк
      }
      return
    }
    const t = setInterval(() => setCodeTimer(s => s - 1), 1000)
    return () => clearInterval(t)
  }, [codeTimer, linkCode])

  // Опрос статуса привязки пока код показан
  useEffect(() => {
    if (!linkCode) return
    const t = setInterval(async () => {
      await loadTgStatus()
      const { data } = await api.get<TelegramStatus>('/telegram/status').catch(() => ({ data: null }))
      if (data?.is_linked) {
        setLinkCode(null)
        setCodeTimer(0)
      }
    }, 5000)
    return () => clearInterval(t)
  }, [linkCode, loadTgStatus])

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setSuccess(false)
    setError(null)
    try {
      await api.put('/settings', settings)
      setSuccess(true)
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const handleGetCode = async () => {
    setCodeLoading(true)
    try {
      const { data } = await api.get<LinkCode>('/telegram/link-code')
      setLinkCode(data)
      setCodeTimer(data.ttl_seconds)
    } catch {
      setError('Не удалось получить код. Попробуйте позже.')
    } finally {
      setCodeLoading(false)
    }
  }

  const handleUnlink = async () => {
    setUnlinkLoading(true)
    try {
      await api.delete('/telegram/unlink')
      setTgStatus({ is_linked: false, telegram_username: null })
      setLinkCode(null)
    } catch {
      setError('Не удалось отвязать Telegram')
    } finally {
      setUnlinkLoading(false)
    }
  }

  const handleCopyCode = () => {
    if (!linkCode) return
    navigator.clipboard.writeText(`/link ${linkCode.code}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const fmtTimer = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  return (
    <Box sx={{ maxWidth: 520 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Настройки</Typography>

      {error   && <Alert severity="error"   sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>Сохранено</Alert>}

      {/* ── Аналитика + уведомления ─────────────────────────── */}
      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle2" color="text.secondary">Аналитика</Typography>

          <TextField
            label="Критерий выгодности (%)"
            type="number"
            size="small"
            value={settings?.min_profit_margin_percent ?? 10}
            onChange={(e) => setSettings((s) => s ? { ...s, min_profit_margin_percent: Number(e.target.value) } : s)}
            helperText="Влияет на выгодные лоты в Избранном, сигналы и Telegram-уведомления — показывает только лоты с прибылью выше этого порога"
            inputProps={{ min: 0, max: 100 }}
          />

          <TextField
            label="Минимальное количество в лоте"
            type="number"
            size="small"
            value={settings?.exclude_less_than_amount ?? 1}
            onChange={(e) => setSettings((s) => s ? { ...s, exclude_less_than_amount: Number(e.target.value) } : s)}
            helperText="Игнорировать лоты с количеством меньше N штук"
            inputProps={{ min: 1 }}
          />

          <Divider />
          <Typography variant="subtitle2" color="text.secondary">Уведомления</Typography>

          <FormControlLabel
            control={
              <Switch
                checked={settings?.auto_refresh_enabled ?? true}
                onChange={(e) => setSettings((s) => s ? { ...s, auto_refresh_enabled: e.target.checked } : s)}
              />
            }
            label="Автоматическое обновление данных"
          />
          <FormControlLabel
            control={
              <Switch
                checked={settings?.notify_telegram ?? false}
                onChange={(e) => setSettings((s) => s ? { ...s, notify_telegram: e.target.checked } : s)}
              />
            }
            label="Уведомления в Telegram"
          />
          <FormControlLabel
            control={
              <Switch
                checked={settings?.notify_browser_push ?? false}
                onChange={(e) => setSettings((s) => s ? { ...s, notify_browser_push: e.target.checked } : s)}
              />
            }
            label="Browser Push уведомления"
          />

          <Button variant="contained" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </CardContent>
      </Card>

      {/* ── Привязка Telegram ────────────────────────────────── */}
      <Card>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TelegramIcon sx={{ color: '#229ED9', fontSize: 22 }} />
            <Typography variant="subtitle2" color="text.secondary">Telegram</Typography>
          </Box>

          <Box sx={{ p: 1.5, borderRadius: '8px', bgcolor: 'rgba(217,175,55,0.06)', border: '1px solid rgba(217,175,55,0.15)' }}>
            <Typography variant="caption" color="text.secondary">
              Уведомления отправляются только по лотам, чья прибыль превышает{' '}
              <strong>критерий выгодности ({settings?.min_profit_margin_percent ?? 10}%)</strong>{' '}
              — настройте его в блоке «Аналитика» выше.
            </Typography>
          </Box>

          {tgStatus?.is_linked ? (
            /* Привязан */
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Chip
                label={tgStatus.telegram_username ? `@${tgStatus.telegram_username}` : 'Привязан'}
                color="success"
                size="small"
                sx={{ fontWeight: 600 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                Уведомления о выгодных лотах включены
              </Typography>
              <Tooltip title="Отвязать Telegram">
                <IconButton
                  size="small"
                  onClick={handleUnlink}
                  disabled={unlinkLoading}
                  sx={{ color: 'text.disabled' }}
                >
                  <LinkOffIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          ) : (
            /* Не привязан */
            <>
              <Typography variant="body2" color="text.secondary">
                Привяжите Telegram-аккаунт, чтобы получать уведомления о выгодных лотах из вотчлиста прямо в мессенджер.
              </Typography>

              {!linkCode ? (
                <Button
                  variant="outlined"
                  startIcon={<TelegramIcon />}
                  onClick={handleGetCode}
                  disabled={codeLoading}
                  sx={{
                    alignSelf: 'flex-start',
                    borderColor: '#229ED9',
                    color: '#229ED9',
                    '&:hover': { borderColor: '#1a8dc2', bgcolor: 'rgba(34,158,217,0.08)' },
                  }}
                >
                  {codeLoading ? 'Генерация...' : 'Получить код привязки'}
                </Button>
              ) : (
                /* Показываем код */
                <Box sx={{
                  border: '1px solid',
                  borderColor: 'rgba(34,158,217,0.35)',
                  borderRadius: 2,
                  p: 2,
                  bgcolor: 'rgba(34,158,217,0.04)',
                }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                    Откройте бота{' '}
                    <Box component="span" sx={{ fontWeight: 700, color: '#229ED9' }}>
                      @{linkCode.bot_username}
                    </Box>{' '}
                    и отправьте команду:
                  </Typography>

                  <Box sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    bgcolor: 'rgba(0,0,0,0.25)', borderRadius: 1.5,
                    px: 2, py: 1, mb: 1.5,
                  }}>
                    <Typography sx={{
                      fontFamily: 'monospace', fontSize: '1.1rem',
                      fontWeight: 700, letterSpacing: '0.15em', flex: 1,
                      color: '#F2C94C',
                    }}>
                      /link {linkCode.code}
                    </Typography>
                    <Tooltip title={copied ? 'Скопировано!' : 'Копировать'}>
                      <IconButton size="small" onClick={handleCopyCode} sx={{ color: 'text.disabled' }}>
                        <ContentCopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.disabled">
                      Код действителен: {fmtTimer(codeTimer)}
                    </Typography>
                    <Button
                      size="small"
                      variant="text"
                      onClick={handleGetCode}
                      disabled={codeLoading}
                      sx={{ fontSize: '0.72rem', color: 'text.disabled' }}
                    >
                      Новый код
                    </Button>
                  </Box>
                </Box>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  )
}
