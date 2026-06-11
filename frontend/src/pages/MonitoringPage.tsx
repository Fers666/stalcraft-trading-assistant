import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  IconButton, Tooltip, Divider, Alert, Avatar,
  ToggleButtonGroup, ToggleButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Button,
  Pagination,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import SearchIcon from '@mui/icons-material/Search'
import BarChartIcon from '@mui/icons-material/BarChart'
import api from '../api/client'
import { formatPrice, iconUrl } from '../utils/i18n'
import { useFeedStore } from '../store/feedStore'


interface BatchBucket {
  label: string
  count: number
  share_pct: number
  avg_price_per_unit: number
  median_price_per_unit: number
}

interface BatchStats {
  by_size: Record<string, BatchBucket>
  median_amount: number
  bulk_discount_pct: number | null
  batch_ratio_pct: number
  most_popular_bucket: string
  total_analyzed: number
}

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
  batch_stats: BatchStats | null
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

const RISK_LABELS: Record<string, { label: string; short: string; color: 'success' | 'warning' | 'error'; desc: string }> = {
  low:    { label: 'Стабильный',     short: 'С', color: 'success', desc: 'цена стабильна, риск минимален'      },
  medium: { label: 'Умеренный риск', short: 'У', color: 'warning', desc: 'умеренные колебания'                 },
  high:   { label: 'Высокий риск',   short: 'В', color: 'error',   desc: 'цена сильно скачет, прогноз ненадёжен' },
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

const qualityColor = (quality: string | null): string | null => {
  if (!quality) return null
  const colors: Record<string, string> = {
    'Обычный': '#555',
    'Необычный': '#4caf50',
    'Особый': '#2196f3',
    'Ветеран': '#9c27b0',
    'Мастер': '#ff9800',
    'Легендарный': '#f44336',
  }
  return colors[quality] ?? null
}

function volatilityRisk(v: number | null): keyof typeof RISK_LABELS | null {
  if (v == null) return null
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

// Сигналы — предвычисленные выгодные лоты из Redis (публикуются коллектором)
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


const ItemCard = memo(function ItemCard({ entry, stats, onDelete, onViewLots, lots: lotsData, signals, minProfitMarginPercent = 0 }: {
  entry: WatchlistEntry
  stats: MarketStats | null
  onDelete: (entry: WatchlistEntry) => void
  onViewLots: (entry: WatchlistEntry) => void
  lots: LotItem[] | undefined
  signals?: SignalsData | null
  minProfitMarginPercent?: number
}) {
  const navigate = useNavigate()
  const [timeMode, setTimeMode] = useState<'week' | 'today'>('today')
  const [lotMode, setLotMode]   = useState<'current' | 'median'>('current')
  const lots       = lotsData ?? []
  const lotsLoaded = lotsData !== undefined
  const riskKey   = stats ? volatilityRisk(stats.price_volatility_7d)  : null
  const riskKey30 = stats ? volatilityRisk(stats.price_volatility_30d) : null
  const risk   = riskKey   ? RISK_LABELS[riskKey]   : null
  const risk30 = riskKey30 ? RISK_LABELS[riskKey30] : null

  const COMMISSION = 0.05

  // Ценовые ориентиры для двух режимов:
  // "Сейчас" — текущий рынок (sell_options уже посчитаны от current_min)
  // "Неделя" — исторический уровень (median_7d), находит просевшие лоты
  // useMemo — пересчитываем только при смене режима/статов, а не на каждый ре-рендер
  // (32 карточки на странице, иначе пересчёт идёт вхолостую при каждом тике опроса)
  const sellPrices = useMemo(() => {
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
  }, [stats?.sell_options, stats?.median_price_7d, lotMode])

  // Выгодные лоты — предпочитаем сигналы из Redis (те же данные что у бота),
  // фолбэк на клиентский расчёт пока Redis-ключ ещё не заполнен.
  const profitableLots = useMemo(() => {
    if (signals?.lots?.length) {
      const opts = sellPrices ?? []
      return signals.lots
        .map(l => ({
          buyout_price:   l.buyout_price,
          amount:         l.amount,
          hours_remaining: null as number | null,
          is_expiring:    false,
          quality_name:   l.quality_name,
          enchant_level:  l.enchant ?? null,
          buyPerUnit:     l.buyout_per_unit,
          profits: opts.map(sp => ({
            label:    sp.label,
            label_ru: sp.label_ru,
            perUnit:  Math.round(sp.price * (1 - COMMISSION) - l.buyout_per_unit),
            total:    Math.round((sp.price * (1 - COMMISSION) - l.buyout_per_unit) * l.amount),
          })),
        }))
        .filter(l => {
          const normalProfit = l.profits.find(p => p.label === 'normal')?.perUnit ?? -1
          if (normalProfit <= 0) return false
          if (minProfitMarginPercent > 0) {
            const profitPct = (normalProfit / l.buyPerUnit) * 100
            if (profitPct < minProfitMarginPercent) return false
          }
          return true
        })
        .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
        .slice(0, 5)
    }

    // Фолбэк: клиентский расчёт (пока коллектор не заполнил Redis)
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
      .filter(l => {
        const normalProfit = l.profits.find(p => p.label === 'normal')?.perUnit ?? -1
        if (normalProfit <= 0) return false
        if (minProfitMarginPercent > 0) {
          const profitPct = (normalProfit / l.buyPerUnit) * 100
          if (profitPct < minProfitMarginPercent) return false
        }
        return true
      })
      .sort((a, b) => a.buyPerUnit - b.buyPerUnit)
      .slice(0, 5)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, sellPrices, lots, entry.quality_filter, entry.enchant_filter, minProfitMarginPercent])

  const totalFilteredLots = useMemo(() => lots.filter(l => {
    if (l.is_expiring) return false
    if (entry.quality_filter !== null && l.quality_name !== QLT_NAMES[entry.quality_filter]) return false
    if (entry.enchant_filter !== null && l.enchant_level !== entry.enchant_filter) return false
    return true
  }).length, [lots, entry.quality_filter, entry.enchant_filter])

  const hasQuality = profitableLots.some(l => l.quality_name || l.enchant_level != null)
  const lotGridCols = hasQuality ? '1fr auto 86px 86px 86px' : '1fr 86px 86px 86px'

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
      width: 520,
      height: 840,
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
        contain: 'layout style paint',
        willChange: 'scroll-position',
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
                  {entry.enchant_filter === 0 ? 'Не точёный' : `+${entry.enchant_filter}`}
                </Typography>
              )}
            </Box>
            {/* ID — на этой же высоте начинается фото справа */}
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {entry.item_id}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, mb: 1.5 }}>
              <Chip label={entry.region} size="small" variant="outlined" />
              {risk ? (
                <Tooltip title={`Волатильность за 7 дней: ${stats!.price_volatility_7d!.toFixed(1)}% — ${risk.label}. ${risk.desc}`}>
                  <Chip label={`7д · ${risk.short}`} size="small" color={risk.color} variant="outlined" />
                </Tooltip>
              ) : stats && (
                <Tooltip title="Мало продаж — волатильность за 7 дней не рассчитана">
                  <Chip label="7д · ?" size="small" variant="outlined" sx={{ color: 'text.disabled', borderColor: 'text.disabled', opacity: 0.5 }} />
                </Tooltip>
              )}
              {risk30 ? (
                <Tooltip title={`Волатильность за 30 дней: ${stats!.price_volatility_30d!.toFixed(1)}% — ${risk30.label}. ${risk30.desc}`}>
                  <Chip label={`30д · ${risk30.short}`} size="small" color={risk30.color} variant="outlined" />
                </Tooltip>
              ) : stats && (
                <Tooltip title="Мало продаж — волатильность за 30 дней не рассчитана">
                  <Chip label="30д · ?" size="small" variant="outlined" sx={{ color: 'text.disabled', borderColor: 'text.disabled', opacity: 0.5 }} />
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
              <Tooltip title="История продаж">
                <IconButton
                  size="small"
                  onClick={() => navigate('/app/sales-history', {
                    state: {
                      itemId: entry.item_id,
                      region: entry.region,
                      qualityFilter: entry.quality_filter,
                      enchantFilter: entry.enchant_filter,
                      itemName: entry.name_ru ?? entry.name_en ?? entry.item_id,
                    },
                  })}
                  sx={{ color: 'text.secondary' }}
                >
                  <BarChartIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Все лоты этого предмета">
                <IconButton size="small" onClick={() => onViewLots(entry)} sx={{ color: 'text.secondary' }}>
                  <SearchIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Удалить из Избранного">
                <IconButton size="small" onClick={() => onDelete(entry)} sx={{ color: 'error.main' }}>
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
              <Chip
                label={QLT_NAMES[entry.quality_filter] ?? `qlt${entry.quality_filter}`}
                size="small"
                variant="outlined"
                sx={{
                  fontSize: '0.6rem',
                  height: 16,
                  mt: 0.5,
                  borderColor: qualityColor(QLT_NAMES[entry.quality_filter]) ?? 'primary.main',
                  color: qualityColor(QLT_NAMES[entry.quality_filter]) ?? 'primary.main',
                }}
              />
            )}
          </Box>
        </Box>

        {!stats && lotsLoaded && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
              <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                НА РЫНКЕ
              </Typography>
              <Chip
                label={totalFilteredLots > 0 ? `${totalFilteredLots}` : 'нет'}
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: 10, color: 'text.secondary' }}
              />
            </Box>
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', py: 0.5 }}>
              {entry.last_successful_check
                ? 'Нет данных о продажах за последние 30 дней'
                : 'Первый сбор данных — готово через ~30 сек'}
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
                      ? <Chip label={`${profitableLots.length} / ${totalFilteredLots}`} size="small" color="success" sx={{ height: 18, fontSize: 10 }} />
                      : <Chip label={`нет / ${totalFilteredLots}`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, color: 'text.disabled' }} />
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
                        <Typography key={sp.label} sx={{
                          fontSize: '0.58rem', color: sellOptionColor(sp.label),
                          fontWeight: 700, letterSpacing: '0.06em', textAlign: 'right',
                        }}>
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
                            {lot.enchant_level != null && (
                              <Typography sx={{ fontSize: '0.6rem', color: 'primary.main', fontWeight: 600, lineHeight: 1.3 }}>
                                {lot.enchant_level === 0 ? 'Не точёный' : `+${lot.enchant_level}`}
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
                {(() => {
                  // Минимальная цена покупки по активным ликвидным лотам с учётом фильтров
                  const cheapestBuy = lots
                    .filter(l => !l.is_expiring && l.buyout_price > 0)
                    .filter(l => entry.quality_filter === null || l.quality_name === QLT_NAMES[entry.quality_filter])
                    .filter(l => entry.enchant_filter === null || l.enchant_level === entry.enchant_filter)
                    .reduce<number | null>((min, l) => {
                      const p = Math.floor(l.buyout_price / l.amount)
                      return min === null || p < min ? p : min
                    }, null)
                  return (
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      {stats.sell_options!.map((opt) => {
                        const c = sellOptionColor(opt.label)
                        // Прибыль от покупки по текущей минимальной цене (после 5% комиссии)
                        const profitFromCheapest = cheapestBuy !== null
                          ? opt.net_price_per_unit - cheapestBuy
                          : null
                        const isProfitable = profitFromCheapest !== null && profitFromCheapest > 0
                        return (
                          <Tooltip key={opt.label} title={`${SELL_OPTION_TOOLTIPS[opt.label]} Покупай дешевле ${formatPrice(opt.net_price_per_unit)} чтобы выйти в плюс (5% комиссия уже учтена).`}>
                            <Box sx={{
                              flex: 1, p: 1.25,
                              borderRadius: '10px',
                              border: profitFromCheapest !== null
                                ? `1px solid ${isProfitable ? 'rgba(62,213,152,0.3)' : 'rgba(235,87,87,0.25)'}`
                                : '1px solid rgba(255,255,255,0.06)',
                              background: profitFromCheapest !== null
                                ? isProfitable ? 'rgba(62,213,152,0.04)' : 'rgba(235,87,87,0.03)'
                                : 'rgba(255,255,255,0.02)',
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
                                получишь (−5%)
                              </Typography>
                              <Typography variant="body2" fontWeight={700} sx={{ color: c }}>
                                {formatPrice(opt.net_price_per_unit)}
                              </Typography>
                              {/* Прибыль от текущей минимальной цены или порог безубыточности */}
                              {profitFromCheapest !== null ? (
                                <>
                                  <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>
                                    прибыль
                                  </Typography>
                                  <Typography sx={{
                                    fontSize: '0.72rem', fontWeight: 700,
                                    color: isProfitable ? 'success.main' : 'error.main',
                                  }}>
                                    {isProfitable ? '+' : ''}{formatPrice(profitFromCheapest)}
                                  </Typography>
                                </>
                              ) : (
                                <>
                                  <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', mt: 0.75, mb: 0.25 }}>
                                    купи до
                                  </Typography>
                                  <Typography sx={{ fontSize: '0.62rem', fontWeight: 600, color: 'text.secondary' }}>
                                    {formatPrice(opt.net_price_per_unit - 1)}
                                  </Typography>
                                </>
                              )}
                              {/* Прогноз времени */}
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                                {opt.estimated_hours_display}
                              </Typography>
                            </Box>
                          </Tooltip>
                        )
                      })}
                    </Box>
                  )
                })()}
              </>
            )}
          </Box>
        )}

        {/* Статистика пачек — только если товар торгуется пачками */}
        {stats?.batch_stats && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
              <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
                ПАЧКИ
              </Typography>
              <Tooltip title={`${stats.batch_stats.batch_ratio_pct}% всех продаж за 30 дней шли пачками (amount > 1)`}>
                <Chip
                  label={`${stats.batch_stats.batch_ratio_pct}% сделок`}
                  size="small" variant="outlined"
                  sx={{ height: 18, fontSize: 10, color: 'text.secondary' }}
                />
              </Tooltip>
              <Tooltip title="Типичный размер одной продажи (медиана)">
                <Chip
                  label={`~${stats.batch_stats.median_amount} шт`}
                  size="small" variant="outlined"
                  sx={{ height: 18, fontSize: 10, color: 'primary.main', borderColor: 'primary.main' }}
                />
              </Tooltip>
            </Box>

            {/* Мини-таблица по размерам */}
            {Object.entries(stats.batch_stats.by_size).map(([key, bucket]) => {
              const isPopular = key === stats.batch_stats!.most_popular_bucket
              return (
                <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography sx={{ fontSize: '0.6rem', color: isPopular ? 'primary.main' : 'text.secondary', minWidth: 52, fontWeight: isPopular ? 700 : 400 }}>
                    {bucket.label}
                  </Typography>
                  {/* Бар-индикатор */}
                  <Box sx={{ flex: 1, height: 4, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.06)', position: 'relative', overflow: 'hidden' }}>
                    <Box sx={{
                      width: `${bucket.share_pct}%`, height: '100%', borderRadius: 2,
                      bgcolor: isPopular ? 'primary.main' : 'rgba(255,255,255,0.18)',
                      transition: 'width 0.3s',
                    }} />
                  </Box>
                  <Typography sx={{ fontSize: '0.58rem', color: 'text.disabled', minWidth: 28, textAlign: 'right' }}>
                    {bucket.share_pct}%
                  </Typography>
                  <Typography sx={{ fontSize: '0.6rem', color: 'text.primary', minWidth: 68, textAlign: 'right', fontFamily: 'monospace', fontWeight: isPopular ? 600 : 400 }}>
                    {formatPrice(bucket.avg_price_per_unit)}/шт
                  </Typography>
                </Box>
              )
            })}

            {/* Оптовая скидка / наценка */}
            {stats.batch_stats.bulk_discount_pct !== null && (
              <Typography sx={{ fontSize: '0.62rem', mt: 0.75, color: stats.batch_stats.bulk_discount_pct > 0 ? 'success.main' : 'warning.main' }}>
                {stats.batch_stats.bulk_discount_pct > 0
                  ? `Оптом дешевле на ${stats.batch_stats.bulk_discount_pct}% — выгоднее покупать пачкой`
                  : `Оптом дороже на ${Math.abs(stats.batch_stats.bulk_discount_pct)}% — выгоднее покупать поштучно`}
              </Typography>
            )}
          </>
        )}

      </CardContent>
    </Card>
  )
})

// Карточки тяжёлые (980px, живой график Recharts, поллинг) — рендерим не больше
// одной "страницы" разом, иначе при 30+ карточках браузер виснет (утечка памяти,
// фризы на 20-30 сек от GC под давлением тысяч живых SVG-узлов и таймеров).
const PAGE_SIZE = 8

export default function MonitoringPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const {
    watchlist, stats: feedStats, lotsMap,
    initialized, loadWatchlistAndStats, removeEntry,
    minProfitMarginPercent,
  } = useFeedStore()
  const stats = feedStats as unknown as Record<number, MarketStats>

  const [loading, setLoading]         = useState(!initialized)
  const [deleteEntry, setDeleteEntry] = useState<WatchlistEntry | null>(null)
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const [signalsMap, setSignalsMap]   = useState<Record<number, SignalsData>>({})
  const [page, setPage]               = useState(1)
  const [pendingScrollId, setPendingScrollId] = useState<number | null>(null)
  const cardRefs = useRef<Record<number, HTMLElement | null>>({})

  const pageCount   = Math.max(1, Math.ceil(watchlist.length / PAGE_SIZE))
  const pageEntries = (watchlist as WatchlistEntry[]).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Если карточку удалили и текущая страница опустела — уходим на предыдущую
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  // Загрузка/обновление при каждом входе на страницу
  useEffect(() => {
    if (initialized) {
      setLoading(false)
      loadWatchlistAndStats(true)  // silent refresh при повторном входе
      return
    }
    loadWatchlistAndStats().then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Опрос статистики (5 мин), карточек без данных (30 сек) и лотов (30 сек)
  // уже выполняется глобально в GlobalFeed (смонтирован в Layout на каждой странице) —
  // дублирующие интервалы здесь удваивали запросы и каскады ре-рендера всех 32 карточек.

  // Опрос сигналов каждые 30 сек (предвычисленные выгодные лоты из Redis)
  const loadAllSignals = useCallback(async () => {
    const entries = watchlist as WatchlistEntry[]
    if (entries.length === 0) return
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const params: Record<string, string | number> = { region: entry.region }
          if (entry.quality_filter !== null) params.quality_filter = entry.quality_filter
          if (entry.enchant_filter  !== null) params.enchant_filter  = entry.enchant_filter
          const { data } = await api.get<SignalsData>(`/monitoring/signals/${entry.item_id}`, { params })
          return [entry.id, data] as [number, SignalsData]
        } catch { return null }
      })
    )
    setSignalsMap(prev => {
      const next = { ...prev }
      for (const r of results) {
        if (r) next[r[0]] = r[1]
      }
      return next
    })
  }, [watchlist])

  useEffect(() => {
    if (watchlist.length === 0) return
    loadAllSignals()
    const t = setInterval(loadAllSignals, 30_000)
    return () => clearInterval(t)
  }, [watchlist, loadAllSignals])

  const handleDeleteConfirm = async () => {
    if (!deleteEntry) return
    await api.delete(`/watchlist/${deleteEntry.id}`)
    removeEntry(deleteEntry.id)
    delete cardRefs.current[deleteEntry.id]
    setSignalsMap(prev => {
      if (!(deleteEntry.id in prev)) return prev
      const next = { ...prev }
      delete next[deleteEntry.id]
      return next
    })
    setDeleteEntry(null)
  }

  // Стабильные колбэки — без них React.memo на ItemCard бесполезен
  // (инлайн-функции в .map() меняются каждый рендер и пробивают сравнение пропсов)
  const handleDeleteRequest = useCallback((entry: WatchlistEntry) => setDeleteEntry(entry), [])
  const handleViewLots = useCallback((entry: WatchlistEntry) => navigate('/app/lots', {
    state: {
      item_id: entry.item_id,
      name_ru: entry.name_ru,
      name_en: entry.name_en,
      icon_path: entry.icon_path,
      region: entry.region,
      quality_filter: entry.quality_filter,
      enchant_filter: entry.enchant_filter,
    },
  }), [navigate])

  const scrollToCard = useCallback((id: number) => {
    const el = cardRefs.current[id]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setHighlightId(id)
    setTimeout(() => setHighlightId(null), 1200)
  }, [])

  // Переход из GlobalFeed к конкретной карточке: сперва переключаемся на её страницу
  // (карточка может быть не смонтирована — рендерим только текущую страницу), затем скроллим
  useEffect(() => {
    const id = (location.state as { scrollTo?: number } | null)?.scrollTo
    if (!id) return
    const idx = watchlist.findIndex(e => e.id === id)
    if (idx === -1) return
    const targetPage = Math.floor(idx / PAGE_SIZE) + 1
    setPendingScrollId(id)
    if (targetPage !== page) setPage(targetPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, watchlist])

  useEffect(() => {
    if (pendingScrollId == null) return
    const id = pendingScrollId
    const t = setTimeout(() => {
      scrollToCard(id)
      setPendingScrollId(null)
    }, 250)
    return () => clearTimeout(t)
  }, [pendingScrollId, page, scrollToCard])

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
            STATS 5 MIN · LOTS 30 SEC · SIGNALS 30 SEC
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
        <>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {pageEntries.map((entry) => (
            <Box
              key={entry.id}
              ref={(el: HTMLElement | null) => { cardRefs.current[entry.id] = el }}
              sx={{
                borderRadius: 1,
                boxShadow: highlightId === entry.id ? '0 0 0 2px #D9AF37' : '0 0 0 2px transparent',
                transition: 'box-shadow 0.4s',
              }}
            >
              <ItemCard
                entry={entry}
                stats={stats[entry.id] ?? null}
                onDelete={handleDeleteRequest}
                onViewLots={handleViewLots}
                lots={lotsMap[entry.id]}
                signals={signalsMap[entry.id] ?? null}
                minProfitMarginPercent={minProfitMarginPercent}
              />
            </Box>
          ))}
          </Box>

          {pageCount > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Pagination
                count={pageCount}
                page={page}
                onChange={(_, p) => setPage(p)}
                color="primary"
                shape="rounded"
              />
            </Box>
          )}
        </>
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
