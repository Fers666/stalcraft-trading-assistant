import { useState, useMemo, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, Chip, CircularProgress,
  Tooltip, Divider, Avatar, ToggleButtonGroup, ToggleButton, IconButton,
} from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SearchIcon from '@mui/icons-material/Search'
import DeleteIcon from '@mui/icons-material/Delete'
import api from '../api/client'
import { formatPrice, iconUrl } from '../utils/i18n'

const COMMISSION = 0.05

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

const qualityColor = (quality: string | null): string | null => {
  if (!quality) return null
  const colors: Record<string, string> = {
    'Обычный': '#555', 'Необычный': '#4caf50', 'Особый': '#2196f3',
    'Ветеран': '#9c27b0', 'Мастер': '#ff9800', 'Легендарный': '#f44336',
  }
  return colors[quality] ?? null
}

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

  useEffect(() => {
    if (!itemId) return
    setLoading(true)
    const params: Record<string, string | number> = { region }
    if (qualityFilter !== null) params.quality_filter = qualityFilter
    if (enchantFilter !== null) params.enchant_filter = enchantFilter

    Promise.all([
      api.get(`/monitoring/item/${itemId}`, { params }).catch(() => null),
      api.get(`/lots/${itemId}`, { params }).catch(() => null),
      api.get(`/monitoring/signals/${itemId}`, { params }).catch(() => null),
    ]).then(([statsRes, lotsRes, sigRes]) => {
      setStats(statsRes?.data ?? null)
      setLots(lotsRes?.data?.lots ?? [])
      setSignals(sigRes?.data ?? null)
      setLoading(false)
    })
  }, [itemId, region, qualityFilter, enchantFilter])

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
        .slice(0, 5)
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
      .slice(0, 5)
  }, [signals, sellPrices, lots, qualityFilter, enchantFilter, minProfitMarginPercent])

  const totalFilteredLots = useMemo(() => lots.filter(l => {
    if (l.is_expiring) return false
    if (qualityFilter !== null && l.quality_name !== QLT_NAMES[qualityFilter]) return false
    if (enchantFilter !== null && l.enchant_level !== enchantFilter) return false
    return true
  }).length, [lots, qualityFilter, enchantFilter])

  const hasQuality = profitableLots.some(l => l.quality_name || l.enchant_level != null)
  const lotGridCols = hasQuality ? '1fr auto 86px 86px 86px' : '1fr 86px 86px 86px'

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

        {/* Хедер: имя + статы + иконка */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>
              {itemName}
              {enchantFilter != null && enchantFilter > 0 && (
                <Typography component="span" sx={{ ml: 0.75, fontSize: '0.75rem', color: 'primary.main', fontWeight: 700 }}>
                  +{enchantFilter}
                </Typography>
              )}
            </Typography>
            <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', fontFamily: 'monospace', mb: 0.5 }}>
              {itemId}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 0.75 }}>
              <Chip label={region} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
              {risk && (
                <Tooltip title={`7д: ${stats?.price_volatility_7d?.toFixed(1)}%`}>
                  <Chip label={`7д: ${risk.label}`} size="small" color={risk.color} sx={{ height: 18, fontSize: 10 }} />
                </Tooltip>
              )}
              {risk30 && (
                <Tooltip title={`30д: ${stats?.price_volatility_30d?.toFixed(1)}%`}>
                  <Chip label={`30д: ${risk30.label}`} size="small" color={risk30.color} variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                </Tooltip>
              )}
            </Box>

            {stats && (
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 0.5 }}>
                {stats.median_price_7d != null && (
                  <Box>
                    <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>МЕДИАНА 7Д</Typography>
                    <Typography sx={{ fontSize: '0.82rem', fontWeight: 700 }}>{formatPrice(stats.median_price_7d)}</Typography>
                  </Box>
                )}
                {stats.sales_volume_7d != null && (
                  <Box>
                    <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>ПРОДАЖ 7Д</Typography>
                    <Typography sx={{ fontSize: '0.82rem', fontWeight: 700 }}>{stats.sales_volume_7d}</Typography>
                  </Box>
                )}
              </Box>
            )}

            {/* Время продажи/покупки */}
            {stats && (sellHour != null || buyHour != null) && (
              <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
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
              </Box>
            )}
          </Box>

          {/* Иконка + качество */}
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            {(onViewLots || onDelete) && (
              <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5 }}>
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
            <Avatar
              src={iconUrl(iconPath) ?? undefined}
              variant="rounded"
              sx={{ width: 88, height: 88, bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px' }}
            >
              {!iconPath && (itemName?.[0] ?? '?')}
            </Avatar>
            {qualityFilter !== null && (
              <Chip
                label={QLT_NAMES[qualityFilter] ?? `qlt${qualityFilter}`}
                size="small" variant="outlined"
                sx={{
                  fontSize: '0.6rem', height: 16, mt: 0.5,
                  borderColor: qualityColor(QLT_NAMES[qualityFilter]) ?? 'primary.main',
                  color: qualityColor(QLT_NAMES[qualityFilter]) ?? 'primary.main',
                }}
              />
            )}
          </Box>
        </Box>

        {/* Выгодные лоты */}
        {stats && (
          <Box>
            <>
              <Divider sx={{ my: 1.5 }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                  ВЫГОДНЫЕ ЛОТЫ
                </Typography>
                {profitableLots.length > 0
                  ? <Chip label={`${profitableLots.length} / ${totalFilteredLots}`} size="small" color="success" sx={{ height: 18, fontSize: 10 }} />
                  : <Chip label={`нет / ${totalFilteredLots}`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.disabled' }} />
                }
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
                  <Box sx={{ display: 'grid', gridTemplateColumns: lotGridCols, gap: 0.5, mb: 0.5, px: 0.5 }}>
                    <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em' }}>ЦЕНА / ШТ</Typography>
                    {hasQuality && <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', letterSpacing: '0.06em', textAlign: 'right' }}>КАЧЕСТВО</Typography>}
                    {sellPrices?.map(sp => (
                      <Typography key={sp.label} sx={{ fontSize: '0.58rem', color: sellOptionColor(sp.label), fontWeight: 700, letterSpacing: '0.06em', textAlign: 'right' }}>
                        {sp.label_ru.toUpperCase()}
                      </Typography>
                    ))}
                  </Box>
                  {profitableLots.map((lot, i) => (
                    <Box key={i} sx={{ display: 'grid', gridTemplateColumns: lotGridCols, gap: 0.5, py: 0.5, px: 0.5, borderRadius: '6px', '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' } }}>
                      <Box>
                        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.primary' }}>{formatPrice(lot.buyPerUnit)}</Typography>
                        {lot.amount > 1 && <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>{lot.amount} шт · {formatPrice(lot.buyout_price)}</Typography>}
                      </Box>
                      {hasQuality && (
                        <Box sx={{ textAlign: 'right', alignSelf: 'center' }}>
                          {lot.quality_name && <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary', lineHeight: 1.3 }}>{lot.quality_name}</Typography>}
                          {lot.enchant_level != null && <Typography sx={{ fontSize: '0.6rem', color: 'primary.main', fontWeight: 600, lineHeight: 1.3 }}>{lot.enchant_level === 0 ? 'Не точёный' : `+${lot.enchant_level}`}</Typography>}
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
                  ))}
                </>
              )}
            </>

            {/* Варианты продажи */}
            {stats.sell_options && stats.sell_options.length > 0 && (
              <>
                <Divider sx={{ my: 1.5 }} />
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
                  return (
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      {stats.sell_options!.map((opt) => {
                        const c = sellOptionColor(opt.label)
                        const profitFromCheapest = cheapestBuy !== null ? opt.net_price_per_unit - cheapestBuy : null
                        const isProfitable = profitFromCheapest !== null && profitFromCheapest > 0
                        return (
                          <Tooltip key={opt.label} title={`${SELL_OPTION_TOOLTIPS[opt.label]} Купи до ${formatPrice(opt.net_price_per_unit)} чтобы выйти в плюс (−5%).`}>
                            <Box sx={{
                              flex: 1, p: 1.25, borderRadius: '10px', textAlign: 'center', cursor: 'help',
                              border: profitFromCheapest !== null
                                ? `1px solid ${isProfitable ? 'rgba(62,213,152,0.3)' : 'rgba(235,87,87,0.25)'}`
                                : '1px solid rgba(255,255,255,0.06)',
                              background: profitFromCheapest !== null
                                ? isProfitable ? 'rgba(62,213,152,0.04)' : 'rgba(235,87,87,0.03)'
                                : 'rgba(255,255,255,0.02)',
                              '&:hover': { borderColor: `${c}44` },
                            }}>
                              <Typography sx={{ fontSize: '0.62rem', color: c, fontWeight: 700, letterSpacing: '0.06em', mb: 0.75 }}>{opt.label_ru.toUpperCase()}</Typography>
                              <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mb: 0.25 }}>выставить за</Typography>
                              <Typography variant="body2" fontWeight={700} color="text.primary">{formatPrice(opt.price_per_unit)}</Typography>
                              <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>получишь (−5%)</Typography>
                              <Typography variant="body2" fontWeight={700} sx={{ color: c }}>{formatPrice(opt.net_price_per_unit)}</Typography>
                              {profitFromCheapest !== null ? (
                                <>
                                  <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>прибыль</Typography>
                                  <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: isProfitable ? 'success.main' : 'error.main' }}>
                                    {isProfitable ? '+' : ''}{formatPrice(profitFromCheapest)}
                                  </Typography>
                                </>
                              ) : (
                                <>
                                  <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>купи до</Typography>
                                  <Typography sx={{ fontSize: '0.62rem', fontWeight: 600, color: 'text.secondary' }}>{formatPrice(opt.net_price_per_unit - 1)}</Typography>
                                </>
                              )}
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>{opt.estimated_hours_display}</Typography>
                            </Box>
                          </Tooltip>
                        )
                      })}
                    </Box>
                  )
                })()}
              </>
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
                        <Box sx={{ width: `${bucket.share_pct}%`, height: '100%', borderRadius: 2, bgcolor: isPopular ? 'primary.main' : 'rgba(255,255,255,0.18)', transition: 'width 0.3s' }} />
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
