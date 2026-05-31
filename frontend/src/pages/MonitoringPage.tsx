import { useEffect, useState, useCallback } from 'react'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  Button, IconButton, Tooltip, Divider, Alert,
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import api from '../api/client'
import { formatPrice } from '../utils/i18n'
import { useRefreshCooldown } from '../hooks/useRefreshCooldown'
import PriceChart from '../components/PriceChart'

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
  price_volatility_7d: number | null
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

const DAYS_RU: Record<string, string> = {
  Monday: 'Пн', Tuesday: 'Вт', Wednesday: 'Ср', Thursday: 'Чт',
  Friday: 'Пт', Saturday: 'Сб', Sunday: 'Вс',
}

const RISK_LABELS: Record<string, { label: string; color: 'success' | 'warning' | 'error' }> = {
  low:    { label: 'Стабильный',     color: 'success' },
  medium: { label: 'Умеренный риск', color: 'warning' },
  high:   { label: 'Высокий риск',   color: 'error'   },
}

const CONFIDENCE_TOOLTIPS: Record<string, string> = {
  low:    'Мало данных — прогноз приблизительный. Точность растёт со временем.',
  medium: 'Данных достаточно для базового прогноза.',
  high:   'Много данных — прогноз надёжный.',
}

const SELL_OPTION_TOOLTIPS: Record<string, string> = {
  fast:    'Цена чуть ниже минимума на рынке. Продастся скорее, но заработаешь меньше.',
  normal:  'Рыночная цена. Баланс между скоростью и доходом.',
  premium: 'Цена выше медианы. Придётся подождать, зато заработаешь больше.',
}

const sellOptionColor = (label: string) =>
  ({ fast: '#4caf84', normal: '#e8a020', premium: '#ef5350' }[label] ?? '#fff')

function volatilityRisk(v: number | null): keyof typeof RISK_LABELS {
  if (v == null) return 'low'
  if (v > 30) return 'high'
  if (v > 15) return 'medium'
  return 'low'
}

function ItemCard({ entry, stats, onRefresh, onDelete }: {
  entry: WatchlistEntry
  stats: MarketStats | null
  onRefresh: () => void
  onDelete: () => void
}) {
  const { isCoolingDown, label: refreshLabel, startCooldown } = useRefreshCooldown(120)

  const handleRefreshClick = () => {
    if (isCoolingDown) return
    startCooldown()
    onRefresh()
  }

  const risk = stats ? RISK_LABELS[volatilityRisk(stats.price_volatility_7d)] : null

  return (
    <Card>
      <CardContent>
        {/* Заголовок */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5 }}>
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>{entry.item_id}</Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              <Chip label={entry.region} size="small" variant="outlined" />
              {risk && (
                <Tooltip title={`Волатильность цены за 7 дней. ${risk.label} = ${
                  risk.color === 'success' ? 'цена стабильна, риск минимален' :
                  risk.color === 'warning' ? 'умеренные колебания' :
                  'цена сильно скачет, прогноз ненадёжен'
                }`}>
                  <Chip label={risk.label} size="small" color={risk.color} variant="outlined" />
                </Tooltip>
              )}
            </Box>
          </Box>
          <Box>
            <Tooltip title={isCoolingDown
              ? 'Данные обновляются автоматически каждые 5 минут'
              : 'Запросить обновление прямо сейчас'
            }>
              <span>
                <Button
                  size="small"
                  startIcon={<RefreshIcon fontSize="small" />}
                  onClick={handleRefreshClick}
                  disabled={isCoolingDown}
                  sx={{ mr: 0.5, fontSize: 11, whiteSpace: 'nowrap' }}
                >
                  {refreshLabel}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Удалить из Избранного">
              <IconButton size="small" onClick={onDelete} sx={{ color: 'error.main' }}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {entry.error_status && (
          <Alert severity="error" sx={{ mb: 1.5, py: 0 }}>{entry.error_status}</Alert>
        )}

        {/* Рыночная статистика */}
        {stats ? (
          <>
            <Grid2 container spacing={1} sx={{ mb: 1.5 }}>
              <Grid2 size={{ xs: 6 }}>
                <Typography variant="caption" color="text.secondary">Медиана 7д</Typography>
                <Typography variant="body2" fontWeight={600}>{formatPrice(stats.median_price_7d)}</Typography>
              </Grid2>
              <Grid2 size={{ xs: 6 }}>
                <Typography variant="caption" color="text.secondary">Продаж за 7д</Typography>
                <Typography variant="body2" fontWeight={600}>{stats.sales_volume_7d ?? '—'}</Typography>
              </Grid2>
              {stats.best_sell_hour != null && (
                <Grid2 size={{ xs: 12 }}>
                  <Tooltip title="В этот час и день недели обычно больше всего покупок — выгоднее выставить лот заранее">
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'help' }}>
                      <AccessTimeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                      <Typography variant="caption" color="text.secondary">
                        Лучшее время: {stats.best_sell_hour}:00
                        {stats.best_sell_day && ` · ${DAYS_RU[stats.best_sell_day] ?? stats.best_sell_day}`}
                      </Typography>
                      <InfoOutlinedIcon sx={{ fontSize: 12, color: 'text.disabled' }} />
                    </Box>
                  </Tooltip>
                </Grid2>
              )}
            </Grid2>

            {/* Варианты продажи */}
            {stats.sell_options && stats.sell_options.length > 0 && (
              <>
                <Divider sx={{ my: 1.5 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                  <TrendingUpIcon sx={{ fontSize: 14, color: 'primary.main' }} />
                  <Typography variant="caption" color="text.secondary" fontWeight={600}>
                    Варианты продажи
                  </Typography>
                  <Tooltip title={CONFIDENCE_TOOLTIPS[stats.sell_options[0].confidence]}>
                    <Chip
                      label={{ low: 'Мало данных', medium: 'Средняя точность', high: 'Высокая точность' }[stats.sell_options[0].confidence]}
                      size="small"
                      color={{ low: 'warning', medium: 'info', high: 'success' }[stats.sell_options[0].confidence] as 'warning' | 'info' | 'success'}
                      sx={{ ml: 'auto', height: 18, fontSize: 10 }}
                    />
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  {stats.sell_options.map((opt) => (
                    <Tooltip key={opt.label} title={SELL_OPTION_TOOLTIPS[opt.label]}>
                      <Box
                        sx={{
                          flex: 1,
                          p: 1,
                          borderRadius: 1,
                          border: '1px solid',
                          borderColor: 'divider',
                          textAlign: 'center',
                          cursor: 'help',
                        }}
                      >
                        <Typography variant="caption" sx={{ color: sellOptionColor(opt.label), fontWeight: 600, display: 'block' }}>
                          {opt.label_ru}
                        </Typography>
                        <Typography variant="body2" fontWeight={700} sx={{ my: 0.25 }}>
                          {formatPrice(opt.price_per_unit)}
                        </Typography>
                        <Tooltip title="Прогноз: сколько обычно висит лот по такой цене до выкупа">
                          <Typography variant="caption" color="text.secondary" sx={{ cursor: 'help' }}>
                            {opt.estimated_hours_display}
                          </Typography>
                        </Tooltip>
                      </Box>
                    </Tooltip>
                  ))}
                </Box>
              </>
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Данных пока нет — первый сбор идёт автоматически каждые 5 мин
          </Typography>
        )}

        {/* График истории цен */}
        {stats && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <PriceChart itemId={entry.item_id} region={entry.region} />
          </>
        )}

        {entry.last_successful_check && (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1.5 }}>
            Обновлено: {new Date(entry.last_successful_check).toLocaleString('ru-RU')}
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}

export default function MonitoringPage() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [stats, setStats]         = useState<Record<string, MarketStats>>({})
  const [loading, setLoading]     = useState(true)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/watchlist/')
      setWatchlist(data)
      const pairs = await Promise.all(
        data.map(async (entry: WatchlistEntry) => {
          try {
            const { data: s } = await api.get(`/monitoring/item/${entry.item_id}?region=${entry.region}`)
            return [entry.item_id, s]
          } catch { return [entry.item_id, null] }
        })
      )
      setStats(Object.fromEntries(pairs.filter(([, v]) => v !== null)))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRefresh = async (entry: WatchlistEntry) => {
    try {
      await api.post(`/watchlist/${entry.id}/refresh`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (msg) alert(msg)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить из Избранного?')) return
    await api.delete(`/watchlist/${id}`)
    setWatchlist((prev) => prev.filter((e) => e.id !== id))
  }

  useEffect(() => { loadAll() }, [loadAll])

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Избранное</Typography>
          <Typography variant="caption" color="text.secondary">
            Данные обновляются автоматически каждые 5 минут
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} onClick={loadAll} size="small">Обновить список</Button>
      </Box>

      {watchlist.length === 0 ? (
        <Box sx={{ textAlign: 'center', mt: 8 }}>
          <Typography variant="h6" color="text.secondary">Избранное пусто</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Добавьте товары в разделе «Каталог»
          </Typography>
        </Box>
      ) : (
        <Grid2 container spacing={2}>
          {watchlist.map((entry) => (
            <Grid2 size={{ xs: 12, md: 6, xl: 4 }} key={entry.id}>
              <ItemCard
                entry={entry}
                stats={stats[entry.item_id] ?? null}
                onRefresh={() => handleRefresh(entry)}
                onDelete={() => handleDelete(entry.id)}
              />
            </Grid2>
          ))}
        </Grid2>
      )}
    </Box>
  )
}
