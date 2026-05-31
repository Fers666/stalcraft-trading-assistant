import { useEffect, useState } from 'react'
import { Box, Typography, CircularProgress, ToggleButtonGroup, ToggleButton } from '@mui/material'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import api from '../api/client'

interface PricePoint {
  time: string
  best_price: number | null
  best_liquid_price: number | null
  avg_price: number | null
  total_lots: number | null
}

interface Props {
  itemId: string
  region: string
}

const HOURS_OPTIONS = [
  { label: '12ч', value: 12 },
  { label: '24ч', value: 24 },
  { label: '48ч', value: 48 },
  { label: '7д',  value: 168 },
]

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

const fmtPrice = (v: number) => v >= 1_000_000
  ? `${(v / 1_000_000).toFixed(2)}M`
  : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : `${v}`

export default function PriceChart({ itemId, region }: Props) {
  const [data, setData]     = useState<PricePoint[]>([])
  const [hours, setHours]   = useState(24)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const { data: rows } = await api.get(`/monitoring/history/${itemId}`, {
          params: { region, hours },
        })
        setData(rows)
      } catch {
        setData([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [itemId, region, hours])

  const chartData = data.map((p) => ({
    t: fmtTime(p.time),
    'Лучшая': p.best_price,
    'Ликвидная': p.best_liquid_price,
    'Средняя': p.avg_price ? Math.round(p.avg_price) : null,
  }))

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="caption" color="text.secondary" fontWeight={600}>
          История цен
        </Typography>
        <ToggleButtonGroup
          value={hours}
          exclusive
          onChange={(_, v) => v && setHours(v)}
          size="small"
        >
          {HOURS_OPTIONS.map((o) => (
            <ToggleButton key={o.value} value={o.value} sx={{ py: 0, px: 1, fontSize: 11 }}>
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>}

      {!loading && chartData.length === 0 && (
        <Typography variant="caption" color="text.disabled">
          Недостаточно данных для графика
        </Typography>
      )}

      {!loading && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#666' }} interval="preserveStartEnd" />
            <YAxis tickFormatter={fmtPrice} tick={{ fontSize: 10, fill: '#666' }} width={48} />
            <ChartTooltip
              contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', fontSize: 12 }}
              formatter={(v: number) => v?.toLocaleString('ru-RU') + ' ₽'}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="Ликвидная" stroke="#e8a020" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="Лучшая"    stroke="#4caf84" dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="Средняя"   stroke="#7c8db0" dot={false} strokeWidth={1} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Box>
  )
}
