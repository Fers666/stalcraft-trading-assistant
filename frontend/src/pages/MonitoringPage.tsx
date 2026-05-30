import { useEffect, useState } from 'react'
import {
  Box, Typography, Card, CardContent, Grid, Chip, CircularProgress,
  Button, IconButton, Tooltip, Divider, Alert,
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import api from '../api/client'

interface SellOption {
  label: 'fast' | 'normal' | 'premium'
  label_ru: string
  price_per_unit: number
  estimated_hours: number
  estimated_hours_display: string
  confidence: 'low' | 'medium' | 'high'
  data_points: number
}

interface MarketStats {
  avg_price_7d: number | null
  median_price_7d: number | null
  sales_volume_7d: number | null
  avg_sell_time_hours: number | null
  best_sell_hour: number | null
  best_sell_day: string | null
  sell_options: SellOption[] | null
}

interface WatchlistEntry {
  id: number
  item_id: string
  region: string
  is_active: boolean
  last_successful_check: string | null
  error_status: string | null
  tracked_batch_sizes: number[]
}

const fmt = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('ru-RU')

const confidenceColor = (c: string) =>
  ({ low: 'warning', medium: 'info', high: 'success' }[c] ?? 'default') as 'warning' | 'info' | 'success'

const sellOptionColor = (label: string) =>
  ({ fast: '#4caf84', normal: '#e8a020', premium: '#ef5350' }[label] ?? '#fff')

export default function MonitoringPage() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [stats, setStats]         = useState<Record<string, MarketStats>>({})
  const [loading, setLoading]     = useState(true)
  const [refreshing, setRefreshing] = useState<number | null>(null)

  const loadWatchlist = async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/watchlist/')
      setWatchlist(data)
      // Загружаем статистику параллельно для всех товаров
      const statsEntries = await Promise.all(
        data.map(async (entry: WatchlistEntry) => {
          try {
            const { data: s } = await api.get(`/monitoring/item/${entry.item_id}?region=${entry.region}`)
            return [entry.item_id, s]
          } catch {
            return [entry.item_id, null]
          }
        })
      )
      setStats(Object.fromEntries(statsEntries.filter(([, v]) => v !== null)))
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = async (entry: WatchlistEntry) => {
    setRefreshing(entry.id)
    try {
      await api.post(`/watchlist/${entry.id}/refresh`)
      setTimeout(loadWatchlist, 3000) // подождать сбор
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      alert(msg || 'Ошибка обновления')
    } finally {
      setRefreshing(null)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить из watchlist?')) return
    await api.delete(`/watchlist/${id}`)
    setWatchlist((prev) => prev.filter((e) => e.id !== id))
  }

  useEffect(() => { loadWatchlist() }, [])

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  if (watchlist.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Watchlist пуст</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Добавьте товары в разделе «Каталог»
        </Typography>
      </Box>
    )
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Мониторинг</Typography>
        <Button startIcon={<RefreshIcon />} onClick={loadWatchlist} size="small">
          Обновить всё
        </Button>
      </Box>

      <Grid container spacing={2}>
        {watchlist.map((entry) => {
          const s = stats[entry.item_id]
          return (
            <Grid item xs={12} md={6} xl={4} key={entry.id}>
              <Card>
                <CardContent>
                  {/* Заголовок */}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5 }}>
                    <Box>
                      <Typography variant="subtitle1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                        {entry.item_id}
                      </Typography>
                      <Chip label={entry.region} size="small" variant="outlined" sx={{ mt: 0.5 }} />
                    </Box>
                    <Box>
                      <Tooltip title="Обновить данные">
                        <IconButton size="small" onClick={() => handleRefresh(entry)} disabled={refreshing === entry.id}>
                          {refreshing === entry.id ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Удалить">
                        <IconButton size="small" onClick={() => handleDelete(entry.id)} sx={{ color: 'error.main' }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>

                  {entry.error_status && (
                    <Alert severity="error" sx={{ mb: 1.5, py: 0 }}>{entry.error_status}</Alert>
                  )}

                  {/* Рыночная статистика */}
                  {s ? (
                    <>
                      <Grid container spacing={1} sx={{ mb: 1.5 }}>
                        <Grid item xs={6}>
                          <Typography variant="caption" color="text.secondary">Медиана 7д</Typography>
                          <Typography variant="body2" fontWeight={600}>{fmt(s.median_price_7d)} ₽</Typography>
                        </Grid>
                        <Grid item xs={6}>
                          <Typography variant="caption" color="text.secondary">Продаж 7д</Typography>
                          <Typography variant="body2" fontWeight={600}>{s.sales_volume_7d ?? '—'}</Typography>
                        </Grid>
                        {s.best_sell_hour != null && (
                          <Grid item xs={12}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <AccessTimeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                              <Typography variant="caption" color="text.secondary">
                                Лучшее время: {s.best_sell_hour}:00 · {s.best_sell_day}
                              </Typography>
                            </Box>
                          </Grid>
                        )}
                      </Grid>

                      {/* Варианты продажи */}
                      {s.sell_options && s.sell_options.length > 0 && (
                        <>
                          <Divider sx={{ my: 1.5 }} />
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                            <TrendingUpIcon sx={{ fontSize: 14, color: 'primary.main' }} />
                            <Typography variant="caption" color="text.secondary" fontWeight={600}>
                              Варианты продажи
                            </Typography>
                            <Chip
                              label={s.sell_options[0].confidence}
                              size="small"
                              color={confidenceColor(s.sell_options[0].confidence)}
                              sx={{ ml: 'auto', height: 18, fontSize: 10 }}
                            />
                          </Box>
                          <Box sx={{ display: 'flex', gap: 1 }}>
                            {s.sell_options.map((opt) => (
                              <Box
                                key={opt.label}
                                sx={{
                                  flex: 1,
                                  p: 1,
                                  borderRadius: 1,
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  textAlign: 'center',
                                }}
                              >
                                <Typography variant="caption" sx={{ color: sellOptionColor(opt.label), fontWeight: 600, display: 'block' }}>
                                  {opt.label_ru}
                                </Typography>
                                <Typography variant="body2" fontWeight={700} sx={{ my: 0.25 }}>
                                  {fmt(opt.price_per_unit)} ₽
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {opt.estimated_hours_display}
                                </Typography>
                              </Box>
                            ))}
                          </Box>
                        </>
                      )}
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Данных пока нет — подождите первый сбор
                    </Typography>
                  )}

                  {/* Время последнего обновления */}
                  {entry.last_successful_check && (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1.5 }}>
                      Обновлено: {new Date(entry.last_successful_check).toLocaleString('ru-RU')}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            </Grid>
          )
        })}
      </Grid>
    </Box>
  )
}
