import { useEffect, useState } from 'react'
import {
  Box, Typography, alpha, Chip, Button, Table, TableBody,
  TableCell, TableHead, TableRow, CircularProgress, Alert,
  ToggleButtonGroup, ToggleButton, Select, MenuItem, TextField,
  Switch, FormControlLabel, LinearProgress,
} from '@mui/material'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import BlockIcon from '@mui/icons-material/Block'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import SyncIcon from '@mui/icons-material/Sync'
import TuneIcon from '@mui/icons-material/Tune'
import InventoryIcon from '@mui/icons-material/Inventory'
import WifiTetheringIcon from '@mui/icons-material/WifiTethering'
import SpeedIcon from '@mui/icons-material/Speed'
import TelegramIcon from '@mui/icons-material/Telegram'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import api from '../api/client'

const G1 = '#B78A2A'
const G2 = '#D9AF37'
const G3 = '#F2C94C'
const G4 = '#FFB800'
const BG1 = '#11151A'
const BG2 = '#1A1F26'
const T0 = '#F5F5F5'
const T1 = '#B8B8B8'
const T2 = '#7C7C7C'
const SUCCESS = '#3ED598'
const DANGER = '#FF5A5A'
const BORDER = 'rgba(255,255,255,0.08)'

const TIER_OPTIONS = ['base', 'advanced', 'advanced_plus', 'advanced_max'] as const
type Tier = typeof TIER_OPTIONS[number]

const TIER_LABELS: Record<Tier, string> = {
  base: 'Базовая',
  advanced: 'Продвинутая',
  advanced_plus: 'Продвинутая+',
  advanced_max: 'Макс',
}

const TIER_COLORS: Record<Tier, string> = {
  base: T2,
  advanced: G1,
  advanced_plus: G2,
  advanced_max: G4,
}

const EXTEND_OPTIONS: { delta: '1d' | '1w' | '1m', label: string }[] = [
  { delta: '1d', label: '+1д' },
  { delta: '1w', label: '+1нед' },
  { delta: '1m', label: '+1мес' },
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

  return (
    <Box sx={{ p: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
        <AdminPanelSettingsIcon sx={{ color: G2, fontSize: 22 }} />
        <Box>
          <Typography sx={{
            fontFamily: '"Rajdhani", sans-serif',
            fontWeight: 700, fontSize: '1.2rem',
            color: T0, letterSpacing: '0.06em', lineHeight: 1,
          }}>
            УПРАВЛЕНИЕ ДОСТУПОМ
          </Typography>
          <Typography sx={{ fontSize: '0.72rem', color: T2, letterSpacing: '0.1em' }}>
            ПОДТВЕРЖДЕНИЕ РЕГИСТРАЦИЙ
          </Typography>
        </Box>

        {/* Gold accent */}
        <Box sx={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${alpha(G2, 0.4)} 0%, transparent 100%)`, ml: 1 }} />
      </Box>

      {/* Stats */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        {[
          { label: 'Всего пользователей', value: users.length, color: T1 },
          { label: 'Ожидают одобрения',  value: pendingCount,  color: '#F5B74F' },
          { label: 'Одобрены',           value: approvedCount, color: SUCCESS },
        ].map(stat => (
          <Box key={stat.label} sx={{
            px: 2.5, py: 1.5,
            background: BG2,
            border: `1px solid ${BORDER}`,
            borderRadius: '10px',
            minWidth: 140,
          }}>
            <Typography sx={{ fontSize: '1.6rem', fontWeight: 700, color: stat.color, lineHeight: 1 }}>
              {stat.value}
            </Typography>
            <Typography sx={{ fontSize: '0.68rem', color: T2, mt: 0.25, letterSpacing: '0.06em' }}>
              {stat.label.toUpperCase()}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* Tasks */}
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant="outlined"
          disabled={refreshLoading}
          onClick={handleForceRefresh}
          startIcon={refreshLoading ? <CircularProgress size={13} sx={{ color: G2 }} /> : <SyncIcon sx={{ fontSize: '15px !important' }} />}
          sx={{
            fontSize: '0.72rem', fontFamily: '"Rajdhani", sans-serif',
            fontWeight: 600, letterSpacing: '0.06em',
            color: G2, border: `1px solid ${alpha(G2, 0.4)}`,
            borderRadius: '8px', px: 2, py: 0.5,
            '&:hover': { background: alpha(G2, 0.08), border: `1px solid ${alpha(G2, 0.6)}` },
          }}
        >
          {refreshLoading ? 'Запускается...' : 'Пересобрать историю (артефакты)'}
        </Button>
        {refreshMsg && (
          <Typography sx={{ fontSize: '0.72rem', color: refreshMsg.startsWith('Ошибка') ? DANGER : SUCCESS }}>
            {refreshMsg}
          </Typography>
        )}
      </Box>

      {/* System stats */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        {/* Уникальные товары в отслеживании */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 200,
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.4 }}>
            <InventoryIcon sx={{ fontSize: 14, color: G2 }} />
            <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em' }}>
              УНИКАЛЬНЫХ ТОВАРОВ В ОТСЛЕЖИВАНИИ
            </Typography>
          </Box>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: T0, lineHeight: 1 }}>
              {stats.unique_watchlist_pairs}
              <Typography component="span" sx={{ fontSize: '0.9rem', fontWeight: 500, color: T2 }}>
                {' '}/ {stats.total_watchlist_entries}
              </Typography>
            </Typography>
          )}
        </Box>

        {/* Онлайн сейчас */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 140,
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.4 }}>
            <WifiTetheringIcon sx={{ fontSize: 14, color: G2 }} />
            <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em' }}>
              ОНЛАЙН СЕЙЧАС
            </Typography>
          </Box>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: SUCCESS, lineHeight: 1 }}>
              {stats.users_online_now}
            </Typography>
          )}
        </Box>

        {/* Тарифы */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 200,
        }}>
          <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em', mb: 0.6 }}>
            ТАРИФЫ
          </Typography>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap' }}>
              {Object.entries(stats.users_by_tier).map(([tier, count]) => {
                const t = tier as Tier
                const color = TIER_COLORS[t] ?? T2
                return (
                  <Chip
                    key={tier}
                    label={`${TIER_LABELS[t] ?? tier}: ${count}`}
                    size="small"
                    sx={{
                      height: 22, fontSize: '0.68rem', fontWeight: 700,
                      letterSpacing: '0.02em',
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

        {/* Rate limit Stalcraft API */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 220,
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.6 }}>
            <SpeedIcon sx={{ fontSize: 14, color: G2 }} />
            <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em' }}>
              RATE LIMIT STALCRAFT API
            </Typography>
          </Box>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (() => {
            const { requests_current_minute, capacity_per_minute } = stats.rate_limit
            const used = requests_current_minute ?? 0
            const pct = capacity_per_minute > 0 ? (used / capacity_per_minute) * 100 : 0
            const barColor = pct > 80 ? DANGER : pct > 50 ? '#F5B74F' : SUCCESS
            return (
              <Box sx={{ minWidth: 160 }}>
                <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: T0, lineHeight: 1, mb: 0.6 }}>
                  {requests_current_minute ?? '—'} / {capacity_per_minute}
                  <Typography component="span" sx={{ fontSize: '0.7rem', fontWeight: 500, color: T2 }}>
                    {' '}запросов/мин
                  </Typography>
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(pct, 100)}
                  sx={{
                    height: 5, borderRadius: 3,
                    background: alpha(barColor, 0.15),
                    '& .MuiLinearProgress-bar': { background: barColor, borderRadius: 3 },
                  }}
                />
              </Box>
            )
          })()}
        </Box>

        {/* Зашли сегодня */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 140,
        }}>
          <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em', mb: 0.4 }}>
            ЗАШЛИ СЕГОДНЯ
          </Typography>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: T0, lineHeight: 1 }}>
              {stats.users_active_today}
            </Typography>
          )}
        </Box>

        {/* Активны за неделю */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 140,
        }}>
          <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em', mb: 0.4 }}>
            АКТИВНЫ ЗА НЕДЕЛЮ
          </Typography>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: T0, lineHeight: 1 }}>
              {stats.users_active_week}
            </Typography>
          )}
        </Box>

        {/* Подключили Telegram */}
        <Box sx={{
          px: 2.5, py: 1.5,
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: '10px',
          minWidth: 160,
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.4 }}>
            <TelegramIcon sx={{ fontSize: 14, color: G2 }} />
            <Typography sx={{ fontSize: '0.68rem', color: T2, letterSpacing: '0.06em' }}>
              ПОДКЛЮЧИЛИ TELEGRAM
            </Typography>
          </Box>
          {statsLoading || !stats ? (
            <CircularProgress size={16} sx={{ color: G2 }} />
          ) : (
            <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: T0, lineHeight: 1 }}>
              {stats.users_telegram_linked}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Registration settings card */}
      <Box sx={{
        mb: 3, p: 2.5,
        background: BG2,
        border: `1px solid ${BORDER}`,
        borderRadius: '12px',
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <TuneIcon sx={{ color: G2, fontSize: 18 }} />
          <Typography sx={{
            fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
            fontSize: '0.95rem', color: T0, letterSpacing: '0.05em',
          }}>
            НАСТРОЙКИ АВТО-ПОДТВЕРЖДЕНИЯ РЕГИСТРАЦИИ
          </Typography>
        </Box>

        {regLoading || !regSettings ? (
          <CircularProgress size={20} sx={{ color: G2 }} />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={regSettings.auto_approve_enabled}
                  onChange={(e) => setRegSettings({ ...regSettings, auto_approve_enabled: e.target.checked })}
                />
              }
              label={
                <Typography sx={{ fontSize: '0.8rem', color: T1 }}>
                  Авто-подтверждение
                </Typography>
              }
            />

            <Box>
              <Typography sx={{ fontSize: '0.65rem', color: T2, letterSpacing: '0.06em', mb: 0.5 }}>
                ТАРИФ ПО УМОЛЧАНИЮ
              </Typography>
              <Select
                size="small"
                value={regSettings.default_tier}
                onChange={(e) => setRegSettings({ ...regSettings, default_tier: e.target.value as Tier })}
                sx={{ minWidth: 150, fontSize: '0.8rem', height: 34 }}
              >
                {TIER_OPTIONS.map(t => (
                  <MenuItem key={t} value={t} sx={{ fontSize: '0.8rem' }}>{TIER_LABELS[t]}</MenuItem>
                ))}
              </Select>
            </Box>

            <Box>
              <Typography sx={{ fontSize: '0.65rem', color: T2, letterSpacing: '0.06em', mb: 0.5 }}>
                ДНЕЙ (ПУСТО = БЕССРОЧНО)
              </Typography>
              <TextField
                size="small"
                type="number"
                value={regDaysInput}
                onChange={(e) => setRegDaysInput(e.target.value)}
                placeholder="бессрочно"
                sx={{ width: 130 }}
                slotProps={{ input: { sx: { fontSize: '0.8rem', height: 34 } } }}
              />
            </Box>

            <Button
              size="small"
              variant="outlined"
              disabled={regSaving}
              onClick={saveRegistrationSettings}
              sx={{
                fontSize: '0.72rem', fontFamily: '"Rajdhani", sans-serif',
                fontWeight: 600, letterSpacing: '0.06em',
                color: G2, border: `1px solid ${alpha(G2, 0.4)}`,
                borderRadius: '8px', px: 2, height: 34,
                '&:hover': { background: alpha(G2, 0.08), border: `1px solid ${alpha(G2, 0.6)}` },
              }}
            >
              {regSaving ? 'Сохранение...' : 'Сохранить'}
            </Button>

            {regMsg && (
              <Typography sx={{ fontSize: '0.72rem', color: regMsg === 'Сохранено' ? SUCCESS : DANGER }}>
                {regMsg}
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {/* Filter */}
      <Box sx={{ mb: 2 }}>
        <ToggleButtonGroup
          value={filter}
          exclusive
          onChange={(_, v) => { if (v) setFilter(v) }}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              color: T2, border: `1px solid ${BORDER}`, borderRadius: '8px !important',
              fontFamily: '"Rajdhani", sans-serif', fontWeight: 600,
              fontSize: '0.78rem', letterSpacing: '0.06em', px: 2, py: 0.5,
              '&.Mui-selected': {
                color: G3,
                background: alpha(G2, 0.12),
                border: `1px solid ${alpha(G2, 0.35)}`,
              },
            },
          }}
        >
          <ToggleButton value="pending">Ожидают {pendingCount > 0 && `(${pendingCount})`}</ToggleButton>
          <ToggleButton value="approved">Одобрены</ToggleButton>
          <ToggleButton value="all">Все</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Error */}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* Table */}
      <Box sx={{
        background: BG2,
        border: `1px solid ${BORDER}`,
        borderRadius: '12px',
        overflow: 'hidden',
      }}>
        {/* Gold top line */}
        <Box sx={{ height: 2, background: `linear-gradient(90deg, ${G1} 0%, ${G2} 50%, ${G3} 100%)` }} />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} sx={{ color: G2 }} />
          </Box>
        ) : filtered.length === 0 ? (
          <Box sx={{ py: 6, textAlign: 'center' }}>
            <Typography sx={{ color: T2, fontSize: '0.85rem' }}>
              {filter === 'pending' ? 'Нет пользователей, ожидающих одобрения' : 'Нет пользователей'}
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                {['Пользователь', 'Email', 'Статус', 'Зарегистрирован', 'Тариф', 'До', 'Telegram', 'Был онлайн', 'Карточек', 'Радар рынка', 'Действие'].map(h => (
                  <TableCell key={h} sx={{
                    color: T2, fontSize: '0.68rem', fontWeight: 600,
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    borderBottom: `1px solid ${BORDER}`,
                    background: BG1, py: 1.2,
                  }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(u => (
                <TableRow key={u.id} sx={{
                  '&:hover': { background: alpha('#fff', 0.02) },
                  '& td': { borderBottom: `1px solid ${alpha(BORDER, 0.5)}` },
                }}>
                  {/* Username */}
                  <TableCell sx={{ py: 1.2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography sx={{ color: T0, fontSize: '0.83rem', fontWeight: 500 }}>
                        {u.username}
                      </Typography>
                      {u.is_admin && (
                        <Chip label="ADMIN" size="small" sx={{
                          height: 16, fontSize: '0.58rem', fontWeight: 700,
                          letterSpacing: '0.08em',
                          background: alpha(G2, 0.15),
                          color: G3,
                          border: `1px solid ${alpha(G2, 0.3)}`,
                        }} />
                      )}
                    </Box>
                  </TableCell>

                  {/* Email */}
                  <TableCell>
                    <Typography sx={{ color: T1, fontSize: '0.8rem' }}>{u.email}</Typography>
                  </TableCell>

                  {/* Status */}
                  <TableCell>
                    {u.is_approved ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <CheckCircleOutlineIcon sx={{ fontSize: 13, color: SUCCESS }} />
                        <Typography sx={{ fontSize: '0.75rem', color: SUCCESS }}>Одобрен</Typography>
                      </Box>
                    ) : (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <PendingActionsIcon sx={{ fontSize: 13, color: '#F5B74F' }} />
                        <Typography sx={{ fontSize: '0.75rem', color: '#F5B74F' }}>Ожидает</Typography>
                      </Box>
                    )}
                  </TableCell>

                  {/* Date */}
                  <TableCell>
                    <Typography sx={{ color: T2, fontSize: '0.78rem' }}>{fmtDate(u.created_at)}</Typography>
                  </TableCell>

                  {/* Tier */}
                  <TableCell>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                      <Chip
                        label={TIER_LABELS[u.tier] ?? u.tier}
                        size="small"
                        sx={{
                          height: 18, fontSize: '0.62rem', fontWeight: 700,
                          letterSpacing: '0.04em', alignSelf: 'flex-start',
                          background: alpha(TIER_COLORS[u.tier] ?? T2, 0.15),
                          color: TIER_COLORS[u.tier] ?? T1,
                          border: `1px solid ${alpha(TIER_COLORS[u.tier] ?? T2, 0.35)}`,
                        }}
                      />
                      <Box sx={{ display: 'flex', gap: 0.4, alignItems: 'center' }}>
                        <Select
                          size="small"
                          value={tierSelect[u.id] ?? u.tier}
                          onChange={(e) => setTierSelect(prev => ({ ...prev, [u.id]: e.target.value as Tier }))}
                          sx={{ fontSize: '0.72rem', height: 26, minWidth: 110 }}
                        >
                          {TIER_OPTIONS.map(t => (
                            <MenuItem key={t} value={t} sx={{ fontSize: '0.75rem' }}>{TIER_LABELS[t]}</MenuItem>
                          ))}
                        </Select>
                        <Button
                          size="small"
                          disabled={tierActionLoading === u.id || (tierSelect[u.id] ?? u.tier) === u.tier}
                          onClick={() => applyTierChange(u.id, u.tier_expires_at)}
                          sx={{
                            minWidth: 0, fontSize: '0.62rem', fontFamily: '"Rajdhani", sans-serif',
                            fontWeight: 600, color: G3, border: `1px solid ${alpha(G2, 0.4)}`,
                            borderRadius: '5px', px: 0.8, py: 0.1, height: 26,
                            '&:hover': { background: alpha(G2, 0.1) },
                          }}
                        >
                          {tierActionLoading === u.id ? '...' : 'Сменить'}
                        </Button>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.4 }}>
                        {EXTEND_OPTIONS.map(({ delta, label }) => (
                          <Button
                            key={delta}
                            size="small"
                            disabled={tierActionLoading === u.id}
                            onClick={() => extendTier(u.id, delta)}
                            sx={{
                              minWidth: 0, fontSize: '0.62rem', fontFamily: '"Rajdhani", sans-serif',
                              fontWeight: 600, color: G2, border: `1px solid ${alpha(G2, 0.3)}`,
                              borderRadius: '5px', px: 0.8, py: 0.1, height: 20,
                              '&:hover': { background: alpha(G2, 0.08) },
                            }}
                          >
                            {label}
                          </Button>
                        ))}
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.4, alignItems: 'center' }}>
                        <input
                          type="date"
                          value={tierDate[u.id] ?? ''}
                          onChange={(e) => setTierDate(prev => ({ ...prev, [u.id]: e.target.value }))}
                          style={{
                            background: BG1, border: `1px solid ${BORDER}`, borderRadius: 5,
                            color: T1, fontSize: '0.68rem', padding: '2px 4px', height: 20,
                            colorScheme: 'dark',
                          }}
                        />
                        <Button
                          size="small"
                          disabled={tierActionLoading === u.id || !tierDate[u.id]}
                          onClick={() => applyExpiryDate(u.id, u.tier)}
                          sx={{
                            minWidth: 0, fontSize: '0.62rem', fontFamily: '"Rajdhani", sans-serif',
                            fontWeight: 600, color: G3, border: `1px solid ${alpha(G2, 0.4)}`,
                            borderRadius: '5px', px: 0.8, py: 0.1, height: 20,
                            '&:hover': { background: alpha(G2, 0.1) },
                          }}
                        >
                          {tierActionLoading === u.id ? '...' : 'Установить дату'}
                        </Button>
                        <Button
                          size="small"
                          disabled={tierActionLoading === u.id || !u.tier_expires_at}
                          onClick={() => clearExpiryDate(u.id, u.tier)}
                          sx={{
                            minWidth: 0, fontSize: '0.62rem', fontFamily: '"Rajdhani", sans-serif',
                            fontWeight: 600, color: T2, border: `1px solid ${BORDER}`,
                            borderRadius: '5px', px: 0.8, py: 0.1, height: 20,
                            '&:hover': { background: alpha(T2, 0.08) },
                          }}
                        >
                          Бессрочно
                        </Button>
                      </Box>
                    </Box>
                  </TableCell>

                  {/* Tier expires at */}
                  <TableCell>
                    <Typography sx={{ color: T2, fontSize: '0.78rem' }}>
                      {u.tier_expires_at ? fmtDate(u.tier_expires_at) : 'Бессрочно'}
                    </Typography>
                  </TableCell>

                  {/* Telegram */}
                  <TableCell>
                    <Typography sx={{ fontSize: '0.78rem', color: u.telegram_username ? T1 : T2 }}>
                      {u.telegram_username ? `@${u.telegram_username}` : '—'}
                    </Typography>
                  </TableCell>

                  {/* Last seen / online */}
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                      <Box sx={{
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: u.is_online ? SUCCESS : T2,
                        boxShadow: u.is_online ? `0 0 6px ${alpha(SUCCESS, 0.7)}` : 'none',
                      }} />
                      <Typography sx={{ fontSize: '0.75rem', color: u.is_online ? SUCCESS : T2 }}>
                        {u.is_online ? 'Онлайн' : fmtRelative(u.last_seen)}
                      </Typography>
                    </Box>
                  </TableCell>

                  {/* Watchlist count + favorites limit override */}
                  <TableCell>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                      <Typography sx={{ color: T1, fontSize: '0.8rem' }}>
                        {u.watchlist_count} / {u.effective_watchlist_limit ?? '∞'}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 0.4, alignItems: 'center' }}>
                        <TextField
                          size="small"
                          type="number"
                          value={favOverrideInput[u.id] ?? (u.favorites_limit_override != null ? String(u.favorites_limit_override) : '')}
                          onChange={(e) => setFavOverrideInput(prev => ({ ...prev, [u.id]: e.target.value }))}
                          placeholder="лимит тарифа"
                          sx={{ width: 100 }}
                          slotProps={{ input: { sx: { fontSize: '0.72rem', height: 26 } } }}
                        />
                        <Button
                          size="small"
                          disabled={favOverrideLoading === u.id || !parseFavOverride(favOverrideInput[u.id] ?? '').valid}
                          onClick={() => applyFavoritesOverride(u.id)}
                          sx={{
                            minWidth: 0, fontSize: '0.62rem', fontFamily: '"Rajdhani", sans-serif',
                            fontWeight: 600, color: G3, border: `1px solid ${alpha(G2, 0.4)}`,
                            borderRadius: '5px', px: 0.8, py: 0.1, height: 26,
                            '&:hover': { background: alpha(G2, 0.1) },
                          }}
                        >
                          {favOverrideLoading === u.id ? '...' : 'Применить'}
                        </Button>
                      </Box>
                    </Box>
                  </TableCell>

                  {/* Радар рынка (аддон) */}
                  <TableCell>
                    <Switch
                      size="small"
                      checked={u.has_market_radar_addon}
                      disabled={marketRadarLoading === u.id}
                      onChange={() => toggleMarketRadar(u.id, !u.has_market_radar_addon)}
                      sx={{
                        '& .MuiSwitch-switchBase.Mui-checked': { color: G2 },
                        '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { background: alpha(G2, 0.5) },
                      }}
                    />
                  </TableCell>

                  {/* Action */}
                  <TableCell>
                    {u.is_approved ? (
                      <Button
                        size="small"
                        disabled={u.is_admin || actionLoading === u.id}
                        onClick={() => revoke(u.id)}
                        startIcon={<BlockIcon sx={{ fontSize: '13px !important' }} />}
                        sx={{
                          fontSize: '0.72rem', fontFamily: '"Rajdhani", sans-serif',
                          fontWeight: 600, letterSpacing: '0.04em',
                          color: u.is_admin ? T2 : DANGER,
                          border: `1px solid ${u.is_admin ? alpha(BORDER, 0.5) : alpha(DANGER, 0.3)}`,
                          borderRadius: '6px', px: 1.5, py: 0.3,
                          '&:hover': { background: alpha(DANGER, 0.08), border: `1px solid ${alpha(DANGER, 0.5)}` },
                          '&.Mui-disabled': { color: T2, border: `1px solid ${BORDER}` },
                        }}
                      >
                        {actionLoading === u.id ? '...' : 'Отозвать'}
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        disabled={actionLoading === u.id}
                        onClick={() => approve(u.id)}
                        startIcon={<CheckCircleOutlineIcon sx={{ fontSize: '13px !important' }} />}
                        sx={{
                          fontSize: '0.72rem', fontFamily: '"Rajdhani", sans-serif',
                          fontWeight: 600, letterSpacing: '0.04em',
                          color: SUCCESS,
                          border: `1px solid ${alpha(SUCCESS, 0.3)}`,
                          borderRadius: '6px', px: 1.5, py: 0.3,
                          '&:hover': { background: alpha(SUCCESS, 0.08), border: `1px solid ${alpha(SUCCESS, 0.5)}` },
                        }}
                      >
                        {actionLoading === u.id ? '...' : 'Одобрить'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>
    </Box>
  )
}
