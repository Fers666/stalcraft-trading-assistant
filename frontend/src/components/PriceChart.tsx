import { useEffect, useState } from 'react'
import { Box, Typography, CircularProgress, ToggleButtonGroup, ToggleButton, Chip } from '@mui/material'
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  ResponsiveContainer, LineChart, Line, Legend,
} from 'recharts'
import api from '../api/client'

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
}

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
}

const HOURS_OPTIONS = [
  { label: '12ч', value: 12 },
  { label: '24ч', value: 24 },
  { label: '48ч', value: 48 },
  { label: '7д',  value: 168 },
]

const fmtPrice = (v: number) => v >= 1_000_000
  ? `${(v / 1_000_000).toFixed(2)}M`
  : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : `${v}`

function fmtMs(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function fmtDayLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`
}

export default function PriceChart({ itemId, region, qualityFilter, enchantFilter }: Props) {
  const [resp, setResp]       = useState<SalesChartResponse | null>(null)
  const [hours, setHours]     = useState(24)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
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
  }, [itemId, region, hours, qualityFilter, enchantFilter])

  const periodLabel = hours === 168 ? '7 дней' : `${hours} ч`

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
    count: d.count,
  })) ?? []

  const isEmpty = !resp || (resp.mode === 'scatter' ? resp.sales.length === 0 : resp.days.length === 0)

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
            ИСТОРИЯ ПРОДАЖ
          </Typography>
          {resp != null && (
            <Chip
              label={`${resp.total_count} за ${periodLabel}`}
              size="small"
              sx={{
                height: 18, fontSize: 10,
                bgcolor: 'rgba(217,175,55,0.10)',
                color: 'primary.main',
                border: '1px solid rgba(217,175,55,0.25)',
              }}
            />
          )}
        </Box>
        <ToggleButtonGroup value={hours} exclusive onChange={(_, v) => v && setHours(v)} size="small">
          {HOURS_OPTIONS.map((o) => (
            <ToggleButton key={o.value} value={o.value} sx={{ py: 0, px: 1, fontSize: 11 }}>
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && isEmpty && (
        <Typography variant="caption" color="text.disabled">
          Нет данных о продажах
        </Typography>
      )}

      {/* Scatter: каждая продажа — точка (12ч / 24ч / 48ч) */}
      {!loading && !isEmpty && resp!.mode === 'scatter' && (
        <ResponsiveContainer width="100%" height={160}>
          <ScatterChart margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="x"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={fmtMs}
              tick={{ fontSize: 10, fill: '#7C7C7C' }}
              interval="preserveStartEnd"
            />
            <YAxis
              dataKey="y"
              tickFormatter={fmtPrice}
              tick={{ fontSize: 10, fill: '#7C7C7C' }}
              width={48}
            />
            <ChartTooltip
              cursor={{ stroke: 'rgba(255,255,255,0.08)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as { x: number; y: number; amount: number }
                const dt = new Date(d.x)
                const timeStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')} `
                  + `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`
                return (
                  <Box sx={{ background: '#1A1F26', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', p: 1 }}>
                    <Typography sx={{ fontSize: 11, color: '#7C7C7C', mb: 0.25 }}>{timeStr}</Typography>
                    <Typography sx={{ fontSize: 13, color: '#D9AF37', fontWeight: 700 }}>
                      {d.y.toLocaleString('ru-RU')} ₽
                    </Typography>
                    {d.amount > 1 && (
                      <Typography sx={{ fontSize: 11, color: '#B8B8B8' }}>{d.amount} шт</Typography>
                    )}
                  </Box>
                )
              }}
            />
            <Scatter data={scatterData} fill="#D9AF37" opacity={0.8} />
          </ScatterChart>
        </ResponsiveContainer>
      )}

      {/* Line chart: мин / средняя / макс по дням (7д) */}
      {!loading && !isEmpty && resp!.mode === 'daily' && (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={dailyData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#7C7C7C' }} />
            <YAxis tickFormatter={fmtPrice} tick={{ fontSize: 10, fill: '#7C7C7C' }} width={48} />
            <ChartTooltip
              contentStyle={{ background: '#1A1F26', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#B8B8B8', marginBottom: 4 }}
              formatter={(v: number, name: string) => [`${fmtPrice(v)} ₽`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="max" stroke="#3ED598" dot={{ r: 3 }} strokeDasharray="4 2" strokeWidth={1} name="Макс"    />
            <Line type="monotone" dataKey="avg" stroke="#D9AF37" dot={{ r: 4 }} strokeWidth={2}       name="Средняя" />
            <Line type="monotone" dataKey="min" stroke="#7C7C7C" dot={{ r: 3 }} strokeDasharray="4 2" strokeWidth={1} name="Мин"     />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Box>
  )
}
