import { useState, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, TextField, Switch,
  FormControlLabel, Button, Alert, Divider, CircularProgress,
} from '@mui/material'
import api from '../api/client'

interface Settings {
  min_profit_margin_percent: number
  exclude_less_than_amount: number
  notify_telegram: boolean
  notify_browser_push: boolean
  auto_refresh_enabled: boolean
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    api.get('/settings').then(({ data }) => setSettings(data)).catch(() => setError('Не удалось загрузить настройки')).finally(() => setLoading(false))
  }, [])

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

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  return (
    <Box sx={{ maxWidth: 520 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Настройки</Typography>

      {error   && <Alert severity="error"   sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>Сохранено</Alert>}

      <Card>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Typography variant="subtitle2" color="text.secondary">Аналитика</Typography>

          <TextField
            label="Минимальная маржа (%)"
            type="number"
            size="small"
            value={settings?.min_profit_margin_percent ?? 10}
            onChange={(e) => setSettings((s) => s ? { ...s, min_profit_margin_percent: Number(e.target.value) } : s)}
            helperText="Показывать рекомендации только если прибыль выше этого порога"
            inputProps={{ min: 1, max: 100 }}
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
    </Box>
  )
}
