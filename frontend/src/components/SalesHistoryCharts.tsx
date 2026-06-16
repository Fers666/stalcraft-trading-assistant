import { Box, Typography } from '@mui/material'
import PriceChart from './PriceChart'

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
}

const PERIODS = [
  { label: '24 часа',  value: 24  },
  { label: '48 часов', value: 48  },
  { label: '7 дней',   value: 168 },
  { label: '30 дней',  value: 720 },
]

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter }: Props) {
  return (
    <Box>
      <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em', mb: 1.5, textTransform: 'uppercase' }}>
        История продаж
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        {PERIODS.map(p => (
          <Box
            key={p.value}
            sx={{
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              p: 1.5,
              bgcolor: 'rgba(255,255,255,0.02)',
            }}
          >
            <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'text.disabled', mb: 1, textTransform: 'uppercase' }}>
              {p.label}
            </Typography>
            <PriceChart
              key={`${itemId}-${p.value}`}
              itemId={itemId}
              region={region}
              qualityFilter={qualityFilter}
              enchantFilter={enchantFilter}
              defaultHours={p.value}
              hideControls
            />
          </Box>
        ))}
      </Box>
    </Box>
  )
}
