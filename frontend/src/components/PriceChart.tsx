import { useEffect, useRef, useState } from 'react'
import { Box, Typography, Skeleton, ToggleButtonGroup, ToggleButton } from '@mui/material'
import {
  ScatterChart, Scatter, Cell, XAxis, YAxis, CartesianGrid, ReferenceLine,
  Tooltip as ChartTooltip, ResponsiveContainer, ComposedChart, Area, Line,
} from 'recharts'
import api from '../api/client'
import { tokens, fs } from '../theme'
import { fmtN, fmtP, fmtCompact } from '../utils/format'
import { logTicks } from '../utils/chartTicks'
import ChartFrame, { type ChartLegendItem } from './ui/ChartFrame'

interface SaleRecord {
  sale_time: string
  price_per_unit: number
  amount: number
}

interface DayPoint {
  period_iso: string
  min_price: number | null
  avg_price: number | null
  max_price: number | null
  count: number
}

interface SalesChartResponse {
  mode: 'scatter' | 'daily'
  sales: SaleRecord[]
  days: DayPoint[]
  total_count: number
  /** Медиана сделок этого окна (считает бэкенд). null — сделок в окне нет. */
  median: number | null
}

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
  defaultHours?: number
  hideControls?: boolean
  /** Резерв для линии-ориентира (медиана 7д), пока окно не отдало свою медиану. */
  median?: number
  /** Медиана сделок за 24ч — вторая линия. Без данных линия не рисуется. */
  median24h?: number
  /**
   * Медиана показанного окна — наверх, в шапку карточки: крупное число и его
   * кикер должны совпадать с золотой линией на графике, иначе карточка
   * утверждает две разные «медианы» одновременно.
   */
  onWindowMedian?: (median: { value: number; label: string } | null) => void
}

const HOURS_OPTIONS = [
  { label: '24ч', value: 24 },
  { label: '48ч', value: 48 },
  { label: '7д',  value: 168 },
  { label: '30д', value: 720 },
]

// Компактный формат для осей (K/M) — только визуальное сокращение тика, не цвет.
const fmtAxis = (v: number) => v >= 1_000_000
  ? `${(v / 1_000_000).toFixed(2)}M`
  : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : `${v}`

function fmtMs(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDayLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

const medianOf = (arr: number[]): number => {
  const a = arr.filter(v => v > 0).sort((x, y) => x - y)
  if (!a.length) return 0
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

// Лог-домен по значениям (+ линии-ориентиры): min×0.85 … max×1.15 (как charts.js:79,140)
const logDomain = (values: number[], ...refs: number[]): [number, number] => {
  const vals = values.filter(v => v > 0)
  vals.push(...refs.filter(v => v > 0))
  if (!vals.length) return [1, 10]
  return [Math.max(1, Math.min(...vals) * 0.85), Math.max(...vals) * 1.15]
}

const axisTick = { fontSize: 11, fill: tokens.text2, fontFamily: tokens.fontMono }

export default function PriceChart({
  itemId, region, qualityFilter, enchantFilter, defaultHours = 48, hideControls = false,
  median, median24h, onWindowMedian,
}: Props) {
  const [resp, setResp]       = useState<SalesChartResponse | null>(null)
  const [hours, setHours]     = useState(defaultHours)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const containerRef          = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true) },
      { rootMargin: '100px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      setLoading(true)
      try {
        const params: Record<string, string | number> = { region, hours }
        if (qualityFilter != null) params.quality_filter = qualityFilter
        if (enchantFilter != null) params.enchant_filter = enchantFilter
        const { data } = await api.get(`/monitoring/sales-chart/${itemId}`, { params })
        setResp(data)
      } catch {
        setResp(null)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [visible, itemId, region, hours, qualityFilter, enchantFilter])

  const periodLabel = hours === 720 ? '30д' : hours === 168 ? '7д' : `${hours}ч`

  const scatterData = resp?.sales.map(s => ({
    x: new Date(s.sale_time).getTime(),
    y: s.price_per_unit,
    amount: s.amount,
  })) ?? []

  const dailyData = resp?.days.map(d => ({
    label: fmtDayLabel(d.period_iso),
    min:   d.min_price,
    avg:   d.avg_price != null ? Math.round(d.avg_price) : null,
    max:   d.max_price,
    range: d.min_price != null && d.max_price != null ? [d.min_price, d.max_price] : undefined,
    count: d.count,
  })) ?? []

  const mode = resp?.mode ?? 'scatter'
  const isEmpty = !resp || (mode === 'scatter' ? resp.sales.length === 0 : resp.days.length === 0)

  // Медиана-ориентир: медиана сделок ЭТОГО окна с бэкенда. Локальный расчёт
  // остаётся страховкой на случай старого ответа без поля: в daily-режиме он
  // считает медиану дневных средних, что не то же самое (день с десятью
  // сделками весит там столько же, сколько день с одной).
  const localMedian = mode === 'scatter'
    ? medianOf(scatterData.map(d => d.y))
    : medianOf(dailyData.map(d => d.avg ?? 0))
  const apiMedian = resp?.median && resp.median > 0 ? resp.median : 0
  const med = apiMedian || (median && median > 0 ? median : localMedian)
  // Подпись честная: окно своё только у медианы окна, у резерва — всегда 7д.
  const medLabel = apiMedian ? periodLabel : '7д'

  useEffect(() => {
    onWindowMedian?.(apiMedian ? { value: apiMedian, label: periodLabel } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiMedian, periodLabel])
  // Фоллбека на медиану окна нет: линия «24ч» либо есть по реальным данным, либо её нет.
  const med24 = median24h && median24h > 0 ? median24h : 0
  // Точки красим относительно свежего уровня рынка: на падающем рынке всё
  // оказывается «ниже медианы 7д», и зелёный цвет усиливает ложное «дёшево».
  const colorRef = med24 > 0 ? med24 : med

  const scatterDomain = logDomain(scatterData.map(d => d.y), med, med24)
  const dailyValues = dailyData.flatMap(d => [d.min ?? 0, d.max ?? 0, d.avg ?? 0])
  const dailyDomain = logDomain(dailyValues, med, med24)

  // Мета-строка + легенда
  let metaNode: React.ReactNode = undefined
  let legend: ChartLegendItem[] | undefined = undefined
  if (!loading && !isEmpty) {
    if (mode === 'scatter') {
      const prices = scatterData.map(d => d.y)
      const min = Math.min(...prices)
      const avg = prices.reduce((s, v) => s + v, 0) / prices.length
      metaNode = `окно ${periodLabel} · ${resp!.total_count} сделок · мин ${fmtCompact(min)} · сред ${fmtCompact(avg)} · лог. шкала`
      legend = med24 > 0
        ? [
            { variant: 'g',  label: 'ниже рынка 24ч' },
            { variant: 'gd', label: 'выше' },
          ]
        : [
            { variant: 'g',  label: 'ниже медианы' },
            { variant: 'gd', label: 'выше' },
          ]
    } else {
      const sales = dailyData.reduce((s, d) => s + d.count, 0)
      metaNode = `окно ${periodLabel} · ${dailyData.length} дн · продаж ${fmtN(sales)} · лог. шкала`
      legend = [
        { variant: 'band', label: 'коридор мин–макс' },
        { variant: 'line', label: 'средняя' },
      ]
    }
  }

  const medianRef = med > 0 ? (
    <ReferenceLine
      y={med}
      stroke={tokens.goldAccent}
      strokeDasharray="4 3"
      strokeOpacity={0.8}
      ifOverflow="extendDomain"
      label={{
        value: `медиана ${medLabel} ${fmtCompact(med)}`,
        position: 'insideTopRight',
        fill: tokens.goldAccent,
        fontSize: 10,
        fontFamily: tokens.fontMono,
      }}
    />
  ) : null

  // Свежий уровень рынка. На падающем рынке идёт заметно ниже золотой линии 7д —
  // именно этот разрыв и объясняет, почему «выгодный» лот выгоден не так сильно.
  const median24hRef = med24 > 0 ? (
    <ReferenceLine
      y={med24}
      stroke={tokens.text1}
      strokeDasharray="2 4"
      strokeOpacity={0.7}
      ifOverflow="extendDomain"
      label={{
        value: `24ч ${fmtCompact(med24)}`,
        position: 'insideBottomRight',
        fill: tokens.text1,
        fontSize: 10,
        fontFamily: tokens.fontMono,
      }}
    />
  ) : null

  return (
    <Box ref={containerRef}>
      {!hideControls && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography sx={{
            fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f12,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: tokens.text1,
          }}>
            История продаж
          </Typography>
          <ToggleButtonGroup value={hours} exclusive onChange={(_, v) => v && setHours(v)} size="small">
            {HOURS_OPTIONS.map((o) => (
              <ToggleButton key={o.value} value={o.value} sx={{ py: 0, px: 1.2 }}>
                {o.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      )}

      <ChartFrame
        meta={metaNode}
        legend={legend}
        isEmpty={!loading && isEmpty}
        emptyText="Нет данных о продажах"
      >
        {loading ? (
          <Skeleton variant="rectangular" height={236} sx={{ bgcolor: tokens.bg2 }} />
        ) : mode === 'scatter' ? (
          <ResponsiveContainer width="100%" height={236} debounce={200}>
            <ScatterChart margin={{ top: 10, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={tokens.grid} />
              <XAxis
                dataKey="x"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={fmtMs}
                tick={axisTick}
                stroke={tokens.borderHi}
                interval="preserveStartEnd"
              />
              <YAxis
                dataKey="y"
                type="number"
                scale="log"
                domain={scatterDomain}
                ticks={logTicks(scatterDomain[0], scatterDomain[1])}
                allowDataOverflow
                tickFormatter={fmtAxis}
                tick={axisTick}
                stroke={tokens.borderHi}
                width={54}
              />
              <ChartTooltip
                cursor={{ stroke: tokens.borderHi }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as { x: number; y: number; amount: number }
                  const dt = new Date(d.x)
                  const timeStr = `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')} `
                    + `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
                  return (
                    <Box className="mono" sx={{ background: tokens.bg3, border: `1px solid ${tokens.borderHi}`, borderRadius: `${tokens.radiusLg}px`, p: 1 }}>
                      <Typography sx={{ fontSize: fs.f11, color: tokens.text2, mb: 0.25 }}>{timeStr}</Typography>
                      <Typography sx={{ fontSize: fs.f13, color: d.y < colorRef ? tokens.success : tokens.gold, fontWeight: 700 }}>
                        {fmtP(d.y)}
                      </Typography>
                      {d.amount > 1 && (
                        <Typography sx={{ fontSize: fs.f11, color: tokens.text1 }}>{d.amount} шт</Typography>
                      )}
                    </Box>
                  )
                }}
              />
              {medianRef}
              {median24hRef}
              <Scatter data={scatterData} fillOpacity={0.85}>
                {scatterData.map((d, i) => (
                  <Cell key={i} fill={colorRef > 0 && d.y < colorRef ? tokens.success : tokens.gold} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={236} debounce={200}>
            <ComposedChart data={dailyData} margin={{ top: 10, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={tokens.grid} />
              <XAxis dataKey="label" tick={axisTick} stroke={tokens.borderHi} />
              <YAxis
                type="number"
                scale="log"
                domain={dailyDomain}
                ticks={logTicks(dailyDomain[0], dailyDomain[1])}
                allowDataOverflow
                tickFormatter={fmtAxis}
                tick={axisTick}
                stroke={tokens.borderHi}
                width={54}
              />
              <ChartTooltip
                contentStyle={{ background: tokens.bg3, border: `1px solid ${tokens.borderHi}`, borderRadius: tokens.radiusLg, fontSize: 12, fontFamily: tokens.fontMono }}
                labelStyle={{ color: tokens.text1, marginBottom: 4 }}
                itemStyle={{ color: tokens.text0 }}
                formatter={(v: number | string | Array<number | string>, name) =>
                  Array.isArray(v)
                    ? [`${fmtCompact(Number(v[0]))} – ${fmtCompact(Number(v[1]))}`, name]
                    : [fmtP(Number(v)), name]
                }
              />
              {medianRef}
              {median24hRef}
              <Area type="monotone" dataKey="range" stroke={tokens.goldLineSoft} strokeWidth={1} fill={tokens.goldDim} name="Коридор мин–макс" />
              <Line type="monotone" dataKey="avg" stroke={tokens.goldAccent} dot={{ r: 3, fill: tokens.goldAccent }} strokeWidth={2} name="Средняя цена" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartFrame>
    </Box>
  )
}
