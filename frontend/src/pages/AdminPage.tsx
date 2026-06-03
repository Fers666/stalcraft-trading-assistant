import { useEffect, useState } from 'react'
import {
  Box, Typography, alpha, Chip, Button, Table, TableBody,
  TableCell, TableHead, TableRow, CircularProgress, Alert,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import BlockIcon from '@mui/icons-material/Block'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import api from '../api/client'

const G1 = '#B78A2A'
const G2 = '#D9AF37'
const G3 = '#F2C94C'
const BG1 = '#11151A'
const BG2 = '#1A1F26'
const T0 = '#F5F5F5'
const T1 = '#B8B8B8'
const T2 = '#7C7C7C'
const SUCCESS = '#3ED598'
const DANGER = '#FF5A5A'
const BORDER = 'rgba(255,255,255,0.08)'

interface AdminUser {
  id: number
  username: string
  email: string
  telegram_username: string | null
  is_admin: boolean
  is_approved: boolean
  is_active: boolean
  created_at: string | null
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

  useEffect(() => {
    if (user && !user.is_admin) {
      navigate('/app/monitoring', { replace: true })
    }
  }, [user, navigate])

  useEffect(() => {
    if (!user?.is_admin) return
    loadUsers()
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

  const filtered = users.filter(u => {
    if (filter === 'pending')  return !u.is_approved
    if (filter === 'approved') return u.is_approved
    return true
  })

  const pendingCount  = users.filter(u => !u.is_approved).length
  const approvedCount = users.filter(u => u.is_approved).length

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
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
                {['Пользователь', 'Email', 'Статус', 'Зарегистрирован', 'Действие'].map(h => (
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
