import { useEffect } from 'react'
import { useEmissionStore } from '../store/emissionStore'
import { tokens } from '../theme'

const G2 = tokens.gold      // #D9AF37
const T2 = tokens.text2     // #7C7C7C

function formatTimeSince(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} сек назад`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins} мин назад`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}ч ${rem}мин назад` : `${hrs}ч назад`
}

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

  const containerStyle: React.CSSProperties = {
    margin: '0 8px',
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1.4,
    color: T2,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    ...(isActive
      ? {
          background: 'rgba(220, 38, 38, 0.15)',
          borderLeft: '2px solid #DC2626',
        }
      : {
          background: 'rgba(217, 175, 55, 0.08)',
          borderLeft: `2px solid ${G2}`,
        }),
  }

  return (
    <div style={containerStyle}>
      {noData ? (
        <span style={{ opacity: 0.5 }}>Выброс: нет данных</span>
      ) : isActive ? (
        <>
          <span style={{ color: '#EF4444', fontWeight: 600 }}>Выброс идёт</span>
          {durationMin !== null && (
            <span style={{ marginLeft: 4, opacity: 0.8 }}>{durationMin} мин</span>
          )}
        </>
      ) : (
        <>
          <span style={{ color: G2, opacity: 0.7 }}>Последний: </span>
          <span>{formatTimeSince(secondsSinceLast)}</span>
        </>
      )}
    </div>
  )
}
