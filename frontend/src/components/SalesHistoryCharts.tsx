import { useState } from 'react'
import { Box, ToggleButtonGroup, ToggleButton } from '@mui/material'
import PriceChart from './PriceChart'

interface Props {
  itemId: string
  region: string
  qualityFilter?: number | null
  enchantFilter?: number | null
}

const HOURS_OPTIONS = [
  { label: '24ч', value: 24  },
  { label: '48ч', value: 48  },
  { label: '7д',  value: 168 },
  { label: '30д', value: 720 },
]

export default function SalesHistoryCharts({ itemId, region, qualityFilter, enchantFilter }: Props) {
  const [hours, setHours] = useState(24)

  return (
    <Box sx={{
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      p: 1.5,
      bgcolor: 'rgba(255,255,255,0.02)',
    }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <ToggleButtonGroup value={hours} exclusive onChange={(_, v) => v && setHours(v)} size="small">
          {HOURS_OPTIONS.map(o => (
            <ToggleButton key={o.value} value={o.value} sx={{ py: 0, px: 1, fontSize: 11 }}>
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
      <PriceChart
        key={hours}
        itemId={itemId}
        region={region}
        qualityFilter={qualityFilter}
        enchantFilter={enchantFilter}
        defaultHours={hours}
        hideControls
      />
    </Box>
  )
}
