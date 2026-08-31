import { useNavigate } from 'react-router-dom'
import { Box, Skeleton } from '@mui/material'
import { QLT_NAMES } from '../../store/feedStore'
import { useFeedPolling } from '../../hooks/useFeedPolling'
import { iconUrl, qualityColor } from '../../utils/i18n'
import { tokens, fs } from '../../theme'
import SignalIcon from '../ui/SignalIcon'
import { signalsVisible } from '../GlobalFeed'

// Лента сигналов (мобайл) — контракт .msignals (mobile.css). Горизонтальный
// трек карточек из feedStore, данные/интервалы через useFeedPolling (та же
// частота, что у десктопного GlobalFeed). Скроллится вместе с контентом.
const hhmm = (d: Date | string | null): string => {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function SignalsHeader({ live }: { live: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <Box
        sx={{
          fontFamily: tokens.fontHead,
          fontWeight: 700,
          fontSize: fs.f11,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: tokens.text2,
        }}
      >
        Сигналы
      </Box>
      <Box className="mono" sx={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: fs.f11, color: tokens.success }}>
        <Box
          aria-hidden
          sx={{ width: 6, height: 6, background: tokens.success, boxShadow: `0 0 8px ${tokens.success}`, animation: 'anomaly-pulse 2s infinite' }}
        />
        {live}
      </Box>
    </Box>
  )
}

const wrapSx = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px 2px' } as const
const trackSx = {
  display: 'flex',
  gap: '8px',
  overflowX: 'auto',
  paddingBottom: '4px',
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' },
} as const

export default function MobileSignals() {
  const navigate = useNavigate()
  const { watchlist, feedItems, lastLotRefresh, initialized } = useFeedPolling()

  // Условие показа — общий предикат с десктопной полосой (GlobalFeed).
  const shown = signalsVisible({
    initialized,
    watchlistCount: watchlist.length,
    feedItemsCount: feedItems.length,
    lastLotRefresh,
  })
  if (!shown) return null

  const handleClick = (id: number) => {
    navigate('/app/monitoring', { state: { scrollTo: id } })
  }

  // Скелетон до первого среза лотов
  if (lastLotRefresh === null) {
    return (
      <Box sx={wrapSx}>
        <SignalsHeader live="обн. —" />
        <Box sx={trackSx}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rectangular" width={190} height={48} sx={{ flexShrink: 0, background: tokens.bg2 }} />
          ))}
        </Box>
      </Box>
    )
  }

  if (feedItems.length === 0) return null

  return (
    <Box sx={wrapSx}>
      {/* «обн.» — момент последнего опроса; «срез» (max(seen_at) строк) живёт
          на странице «Ленты». Два разных времени под одним словом читались
          как ошибка (прототип: .livehint «обновлено» ≠ .hcut «срез»). */}
      <SignalsHeader live={`обн. ${hhmm(lastLotRefresh)}`} />
      <Box sx={trackSx}>
        {feedItems.map(({ entry, count, latest_lot_time }) => {
          const qColor = entry.quality_filter !== null
            ? qualityColor(QLT_NAMES[entry.quality_filter])
            : tokens.text2
          const label = entry.name_ru || entry.name_en || entry.item_id
          return (
            <Box
              key={entry.id}
              component="button"
              type="button"
              onClick={() => handleClick(entry.id)}
              aria-label={`${label} — ${count} выгодных лотов, открыть карточку`}
              sx={{
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                minWidth: 190,
                maxWidth: '80vw',
                padding: '8px 10px',
                background: tokens.bg1,
                border: `1px solid ${tokens.border}`,
                borderRadius: '2px',
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
                transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                '&:active': { background: tokens.goldDim, borderColor: tokens.goldLine },
              }}
            >
              {/* .sig-ico */}
              <SignalIcon
                src={iconUrl(entry.icon_path) ?? undefined}
                label={label}
                color={qColor}
                size={30}
              />

              {/* .msig .m */}
              <Box sx={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '5px',
                    fontSize: fs.f125,
                    fontWeight: 500,
                    color: tokens.text0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
                  {entry.enchant_filter !== null && (
                    <Box component="span" className="mono" sx={{ flex: 'none', color: tokens.goldAccent, fontWeight: 700 }}>
                      +{entry.enchant_filter}
                    </Box>
                  )}
                </Box>
                <Box className="mono" sx={{ fontSize: fs.f105, color: tokens.text2, whiteSpace: 'nowrap' }}>
                  обн. {hhmm(latest_lot_time)}
                </Box>
              </Box>

              {/* .msig .badge */}
              <Box
                className="mono"
                sx={{
                  flex: 'none',
                  fontSize: fs.f105,
                  fontWeight: 700,
                  color: tokens.success,
                  background: tokens.successDim,
                  border: `1px solid ${tokens.successLine}`,
                  padding: '1px 6px',
                  borderRadius: '2px',
                }}
              >
                +{count}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
