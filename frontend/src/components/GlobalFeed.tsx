import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Skeleton } from '@mui/material'
import { useFeedStore, QLT_NAMES } from '../store/feedStore'
import { iconUrl, qualityColor } from '../utils/i18n'
import { tokens, fs } from '../theme'

// Лента сигналов — контракт .signals (base.css:104-136).
// Панель bg1 в 12px от навбара, боковые поля 16px.
export const FEED_GAP = 12       // отступ панели от навбара
export const FEED_PANEL_H = 54   // высота самой панели
export const FEED_HEIGHT = FEED_GAP + FEED_PANEL_H  // вертикальный след ниже навбара

const hhmm = (d: Date | string | null): string => {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

const feedBarSx = {
  position:      'fixed',
  top:           `${tokens.navH + FEED_GAP}px`,
  left:          '16px',
  right:         '16px',
  height:        `${FEED_PANEL_H}px`,
  zIndex:        1200, // ниже навбара (1300), выше контента
  display:       'flex',
  alignItems:    'stretch',
  background:    tokens.bg1,
  border:        `1px solid ${tokens.border}`,
  borderRadius:  '2px',
  overflow:      'hidden',
} as const

// .sig-label
function FeedLabel({ lastRefresh, hasItems }: { lastRefresh: Date | null; hasItems: boolean }) {
  return (
    <Box
      sx={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: '3px',
        padding: '0 16px',
        minWidth: 132,
        borderRight: `1px solid ${tokens.border}`,
      }}
    >
      <Box
        sx={{
          fontFamily: tokens.fontHead,
          fontWeight: 700,
          fontSize: fs.f11,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: tokens.text2,
          lineHeight: 1,
        }}
      >
        Сигналы
      </Box>
      <Box
        className="mono"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: fs.f11,
          color: tokens.success,
          lineHeight: 1,
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 6,
            height: 6,
            flexShrink: 0,
            background: hasItems ? tokens.success : tokens.text2,
            boxShadow: hasItems ? `0 0 8px ${tokens.success}` : 'none',
            animation: hasItems ? 'anomaly-pulse 2s infinite' : 'none',
          }}
        />
        срез {hhmm(lastRefresh)}
      </Box>
    </Box>
  )
}

export default function GlobalFeed() {
  const navigate  = useNavigate()
  const {
    watchlist, feedItems, lastLotRefresh, initialized,
    loadWatchlistAndStats, loadAllLots,
  } = useFeedStore()

  // Stats: каждые 5 мин
  useEffect(() => {
    loadWatchlistAndStats()
    const t = setInterval(() => loadWatchlistAndStats(true), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadWatchlistAndStats])

  const watchlistIds = watchlist.map((w) => w.id).join(',')

  // Лоты: каждые 30 сек
  useEffect(() => {
    if (!watchlistIds) return
    loadAllLots()
    const t = setInterval(loadAllLots, 30_000)
    return () => clearInterval(t)
  }, [watchlistIds, loadAllLots])

  // Быстрый опрос пока есть непроверенные позиции
  useEffect(() => {
    const hasPending = watchlist.some(e => !e.last_successful_check)
    if (!hasPending) return
    const t = setInterval(() => loadWatchlistAndStats(true), 30_000)
    return () => clearInterval(t)
  }, [watchlistIds, loadWatchlistAndStats])

  if (!initialized || watchlist.length === 0) return null

  const handleClick = (id: number) => {
    navigate('/app/monitoring', { state: { scrollTo: id } })
  }

  const trackSx = {
    display:    'flex',
    gap:        '1px',
    flex:       1,
    background: tokens.border, // 1px-щели между карточками
    overflowX:  'auto',
    overflowY:  'hidden',
    '&::-webkit-scrollbar': { height: '3px' },
    '&::-webkit-scrollbar-thumb': { background: tokens.goldLineSoft, borderRadius: '2px' },
  } as const

  if (lastLotRefresh === null) {
    return (
      <Box sx={feedBarSx}>
        <FeedLabel lastRefresh={null} hasItems={false} />
        <Box sx={trackSx}>
          {[0, 1, 2, 3].map(i => (
            <Skeleton
              key={i}
              variant="rectangular"
              width={196}
              height="100%"
              sx={{ flexShrink: 0, background: tokens.bg2 }}
            />
          ))}
        </Box>
      </Box>
    )
  }

  if (feedItems.length === 0) return null

  return (
    <Box sx={feedBarSx}>
      <FeedLabel lastRefresh={lastLotRefresh} hasItems={true} />

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
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '9px',
                minWidth: 196,
                padding: '7px 12px',
                background: tokens.bg1,
                border: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
                transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                '&:hover': { background: tokens.bg2 },
                '&:active': { background: tokens.bg3 },
              }}
            >
              {/* .sig-ico */}
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  position: 'relative',
                  display: 'grid',
                  placeItems: 'center',
                  background: tokens.bg2,
                  border: `1px solid ${tokens.border}`,
                }}
              >
                {iconUrl(entry.icon_path) ? (
                  <Box
                    component="img"
                    src={iconUrl(entry.icon_path) ?? undefined}
                    alt=""
                    sx={{ width: 24, height: 24, objectFit: 'contain' }}
                  />
                ) : (
                  <Box component="span" sx={{ fontSize: fs.f13, fontWeight: 700, color: qColor }}>
                    {label[0] ?? '?'}
                  </Box>
                )}
              </Box>

              {/* .sig-main */}
              <Box sx={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '5px',
                    fontSize: fs.f12,
                    fontWeight: 600,
                    color: tokens.text0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {label}
                  </Box>
                  {entry.enchant_filter !== null && (
                    <Box component="span" className="mono" sx={{ flexShrink: 0, color: tokens.goldAccent, fontWeight: 700 }}>
                      +{entry.enchant_filter}
                    </Box>
                  )}
                </Box>
                <Box
                  className="mono"
                  sx={{ fontSize: fs.f11, color: tokens.text2, whiteSpace: 'nowrap' }}
                >
                  обн. {hhmm(latest_lot_time)}
                </Box>
              </Box>

              {/* .sig-badge */}
              <Box
                className="mono"
                sx={{
                  flexShrink: 0,
                  fontSize: fs.f12,
                  fontWeight: 700,
                  color: tokens.success,
                  background: tokens.successDim,
                  border: `1px solid ${tokens.successLine}`,
                  padding: '2px 8px',
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
