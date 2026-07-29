import { useEffect } from 'react'
import { Box } from '@mui/material'
import { useEmissionStore } from '../../store/emissionStore'
import { tokens, fs } from '../../theme'

// Индикатор выброса в мобильном минибаре — контракт .memis (mobile.css).
// Своя логика опроса зеркалит EmissionWidget (частота не меняется: 15с/30с);
// одновременно смонтирована одна оболочка → двойного опроса нет.
function formatTimeSince(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} сек`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} мин`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}ч ${rem}м` : `${hrs}ч`
}

export default function MobileEmission() {
  const { isActive, durationMin, secondsSinceLast, loading, fetch } = useEmissionStore()

  useEffect(() => {
    fetch()
    const interval = setInterval(() => { fetch() }, isActive ? 15_000 : 30_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  const noData = loading && durationMin === null && secondsSinceLast === null
  const accent = isActive ? tokens.danger : tokens.warning

  return (
    <Box
      title="Последний выброс"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        flex: 'none',
        padding: '4px 7px',
        background: isActive ? tokens.dangerDim : tokens.bg2,
        border: `1px solid ${isActive ? tokens.dangerLine : tokens.border}`,
        borderRadius: '2px',
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
      <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: accent, whiteSpace: 'nowrap' }}>
        {noData
          ? 'нет данных'
          : isActive
            ? `идёт${durationMin !== null ? ` ${durationMin}м` : ''}`
            : formatTimeSince(secondsSinceLast)}
      </Box>
    </Box>
  )
}
