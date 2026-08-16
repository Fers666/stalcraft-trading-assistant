import { useState, useEffect } from 'react'
import { Box, Typography, Skeleton, ToggleButtonGroup, ToggleButton } from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import { formatLastUpdate, qualityColor, iconUrl } from '../../utils/i18n'
import { fmtN, fmtP } from '../../utils/format'
import { tokens, fs } from '../../theme'
import { useLotStats, QLT_NAMES, type RiskKey } from '../../hooks/useLotStats'
import Kick from '../ui/Kick'
import TrendBadge from '../ui/TrendBadge'
import LockIcon from '../ui/LockIcon'
import ItemIcon from '../ui/ItemIcon'
import QualityChip from '../ui/QualityChip'
import RiskChip, { type RiskLevel } from '../ui/RiskChip'
import SalesHistoryCharts from '../SalesHistoryCharts'
import DCard from './ui/DCard'
import StatusGrid, { type StatusItem } from './ui/StatusGrid'

// Мобильная карточка предмета «Избранное» (detail-вью master-detail). Тот же
// дата-слой, что у десктопного LotStatCard — useLotStats (расчёт прибыли/сигналов/
// риска идентичен). Раскладка — вертикальная стопка секций (прототип
// design/mobile/app/favorites.html): шапка+медиана → StatusGrid → выгодные лоты →
// динамика цен → варианты продажи → пачки. Стиль — только tokens/fs.

const DAYS_RU: Record<string, string> = {
  Monday: 'Пн', Tuesday: 'Вт', Wednesday: 'Ср', Thursday: 'Чт',
  Friday: 'Пт', Saturday: 'Сб', Sunday: 'Вс',
}
const TODAY_EN = new Date().toLocaleDateString('en-US', { weekday: 'long' })

const RISK_LEVEL: Record<RiskKey, RiskLevel> = { low: 'lo', medium: 'md', high: 'hi' }

const SELL_NAME_COLOR: Record<string, string> = {
  fast: tokens.text1, normal: tokens.goldAccent, premium: tokens.goldHighlight,
}
const CONF_LABELS: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' }

// секция-«ячейка» (прототип .cell)
const cellSx = { background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: '2px', overflow: 'hidden' } as const
const secHSx = {
  m: 0, fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f12,
  letterSpacing: '0.13em', textTransform: 'uppercase', color: tokens.text1,
} as const

export interface MobileLotStatCardProps {
  itemId: string
  region: string
  qualityFilter: number | null
  enchantFilter: number | null
  itemName: string
  iconPath?: string | null
  minProfitMarginPercent?: number
  /** Кикер шапки. В «Избранном» его нет (заголовок даёт страница), в «Ленте» — «Лента · RU». */
  kicker?: React.ReactNode
  /** Источник «выгодных лотов»: watchlist-сигналы или /feed/lots (см. useLotStats). */
  signalsSource?: 'watchlist' | 'feed'
}

export default function MobileLotStatCard({
  itemId, region, qualityFilter, enchantFilter, itemName, iconPath, minProfitMarginPercent = 0,
  kicker, signalsSource = 'watchlist',
}: MobileLotStatCardProps) {
  const [timeMode, setTimeMode] = useState<'week' | 'today'>('today')
  // Дефолт — «Неделя», как на десктопе: см. комментарий в LotStatCard
  const [lotMode, setLotMode]   = useState<'current' | 'median'>('median')
  const [selectedLotIdx, setSelectedLotIdx] = useState(0)
  // Медиана окна «Динамики цен» — см. LotStatCard: крупное число обязано
  // совпадать с золотой линией графика.
  const [winMedian, setWinMedian] = useState<{ value: number; label: string } | null>(null)

  const {
    stats, lots, loading, sellOptions, sellOptionsAreCurrent, trend, median24h,
    profitableLots, totalFilteredLots,
    cheapestBuy, riskKey, riskKey30, risk, risk30, sellOptionsLocked, risk30Locked, lastUpdated,
  } = useLotStats({ itemId, region, qualityFilter, enchantFilter, minProfitMarginPercent, lotMode, signalsSource })

  // Завязка на сам массив сбрасывала бы выбор каждые 30с — он новый на каждом поллинге
  useEffect(() => { setSelectedLotIdx(0) }, [profitableLots.length, itemId])

  // Лот-база «Вариантов продажи»: от него и цена покупки, и цены продажи
  // (в «Ленте» приведены к размеру пачки — см. useLotStats)
  const selectedLot = profitableLots[selectedLotIdx] ?? null
  const baseBuy = selectedLot?.buyPerUnit ?? cheapestBuy

  // Резерв — прежняя медиана 7д, пока окно не отдало свою (закрыто тарифом
  // либо сделок в нём нет).
  const headMedian = winMedian?.value ?? stats?.median_price_7d ?? null
  const headMedianLabel = winMedian?.label ?? '7д'

  const sellHour = timeMode === 'today'
    ? (stats?.sell_hours_by_day?.[TODAY_EN] ?? stats?.best_sell_hour)
    : stats?.best_sell_hour
  const buyHour = timeMode === 'today'
    ? (stats?.buy_hours_by_day?.[TODAY_EN] ?? stats?.best_buy_hour)
    : stats?.best_buy_hour
  const sellDay = timeMode === 'week' ? stats?.best_sell_day : null
  const buyDay  = timeMode === 'week' ? stats?.best_buy_day  : null

  const qColor = qualityFilter !== null ? (qualityColor(QLT_NAMES[qualityFilter]) ?? tokens.gold) : tokens.gold

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Skeleton variant="rectangular" height={150} sx={{ bgcolor: tokens.bg2 }} />
        <Skeleton variant="rectangular" height={200} sx={{ bgcolor: tokens.bg2 }} />
        <Skeleton variant="rectangular" height={220} sx={{ bgcolor: tokens.bg2 }} />
      </Box>
    )
  }

  const statusItems: StatusItem[] = []
  if (stats) {
    if (stats.sales_volume_7d != null) statusItems.push({ k: 'Продаж 7д', v: fmtN(stats.sales_volume_7d), unit: 'шт' })
    statusItems.push({ k: 'Лотов', v: fmtN(totalFilteredLots) })
    if (sellHour != null) statusItems.push({ k: 'Продавать', v: `${sellDay ? `${DAYS_RU[sellDay] ?? sellDay} ` : ''}${String(sellHour).padStart(2, '0')}:00`, tone: 'success' })
    if (buyHour != null) statusItems.push({ k: 'Покупать', v: `${buyDay ? `${DAYS_RU[buyDay] ?? buyDay} ` : ''}${String(buyHour).padStart(2, '0')}:00`, tone: 'warning' })
    if (stats.avg_sell_time_hours != null) statusItems.push({ k: 'Ср. продажа', v: `~${(Math.round(stats.avg_sell_time_hours * 10) / 10).toLocaleString('ru-RU')}`, unit: 'ч' })
    const upd = formatLastUpdate(lastUpdated)
    if (upd) statusItems.push({ k: 'Обновлено', v: upd })
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

      {/* ── Шапка + медиана ─────────────────────────────────────── */}
      <Box sx={cellSx}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '12px', p: '12px 12px 10px' }}>
          <ItemIcon src={iconUrl(iconPath) ?? undefined} name={itemName} size={48} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {kicker && <Kick sx={{ display: 'block', mb: '3px' }}>{kicker}</Kick>}
            <Typography sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.02em', lineHeight: 1.05 }}>
              {itemName}
              {enchantFilter != null && enchantFilter > 0 && (
                <Box component="span" className="mono" sx={{ ml: 1, fontSize: fs.f16, color: tokens.goldAccent, fontWeight: 700 }}>+{enchantFilter}</Box>
              )}
            </Typography>
            <Box component="span" className="mono" sx={{ display: 'inline-block', mt: '4px', fontSize: fs.f105, color: tokens.text2, border: `1px solid ${tokens.border}`, px: '5px', borderRadius: '2px' }}>
              {itemId}
            </Box>
          </Box>
        </Box>

        {/* чипы качества / риска */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px', px: '12px', pb: '12px' }}>
          {qualityFilter !== null && <QualityChip color={qColor} label={QLT_NAMES[qualityFilter] ?? `кач. ${qualityFilter}`} />}
          {riskKey && risk && <RiskChip level={RISK_LEVEL[riskKey]} label={<>7Д {risk.label}</>} value={stats?.price_volatility_7d != null ? `${Math.round(stats.price_volatility_7d)}%` : undefined} />}
          {risk30Locked ? (
            <Box component="span" className="mono" sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: fs.f11, px: '8px', borderRadius: '2px', color: tokens.text2, border: `1px solid ${tokens.border}` }}>
              <LockIcon size={11} /> 30Д
            </Box>
          ) : riskKey30 && risk30 && (
            <RiskChip level={RISK_LEVEL[riskKey30]} label={<>30Д {risk30.label}</>} />
          )}
        </Box>

        {/* медиана-пик (единственный goldHighlight) */}
        {headMedian != null && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', m: '0 12px 12px', p: '10px 12px', background: tokens.bg2, border: `1px solid ${tokens.border}` }}>
            <Box>
              <Kick>Медиана {headMedianLabel}</Kick>
              <TrendBadge trend={trend} median7d={stats?.median_price_7d} median24h={median24h} />
            </Box>
            <Box className="mono" sx={{ fontSize: fs.f28, fontWeight: 700, lineHeight: 1.05, color: tokens.goldHighlight, textShadow: `0 0 22px ${tokens.goldGlow}`, whiteSpace: 'nowrap' }}>
              {fmtP(headMedian)}
            </Box>
          </Box>
        )}

        {/* переключатель окна времени */}
        {stats && (sellHour != null || buyHour != null) && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: '12px', pb: '10px' }}>
            <ToggleButtonGroup value={timeMode} exclusive size="small" onChange={(_, v) => v && setTimeMode(v)}>
              <ToggleButton value="today" sx={{ py: 0.2, px: 1.2 }}>Сегодня</ToggleButton>
              <ToggleButton value="week"  sx={{ py: 0.2, px: 1.2 }}>Неделя</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        )}

        {statusItems.length > 0 && <Box sx={{ p: '0 12px 12px' }}><StatusGrid items={statusItems} cols={3} /></Box>}
      </Box>

      {!stats && lots.length > 0 && (
        <Box sx={{ ...cellSx, p: '14px 16px' }}>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2 }}>Нет данных о продажах за последние 30 дней</Typography>
        </Box>
      )}

      {stats && (
        <>
          {/* ── ① Выгодные лоты ────────────────────────────────── */}
          <Box sx={cellSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', p: '11px 12px 6px', flexWrap: 'wrap' }}>
              <Box component="h2" sx={secHSx}>Выгодные лоты</Box>
              <Box component="span" className="mono" sx={{
                fontSize: fs.f11, color: profitableLots.length ? tokens.success : tokens.text2,
                background: profitableLots.length ? tokens.successDim : 'transparent',
                border: `1px solid ${profitableLots.length ? tokens.successLine : tokens.border}`,
                px: '6px', borderRadius: '2px',
              }}>
                {profitableLots.length} / {totalFilteredLots}
              </Box>
              <Box sx={{ ml: 'auto' }}>
                <ToggleButtonGroup value={lotMode} exclusive size="small" onChange={(_, v) => v && setLotMode(v)}>
                  <ToggleButton value="current" sx={{ py: 0.2, px: 1 }}>Сейчас</ToggleButton>
                  <ToggleButton value="median"  sx={{ py: 0.2, px: 1 }}>Неделя</ToggleButton>
                </ToggleButtonGroup>
              </Box>
            </Box>

            <Box sx={{ p: '0 12px 14px' }}>
              {lotMode === 'current' && sellOptionsAreCurrent && profitableLots.length > 0 && (
                <Typography sx={{ fontSize: fs.f11, color: tokens.text2, mb: 1 }}>
                  Цены от текущего минимума рынка — продажа ниже него убыточна по определению.
                </Typography>
              )}
              {profitableLots.length === 0 ? (
                <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>Нет выгодных лотов</Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {profitableLots.map((lot, i) => {
                    // В «Неделе» бэкендовая оценка и колонка «Быстро» считаются от одной
                    // опорной цены — берём бэкендовую, в ней ещё поправка на размер пачки.
                    // В «Сейчас» — клиентский what-if, иначе знак разойдётся с десктопом:
                    // мобайл показывал бы плюс там, где в таблице минус.
                    const fastWhatIf = lot.profits.find(p => p.label === 'fast')?.perUnit ?? 0
                    const fromBackend = lotMode === 'median' && lot.profit != null
                    const value = fromBackend ? lot.profit! : fastWhatIf
                    return (
                      <DCard
                        key={i}
                        selected={i === selectedLotIdx}
                        onClick={() => setSelectedLotIdx(i)}
                        name={<Box className="mono">{fmtP(lot.buyPerUnit)}<Box component="span" sx={{ color: tokens.text2, fontWeight: 400 }}> / шт</Box></Box>}
                        sub={<>{fmtN(lot.amount)} шт{lot.amount > 1 ? ` · выкуп ${fmtP(lot.buyout_price)}` : ''}{lot.enchant_level != null && lot.enchant_level > 0 ? ` · +${lot.enchant_level}` : ''}{lot.breakeven != null ? ` · безубыток ${fmtP(lot.breakeven)}` : ''}</>}
                        right={
                          <Box>
                            <Box className="mono" sx={{ fontSize: fs.f14, fontWeight: 700, color: value > 0 ? tokens.success : tokens.danger }}>
                              {value > 0 ? '+' : '−'}{fmtP(Math.abs(value))}
                            </Box>
                            <Box sx={{ fontSize: fs.f105, color: tokens.text2 }}>прибыль / шт (быстро)</Box>
                          </Box>
                        }
                      />
                    )
                  })}
                  {profitableLots.length > 1 && (
                    <Typography sx={{ fontSize: fs.f11, color: tokens.text2 }}>
                      ↳ Тапни лот — «Варианты продажи» пересчитаются от его цены покупки.
                    </Typography>
                  )}
                </Box>
              )}
            </Box>
          </Box>

          {/* ── ② Динамика цен ─────────────────────────────────── */}
          <Box sx={{ ...cellSx, p: '11px 12px 14px' }}>
            <SalesHistoryCharts
              itemId={itemId}
              region={region}
              qualityFilter={qualityFilter}
              enchantFilter={enchantFilter}
              median={stats.median_price_7d ?? undefined}
              median24h={median24h ?? undefined}
              onWindowMedian={setWinMedian}
            />
          </Box>

          {/* ── ③ Варианты продажи ─────────────────────────────── */}
          <Box sx={cellSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', p: '11px 12px 8px' }}>
              <TrendingUpIcon sx={{ fontSize: 14, color: tokens.gold }} />
              <Box component="h2" sx={secHSx}>Варианты продажи</Box>
            </Box>

            <Box sx={{ p: '0 12px 14px' }}>
              {sellOptionsLocked ? (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 2, color: tokens.text2 }}>
                  <LockIcon size={16} />
                  <Typography sx={{ fontSize: fs.f12, color: tokens.text2 }}>Доступно на тарифе Продвинутая+ и выше</Typography>
                </Box>
              ) : sellOptions && sellOptions.length > 0 ? (
                <>
                  {baseBuy !== null && (
                    <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mb: 1 }}>
                      Расчёт для лота <Box component="span" className="mono" sx={{ fontWeight: 700, color: tokens.goldAccent }}>{fmtP(baseBuy)}</Box>
                      {lotMode === 'current' && !sellOptionsAreCurrent && ' · нет свежего снапшота, цены за неделю'}
                    </Typography>
                  )}
                  {selectedLot?.batchPricePct != null && (
                    <Typography sx={{ fontSize: fs.f11, color: tokens.text2, mb: 1 }}>
                      Цены — для пачки{' '}
                      <Box component="span" className="mono" sx={{ color: tokens.text1 }}>×{fmtN(selectedLot.amount)}</Box>
                      : сделки такими пачками идут на{' '}
                      <Box component="span" className="mono" sx={{ color: tokens.text1 }}>
                        {Math.abs(selectedLot.batchPricePct).toLocaleString('ru-RU')} %
                      </Box>{' '}
                      {selectedLot.batchPricePct > 0 ? 'дороже' : 'дешевле'} штучных. Те же цены — в списке выгодных лотов.
                    </Typography>
                  )}
                  {stats.reference_confidence === 'low' && stats.reference_samples != null && (
                    <Typography sx={{ fontSize: fs.f11, color: tokens.warning, mb: 1 }}>
                      Сделки редкие или несвежие ({fmtN(stats.reference_samples)} в выборке) — оценка приблизительная
                    </Typography>
                  )}
                  {stats.reference_confidence === 'medium' && stats.reference_samples != null && (
                    <Typography sx={{ fontSize: fs.f11, color: tokens.goldSoft, mb: 1 }}>
                      Свежих сделок немного ({fmtN(stats.reference_samples)} в выборке) — оценка рабочая, запас небольшой
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: '1px', background: tokens.border, border: `1px solid ${tokens.border}` }}>
                    {sellOptions.map(opt => {
                      // Цены и прибыль — у выбранного лота (batch-фактор уже применён
                      // в useLotStats, там же и число из списка выгодных лотов).
                      // Лота нет → сырые опции, как раньше.
                      const lotOpt = selectedLot?.profits.find(p => p.label === opt.label) ?? null
                      const batchedNet = lotOpt?.netUnit ?? null
                      const priceUnit = lotOpt?.priceUnit ?? opt.price_per_unit
                      const netUnit   = batchedNet ?? opt.net_price_per_unit
                      const profit = batchedNet !== null && lotOpt
                        ? lotOpt.perUnit
                        : baseBuy !== null ? opt.net_price_per_unit - baseBuy : null
                      const isProfitable = profit !== null && profit > 0
                      const dtSx = { fontSize: fs.f11, color: tokens.text2, whiteSpace: 'nowrap' } as const
                      const ddSx = { m: 0, fontFamily: tokens.fontMono, fontSize: fs.f125, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: tokens.text0, whiteSpace: 'nowrap' } as const
                      return (
                        <Box key={opt.label} sx={{ background: tokens.bg2, p: '11px 12px' }}>
                          <Box sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f11, letterSpacing: '0.14em', textTransform: 'uppercase', mb: '7px', color: SELL_NAME_COLOR[opt.label] ?? tokens.text0 }}>
                            {opt.label_ru}
                          </Box>
                          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px' }}>
                            <Box component="dt" sx={dtSx}>выставить за</Box>
                            <Box component="dd" sx={ddSx}>{fmtP(priceUnit)}</Box>
                            <Box component="dt" sx={dtSx}>получишь (−5 %)</Box>
                            <Box component="dd" sx={ddSx}>{fmtP(netUnit)}</Box>
                            {profit !== null && (
                              <>
                                <Box component="dt" sx={dtSx}>прибыль</Box>
                                <Box component="dd" sx={{ ...ddSx, color: isProfitable ? tokens.success : tokens.danger }}>
                                  {isProfitable ? '+' : '−'}{fmtP(Math.abs(profit))}
                                </Box>
                              </>
                            )}
                            <Box component="dt" sx={dtSx}>срок</Box>
                            <Box component="dd" sx={ddSx}>{opt.estimated_hours_display}</Box>
                            {/* Ценовая позиция тира (доля сделок по этой цене и выше),
                                не исполнение лота; пока бэкенд не пересчитал
                                статистику — поля нет и строки нет (см. LotStatCard). */}
                            {opt.fill_probability != null && (
                              <>
                                <Box component="dt" sx={dtSx}>сделок дороже</Box>
                                <Box component="dd" sx={ddSx}>~{opt.fill_probability} %</Box>
                              </>
                            )}
                          </Box>
                          {opt.data_points != null && (
                            <Box className="mono" sx={{ mt: '7px', pt: '7px', borderTop: `1px solid ${tokens.border}`, fontSize: fs.f105, color: tokens.text2 }}>
                              уверенность: {CONF_LABELS[opt.confidence] ?? opt.confidence} · {fmtN(opt.data_points)} сделок
                            </Box>
                          )}
                        </Box>
                      )
                    })}
                  </Box>
                </>
              ) : (
                <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>Недостаточно данных для расчёта</Box>
              )}
            </Box>
          </Box>

          {/* ── ④ Пачки · распределение ────────────────────────── */}
          <Box sx={cellSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', p: '11px 12px 8px', flexWrap: 'wrap' }}>
              <Box component="h2" sx={secHSx}>Пачки · распределение</Box>
              {stats.batch_stats && (
                <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
                  ~{stats.batch_stats.median_amount} шт · {stats.batch_stats.batch_ratio_pct}% сделок
                </Box>
              )}
            </Box>
            <Box sx={{ p: '0 12px 14px' }}>
              {stats.batch_stats ? (
                <>
                  {Object.entries(stats.batch_stats.by_size).map(([key, bucket]) => {
                    const isPopular = key === stats.batch_stats!.most_popular_bucket
                    return (
                      <Box key={key} sx={{ display: 'grid', gridTemplateColumns: '58px 1fr auto', gap: '6px 9px', alignItems: 'center', mb: '6px' }}>
                        <Box component="span" className="mono" sx={{ fontSize: fs.f11, color: isPopular ? tokens.goldAccent : tokens.text1, fontWeight: isPopular ? 700 : 500, whiteSpace: 'nowrap' }}>{bucket.label}</Box>
                        <Box sx={{ height: 13, background: tokens.bg2, border: `1px solid ${tokens.border}`, position: 'relative', overflow: 'hidden' }}>
                          <Box sx={{
                            position: 'absolute', inset: '1px auto 1px 1px', width: `${bucket.share_pct}%`, minWidth: 2,
                            transition: `width ${tokens.motion.mid}ms ${tokens.motion.ease}`,
                            background: isPopular ? `linear-gradient(90deg, ${tokens.gold}, ${tokens.goldAccent})` : `linear-gradient(90deg, ${tokens.goldSoft}, ${tokens.gold})`,
                          }} />
                        </Box>
                        <Box component="span" className="mono" sx={{ fontSize: fs.f11, color: tokens.text2, textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                <Box sx={{ p: '22px 10px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>Данных о пачках нет</Box>
              )}
            </Box>
          </Box>
        </>
      )}
    </Box>
  )
}
