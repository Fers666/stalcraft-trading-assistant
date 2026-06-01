import { useEffect, useState, useCallback } from 'react'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  IconButton, Tooltip, Divider, Alert, Avatar,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import api from '../api/client'
import { formatPrice, iconUrl } from '../utils/i18n'

import PriceChart from '../components/PriceChart'

interface SellOption {
  label: 'fast' | 'normal' | 'premium'
  label_ru: string
  price_per_unit: number        // цена выставления лота
  net_price_per_unit: number    // продавец получит (после 5% комиссии)
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
  best_buy_hour: number | null
  best_buy_day: string | null
  sell_hours_by_day: Record<string, number> | null
  buy_hours_by_day: Record<string, number> | null
  price_volatility_7d: number | null
  sell_options: SellOption[] | null
}

interface WatchlistEntry {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
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
  ({ fast: '#3ED598', normal: '#D9AF37', premium: '#F5B74F' }[label] ?? '#F5F5F5')

function volatilityRisk(v: number | null): keyof typeof RISK_LABELS {
  if (v == null) return 'low'
  if (v > 30) return 'high'
  if (v > 15) return 'medium'
  return 'low'
}

// Текущий день недели на английском (как в БД)
const TODAY_EN = new Date().toLocaleDateString('en-US', { weekday: 'long' })

interface LotItem {
  buyout_price: number
  amount: number
  hours_remaining: number | null
  is_expiring: boolean
}

function ItemCard({ entry, stats, onDelete }: {
  entry: WatchlistEntry
  stats: MarketStats | null
  onDelete: () => void
}) {
  const [timeMode, setTimeMode]   = useState<'week' | 'today'>('week')
  const [lotMode, setLotMode]     = useState<'current' | 'median'>('median')
  const [lots, setLots]           = useState<LotItem[]>([])
  const [lotsLoaded, setLotsLoaded] = useState(false)
  const risk = stats ? RISK_LABELS[volatilityRisk(stats.price_volatility_7d)] : null

  // Загружаем лоты при появлении stats
  useEffect(() => {
    if (!stats) return
    setLotsLoaded(false)
    api.get(`/lots/${entry.item_id}`, { params: { region: entry.region } })
      .then(({ data }) => { setLots(data.lots || []); setLotsLoaded(true) })
      .catch(() => { setLots([]); setLotsLoaded(true) })
  }, [entry.item_id, entry.region])

  const COMMISSION = 0.05

  // Ценовые ориентиры для двух режимов:
  // "Сейчас" — текущий рынок (sell_options уже посчитаны от current_min)
  // "Неделя" — исторический уровень (median_7d), находит просевшие лоты
  const sellPrices = (() => {
    if (!stats?.sell_options) return null
    if (lotMode === 'current') {
      return stats.sell_options.map(o => ({
        label: o.label, label_ru: o.label_ru,
        price: o.price_per_unit,
      }))
    }
    // Режим "Неделя": пересчитываем от медианы
    const m = stats.median_price_7d
    if (!m) return null
    return [
      { label: 'fast',    label_ru: 'Быстро',    price: Math.round(m * 0.97) },
      { label: 'normal',  label_ru: 'Нормально', price: Math.round(m * 1.00) },
      { label: 'premium', label_ru: 'Выгодно',   price: Math.round(m * 1.03) },
    ]
  })()

  // Выгодные лоты — те где прибыль по "Нормально" > 0
  const profitableLots = (() => {
    if (!sellPrices || lots.length === 0) return []
    const normalPrice = sellPrices.find(p => p.label === 'normal')?.price
    if (!normalPrice) return []

    return lots
      .filter(l => !l.is_expiring && l.buyout_price > 0)
      .map(l => {
        const buyPerUnit = Math.floor(l.buyout_price / l.amount)
        return {
          ...l,
          buyPerUnit,
          profits: sellPrices.map(sp => ({
            label:    sp.label,
            label_ru: sp.label_ru,
            perUnit:  Math.round(sp.price * (1 - COMMISSION) - buyPerUnit),
            total:    Math.round((sp.price * (1 - COMMISSION) - buyPerUnit) * l.amount),
          })),
        }
      })
      .filter(l => (l.profits.find(p => p.label === 'normal')?.perUnit ?? -1) > 0)
      .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
      .slice(0, 5)
  })()

  // Часы продажи/покупки в зависимости от режима
  const sellHour = timeMode === 'today'
    ? (stats?.sell_hours_by_day?.[TODAY_EN] ?? stats?.best_sell_hour)
    : stats?.best_sell_hour
  const buyHour = timeMode === 'today'
    ? (stats?.buy_hours_by_day?.[TODAY_EN] ?? stats?.best_buy_hour)
    : stats?.best_buy_hour
  const sellDay = timeMode === 'week' ? stats?.best_sell_day : null
  const buyDay  = timeMode === 'week' ? stats?.best_buy_day  : null

  return (
    <Card>
      {/* Золотая полоска сверху на активных карточках */}
      {!entry.error_status && (
        <Box sx={{
          height: 2,
          background: 'linear-gradient(90deg, #B78A2A 0%, #D9AF37 50%, #F2C94C 100%)',
          borderRadius: '18px 18px 0 0',
        }} />
      )}
      <CardContent>
        {entry.error_status && (
          <Alert severity="error" sx={{ mb: 1.5, py: 0 }}>{entry.error_status}</Alert>
        )}

        {/* Основная раскладка: левая колонка (инфо + статы) + правая (удалить + фото) */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>

          {/* Левая колонка */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {/* Название */}
            <Typography variant="subtitle1" fontWeight={700} noWrap>
              {entry.name_ru || entry.name_en || entry.item_id}
            </Typography>
            {/* ID — на этой же высоте начинается фото справа */}
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {entry.item_id}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, mb: 1.5 }}>
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

            {/* Статистика */}
            {stats && (
              <Grid2 container spacing={1}>
                <Grid2 size={{ xs: 6 }}>
                  <Typography variant="caption" color="text.secondary">Медиана 7д</Typography>
                  <Typography variant="body2" fontWeight={700} sx={{ color: 'primary.main' }}>
                    {formatPrice(stats.median_price_7d)}
                  </Typography>
                </Grid2>
                <Grid2 size={{ xs: 6 }}>
                  <Typography variant="caption" color="text.secondary">Продаж за 7д</Typography>
                  <Typography variant="body2" fontWeight={600}>{stats.sales_volume_7d ?? '—'}</Typography>
                </Grid2>
                {(sellHour != null || buyHour != null) && (
                  <Grid2 size={{ xs: 12 }}>
                    {/* Toggle неделя / сегодня */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
                      <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.08em', fontWeight: 600 }}>
                        ВРЕМЯ
                      </Typography>
                      <ToggleButtonGroup
                        value={timeMode}
                        exclusive
                        onChange={(_, v) => v && setTimeMode(v)}
                        size="small"
                      >
                        <ToggleButton value="week" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>
                          Неделя
                        </ToggleButton>
                        <ToggleButton value="today" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>
                          Сегодня
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </Box>

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      {sellHour != null && (
                        <Tooltip title="Лучший час выставить лот: высокая цена + активный рынок. Выставляй за 1–2 часа до этого момента.">
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'help' }}>
                            <AccessTimeIcon sx={{ fontSize: 13, color: 'secondary.main' }} />
                            <Typography variant="caption" sx={{ color: 'secondary.main' }}>
                              Продавать: {sellHour}:00
                              {sellDay && ` · ${DAYS_RU[sellDay] ?? sellDay}`}
                              {timeMode === 'today' && ` · ${DAYS_RU[TODAY_EN] ?? TODAY_EN}`}
                            </Typography>
                          </Box>
                        </Tooltip>
                      )}
                      {buyHour != null && (
                        <Tooltip title="Лучший час для покупки: исторически минимальные цены лотов.">
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'help' }}>
                            <AccessTimeIcon sx={{ fontSize: 13, color: 'info.main' }} />
                            <Typography variant="caption" sx={{ color: 'info.main' }}>
                              Покупать: {buyHour}:00
                              {buyDay && ` · ${DAYS_RU[buyDay] ?? buyDay}`}
                              {timeMode === 'today' && ` · ${DAYS_RU[TODAY_EN] ?? TODAY_EN}`}
                            </Typography>
                          </Box>
                        </Tooltip>
                      )}
                    </Box>
                  </Grid2>
                )}
              </Grid2>
            )}
          </Box>

          {/* Правая колонка: кнопка удалить (вверху) + фото (начинается на уровне ID) */}
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
            {/* Кнопка удалить — занимает высоту строки с названием */}
            <Tooltip title="Удалить из Избранного">
              <IconButton size="small" onClick={onDelete} sx={{ color: 'error.main', mb: 0.5 }}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {/* Фото — верхний край на уровне ID */}
            <Avatar
              src={iconUrl(entry.icon_path) ?? undefined}
              variant="rounded"
              sx={{
                width: 144, height: 144,
                bgcolor: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '12px',
              }}
            >
              {!entry.icon_path && (entry.name_ru?.[0] ?? '?')}
            </Avatar>
            {entry.last_successful_check && (
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem', mt: 0.5 }}>
                {new Date(entry.last_successful_check).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </Typography>
            )}
          </Box>
        </Box>

        {stats && (
          <Box>

            {/* Выгодные лоты для покупки */}
            {lotsLoaded && (
              <>
                <Divider sx={{ my: 1.5 }} />

                {/* Заголовок с toggle */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                  <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                    ВЫГОДНЫЕ ЛОТЫ
                  </Typography>
                  <Tooltip title={lotMode === 'median'
                    ? 'Прибыль если купить сейчас и продать по медиане за 7 дней. Находит лоты когда рынок просел.'
                    : 'Прибыль если купить сейчас и продать по текущим рыночным ценам.'
                  }>
                    {profitableLots.length > 0
                      ? <Chip label={`${profitableLots.length}`} size="small" color="success" sx={{ height: 18, fontSize: 10 }} />
                      : <Chip label="нет" size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.disabled' }} />
                    }
                  </Tooltip>
                  <ToggleButtonGroup
                    value={lotMode}
                    exclusive
                    onChange={(_, v) => v && setLotMode(v)}
                    size="small"
                    sx={{ ml: 'auto' }}
                  >
                    <ToggleButton value="median" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Неделя</ToggleButton>
                    <ToggleButton value="current" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Сейчас</ToggleButton>
                  </ToggleButtonGroup>
                </Box>

                {profitableLots.length === 0 ? (
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'center', py: 1 }}>
                    Нет выгодных лотов
                  </Typography>
                ) : (
                  <>
                    {/* Заголовок таблицы */}
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 0.5, mb: 0.5, px: 0.5 }}>
                      <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em' }}>ЦЕНА / ШТ</Typography>
                      {sellPrices!.map(sp => (
                        <Typography key={sp.label} sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em', textAlign: 'right' }}>
                          {sp.label_ru.toUpperCase()}
                        </Typography>
                      ))}
                    </Box>

                    {profitableLots.map((lot, i) => (
                      <Box key={i} sx={{
                        display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                        gap: 0.5, py: 0.5, px: 0.5,
                        borderRadius: '6px',
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
                      }}>
                        <Box>
                          <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.primary' }}>
                            {formatPrice(lot.buyPerUnit)}
                          </Typography>
                          {lot.amount > 1 && (
                            <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>
                              {lot.amount} шт · {formatPrice(lot.buyout_price)}
                            </Typography>
                          )}
                        </Box>
                        {lot.profits.map(p => (
                          <Box key={p.label} sx={{ textAlign: 'right' }}>
                            <Typography variant="caption" sx={{
                              fontWeight: 600,
                              color: p.perUnit > 0 ? 'success.main' : 'error.main',
                            }}>
                              {p.perUnit > 0 ? '+' : ''}{formatPrice(p.perUnit)}
                            </Typography>
                            {lot.amount > 1 && (
                              <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', display: 'block' }}>
                                итого {p.total > 0 ? '+' : ''}{formatPrice(p.total)}
                              </Typography>
                            )}
                          </Box>
                    ))}
                  </Box>
                ))}
              </>
            )}

            {/* Варианты продажи */}
            {stats.sell_options && stats.sell_options.length > 0 && (
              <>
                <Divider sx={{ my: 1.5 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                  <TrendingUpIcon sx={{ fontSize: 13, color: 'primary.main' }} />
                  <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                    ВАРИАНТЫ ПРОДАЖИ
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
                  {stats.sell_options.map((opt) => {
                    const c = sellOptionColor(opt.label)
                    return (
                      <Tooltip key={opt.label} title={SELL_OPTION_TOOLTIPS[opt.label]}>
                        <Box sx={{
                          flex: 1, p: 1.25,
                          borderRadius: '10px',
                          border: '1px solid rgba(255,255,255,0.06)',
                          background: 'rgba(255,255,255,0.02)',
                          textAlign: 'center',
                          cursor: 'help',
                          transition: 'border-color 0.2s',
                          '&:hover': { borderColor: `${c}44` },
                        }}>
                          <Typography sx={{ fontSize: '0.62rem', color: c, fontWeight: 700, display: 'block', letterSpacing: '0.06em', mb: 0.75 }}>
                            {opt.label_ru.toUpperCase()}
                          </Typography>
                          {/* Цена выставления */}
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mb: 0.25 }}>
                            выставить за
                          </Typography>
                          <Typography variant="body2" fontWeight={700} color="text.primary">
                            {formatPrice(opt.price_per_unit)}
                          </Typography>
                          {/* Чистая сумма после комиссии */}
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>
                            получишь
                          </Typography>
                          <Typography variant="body2" fontWeight={700} sx={{ color: c }}>
                            {formatPrice(opt.net_price_per_unit)}
                          </Typography>
                          {/* Прогноз времени */}
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                            {opt.estimated_hours_display}
                          </Typography>
                        </Box>
                      </Tooltip>
                    )
                  })}
                </Box>
              </>
            )}
          </Box>
        )}

        {/* График истории цен */}
        {stats && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <PriceChart itemId={entry.item_id} region={entry.region} />
          </>
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

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить из Избранного?')) return
    await api.delete(`/watchlist/${id}`)
    setWatchlist((prev) => prev.filter((e) => e.id !== id))
  }

  useEffect(() => { loadAll() }, [loadAll])

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600 }}>
            WATCHLIST
          </Typography>
          <Box sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: 'success.main', opacity: 0.8 }} />
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.1em' }}>
            AUTO-UPDATE 5 MIN
          </Typography>
        </Box>
        <Typography variant="h5" fontWeight={700}>Избранное</Typography>
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
                onDelete={() => handleDelete(entry.id)}
              />
            </Grid2>
          ))}
        </Grid2>
      )}
    </Box>
  )
}
