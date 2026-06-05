import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Box, Avatar, Typography, Skeleton } from '@mui/material'
import { useFeedStore, QLT_NAMES } from '../store/feedStore'
import { iconUrl } from '../utils/i18n'

export const FEED_HEIGHT = 84

const feedBarSx = {
  position:             'fixed',
  top:                  '56px',
  left:                 0,
  right:                0,
  height:               `${FEED_HEIGHT}px`,
  zIndex:               1200,
  bgcolor:              'rgba(9, 12, 16, 0.97)',
  borderBottom:         '1px solid rgba(255,255,255,0.055)',
  backdropFilter:       'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  display:              'flex',
  alignItems:           'center',
  px:                   3,
  gap:                  2,
  '&::before': {
    content:    '""',
    position:   'absolute',
    top:        0,
    left:       0,
    right:      0,
    height:     '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(183,138,42,0.5) 15%, rgba(217,175,55,0.7) 50%, rgba(183,138,42,0.5) 85%, transparent 100%)',
  },
} as const

function FeedLabel({ lastRefresh, hasItems }: { lastRefresh: Date | null; hasItems: boolean }) {
  return (
    <Box sx={{ flexShrink: 0, width: 64 }}>
      <Typography sx={{
        fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.16em',
        color: 'rgba(217,175,55,0.65)', lineHeight: 1, mb: 0.75,
      }}>
        СИГНАЛЫ
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{
          width: 5, height: 5, borderRadius: '50%',
          bgcolor: hasItems ? 'success.main' : 'text.disabled',
          flexShrink: 0,
        }} />
        <Typography sx={{ fontSize: '0.52rem', color: 'text.disabled', letterSpacing: '0.08em', lineHeight: 1 }}>
          {lastRefresh
            ? lastRefresh.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '…'}
        </Typography>
      </Box>
    </Box>
  )
}

export default function GlobalFeed() {
  const navigate  = useNavigate()
  const location  = useLocation()
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

  // Лоты: каждые 30 сек
  useEffect(() => {
    if (watchlist.length === 0) return
    loadAllLots()
    const t = setInterval(loadAllLots, 30_000)
    return () => clearInterval(t)
  }, [watchlist, loadAllLots])

  // Быстрый опрос пока есть непроверенные позиции
  useEffect(() => {
    const hasPending = watchlist.some(e => !e.last_successful_check)
    if (!hasPending) return
    const t = setInterval(() => loadWatchlistAndStats(true), 30_000)
    return () => clearInterval(t)
  }, [watchlist, loadWatchlistAndStats])

  // Скрываем на странице мониторинга
  if (location.pathname === '/app/monitoring') return null
  // До инициализации и при пустом вотчлисте — не занимаем место
  if (!initialized || watchlist.length === 0) return null

  console.log('[GlobalFeed] state:', { initialized, watchlistLen: watchlist.length, lastLotRefresh, feedItemsLen: feedItems.length })

  const handleClick = (id: number) => {
    navigate('/app/monitoring', { state: { scrollTo: id } })
  }

  // Лоты ещё грузятся — скелетон
  if (lastLotRefresh === null) {
    return (
      <Box sx={feedBarSx}>
        <FeedLabel lastRefresh={null} hasItems={false} />
        <Box sx={{ width: 1, height: 52, bgcolor: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
        <div style={{ display: 'flex', gap: 10, flex: 1, alignItems: 'center', overflow: 'hidden' }}>
          {[0, 1, 2, 3].map(i => (
            <Skeleton
              key={i}
              variant="rounded"
              width={172}
              height={62}
              sx={{ flexShrink: 0, bgcolor: 'rgba(255,255,255,0.05)', borderRadius: '10px' }}
            />
          ))}
        </div>
      </Box>
    )
  }

  // feedItems вычислены в сторе атомарно — нет выгодных позиций
  if (feedItems.length === 0) return null

  console.log('[GlobalFeed] rendering feedItems:', feedItems.length, feedItems)

  return (
    <Box sx={feedBarSx}>
      <FeedLabel lastRefresh={lastLotRefresh} hasItems={true} />

      {/* Разделитель */}
      <Box sx={{ width: 1, height: 52, bgcolor: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

      {/* DEBUG: plain divs to test visibility */}
      <div style={{ display: 'flex', gap: 10, flex: 1, alignItems: 'center', overflowX: 'auto', overflowY: 'hidden', height: FEED_HEIGHT }}>
        {feedItems.map(({ entry, count }) => (
          <div
            key={entry.id}
            onClick={() => handleClick(entry.id)}
            style={{
              width: 172, height: 62,
              background: 'red',
              color: 'white',
              fontSize: 13,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            {entry.name_ru || entry.item_id} ({count})
          </div>
        ))}
      </div>
    </Box>
  )
}
