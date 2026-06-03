import { useEffect, useState, useCallback } from 'react'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  IconButton, Tooltip, Divider, Alert, Avatar,
  ToggleButtonGroup, ToggleButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Button,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
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
  quality_filter: number | null
  enchant_filter: number | null
  is_active: boolean
  last_successful_check: string | null
  error_status: string | null
  tracked_batch_sizes: number[]
}

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
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

function formatLastCheck(iso: string): string {
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + time
}

interface LotItem {
  buyout_price: number
  amount: number
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
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

  // Загружаем лоты независимо от наличия stats
  useEffect(() => {
    setLotsLoaded(false)
    const params: Record<string, string | number> = { region: entry.region }
    if (entry.quality_filter !== null) params.quality_filter = entry.quality_filter
    if (entry.enchant_filter !== null) params.enchant_filter = entry.enchant_filter
    api.get(`/lots/${entry.item_id}`, { params })
      .then(({ data }) => { setLots(data.lots || []); setLotsLoaded(true) })
      .catch(() => { setLots([]); setLotsLoaded(true) })
  }, [entry.item_id, entry.region, entry.quality_filter, entry.enchant_filter])

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
      .filter(l => {
        if (l.is_expiring || l.buyout_price <= 0) return false
        if (entry.quality_filter !== null && l.quality_name !== QLT_NAMES[entry.quality_filter]) return false
        if (entry.enchant_filter !== null && l.enchant_level !== entry.enchant_filter) return false
        return true
      })
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

  const hasQuality = profitableLots.some(l => l.quality_name || l.enchant_level)
  const lotGridCols = hasQuality ? '1fr auto auto auto auto' : '1fr auto auto auto'

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
    <Card sx={{
      width: 440,
      height: 900,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Золотая полоска сверху на активных карточках */}
      {!entry.error_status && (
        <Box sx={{
          flexShrink: 0,
          height: 2,
          background: 'linear-gradient(90deg, #B78A2A 0%, #D9AF37 50%, #F2C94C 100%)',
          borderRadius: '18px 18px 0 0',
        }} />
      )}
      <CardContent sx={{
        flex: 1,
        overflowY: 'auto',
        '&::-webkit-scrollbar': { width: '3px' },
        '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.08)', borderRadius: '2px' },
      }}>
        {entry.error_status && (
          <Alert severity="error" sx={{ mb: 1.5, py: 0 }}>{entry.error_status}</Alert>
        )}

        {/* Основная раскладка: левая колонка (инфо + статы) + правая (удалить + фото) */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>

          {/* Левая колонка */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {/* Название + заточка */}
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
              <Typography variant="subtitle1" fontWeight={700} noWrap>
                {entry.name_ru || entry.name_en || entry.item_id}
              </Typography>
              {entry.enchant_filter !== null && (
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: 'primary.main', flexShrink: 0 }}>
                  +{entry.enchant_filter}
                </Typography>
              )}
            </Box>
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
            {/* Кнопка удалить + время обновления */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
              {entry.last_successful_check && (
                <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', whiteSpace: 'nowrap' }}>
                  {formatLastCheck(entry.last_successful_check)}
                </Typography>
              )}
              <Tooltip title="Удалить из Избранного">
                <IconButton size="small" onClick={onDelete} sx={{ color: 'error.main' }}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
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
            {/* Качество под иконкой */}
            {entry.quality_filter !== null && (
              <Typography sx={{
                fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.04em',
                color: 'primary.main', textAlign: 'center', mt: 0.5,
              }}>
                {QLT_NAMES[entry.quality_filter] ?? `qlt${entry.quality_filter}`}
              </Typography>
            )}
          </Box>
        </Box>

        {!stats && lotsLoaded && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'center', py: 0.5 }}>
              Статистика рассчитывается — обновится автоматически через ~1 мин
            </Typography>
          </>
        )}

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
                    <Box sx={{ display: 'grid', gridTemplateColumns: lotGridCols, gap: 0.5, mb: 0.5, px: 0.5 }}>
                      <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em' }}>ЦЕНА / ШТ</Typography>
                      {hasQuality && (
                        <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em', textAlign: 'right' }}>КАЧЕСТВО</Typography>
                      )}
                      {sellPrices!.map(sp => (
                        <Typography key={sp.label} sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em', textAlign: 'right' }}>
                          {sp.label_ru.toUpperCase()}
                        </Typography>
                      ))}
                    </Box>

                    {profitableLots.map((lot, i) => (
                      <Box key={i} sx={{
                        display: 'grid', gridTemplateColumns: lotGridCols,
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
                        {hasQuality && (
                          <Box sx={{ textAlign: 'right', alignSelf: 'center' }}>
                            {lot.quality_name && (
                              <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary', lineHeight: 1.3 }}>
                                {lot.quality_name}
                              </Typography>
                            )}
                            {lot.enchant_level && (
                              <Typography sx={{ fontSize: '0.6rem', color: 'primary.main', fontWeight: 600, lineHeight: 1.3 }}>
                                +{lot.enchant_level}
                              </Typography>
                            )}
                          </Box>
                        )}
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

        {/* График истории цен — показываем всегда (данные есть после первого сбора) */}
        <>
          <Divider sx={{ my: 1.5 }} />
          <PriceChart
            itemId={entry.item_id}
            region={entry.region}
            qualityFilter={entry.quality_filter}
            enchantFilter={entry.enchant_filter}
          />
        </>

      </CardContent>
    </Card>
  )
}

export default function MonitoringPage() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [stats, setStats]         = useState<Record<number, MarketStats>>({})
  const [loading, setLoading]     = useState(true)
  const [deleteEntry, setDeleteEntry] = useState<WatchlistEntry | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/watchlist/')
      setWatchlist(data)
      const pairs = await Promise.all(
        data.map(async (entry: WatchlistEntry) => {
          try {
            const params: Record<string, string> = { region: entry.region }
            if (entry.quality_filter !== null) params.quality_filter = String(entry.quality_filter)
            if (entry.enchant_filter !== null) params.enchant_filter = String(entry.enchant_filter)
            const { data: s } = await api.get(`/monitoring/item/${entry.item_id}`, { params })
            return [entry.id, s]
          } catch { return [entry.id, null] }
        })
      )
      setStats(Object.fromEntries(pairs.filter(([, v]) => v !== null)))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDeleteConfirm = async () => {
    if (!deleteEntry) return
    await api.delete(`/watchlist/${deleteEntry.id}`)
    setWatchlist((prev) => prev.filter((e) => e.id !== deleteEntry.id))
    setDeleteEntry(null)
  }

  useEffect(() => {
    loadAll()
    const interval = setInterval(loadAll, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loadAll])

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
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {watchlist.map((entry) => (
            <ItemCard
              key={entry.id}
              entry={entry}
              stats={stats[entry.id] ?? null}
              onDelete={() => setDeleteEntry(entry)}
            />
          ))}
        </Box>
      )}

      <Dialog
        open={!!deleteEntry}
        onClose={() => setDeleteEntry(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Typography fontWeight={700}>Удалить из Избранного?</Typography>
          <Typography variant="caption" color="text.secondary">
            {deleteEntry?.name_ru || deleteEntry?.item_id}
            {deleteEntry?.quality_filter != null ? ` · кач. ${deleteEntry.quality_filter}` : ''}
            {deleteEntry?.enchant_filter != null ? ` · +${deleteEntry.enchant_filter}` : ''}
            {deleteEntry ? ` · ${deleteEntry.region}` : ''}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Typography variant="body2" color="text.secondary">
            Карточка будет удалена из мониторинга. Вы сможете добавить её снова из Каталога.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteEntry(null)} color="inherit">Отмена</Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteConfirm}
          >
            Удалить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
