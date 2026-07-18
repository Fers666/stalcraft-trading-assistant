import { useState, useMemo, useEffect } from 'react'
import {
  Box, Typography, Card, Chip, Skeleton, Tooltip, IconButton,
  ToggleButtonGroup, ToggleButton, Table, TableHead, TableBody, TableRow, TableCell,
} from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SearchIcon from '@mui/icons-material/Search'
import DeleteIcon from '@mui/icons-material/Delete'
import api from '../api/client'
import { formatLastUpdate, qualityColor, iconUrl } from '../utils/i18n'
import { fmtN, fmtP } from '../utils/format'
import { tokens, fs } from '../theme'
import { useAuthStore } from '../store/authStore'
import Kick from './ui/Kick'
import LockIcon from './ui/LockIcon'
import ItemIcon from './ui/ItemIcon'
import StatusLine, { type StatusMetric } from './ui/StatusLine'
import SortHeader from './ui/SortHeader'
import SalesHistoryCharts from './SalesHistoryCharts'

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

const RISK_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'error' }> = {
  low:    { label: 'низкий риск',    tone: 'success' },
  medium: { label: 'умеренный риск', tone: 'warning' },
  high:   { label: 'высокий риск',   tone: 'error'   },
}

const RISK_TONE: Record<'success' | 'warning' | 'error', { color: string; dim: string; line: string }> = {
  success: { color: tokens.success, dim: tokens.successDim, line: tokens.successLine },
  warning: { color: tokens.warning, dim: tokens.warningDim, line: tokens.warningLine },
  error:   { color: tokens.danger,  dim: tokens.dangerDim,  line: tokens.dangerLine  },
}

const SELL_OPTION_TOOLTIPS: Record<string, string> = {
  fast:    'Цена чуть ниже минимума. Продастся скорее.',
  normal:  'Рыночная цена. Баланс между скоростью и доходом.',
  premium: 'Цена выше медианы. Придётся подождать.',
}

// цвет названия стратегии в карточке .sell (прототип favorites.html: .sell.f/.n/.p .name)
const sellOptionNameColor = (label: string) =>
  ({ fast: tokens.text1, normal: tokens.goldAccent, premium: tokens.goldHighlight }[label] ?? tokens.text0)

const CONF_LABELS: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' }

const SORT_DEFAULT_DIR: Record<string, 'asc' | 'desc'> = { price: 'asc', fast: 'desc', normal: 'desc', premium: 'desc' }

function volatilityRisk(v: number | null): keyof typeof RISK_LABELS | null {
  if (v == null) return null
  if (v > 30) return 'high'
  if (v > 15) return 'medium'
  return 'low'
}

const TODAY_EN = new Date().toLocaleDateString('en-US', { weekday: 'long' })

// .sec-h h2 — единый заголовок компартмент-ячейки (Rajdhani, uppercase, ls .14em)
const SEC_H_SX = {
  m: 0, fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f12,
  letterSpacing: '0.14em', textTransform: 'uppercase', color: tokens.text1,
} as const

// содержимое каждой .cell компартмент-сетки .grid-2 (непрозрачный bg1 → 1px-щели)
const CELL_SX = { background: tokens.bg1, p: '12px 16px 16px', minWidth: 0 } as const

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

  const statsWindows = useAuthStore(s => s.user?.stats_windows)
  const sellOptionsLocked = !statsWindows?.includes('7d')
  const risk30Locked = !statsWindows?.includes('30d')

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

  const cheapestBuy = lots
    .filter(l => !l.is_expiring && l.buyout_price > 0)
    .filter(l => qualityFilter === null || l.quality_name === QLT_NAMES[qualityFilter])
    .filter(l => enchantFilter === null || l.enchant_level === enchantFilter)
    .reduce<number | null>((min, l) => {
      const p = Math.floor(l.buyout_price / l.amount)
      return min === null || p < min ? p : min
    }, null)
  const baseBuy = profitableLots[selectedLotIdx]?.buyPerUnit ?? cheapestBuy

  const sellHour = timeMode === 'today'
    ? (stats?.sell_hours_by_day?.[TODAY_EN] ?? stats?.best_sell_hour)
    : stats?.best_sell_hour
  const buyHour = timeMode === 'today'
    ? (stats?.buy_hours_by_day?.[TODAY_EN] ?? stats?.best_buy_hour)
    : stats?.best_buy_hour
  const sellDay = timeMode === 'week' ? stats?.best_sell_day : null
  const buyDay  = timeMode === 'week' ? stats?.best_buy_day  : null

  const qColor = qualityFilter !== null ? (qualityColor(QLT_NAMES[qualityFilter]) ?? tokens.gold) : tokens.gold

  const statusMetrics = useMemo<StatusMetric[]>(() => {
    if (!stats) return []
    const m: StatusMetric[] = []
    if (stats.sales_volume_7d != null) m.push({ label: 'Продаж 7д', value: fmtN(stats.sales_volume_7d), unit: 'шт' })
    m.push({ label: 'Лотов на рынке', value: fmtN(totalFilteredLots) })
    if (sellHour != null) m.push({ label: 'Продавать', value: `${sellDay ? `${DAYS_RU[sellDay] ?? sellDay} ` : ''}${String(sellHour).padStart(2, '0')}:00`, tone: 'g' })
    if (buyHour != null) m.push({ label: 'Покупать', value: `${buyDay ? `${DAYS_RU[buyDay] ?? buyDay} ` : ''}${String(buyHour).padStart(2, '0')}:00`, tone: 'a' })
    if (stats.avg_sell_time_hours != null) m.push({ label: 'Ср. время продажи', value: `~${(Math.round(stats.avg_sell_time_hours * 10) / 10).toLocaleString('ru-RU')}`, unit: 'ч' })
    const upd = formatLastUpdate(lastUpdated)
    if (upd) m.push({ label: 'Обновлено', value: upd })
    return m
  }, [stats, totalFilteredLots, sellHour, buyHour, sellDay, buyDay, lastUpdated])

  if (loading) return (
    <Card sx={{ width: fullWidth ? '100%' : 520 }}>
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Skeleton variant="rectangular" height={72} sx={{ bgcolor: tokens.bg2 }} />
        <Skeleton variant="rectangular" height={52} sx={{ bgcolor: tokens.bg2 }} />
        <Skeleton variant="rectangular" height={200} sx={{ bgcolor: tokens.bg2 }} />
      </Box>
    </Card>
  )

  return (
    <Card sx={{ width: fullWidth ? '100%' : 520, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Шапка .pg-h ─────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, p: '14px 18px 12px' }}>
        <ItemIcon src={iconUrl(iconPath) ?? undefined} name={itemName} size={56} sx={{ mt: '2px' }} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Kick>Избранное · {region}</Kick>
          <Typography
            component="h1"
            noWrap
            sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}
          >
            {itemName}
            {enchantFilter != null && enchantFilter > 0 && (
              <Box component="span" className="mono" sx={{ ml: 1, fontSize: fs.f16, color: tokens.goldAccent, fontWeight: 700 }}>
                +{enchantFilter}
              </Box>
            )}
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1, flexWrap: 'wrap' }}>
            <Box component="span" className="mono" sx={{ fontSize: fs.f11, color: tokens.text2, border: `1px solid ${tokens.border}`, px: 0.75, py: '1px', borderRadius: `${tokens.radiusLg / 2}px` }}>
              {itemId}
            </Box>
            {qualityFilter !== null && (
              <Chip label={QLT_NAMES[qualityFilter] ?? `кач. ${qualityFilter}`} size="small" variant="outlined"
                sx={{ height: 20, fontSize: fs.f11, borderColor: qColor, color: qColor }} />
            )}
            {risk && (
              <Tooltip title={`7д: ${stats?.price_volatility_7d?.toFixed(1)}%`}>
                <Box className="mono" sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 20, px: 1, borderRadius: `${tokens.radiusLg / 2}px`, cursor: 'help',
                  color: RISK_TONE[risk.tone].color, background: RISK_TONE[risk.tone].dim, border: `1px solid ${RISK_TONE[risk.tone].line}`, fontSize: fs.f11,
                }}>
                  <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f10, letterSpacing: '0.1em' }}>7Д</Box>
                  {risk.label}
                </Box>
              </Tooltip>
            )}
            {risk30Locked ? (
              <Tooltip title="Доступно на тарифе Макс">
                <Box className="mono" sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.6, height: 20, px: 1, borderRadius: `${tokens.radiusLg / 2}px`, cursor: 'not-allowed',
                  color: tokens.text2, border: `1px solid ${tokens.border}`, fontSize: fs.f11,
                }}>
                  <LockIcon size={11} />
                  30Д
                </Box>
              </Tooltip>
            ) : risk30 && (
              <Tooltip title={`30д: ${stats?.price_volatility_30d?.toFixed(1)}%`}>
                <Box className="mono" sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 20, px: 1, borderRadius: `${tokens.radiusLg / 2}px`, cursor: 'help',
                  color: RISK_TONE[risk30.tone].color, background: RISK_TONE[risk30.tone].dim, border: `1px solid ${RISK_TONE[risk30.tone].line}`, fontSize: fs.f11,
                }}>
                  <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f10, letterSpacing: '0.1em' }}>30Д</Box>
                  {risk30.label}
                </Box>
              </Tooltip>
            )}
          </Box>
        </Box>

        {/* Правая колонка: действия + медиана (единственный goldHighlight-пик) */}
        <Box sx={{ flex: 'none', textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
          {(onViewLots || onDelete) && (
            <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5 }}>
              {onViewLots && (
                <Tooltip title="Все лоты этого предмета">
                  <IconButton size="small" onClick={onViewLots} aria-label="Все лоты этого предмета">
                    <SearchIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {onDelete && (
                <Tooltip title="Убрать из Избранного">
                  <IconButton size="small" onClick={onDelete} aria-label="Убрать из Избранного" sx={{ '&:hover': { color: tokens.danger, borderColor: tokens.dangerLine } }}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )}
          {stats?.median_price_7d != null && (
            <>
              <Kick>Медиана 7Д</Kick>
              <Box className="mono" sx={{ fontSize: fs.f28, fontWeight: 700, lineHeight: 1.05, color: tokens.goldHighlight, textShadow: `0 0 22px ${tokens.goldGlow}`, whiteSpace: 'nowrap' }}>
                {fmtP(stats.median_price_7d)}
              </Box>
            </>
          )}
        </Box>
      </Box>

      {/* переключатель окна лучшего времени */}
      {stats && (sellHour != null || buyHour != null) && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: '18px', pb: '8px' }}>
          <ToggleButtonGroup value={timeMode} exclusive size="small" onChange={(_, v) => v && setTimeMode(v)}>
            <ToggleButton value="today" sx={{ py: 0.2, px: 1.2 }}>Сегодня</ToggleButton>
            <ToggleButton value="week"  sx={{ py: 0.2, px: 1.2 }}>Неделя</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {/* ── StatusLine ──────────────────────────────────────────── */}
      {statusMetrics.length > 0 && <StatusLine metrics={statusMetrics} />}

      {/* ── Компартмент-сетка .grid-2: 4 ячейки 2×2 ─────────────────
           [①Выгодные лоты | ②Динамика цен] / [③Варианты продажи | ④Пачки]
           1px-щели: контейнер bg=border, ячейки — непрозрачный bg1 */}
      {stats && (
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: fullWidth ? { xs: '1fr', md: 'minmax(0,1.15fr) minmax(0,1fr)' } : '1fr',
          gap: '1px', background: tokens.border, borderTop: `1px solid ${tokens.border}`,
        }}>

          {/* ── ① Выгодные лоты ──────────────────────────────────── */}
          <Box sx={CELL_SX}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: 24, mb: '10px' }}>
              <Box component="h2" sx={SEC_H_SX}>Выгодные лоты</Box>
              <Box component="span" className="mono" sx={{
                fontSize: fs.f11, color: profitableLots.length ? tokens.success : tokens.text2,
                background: profitableLots.length ? tokens.successDim : 'transparent',
                border: `1px solid ${profitableLots.length ? tokens.successLine : tokens.border}`,
                px: 0.875, py: '1px', borderRadius: `${tokens.radiusLg / 2}px`,
              }}>
                {profitableLots.length} / {totalFilteredLots}
              </Box>
              <Box component="span" sx={{ ml: 'auto' }}>
                <ToggleButtonGroup value={lotMode} exclusive onChange={(_, v) => v && setLotMode(v)} size="small">
                  <ToggleButton value="current" sx={{ py: 0.2, px: 1 }}>Сейчас</ToggleButton>
                  <ToggleButton value="median"  sx={{ py: 0.2, px: 1 }}>Неделя</ToggleButton>
                </ToggleButtonGroup>
              </Box>
            </Box>

            {singleQuality && (
              <Typography sx={{ fontSize: fs.f12, color: tokens.text1, mb: 1 }}>
                Фильтр качества:{' '}
                <Box component="span" sx={{ fontWeight: 700, color: tokens.text0 }}>
                  {singleQuality.quality}
                  {singleQuality.enchant != null && (
                    <Box component="span" sx={{ fontWeight: 700, color: singleQuality.enchant === 0 ? tokens.text2 : tokens.goldAccent }}>
                      {' · '}{singleQuality.enchant === 0 ? 'не точёный' : `+${singleQuality.enchant}`}
                    </Box>
                  )}
                </Box>
              </Typography>
            )}

            {profitableLots.length === 0 ? (
              <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>
                Нет выгодных лотов
              </Box>
            ) : (
              <>
                <Table size="small" aria-label="Выгодные лоты">
                  <TableHead>
                    <TableRow>
                      <SortHeader label="Цена / шт" align="left" active={sortState.col === 'price'} direction={sortState.dir} onSort={() => toggleSort('price')} />
                      <TableCell component="th" sx={{ textAlign: 'right' }}>Кол-во</TableCell>
                      <TableCell component="th" sx={{ textAlign: 'right' }}>Заточка</TableCell>
                      {sellPrices?.map(sp => (
                        <SortHeader key={sp.label} label={sp.label_ru} active={sortState.col === sp.label} direction={sortState.dir} onSort={() => toggleSort(sp.label)} />
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {displayLots.map((lot, i) => {
                      const isSelected = profitableLots[selectedLotIdx] === lot
                      return (
                        <TableRow
                          key={i}
                          hover
                          selected={isSelected}
                          aria-selected={isSelected}
                          onClick={() => setSelectedLotIdx(profitableLots.indexOf(lot))}
                          sx={{ cursor: 'pointer' }}
                        >
                          <TableCell sx={{ textAlign: 'left' }}>
                            {fmtP(lot.buyPerUnit)}
                            {lot.amount > 1 && (
                              <Box component="span" sx={{ display: 'block', color: tokens.text2, fontSize: fs.f11 }}>
                                выкуп {fmtP(lot.buyout_price)}
                              </Box>
                            )}
                          </TableCell>
                          <TableCell className="mono" sx={{ textAlign: 'right', color: tokens.text1 }}>{fmtN(lot.amount)}</TableCell>
                          <TableCell sx={{ textAlign: 'right' }}>
                            {lot.enchant_level != null && lot.enchant_level > 0 ? (
                              <Box component="span" className="mono" sx={{ color: tokens.goldAccent, fontWeight: 600 }}>+{lot.enchant_level}</Box>
                            ) : (
                              <Box component="span" sx={{ color: tokens.text2 }}>—</Box>
                            )}
                          </TableCell>
                          {lot.profits.map(p => (
                            <TableCell key={p.label} sx={{ color: p.perUnit > 0 ? tokens.success : tokens.danger }}>
                              {p.perUnit > 0 ? '+' : '−'}{fmtP(Math.abs(p.perUnit))}
                              {lot.amount > 1 && (
                                <Box component="span" sx={{ display: 'block', color: tokens.text2, fontSize: fs.f11 }}>
                                  итого {p.total > 0 ? '+' : '−'}{fmtP(Math.abs(p.total))}
                                </Box>
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                {profitableLots.length > 1 && (
                  <Typography sx={{ fontSize: fs.f11, color: tokens.text2, mt: 1 }}>
                    ↳ Кликни строку — «Варианты продажи» пересчитаются от её цены покупки.
                  </Typography>
                )}
              </>
            )}
          </Box>

          {/* ── ② Динамика цен (графики + табы окон) ──────────────── */}
          <Box sx={CELL_SX}>
            <SalesHistoryCharts
              itemId={itemId}
              region={region}
              qualityFilter={qualityFilter}
              enchantFilter={enchantFilter}
              median={stats.median_price_7d ?? undefined}
            />
          </Box>

          {/* ── ③ Варианты продажи ───────────────────────────────── */}
          <Box sx={CELL_SX}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 24, mb: 1 }}>
              <TrendingUpIcon sx={{ fontSize: 14, color: tokens.gold }} />
              <Box component="h2" sx={SEC_H_SX}>Варианты продажи</Box>
            </Box>

            {sellOptionsLocked ? (
              <Tooltip title="Доступно на тарифах Продвинутая+ и выше">
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 2, color: tokens.text2, cursor: 'not-allowed' }}>
                  <LockIcon size={16} />
                  <Typography sx={{ fontSize: fs.f12, color: tokens.text2 }}>Недоступно на тарифе</Typography>
                </Box>
              </Tooltip>
            ) : stats.sell_options && stats.sell_options.length > 0 ? (
              <>
                {baseBuy !== null && (
                  <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mb: 1 }}>
                    Расчёт для лота{' '}
                    <Box component="span" className="mono" sx={{ fontWeight: 700, color: tokens.goldAccent }}>
                      {fmtP(baseBuy)}
                    </Box>
                  </Typography>
                )}
                {/* .sellgrid — 3 равные колонки, 1px-щели через border-контейнер (прототип favorites.html) */}
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1px', background: tokens.border, border: `1px solid ${tokens.border}` }}>
                  {stats.sell_options.map(opt => {
                    const profit = baseBuy !== null ? opt.net_price_per_unit - baseBuy : null
                    const isProfitable = profit !== null && profit > 0
                    const ddSx = { m: 0, fontSize: fs.f125, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: tokens.text0, whiteSpace: 'nowrap' } as const
                    const dtSx = { fontSize: fs.f11, color: tokens.text2, whiteSpace: 'nowrap' } as const
                    return (
                      <Box key={opt.label} sx={{ background: tokens.bg2, p: '10px 14px 12px' }}>
                        <Tooltip title={SELL_OPTION_TOOLTIPS[opt.label]}>
                          <Box sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f11, letterSpacing: '0.14em', textTransform: 'uppercase', mb: 1, color: sellOptionNameColor(opt.label), cursor: 'help' }}>
                            {opt.label_ru}
                          </Box>
                        </Tooltip>
                        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px' }}>
                          <Box component="dt" sx={dtSx}>выставить за</Box>
                          <Box component="dd" className="mono" sx={ddSx}>{fmtP(opt.price_per_unit)}</Box>

                          <Box component="dt" sx={dtSx}>получишь (−5 %)</Box>
                          <Box component="dd" className="mono" sx={ddSx}>{fmtP(opt.net_price_per_unit)}</Box>

                          {profit !== null && (
                            <>
                              <Box component="dt" sx={dtSx}>прибыль</Box>
                              <Box component="dd" className="mono" sx={{ ...ddSx, color: isProfitable ? tokens.success : tokens.danger, fontWeight: isProfitable ? 500 : 400 }}>
                                {isProfitable ? '+' : '−'}{fmtP(Math.abs(profit))}
                              </Box>
                            </>
                          )}

                          <Box component="dt" sx={dtSx}>срок</Box>
                          <Box component="dd" className="mono" sx={ddSx}>{opt.estimated_hours_display}</Box>
                        </Box>
                        {opt.data_points != null && (
                          <Box className="mono" sx={{ mt: 1, pt: '7px', borderTop: `1px solid ${tokens.border}`, fontSize: fs.f105, color: tokens.text2, fontVariantNumeric: 'tabular-nums' }}>
                            уверенность: {CONF_LABELS[opt.confidence] ?? opt.confidence} · {fmtN(opt.data_points)} сделок
                          </Box>
                        )}
                      </Box>
                    )
                  })}
                </Box>
              </>
            ) : (
              <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>
                Недостаточно данных для расчёта
              </Box>
            )}
          </Box>

          {/* ── ④ Пачки · распределение ──────────────────────────── */}
          <Box sx={CELL_SX}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 24, mb: 1, flexWrap: 'wrap' }}>
              <Box component="h2" sx={SEC_H_SX}>Пачки · распределение</Box>
              {stats.batch_stats && (
                <>
                  <Chip label={`${stats.batch_stats.batch_ratio_pct}% сделок`} size="small" variant="outlined" sx={{ height: 20, fontSize: fs.f11 }} />
                  <Chip label={`~${stats.batch_stats.median_amount} шт`} size="small" color="primary" sx={{ height: 20, fontSize: fs.f11 }} />
                </>
              )}
            </Box>

            {stats.batch_stats ? (
              <>
                {Object.entries(stats.batch_stats.by_size).map(([key, bucket]) => {
                  const isPopular = key === stats.batch_stats!.most_popular_bucket
                  return (
                    <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Box component="span" className="mono" sx={{ fontSize: fs.f115, color: isPopular ? tokens.goldAccent : tokens.text1, minWidth: 56, fontWeight: isPopular ? 700 : 500, whiteSpace: 'nowrap' }}>{bucket.label}</Box>
                      <Box sx={{ flex: 1, height: 14, background: tokens.bg2, border: `1px solid ${tokens.border}`, position: 'relative', overflow: 'hidden' }}>
                        <Box sx={{
                          position: 'absolute', inset: '1px auto 1px 1px', width: `${bucket.share_pct}%`, minWidth: 2, transition: `width ${tokens.motion.mid}ms ${tokens.motion.ease}`,
                          background: isPopular ? `linear-gradient(90deg, ${tokens.gold}, ${tokens.goldAccent})` : `linear-gradient(90deg, ${tokens.goldSoft}, ${tokens.gold})`,
                        }} />
                      </Box>
                      <Box component="span" className="mono" sx={{ fontSize: fs.f115, color: tokens.text2, minWidth: 96, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Box component="span" sx={{ color: tokens.text0, fontWeight: 500 }}>{bucket.share_pct}%</Box> · {fmtP(bucket.avg_price_per_unit)}
                      </Box>
                    </Box>
                  )
                })}
                {stats.batch_stats.bulk_discount_pct !== null && (
                  <Typography sx={{ fontSize: fs.f12, mt: 1, color: stats.batch_stats.bulk_discount_pct > 0 ? tokens.success : tokens.warning }}>
                    {stats.batch_stats.bulk_discount_pct > 0
                      ? `Оптом дешевле на ${stats.batch_stats.bulk_discount_pct}% — выгоднее покупать пачкой`
                      : `Оптом дороже на ${Math.abs(stats.batch_stats.bulk_discount_pct)}% — выгоднее покупать поштучно`}
                  </Typography>
                )}
              </>
            ) : (
              <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>
                Данных о пачках нет
              </Box>
            )}
          </Box>

        </Box>
      )}

      {!stats && lots.length > 0 && (
        <Box sx={{ p: '16px 18px' }}>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2 }}>Нет данных о продажах за последние 30 дней</Typography>
        </Box>
      )}
    </Card>
  )
}
