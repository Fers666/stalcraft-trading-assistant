import { useState, useMemo, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, Chip, CircularProgress,
  Tooltip, Divider, Avatar, ToggleButtonGroup, ToggleButton, IconButton, alpha,
} from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SearchIcon from '@mui/icons-material/Search'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import api from '../api/client'
import { formatPrice, formatLastUpdate, qualityColor, iconUrl } from '../utils/i18n'
import { tokens } from '../theme'

const COMMISSION = 0.05
const MAX_PROFITABLE_LOTS = 10

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
  low:    'Мало данных — прогноз приблизительный.',
  medium: 'Данных достаточно для базового прогноза.',
  high:   'Много данных — прогноз надёжный.',
}

const SELL_OPTION_TOOLTIPS: Record<string, string> = {
  fast:    'Цена чуть ниже минимума. Продастся скорее.',
  normal:  'Рыночная цена. Баланс между скоростью и доходом.',
  premium: 'Цена выше медианы. Придётся подождать.',
}

const sellOptionColor = (label: string) =>
  ({ fast: '#3ED598', normal: '#D9AF37', premium: '#F5B74F' }[label] ?? '#F5F5F5')

const SORT_DEFAULT_DIR: Record<string, 'asc' | 'desc'> = { price: 'asc', fast: 'desc', normal: 'desc', premium: 'desc' }

function volatilityRisk(v: number | null): keyof typeof RISK_LABELS | null {
  if (v == null) return null
  if (v > 30) return 'high'
  if (v > 15) return 'medium'
  return 'low'
}

const TODAY_EN = new Date().toLocaleDateString('en-US', { weekday: 'long' })

interface SellOption {
  label: 'fast' | 'normal' | 'premium'
  label_ru: string
  price_per_unit: number
  net_price_per_unit: number
  estimated_hours: number
  estimated_hours_display: string
  confidence: 'low' | 'medium' | 'high'
  data_points: number
}

interface MarketStats {
  avg_price_7d: number | null
  median_price_7d: number | null
  sales_volume_7d: number | null
  sales_volume_30d: number | null
  avg_sell_time_hours: number | null
  best_sell_hour: number | null
  best_sell_day: string | null
  best_buy_hour: number | null
  best_buy_day: string | null
  sell_hours_by_day: Record<string, number> | null
  buy_hours_by_day: Record<string, number> | null
  price_volatility_7d: number | null
  price_volatility_30d: number | null
  sell_options: SellOption[] | null
  batch_stats: {
    by_size: Record<string, { label: string; count: number; share_pct: number; avg_price_per_unit: number; median_price_per_unit: number }>
    median_amount: number
    bulk_discount_pct: number | null
    batch_ratio_pct: number
    most_popular_bucket: string
    total_analyzed: number
  } | null
  calculated_at: string | null
}

interface LotItem {
  buyout_price: number
  amount: number
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
}

interface SignalLot {
  start_time: string
  buyout_per_unit: number
  buyout_price: number
  amount: number
  quality_name: string | null
  enchant: number | null
}

interface SignalsData {
  lots: SignalLot[]
  sell_options: SellOption[] | null
  volume_7d: number | null
  volatility_7d: number | null
  computed_at: string | null
}

export interface LotStatCardProps {
  itemId: string
  region: string
  qualityFilter: number | null
  enchantFilter: number | null
  itemName: string
  iconPath?: string | null
  minProfitMarginPercent?: number
  fullWidth?: boolean
  onViewLots?: () => void
  onDelete?: () => void
}

export default function LotStatCard({
  itemId, region, qualityFilter, enchantFilter, itemName, iconPath, minProfitMarginPercent = 0, fullWidth = false,
  onViewLots, onDelete,
}: LotStatCardProps) {
  const [stats, setStats]     = useState<MarketStats | null>(null)
  const [lots, setLots]       = useState<LotItem[]>([])
  const [signals, setSignals] = useState<SignalsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [timeMode, setTimeMode] = useState<'week' | 'today'>('today')
  const [lotMode, setLotMode]   = useState<'current' | 'median'>('current')
  const [sortState, setSortState] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'price', dir: 'asc' })
  const [selectedLotIdx, setSelectedLotIdx] = useState(0)

  useEffect(() => {
    if (!itemId) return
    const params: Record<string, string | number> = { region }
    if (qualityFilter !== null) params.quality_filter = qualityFilter
    if (enchantFilter !== null) params.enchant_filter = enchantFilter

    const fetchData = () => Promise.all([
      api.get(`/monitoring/item/${itemId}`, { params }).catch(() => null),
      api.get(`/lots/${itemId}`, { params }).catch(() => null),
      api.get(`/monitoring/signals/${itemId}`, { params }).catch(() => null),
    ]).then(([statsRes, lotsRes, sigRes]) => {
      setStats(statsRes?.data ?? null)
      setLots(lotsRes?.data?.lots ?? [])
      setSignals(sigRes?.data ?? null)
      setLoading(false)
    })

    setLoading(true)
    fetchData()
    // Сигналы пересчитываются на бэкенде каждые ~20 сек — синхронизируемся с этим циклом.
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [itemId, region, qualityFilter, enchantFilter])

  const lastUpdated = signals?.computed_at ?? stats?.calculated_at ?? null

  const riskKey   = stats ? volatilityRisk(stats.price_volatility_7d)  : null
  const riskKey30 = stats ? volatilityRisk(stats.price_volatility_30d) : null
  const risk   = riskKey   ? RISK_LABELS[riskKey]   : null
  const risk30 = riskKey30 ? RISK_LABELS[riskKey30] : null

  const sellPrices = useMemo(() => {
    if (!stats?.sell_options) return null
    if (lotMode === 'current') {
      return stats.sell_options.map(o => ({ label: o.label, label_ru: o.label_ru, price: o.price_per_unit }))
    }
    const m = stats.median_price_7d
    if (!m) return null
    return [
      { label: 'fast',    label_ru: 'Быстро',    price: Math.round(m * 0.97) },
      { label: 'normal',  label_ru: 'Нормально', price: Math.round(m * 1.00) },
      { label: 'premium', label_ru: 'Выгодно',   price: Math.round(m * 1.03) },
    ]
  }, [stats?.sell_options, stats?.median_price_7d, lotMode])

  const profitableLots = useMemo(() => {
    if (signals?.lots?.length) {
      const opts = sellPrices ?? []
      return signals.lots
        .map(l => ({
          buyout_price: l.buyout_price,
          amount: l.amount,
          quality_name: l.quality_name,
          enchant_level: l.enchant ?? null,
          buyPerUnit: l.buyout_per_unit,
          profits: opts.map(sp => ({
            label: sp.label, label_ru: sp.label_ru,
            perUnit: Math.round(sp.price * (1 - COMMISSION) - l.buyout_per_unit),
            total: Math.round((sp.price * (1 - COMMISSION) - l.buyout_per_unit) * l.amount),
          })),
        }))
        .filter(l => {
          const normalProfit = l.profits.find(p => p.label === 'normal')?.perUnit ?? -1
          if (normalProfit <= 0) return false
          if (minProfitMarginPercent > 0) {
            const pct = (normalProfit / l.buyPerUnit) * 100
            if (pct < minProfitMarginPercent) return false
          }
          return true
        })
        .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
        .slice(0, MAX_PROFITABLE_LOTS)
    }
    if (!sellPrices || lots.length === 0) return []
    const normalPrice = sellPrices.find(p => p.label === 'normal')?.price
    if (!normalPrice) return []
    return lots
      .filter(l => {
        if (l.is_expiring || l.buyout_price <= 0) return false
        if (qualityFilter !== null && l.quality_name !== QLT_NAMES[qualityFilter]) return false
        if (enchantFilter !== null && l.enchant_level !== enchantFilter) return false
        return true
      })
      .map(l => {
        const buyPerUnit = Math.floor(l.buyout_price / l.amount)
        return {
          ...l, buyPerUnit,
          profits: sellPrices.map(sp => ({
            label: sp.label, label_ru: sp.label_ru,
            perUnit:  Math.round(sp.price * (1 - COMMISSION) - buyPerUnit),
            total:    Math.round((sp.price * (1 - COMMISSION) - buyPerUnit) * l.amount),
          })),
        }
      })
      .filter(l => {
        const normalProfit = l.profits.find(p => p.label === 'normal')?.perUnit ?? -1
        if (normalProfit <= 0) return false
        if (minProfitMarginPercent > 0) {
          const pct = (normalProfit / l.buyPerUnit) * 100
          if (pct < minProfitMarginPercent) return false
        }
        return true
      })
      .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
      .slice(0, MAX_PROFITABLE_LOTS)
  }, [signals, sellPrices, lots, qualityFilter, enchantFilter, minProfitMarginPercent])

  const totalFilteredLots = useMemo(() => lots.filter(l => {
    if (l.is_expiring) return false
    if (qualityFilter !== null && l.quality_name !== QLT_NAMES[qualityFilter]) return false
    if (enchantFilter !== null && l.enchant_level !== enchantFilter) return false
    return true
  }).length, [lots, qualityFilter, enchantFilter])

  // Сброс выбора базового лота при каждом обновлении данных (новые лоты раз в 30с)
  useEffect(() => {
    setSelectedLotIdx(0)
  }, [profitableLots])

  const displayLots = useMemo(() => {
    const arr = [...profitableLots]
    arr.sort((a, b) => {
      const av = sortState.col === 'price' ? a.buyPerUnit : (a.profits.find(p => p.label === sortState.col)?.perUnit ?? -Infinity)
      const bv = sortState.col === 'price' ? b.buyPerUnit : (b.profits.find(p => p.label === sortState.col)?.perUnit ?? -Infinity)
      return sortState.dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [profitableLots, sortState])

  const toggleSort = (col: string) => {
    setSortState(prev => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: SORT_DEFAULT_DIR[col] ?? 'desc' })
  }

  const hasQuality = profitableLots.some(l => l.quality_name || l.enchant_level != null)
  const firstLot = profitableLots[0]
  const singleQuality = hasQuality && profitableLots.every(l => l.quality_name === firstLot.quality_name && l.enchant_level === firstLot.enchant_level)
    ? { quality: firstLot.quality_name, enchant: firstLot.enchant_level }
    : null
  const showQualityColumn = hasQuality && !singleQuality
  const lotGridCols = showQualityColumn ? '1fr auto 86px 86px 86px' : '1fr 86px 86px 86px'
  const hasRight = !!((stats?.sell_options?.length ?? 0) > 0 || stats?.batch_stats)

  const sellHour = timeMode === 'today'
    ? (stats?.sell_hours_by_day?.[TODAY_EN] ?? stats?.best_sell_hour)
    : stats?.best_sell_hour
  const buyHour = timeMode === 'today'
    ? (stats?.buy_hours_by_day?.[TODAY_EN] ?? stats?.best_buy_hour)
    : stats?.best_buy_hour
  const sellDay = timeMode === 'week' ? stats?.best_sell_day : null
  const buyDay  = timeMode === 'week' ? stats?.best_buy_day  : null

  if (loading) return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300, width: fullWidth ? '100%' : 520 }}>
      <CircularProgress />
    </Box>
  )

  return (
    <Card sx={{ width: fullWidth ? '100%' : 520, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Золотая полоска */}
      <Box sx={{ height: 3, background: 'linear-gradient(90deg, #D9AF37 0%, #F5B74F 100%)', flexShrink: 0 }} />
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>

        {/* Хедер: иконка + имя + ключевые статы */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Avatar
            src={iconUrl(iconPath) ?? undefined}
            variant="rounded"
            sx={{ width: 64, height: 64, bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', flexShrink: 0 }}
          >
            {!iconPath && (itemName?.[0] ?? '?')}
          </Avatar>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>
              {itemName}
              {enchantFilter != null && enchantFilter > 0 && (
                <Typography component="span" sx={{ ml: 0.75, fontSize: '0.75rem', color: 'primary.main', fontWeight: 700 }}>
                  +{enchantFilter}
                </Typography>
              )}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
              <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', fontFamily: 'monospace' }}>
                {itemId}
              </Typography>
              <Chip label={region} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
              {qualityFilter !== null && (
                <Chip
                  label={QLT_NAMES[qualityFilter] ?? `qlt${qualityFilter}`}
                  size="small" variant="outlined"
                  sx={{
                    height: 18, fontSize: 10,
                    borderColor: qualityColor(QLT_NAMES[qualityFilter]) ?? 'primary.main',
                    color: qualityColor(QLT_NAMES[qualityFilter]) ?? 'primary.main',
                  }}
                />
              )}
              {risk && (
                <Tooltip title={`7д: ${stats?.price_volatility_7d?.toFixed(1)}%`}>
                  <Chip
                    label={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: `${risk.color}.main`, flexShrink: 0 }} />
                        {`7д: ${risk.label}`}
                      </Box>
                    }
                    size="small" color={risk.color} sx={{ height: 18, fontSize: 10 }}
                  />
                </Tooltip>
              )}
              {risk30 && (
                <Tooltip title={`30д: ${stats?.price_volatility_30d?.toFixed(1)}%`}>
                  <Chip
                    label={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: `${risk30.color}.main`, flexShrink: 0 }} />
                        {`30д: ${risk30.label}`}
                      </Box>
                    }
                    size="small" color={risk30.color} variant="outlined" sx={{ height: 18, fontSize: 10 }}
                  />
                </Tooltip>
              )}
            </Box>
          </Box>

          {stats?.median_price_7d != null && (
            <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>МЕДИАНА 7Д</Typography>
              <Typography sx={{ fontSize: '1.05rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatPrice(stats.median_price_7d)}</Typography>
            </Box>
          )}

          {(onViewLots || onDelete) && (
            <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
              {onViewLots && (
                <Tooltip title="Все лоты этого предмета">
                  <IconButton size="small" onClick={onViewLots} sx={{ color: 'text.secondary' }}>
                    <SearchIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {onDelete && (
                <Tooltip title="Удалить из Избранного">
                  <IconButton size="small" onClick={onDelete} sx={{ color: 'error.main' }}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )}
        </Box>

        {/* Статус-бар: продажи за 7д, лучшее время, обновление */}
        {(stats || lastUpdated) && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mt: 1, pt: 1, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            {stats?.sales_volume_7d != null && (
              <Box>
                <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>ПРОДАЖ 7Д</Typography>
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 700 }}>{stats.sales_volume_7d}</Typography>
              </Box>
            )}

            {stats && (sellHour != null || buyHour != null) && (
              <>
                <ToggleButtonGroup value={timeMode} exclusive onChange={(_, v) => v && setTimeMode(v)} size="small">
                  <ToggleButton value="today" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Сегодня</ToggleButton>
                  <ToggleButton value="week"  sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Неделя</ToggleButton>
                </ToggleButtonGroup>
                {sellHour != null && (
                  <Tooltip title="Лучшее время выставлять лот">
                    <Chip label={`▲ ${sellHour}:00${sellDay ? ` · ${DAYS_RU[sellDay] ?? sellDay}` : ''}`} size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: 10 }} />
                  </Tooltip>
                )}
                {buyHour != null && (
                  <Tooltip title="Лучшее время покупать">
                    <Chip label={`▼ ${buyHour}:00${buyDay ? ` · ${DAYS_RU[buyDay] ?? buyDay}` : ''}`} size="small" color="info" variant="outlined" sx={{ height: 20, fontSize: 10 }} />
                  </Tooltip>
                )}
              </>
            )}

            {lastUpdated && (
              <Tooltip title={`Данные обновлены: ${new Date(lastUpdated).toLocaleString('ru-RU')}`}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3, ml: 'auto', cursor: 'help' }}>
                  <AccessTimeIcon sx={{ fontSize: 10, color: 'text.disabled' }} />
                  <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', whiteSpace: 'nowrap' }}>
                    {formatLastUpdate(lastUpdated)}
                  </Typography>
                </Box>
              </Tooltip>
            )}
          </Box>
        )}

        {/* Выгодные лоты / Варианты продажи / Пачки */}
        {stats && (
          <Box>
            <Divider sx={{ my: 1.5 }} />
            <Box sx={{ display: 'grid', gridTemplateColumns: fullWidth && hasRight ? '1.6fr 1fr' : '1fr', gap: 2 }}>

              {/* Выгодные лоты */}
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                  <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                    ВЫГОДНЫЕ ЛОТЫ
                  </Typography>
                  {profitableLots.length > 0
                    ? <Chip label={`${profitableLots.length} / ${totalFilteredLots}`} size="small" color="success" sx={{ height: 18, fontSize: 10 }} />
                    : <Chip label={`нет / ${totalFilteredLots}`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.disabled' }} />
                  }
                  {singleQuality && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      {singleQuality.quality && <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary' }}>{singleQuality.quality}</Typography>}
                      {singleQuality.enchant != null && (
                        <Typography sx={{ fontSize: '0.6rem', color: singleQuality.enchant === 0 ? 'text.disabled' : 'primary.main', fontWeight: 600 }}>
                          {singleQuality.enchant === 0 ? 'Не точёный' : `+${singleQuality.enchant}`}
                        </Typography>
                      )}
                    </Box>
                  )}
                  <ToggleButtonGroup value={lotMode} exclusive onChange={(_, v) => v && setLotMode(v)} size="small" sx={{ ml: 'auto' }}>
                    <ToggleButton value="median"  sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Неделя</ToggleButton>
                    <ToggleButton value="current" sx={{ py: 0, px: 1, fontSize: '0.6rem', height: 20 }}>Сейчас</ToggleButton>
                  </ToggleButtonGroup>
                </Box>

                {profitableLots.length === 0 ? (
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'center', py: 1 }}>
                    Нет выгодных лотов
                  </Typography>
                ) : (
                  <>
                    <Box sx={{ display: 'grid', gridTemplateColumns: lotGridCols, gap: 0.5, mb: 0.5, px: 0.5, py: 0.4, borderRadius: '6px', bgcolor: tokens.bg1 }}>
                      <Typography
                        onClick={() => toggleSort('price')}
                        sx={{
                          fontSize: '0.58rem', letterSpacing: '0.06em', cursor: 'pointer', userSelect: 'none',
                          display: 'flex', alignItems: 'center', gap: 0.4,
                          color: sortState.col === 'price' ? tokens.goldAccent : 'text.disabled',
                          fontWeight: sortState.col === 'price' ? 700 : 400,
                        }}
                      >
                        ЦЕНА / ШТ{sortState.col === 'price' && (sortState.dir === 'asc' ? ' ▲' : ' ▼')}
                      </Typography>
                      {showQualityColumn && <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em', textAlign: 'right' }}>КАЧЕСТВО</Typography>}
                      {sellPrices?.map(sp => {
                        const active = sortState.col === sp.label
                        return (
                          <Typography
                            key={sp.label}
                            onClick={() => toggleSort(sp.label)}
                            sx={{
                              fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.06em', textAlign: 'right', cursor: 'pointer', userSelect: 'none',
                              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.4,
                              color: active ? tokens.goldAccent : sellOptionColor(sp.label),
                            }}
                          >
                            {sp.label_ru.toUpperCase()}{active && (sortState.dir === 'asc' ? ' ▲' : ' ▼')}
                          </Typography>
                        )
                      })}
                    </Box>
                    {displayLots.map((lot, i) => {
                      const isSelected = profitableLots[selectedLotIdx] === lot
                      return (
                        <Box
                          key={i}
                          onClick={() => setSelectedLotIdx(profitableLots.indexOf(lot))}
                          sx={{
                            display: 'grid', gridTemplateColumns: lotGridCols, gap: 0.5, py: 0.5, px: 0.5, borderRadius: '6px',
                            cursor: 'pointer',
                            borderLeft: '3px solid',
                            borderLeftColor: isSelected ? tokens.gold : 'transparent',
                            bgcolor: isSelected ? alpha(tokens.gold, 0.08) : 'transparent',
                            '&:hover': { bgcolor: isSelected ? alpha(tokens.gold, 0.08) : alpha(tokens.gold, 0.04) },
                          }}
                        >
                          <Box>
                            <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.primary' }}>{formatPrice(lot.buyPerUnit)}</Typography>
                            {lot.amount > 1 && <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>{lot.amount} шт · {formatPrice(lot.buyout_price)}</Typography>}
                          </Box>
                          {showQualityColumn && (
                            <Box sx={{ textAlign: 'right', alignSelf: 'center' }}>
                              {lot.quality_name && <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary', lineHeight: 1.3 }}>{lot.quality_name}</Typography>}
                              {lot.enchant_level != null && (
                                <Typography sx={{ fontSize: '0.6rem', color: lot.enchant_level === 0 ? 'text.disabled' : 'primary.main', fontWeight: 600, lineHeight: 1.3 }}>
                                  {lot.enchant_level === 0 ? 'Не точёный' : `+${lot.enchant_level}`}
                                </Typography>
                              )}
                            </Box>
                          )}
                          {lot.profits.map(p => (
                            <Box key={p.label} sx={{ textAlign: 'right' }}>
                              <Typography variant="caption" sx={{ fontWeight: 600, color: p.perUnit > 0 ? 'success.main' : 'error.main' }}>
                                {p.perUnit > 0 ? '+' : ''}{formatPrice(p.perUnit)}
                              </Typography>
                              {lot.amount > 1 && <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', display: 'block' }}>итого {p.total > 0 ? '+' : ''}{formatPrice(p.total)}</Typography>}
                            </Box>
                          ))}
                        </Box>
                      )
                    })}
                  </>
                )}
              </Box>

              {/* Варианты продажи + Пачки */}
              {hasRight && (
                <Box sx={fullWidth ? { borderLeft: '1px solid rgba(255,255,255,0.06)', pl: 2 } : {}}>
                  {!fullWidth && <Divider sx={{ mb: 1.5 }} />}

                  {stats.sell_options && stats.sell_options.length > 0 && (
                    <Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                        <TrendingUpIcon sx={{ fontSize: 13, color: 'primary.main' }} />
                        <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>ВАРИАНТЫ ПРОДАЖИ</Typography>
                        <Tooltip title={CONFIDENCE_TOOLTIPS[stats.sell_options[0].confidence]}>
                          <Chip
                            label={{ low: 'Мало данных', medium: 'Средняя точность', high: 'Высокая точность' }[stats.sell_options[0].confidence]}
                            size="small"
                            color={{ low: 'warning', medium: 'info', high: 'success' }[stats.sell_options[0].confidence] as 'warning' | 'info' | 'success'}
                            sx={{ ml: 'auto', height: 18, fontSize: 10 }}
                          />
                        </Tooltip>
                      </Box>
                      {(() => {
                        const cheapestBuy = lots
                          .filter(l => !l.is_expiring && l.buyout_price > 0)
                          .filter(l => qualityFilter === null || l.quality_name === QLT_NAMES[qualityFilter])
                          .filter(l => enchantFilter === null || l.enchant_level === enchantFilter)
                          .reduce<number | null>((min, l) => {
                            const p = Math.floor(l.buyout_price / l.amount)
                            return min === null || p < min ? p : min
                          }, null)
                        const baseBuy = profitableLots[selectedLotIdx]?.buyPerUnit ?? cheapestBuy
                        const optionCols = `repeat(${stats.sell_options!.length}, 86px)`
                        return (
                          <Box sx={{ display: 'grid', gridTemplateColumns: `1fr ${optionCols}`, gap: 0.5, alignItems: 'center' }}>
                            <Box />
                            {stats.sell_options!.map(opt => (
                              <Tooltip key={opt.label} title={SELL_OPTION_TOOLTIPS[opt.label]}>
                                <Typography sx={{ fontSize: '0.58rem', color: sellOptionColor(opt.label), fontWeight: 700, letterSpacing: '0.06em', textAlign: 'right', cursor: 'help' }}>
                                  {opt.label_ru.toUpperCase()}
                                </Typography>
                              </Tooltip>
                            ))}

                            <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Выставить за</Typography>
                            {stats.sell_options!.map(opt => (
                              <Typography key={opt.label} variant="body2" fontWeight={700} sx={{ textAlign: 'right' }}>
                                {formatPrice(opt.price_per_unit)}
                              </Typography>
                            ))}

                            <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Получишь (−5%)</Typography>
                            {stats.sell_options!.map(opt => (
                              <Typography key={opt.label} variant="body2" fontWeight={700} sx={{ textAlign: 'right', color: sellOptionColor(opt.label) }}>
                                {formatPrice(opt.net_price_per_unit)}
                              </Typography>
                            ))}

                            {baseBuy !== null && (
                              <>
                                <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Прибыль</Typography>
                                {stats.sell_options!.map(opt => {
                                  const profit = opt.net_price_per_unit - baseBuy
                                  const isProfitable = profit > 0
                                  return (
                                    <Typography key={opt.label} sx={{ fontSize: '0.8rem', fontWeight: 700, textAlign: 'right', color: isProfitable ? 'success.main' : 'error.main' }}>
                                      {isProfitable ? '+' : ''}{formatPrice(profit)}
                                    </Typography>
                                  )
                                })}
                              </>
                            )}

                            <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled' }}>Срок</Typography>
                            {stats.sell_options!.map(opt => (
                              <Typography key={opt.label} variant="caption" sx={{ textAlign: 'right', color: 'text.secondary' }}>
                                {opt.estimated_hours_display}
                              </Typography>
                            ))}
                          </Box>
                        )
                      })()}
                    </Box>
                  )}

                  {/* Пачки */}
                  {stats.batch_stats && (
                    <>
                      <Divider sx={{ my: 1.5 }} />
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                        <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>ПАЧКИ</Typography>
                        <Chip label={`${stats.batch_stats.batch_ratio_pct}% сделок`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.secondary' }} />
                        <Chip label={`~${stats.batch_stats.median_amount} шт`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'primary.main', borderColor: 'primary.main' }} />
                      </Box>
                      {Object.entries(stats.batch_stats.by_size).map(([key, bucket]) => {
                        const isPopular = key === stats.batch_stats!.most_popular_bucket
                        return (
                          <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                            <Typography sx={{ fontSize: '0.6rem', color: isPopular ? 'primary.main' : 'text.secondary', minWidth: 52, fontWeight: isPopular ? 700 : 400 }}>{bucket.label}</Typography>
                            <Box sx={{ flex: 1, height: 4, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
                              <Box sx={{
                                width: `${bucket.share_pct}%`, height: '100%', borderRadius: 2, transition: 'width 0.3s',
                                background: isPopular ? `linear-gradient(90deg, ${tokens.goldSoft}, ${tokens.gold}, ${tokens.goldAccent})` : 'rgba(255,255,255,0.18)',
                              }} />
                            </Box>
                            <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', minWidth: 28, textAlign: 'right' }}>{bucket.share_pct}%</Typography>
                            <Typography sx={{ fontSize: '0.6rem', color: 'text.primary', minWidth: 68, textAlign: 'right', fontFamily: 'monospace', fontWeight: isPopular ? 600 : 400 }}>{formatPrice(bucket.avg_price_per_unit)}/шт</Typography>
                          </Box>
                        )
                      })}
                      {stats.batch_stats.bulk_discount_pct !== null && (
                        <Typography sx={{ fontSize: '0.62rem', mt: 0.75, color: stats.batch_stats.bulk_discount_pct > 0 ? 'success.main' : 'warning.main' }}>
                          {stats.batch_stats.bulk_discount_pct > 0
                            ? `Оптом дешевле на ${stats.batch_stats.bulk_discount_pct}% — выгоднее покупать пачкой`
                            : `Оптом дороже на ${Math.abs(stats.batch_stats.bulk_discount_pct)}% — выгоднее покупать поштучно`}
                        </Typography>
                      )}
                    </>
                  )}
                </Box>
              )}

            </Box>
          </Box>
        )}

        {!stats && lots.length > 0 && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="caption" color="text.disabled">Нет данных о продажах за последние 30 дней</Typography>
          </>
        )}

      </CardContent>
    </Card>
  )
}
