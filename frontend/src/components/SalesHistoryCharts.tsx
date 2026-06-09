import { Box, Typography } from '@mui/material'
import PriceChart from './PriceChart'

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
}

const PERIODS = [
  { label: '24 часа',  hours: 24  },
  { label: '48 часов', hours: 48  },
  { label: '7 дней',   hours: 168 },
  { label: '30 дней',  hours: 720 },
]

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter }: Props) {
  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        {PERIODS.map(({ label, hours }) => (
          <Box key={hours} sx={{
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
            p: 1.5,
            bgcolor: 'rgba(255,255,255,0.02)',
          }}>
            <Typography sx={{
              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em',
              color: 'text.disabled', mb: 1,
            }}>
              {label.toUpperCase()}
            </Typography>
            <PriceChart
              itemId={itemId}
              region={region}
              qualityFilter={qualityFilter}
              enchantFilter={enchantFilter}
              defaultHours={hours}
              hideControls
            />
          </Box>
        ))}
      </Box>
    </Box>
  )
}
