import { useEffect, useState } from 'react'
import {
  Box, Typography, alpha, Chip, Button, Table, TableBody,
  TableCell, TableHead, TableRow, Skeleton, Alert,
  ToggleButtonGroup, ToggleButton, Select, MenuItem, TextField,
  Switch, FormControlLabel, LinearProgress,
} from '@mui/material'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import BlockIcon from '@mui/icons-material/Block'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import SyncIcon from '@mui/icons-material/Sync'
import TuneIcon from '@mui/icons-material/Tune'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import api from '../api/client'
import { TIER_OPTIONS, TIER_LABELS, TIER_COLORS, type Tier } from '../constants/tiers'
import { tokens, fs } from '../theme'
import { fmtN } from '../utils/format'
import Kick from '../components/ui/Kick'
import Panel from '../components/ui/Panel'
import StatusLine, { type StatusMetric } from '../components/ui/StatusLine'
import CompartmentGrid from '../components/ui/CompartmentGrid'

const EXTEND_OPTIONS: { delta: '1d' | '1w' | '1m', label: string }[] = [
  { delta: '1d', label: '+1д' },
  { delta: '1w', label: '+1нед' },
  { delta: '1m', label: '+1мес' },
]

// ── компактная золотая кнопка действия в таблице (.qbtn-подобная, размер строки)
const miniGold = {
  minWidth: 0, height: 24, px: 1, py: 0,
  fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11,
  letterSpacing: '0.06em', textTransform: 'uppercase', borderRadius: 1,
  color: tokens.goldAccent, border: `1px solid ${tokens.goldLine}`, background: tokens.bg2,
  '&:hover': { background: tokens.goldDim, borderColor: tokens.gold, color: tokens.goldAccent },
  '&.Mui-disabled': { color: tokens.text2, borderColor: tokens.border, background: tokens.bg2 },
} as const

// ── нейтральная компактная кнопка (Бессрочно / отзыв у админа)
const miniNeutral = {
  minWidth: 0, height: 24, px: 1, py: 0,
  fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11,
  letterSpacing: '0.06em', textTransform: 'uppercase', borderRadius: 1,
  color: tokens.text2, border: `1px solid ${tokens.border}`, background: tokens.bg2,
  '&:hover': { color: tokens.text1, borderColor: tokens.borderHi },
  '&.Mui-disabled': { color: tokens.text2, borderColor: tokens.border, background: tokens.bg2 },
} as const

// ── кнопка «Одобрить» (успех)
const successBtn = {
  minWidth: 0, height: 28, px: 1.5, py: 0,
  fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.04em',
  textTransform: 'uppercase', borderRadius: 1,
  color: tokens.success, border: `1px solid ${tokens.successLine}`, background: tokens.successDim,
  '&:hover': { background: tokens.successDim, borderColor: tokens.success },
  '&.Mui-disabled': { color: tokens.text2, borderColor: tokens.border, background: tokens.bg2 },
} as const

// ── кнопка «Отозвать» (опасность)
const dangerBtn = {
  minWidth: 0, height: 28, px: 1.5, py: 0,
  fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.04em',
  textTransform: 'uppercase', borderRadius: 1,
  color: tokens.danger, border: `1px solid ${tokens.dangerLine}`, background: tokens.dangerDim,
  '&:hover': { background: tokens.dangerDim, borderColor: tokens.danger },
  '&.Mui-disabled': { color: tokens.text2, borderColor: tokens.border, background: tokens.bg2 },
} as const

// Заголовки таблицы + выравнивание колонок (числа/даты — вправо, остальное — влево)
const TABLE_HEADS: { label: string, align: 'left' | 'right' }[] = [
  { label: 'Пользователь', align: 'left' },
  { label: 'Email', align: 'left' },
  { label: 'Статус', align: 'left' },
  { label: 'Зарегистрирован', align: 'right' },
  { label: 'Тариф', align: 'left' },
  { label: 'До', align: 'right' },
  { label: 'Telegram', align: 'left' },
  { label: 'Был онлайн', align: 'left' },
  { label: 'Карточек', align: 'left' },
  { label: 'Радар рынка', align: 'left' },
  { label: 'Действие', align: 'left' },
]

interface AdminUser {
  id: number
  username: string
  email: string
  telegram_username: string | null
  telegram_chat_id: number | null
  is_admin: boolean
  is_approved: boolean
  is_active: boolean
  created_at: string | null
  tier: Tier
  tier_expires_at: string | null
  last_seen: string | null
  is_online: boolean
  watchlist_count: number
  has_market_radar_addon: boolean
  favorites_limit_override: number | null
  effective_watchlist_limit: number | null
}

interface RegistrationSettings {
  auto_approve_enabled: boolean
  default_tier: Tier
  default_tier_duration_days: number | null
}

interface AdminStats {
  users_by_tier: Record<string, number>
  users_online_now: number
  users_active_today: number
  users_active_week: number
  users_telegram_linked: number
  unique_watchlist_pairs: number
  total_watchlist_entries: number
  rate_limit: {
    requests_current_minute: number | null
    capacity_per_minute: number
    source: 'redis' | 'fallback'
  }
}

type FilterType = 'all' | 'pending' | 'approved'

export default function AdminPage() {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<FilterType>('pending')
  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  // Tier change UI state — per-row pending selections
  const [tierSelect, setTierSelect] = useState<Record<number, Tier>>({})
  const [tierDate, setTierDate] = useState<Record<number, string>>({})
  const [tierActionLoading, setTierActionLoading] = useState<number | null>(null)

  // Favorites (watchlist) limit override — per-row pending input
  const [favOverrideInput, setFavOverrideInput] = useState<Record<number, string>>({})
  const [favOverrideLoading, setFavOverrideLoading] = useState<number | null>(null)

  // Радар рынка (аддон, не тариф) — ручная выдача/отзыв
  const [marketRadarLoading, setMarketRadarLoading] = useState<number | null>(null)

  // Registration settings card
  const [regSettings, setRegSettings] = useState<RegistrationSettings | null>(null)
  const [regLoading, setRegLoading] = useState(false)
  const [regSaving, setRegSaving] = useState(false)
  const [regMsg, setRegMsg] = useState<string | null>(null)
  const [regDaysInput, setRegDaysInput] = useState('')

  // Stats card (snapshot — без поллинга, обновляется при заходе на страницу)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  useEffect(() => {
    if (user && !user.is_admin) {
      navigate('/app/monitoring', { replace: true })
    }
  }, [user, navigate])

  useEffect(() => {
    if (!user?.is_admin) return
    loadUsers()
    loadRegistrationSettings()
    loadStats()
  }, [user])

  const loadUsers = async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get('/admin/users')
      setUsers(data)
    } catch {
      setError('Не удалось загрузить список пользователей')
    } finally {
      setLoading(false)
    }
  }

  const loadRegistrationSettings = async () => {
    setRegLoading(true)
    try {
      const { data } = await api.get('/admin/settings/registration')
      setRegSettings(data)
      setRegDaysInput(data.default_tier_duration_days != null ? String(data.default_tier_duration_days) : '')
    } catch {
      // тихо игнорируем — карточка просто не покажет значения
    } finally {
      setRegLoading(false)
    }
  }

  const loadStats = async () => {
    setStatsLoading(true)
    try {
      const { data } = await api.get('/admin/stats')
      setStats(data)
    } catch {
      // тихо игнорируем — блок статистики просто не покажет значения
    } finally {
      setStatsLoading(false)
    }
  }

  const saveRegistrationSettings = async () => {
    if (!regSettings) return
    setRegSaving(true)
    setRegMsg(null)
    try {
      const days = regDaysInput.trim() === '' ? null : parseInt(regDaysInput, 10)
      const payload = {
        auto_approve_enabled: regSettings.auto_approve_enabled,
        default_tier: regSettings.default_tier,
        default_tier_duration_days: Number.isNaN(days) ? null : days,
      }
      const { data } = await api.put('/admin/settings/registration', payload)
      setRegSettings(data)
      setRegDaysInput(data.default_tier_duration_days != null ? String(data.default_tier_duration_days) : '')
      setRegMsg('Сохранено')
    } catch {
      setRegMsg('Ошибка сохранения')
    } finally {
      setRegSaving(false)
    }
  }

  const approve = async (id: number) => {
    setActionLoading(id)
    try {
      await api.post(`/admin/users/${id}/approve`)
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_approved: true } : u))
    } finally {
      setActionLoading(null)
    }
  }

  const revoke = async (id: number) => {
    setActionLoading(id)
    try {
      await api.post(`/admin/users/${id}/revoke`)
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_approved: false } : u))
    } finally {
      setActionLoading(null)
    }
  }

  // Смена тарифа — не трогает текущую дату окончания подписки.
  const applyTierChange = async (id: number, currentExpiresAt: string | null) => {
    const tier = tierSelect[id]
    if (!tier) return
    setTierActionLoading(id)
    try {
      await api.post(`/admin/users/${id}/tier`, { tier, expires_at: currentExpiresAt })
      setUsers(prev => prev.map(u => u.id === id ? { ...u, tier } : u))
    } finally {
      setTierActionLoading(null)
    }
  }

  // Установка даты окончания — не трогает текущий тариф. Требует выбранную
  // дату (кнопка в UI неактивна без неё) — отдельное действие "Бессрочно"
  // ниже для явной очистки срока, чтобы пустое поле не сбрасывало дату случайно.
  const applyExpiryDate = async (id: number, currentTier: Tier) => {
    const dateStr = tierDate[id]
    if (!dateStr) return
    const expiresAt = new Date(`${dateStr}T00:00:00Z`).toISOString()
    setTierActionLoading(id)
    try {
      await api.post(`/admin/users/${id}/tier`, { tier: currentTier, expires_at: expiresAt })
      setUsers(prev => prev.map(u => u.id === id ? { ...u, tier_expires_at: expiresAt } : u))
    } finally {
      setTierActionLoading(null)
    }
  }

  // Явная очистка срока (сделать тариф бессрочным) — отдельное действие,
  // не связано с полем даты.
  const clearExpiryDate = async (id: number, currentTier: Tier) => {
    setTierActionLoading(id)
    try {
      await api.post(`/admin/users/${id}/tier`, { tier: currentTier, expires_at: null })
      setUsers(prev => prev.map(u => u.id === id ? { ...u, tier_expires_at: null } : u))
      setTierDate(prev => ({ ...prev, [id]: '' }))
    } finally {
      setTierActionLoading(null)
    }
  }

  const extendTier = async (id: number, delta: '1d' | '1w' | '1m') => {
    setTierActionLoading(id)
    try {
      const { data } = await api.post(`/admin/users/${id}/tier/extend`, { delta })
      setUsers(prev => prev.map(u => u.id === id ? { ...u, tier_expires_at: data.tier_expires_at } : u))
    } finally {
      setTierActionLoading(null)
    }
  }

  // Пустая строка → снять override (null); иначе целое число >= 0.
  // Невалидный ввод (не число / отрицательное) — кнопка просто неактивна (см. disabled ниже).
  const parseFavOverride = (raw: string): { valid: true, value: number | null } | { valid: false } => {
    if (raw.trim() === '') return { valid: true, value: null }
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < 0) return { valid: false }
    return { valid: true, value: n }
  }

  const applyFavoritesOverride = async (id: number) => {
    const parsed = parseFavOverride(favOverrideInput[id] ?? '')
    if (!parsed.valid) return
    setFavOverrideLoading(id)
    try {
      await api.post(`/admin/users/${id}/favorites-limit-override`, { override: parsed.value })
      // effective_watchlist_limit (а при override=null — лимит тарифа) считается на
      // backend (tiers.py) — перезагружаем список, чтобы не дублировать эту логику.
      await loadUsers()
    } finally {
      setFavOverrideLoading(null)
    }
  }

  const toggleMarketRadar = async (id: number, enabled: boolean) => {
    setMarketRadarLoading(id)
    try {
      await api.post(`/admin/users/${id}/market-radar-addon`, { enabled })
      setUsers(prev => prev.map(u => u.id === id ? { ...u, has_market_radar_addon: enabled } : u))
    } finally {
      setMarketRadarLoading(null)
    }
  }

  const filtered = users.filter(u => {
    if (filter === 'pending')  return !u.is_approved
    if (filter === 'approved') return u.is_approved
    return true
  })

  const pendingCount  = users.filter(u => !u.is_approved).length
  const approvedCount = users.filter(u => u.is_approved).length

  const handleForceRefresh = async () => {
    setRefreshLoading(true)
    setRefreshMsg(null)
    try {
      const { data } = await api.post('/admin/tasks/force-refresh-history')
      setRefreshMsg(data.message)
    } catch {
      setRefreshMsg('Ошибка запуска задачи')
    } finally {
      setRefreshLoading(false)
    }
  }

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const fmtRelative = (iso: string | null) => {
    if (!iso) return 'никогда'
    const diffMs = Date.now() - new Date(iso).getTime()
    const min = Math.floor(diffMs / 60000)
    if (min < 1) return 'сейчас'
    if (min < 60) return `${min} мин назад`
    const hrs = Math.floor(min / 60)
    if (hrs < 24) return `${hrs} ч назад`
    const days = Math.floor(hrs / 24)
    return `${days} дн назад`
  }

  if (!user?.is_admin) return null

  // Скелетон значения статус-строки, пока данные грузятся (LOAD-01)
  const skv = () => <Skeleton variant="text" width={28} sx={{ display: 'inline-block' }} />
  const sysLoad = statsLoading || !stats

  const userMetrics: StatusMetric[] = [
    { label: 'Всего', value: loading ? skv() : fmtN(users.length) },
    { label: 'Ожидают', value: loading ? skv() : fmtN(pendingCount), tone: 'a' },
    { label: 'Одобрены', value: loading ? skv() : fmtN(approvedCount), tone: 'g' },
    { label: 'Онлайн сейчас', value: statsLoading || !stats ? skv() : fmtN(stats.users_online_now), tone: 'g' },
  ]

  const sysMetrics: StatusMetric[] = [
    { label: 'Зашли сегодня', value: statsLoading || !stats ? skv() : fmtN(stats.users_active_today) },
    { label: 'Активны за неделю', value: statsLoading || !stats ? skv() : fmtN(stats.users_active_week) },
    { label: 'Подключили Telegram', value: statsLoading || !stats ? skv() : fmtN(stats.users_telegram_linked) },
    {
      label: 'В отслеживании',
      value: statsLoading || !stats ? skv() : fmtN(stats.unique_watchlist_pairs),
      unit: statsLoading || !stats ? undefined : `/ ${fmtN(stats.total_watchlist_entries)}`,
    },
  ]

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* .pg-h — шапка страницы */}
      <Panel>
        <Box sx={{ padding: '14px 18px 12px' }}>
          <Kick>Админ // Access Control</Kick>
          <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
            Управление доступом
          </Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
            Подтверждение регистраций, тарифы, аддоны и системные метрики терминала.
          </Typography>
        </Box>
      </Panel>

      {error && <Alert severity="error">{error}</Alert>}

      {/* Статус-строки: пользователи + активность */}
      <StatusLine metrics={userMetrics} />
      <StatusLine metrics={sysMetrics} />

      {/* Тарифы + Rate limit — сетка отсеков с 1px-щелями */}
      <CompartmentGrid columns={2}>
        <Box>
          <Kick sx={{ display: 'block', mb: '8px' }}>Тарифы</Kick>
          {sysLoad ? (
            <Skeleton variant="rounded" width="60%" height={22} />
          ) : (
            <Box sx={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {Object.entries(stats.users_by_tier).map(([tier, count]) => {
                const t = tier as Tier
                const color = TIER_COLORS[t] ?? tokens.text2
                return (
                  <Chip
                    key={tier}
                    className="mono"
                    label={`${TIER_LABELS[t] ?? tier}: ${count}`}
                    size="small"
                    sx={{
                      height: 22, fontSize: fs.f11, fontWeight: 700,
                      background: alpha(color, 0.15),
                      color,
                      border: `1px solid ${alpha(color, 0.35)}`,
                    }}
                  />
                )
              })}
            </Box>
          )}
        </Box>

        <Box>
          <Kick sx={{ display: 'block', mb: '8px' }}>Rate limit Stalcraft API</Kick>
          {sysLoad ? (
            <Skeleton variant="rounded" width="70%" height={22} />
          ) : (() => {
            const { requests_current_minute, capacity_per_minute } = stats.rate_limit
            const used = requests_current_minute ?? 0
            const pct = capacity_per_minute > 0 ? (used / capacity_per_minute) * 100 : 0
            const barColor = pct > 80 ? tokens.danger : pct > 50 ? tokens.warning : tokens.success
            const barDim   = pct > 80 ? tokens.dangerDim : pct > 50 ? tokens.warningDim : tokens.successDim
            return (
              <Box sx={{ maxWidth: 220 }}>
                <Box className="mono" sx={{ fontSize: fs.f14, fontWeight: 500, color: tokens.text0, mb: '6px' }}>
                  {requests_current_minute ?? '—'} / {capacity_per_minute}
                  <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2 }}> запросов/мин</Box>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(pct, 100)}
                  sx={{
                    height: 5, borderRadius: 1, background: barDim,
                    '& .MuiLinearProgress-bar': { background: barColor, borderRadius: 1 },
                  }}
                />
              </Box>
            )
          })()}
        </Box>
      </CompartmentGrid>

      {/* Задача пересборки истории */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          disabled={refreshLoading}
          onClick={handleForceRefresh}
          startIcon={<SyncIcon sx={{ fontSize: '15px !important' }} />}
        >
          {refreshLoading ? 'Запускается…' : 'Пересобрать историю (артефакты)'}
        </Button>
        {refreshMsg && (
          <Typography className="mono" sx={{ fontSize: fs.f12, color: refreshMsg.startsWith('Ошибка') ? tokens.danger : tokens.success }}>
            {refreshMsg}
          </Typography>
        )}
      </Box>

      {/* Настройки авто-подтверждения регистрации */}
      <Panel
        title={
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <TuneIcon sx={{ fontSize: 16, color: tokens.gold }} />
            Настройки авто-подтверждения регистрации
          </Box>
        }
      >
        <Box sx={{ borderTop: `1px solid ${tokens.border}`, padding: '14px 16px 16px' }}>
          {regLoading || !regSettings ? (
            <Box sx={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              <Skeleton variant="rounded" width={180} height={34} />
              <Skeleton variant="rounded" width={150} height={34} />
              <Skeleton variant="rounded" width={130} height={34} />
            </Box>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap' }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={regSettings.auto_approve_enabled}
                    onChange={(e) => setRegSettings({ ...regSettings, auto_approve_enabled: e.target.checked })}
                  />
                }
                label={
                  <Typography sx={{ fontSize: fs.f125, color: tokens.text1 }}>
                    Авто-подтверждение
                  </Typography>
                }
              />

              <Box>
                <Kick component="label" sx={{ display: 'block', mb: '5px' }}>Тариф по умолчанию</Kick>
                <Select
                  size="small"
                  value={regSettings.default_tier}
                  onChange={(e) => setRegSettings({ ...regSettings, default_tier: e.target.value as Tier })}
                  sx={{ minWidth: 150 }}
                >
                  {TIER_OPTIONS.map(t => (
                    <MenuItem key={t} value={t}>{TIER_LABELS[t]}</MenuItem>
                  ))}
                </Select>
              </Box>

              <Box>
                <Kick component="label" sx={{ display: 'block', mb: '5px' }}>Дней (пусто = бессрочно)</Kick>
                <TextField
                  size="small"
                  type="number"
                  value={regDaysInput}
                  onChange={(e) => setRegDaysInput(e.target.value)}
                  placeholder="бессрочно"
                  inputProps={{ className: 'mono' }}
                  sx={{ width: 130 }}
                />
              </Box>

              <Button
                size="small"
                variant="contained"
                disabled={regSaving}
                onClick={saveRegistrationSettings}
              >
                {regSaving ? 'Сохранение…' : 'Сохранить'}
              </Button>

              {regMsg && (
                <Typography className="mono" sx={{ fontSize: fs.f12, color: regMsg === 'Сохранено' ? tokens.success : tokens.danger }}>
                  {regMsg}
                </Typography>
              )}
            </Box>
          )}
        </Box>
      </Panel>

      {/* Фильтр — .tabs из темы */}
      <ToggleButtonGroup
        value={filter}
        exclusive
        onChange={(_, v) => { if (v) setFilter(v) }}
        size="small"
      >
        <ToggleButton value="pending">Ожидают {pendingCount > 0 && `(${pendingCount})`}</ToggleButton>
        <ToggleButton value="approved">Одобрены</ToggleButton>
        <ToggleButton value="all">Все</ToggleButton>
      </ToggleButtonGroup>

      {/* Таблица пользователей — оверрайды MuiTable из темы */}
      <Panel>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {TABLE_HEADS.map(h => (
                  <TableCell key={h.label} align={h.align}>{h.label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell colSpan={TABLE_HEADS.length} sx={{ py: '10px' }}>
                      <Skeleton variant="text" height={20} />
                    </TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={TABLE_HEADS.length} align="center" sx={{ py: '40px', color: tokens.text2, fontFamily: tokens.fontUi }}>
                    {filter === 'pending' ? 'Нет пользователей, ожидающих одобрения' : 'Нет пользователей'}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(u => (
                  <TableRow key={u.id}>
                    {/* Username */}
                    <TableCell align="left">
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Box component="span" sx={{ color: tokens.text0, fontSize: fs.f125, fontWeight: 500 }}>
                          {u.username}
                        </Box>
                        {u.is_admin && (
                          <Chip label="ADMIN" size="small" color="primary" sx={{ height: 16, fontSize: fs.f10, fontWeight: 700 }} />
                        )}
                      </Box>
                    </TableCell>

                    {/* Email */}
                    <TableCell align="left" sx={{ color: tokens.text1 }}>{u.email}</TableCell>

                    {/* Status */}
                    <TableCell align="left">
                      {u.is_approved ? (
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <CheckCircleOutlineIcon sx={{ fontSize: 13, color: tokens.success }} />
                          <Box component="span" sx={{ fontSize: fs.f12, color: tokens.success, fontFamily: tokens.fontUi }}>Одобрен</Box>
                        </Box>
                      ) : (
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <PendingActionsIcon sx={{ fontSize: 13, color: tokens.warning }} />
                          <Box component="span" sx={{ fontSize: fs.f12, color: tokens.warning, fontFamily: tokens.fontUi }}>Ожидает</Box>
                        </Box>
                      )}
                    </TableCell>

                    {/* Date */}
                    <TableCell align="right" sx={{ color: tokens.text2 }}>{fmtDate(u.created_at)}</TableCell>

                    {/* Tier */}
                    <TableCell align="left">
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <Chip
                          className="mono"
                          label={TIER_LABELS[u.tier] ?? u.tier}
                          size="small"
                          sx={{
                            height: 18, fontSize: fs.f10, fontWeight: 700, alignSelf: 'flex-start',
                            background: alpha(TIER_COLORS[u.tier] ?? tokens.text2, 0.15),
                            color: TIER_COLORS[u.tier] ?? tokens.text1,
                            border: `1px solid ${alpha(TIER_COLORS[u.tier] ?? tokens.text2, 0.35)}`,
                          }}
                        />
                        <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <Select
                            size="small"
                            value={tierSelect[u.id] ?? u.tier}
                            onChange={(e) => setTierSelect(prev => ({ ...prev, [u.id]: e.target.value as Tier }))}
                            sx={{ fontSize: fs.f12, minWidth: 110 }}
                          >
                            {TIER_OPTIONS.map(t => (
                              <MenuItem key={t} value={t}>{TIER_LABELS[t]}</MenuItem>
                            ))}
                          </Select>
                          <Button
                            size="small"
                            disabled={tierActionLoading === u.id || (tierSelect[u.id] ?? u.tier) === u.tier}
                            onClick={() => applyTierChange(u.id, u.tier_expires_at)}
                            sx={[miniGold, { height: 26 }]}
                          >
                            {tierActionLoading === u.id ? '…' : 'Сменить'}
                          </Button>
                        </Box>
                        <Box sx={{ display: 'flex', gap: '4px' }}>
                          {EXTEND_OPTIONS.map(({ delta, label }) => (
                            <Button
                              key={delta}
                              size="small"
                              disabled={tierActionLoading === u.id}
                              onClick={() => extendTier(u.id, delta)}
                              sx={[miniGold, { height: 22 }]}
                            >
                              {label}
                            </Button>
                          ))}
                        </Box>
                        <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <input
                            type="date"
                            value={tierDate[u.id] ?? ''}
                            onChange={(e) => setTierDate(prev => ({ ...prev, [u.id]: e.target.value }))}
                            style={{
                              background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: 2,
                              color: tokens.text1, fontSize: '11px', padding: '2px 4px', height: 20,
                              colorScheme: 'dark', fontFamily: tokens.fontMono,
                            }}
                          />
                          <Button
                            size="small"
                            disabled={tierActionLoading === u.id || !tierDate[u.id]}
                            onClick={() => applyExpiryDate(u.id, u.tier)}
                            sx={[miniGold, { height: 20 }]}
                          >
                            {tierActionLoading === u.id ? '…' : 'Установить дату'}
                          </Button>
                          <Button
                            size="small"
                            disabled={tierActionLoading === u.id || !u.tier_expires_at}
                            onClick={() => clearExpiryDate(u.id, u.tier)}
                            sx={[miniNeutral, { height: 20 }]}
                          >
                            Бессрочно
                          </Button>
                        </Box>
                      </Box>
                    </TableCell>

                    {/* Tier expires at */}
                    <TableCell align="right" sx={{ color: tokens.text2 }}>
                      {u.tier_expires_at ? fmtDate(u.tier_expires_at) : 'Бессрочно'}
                    </TableCell>

                    {/* Telegram */}
                    <TableCell align="left" sx={{ color: u.telegram_username ? tokens.text1 : tokens.text2 }}>
                      {u.telegram_username ? `@${u.telegram_username}` : '—'}
                    </TableCell>

                    {/* Last seen / online */}
                    <TableCell align="left">
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <Box sx={{
                          width: 7, height: 7, flexShrink: 0,
                          background: u.is_online ? tokens.success : tokens.text2,
                          boxShadow: u.is_online ? `0 0 6px ${tokens.success}` : 'none',
                        }} />
                        <Box component="span" sx={{ fontSize: fs.f12, color: u.is_online ? tokens.success : tokens.text2, fontFamily: tokens.fontUi }}>
                          {u.is_online ? 'Онлайн' : fmtRelative(u.last_seen)}
                        </Box>
                      </Box>
                    </TableCell>

                    {/* Watchlist count + favorites limit override */}
                    <TableCell align="left">
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <Box component="span" className="mono" sx={{ color: tokens.text1, fontSize: fs.f12 }}>
                          {u.watchlist_count} / {u.effective_watchlist_limit ?? '∞'}
                        </Box>
                        <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <TextField
                            size="small"
                            type="number"
                            value={favOverrideInput[u.id] ?? (u.favorites_limit_override != null ? String(u.favorites_limit_override) : '')}
                            onChange={(e) => setFavOverrideInput(prev => ({ ...prev, [u.id]: e.target.value }))}
                            placeholder="лимит тарифа"
                            inputProps={{ className: 'mono' }}
                            sx={{ width: 100 }}
                          />
                          <Button
                            size="small"
                            disabled={favOverrideLoading === u.id || !parseFavOverride(favOverrideInput[u.id] ?? '').valid}
                            onClick={() => applyFavoritesOverride(u.id)}
                            sx={[miniGold, { height: 26 }]}
                          >
                            {favOverrideLoading === u.id ? '…' : 'Применить'}
                          </Button>
                        </Box>
                      </Box>
                    </TableCell>

                    {/* Радар рынка (аддон) */}
                    <TableCell align="left">
                      <Switch
                        size="small"
                        checked={u.has_market_radar_addon}
                        disabled={marketRadarLoading === u.id}
                        onChange={() => toggleMarketRadar(u.id, !u.has_market_radar_addon)}
                      />
                    </TableCell>

                    {/* Action */}
                    <TableCell align="left">
                      {u.is_approved ? (
                        <Button
                          size="small"
                          disabled={u.is_admin || actionLoading === u.id}
                          onClick={() => revoke(u.id)}
                          startIcon={<BlockIcon sx={{ fontSize: '13px !important' }} />}
                          sx={u.is_admin ? miniNeutral : dangerBtn}
                        >
                          {actionLoading === u.id ? '…' : 'Отозвать'}
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          disabled={actionLoading === u.id}
                          onClick={() => approve(u.id)}
                          startIcon={<CheckCircleOutlineIcon sx={{ fontSize: '13px !important' }} />}
                          sx={successBtn}
                        >
                          {actionLoading === u.id ? '…' : 'Одобрить'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Box>
      </Panel>
    </Box>
  )
}
