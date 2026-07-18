import { useEffect } from 'react'
import { Box } from '@mui/material'
import { useEmissionStore } from '../store/emissionStore'
import { tokens, fs } from '../theme'

function formatTimeSince(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} сек назад`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} мин назад`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}ч ${rem}мин назад` : `${hrs}ч назад`
}

// Виджет выброса в навбаре — контракт .emis (base.css:78-81).
// COL-03: активное состояние → danger-токены, покой → amber (warning).
export function EmissionWidget() {
  const { isActive, durationMin, secondsSinceLast, loading, fetch } = useEmissionStore()

  useEffect(() => {
    fetch()
    const interval = setInterval(() => {
      fetch()
    }, isActive ? 15_000 : 30_000)
    return () => clearInterval(interval)
  }, [isActive])

  const noData = loading && durationMin === null && secondsSinceLast === null
  const accent = isActive ? tokens.danger : tokens.warning

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        padding: '5px 10px',
        borderRadius: '2px',
        background: isActive ? tokens.dangerDim : tokens.bg2,
        border: `1px solid ${isActive ? tokens.dangerLine : tokens.border}`,
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 6,
          height: 6,
          flexShrink: 0,
          background: accent,
          boxShadow: `0 0 8px ${accent}`,
          animation: 'anomaly-pulse 2.4s infinite',
        }}
      />
      <Box
        component="span"
        sx={{
          fontFamily: tokens.fontHead,
          fontWeight: 600,
          fontSize: fs.f10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: tokens.text2,
        }}
      >
        Выброс
      </Box>
      <Box
        component="span"
        className="mono"
        sx={{ fontSize: fs.f12, color: accent }}
      >
        {noData
          ? 'нет данных'
          : isActive
            ? `идёт${durationMin !== null ? ` · ${durationMin} мин` : ''}`
            : formatTimeSince(secondsSinceLast)}
      </Box>
    </Box>
  )
}
