import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Box, Avatar, Typography, Skeleton } from '@mui/material'
import { useFeedStore, QLT_NAMES, FEED_COMMISSION } from '../store/feedStore'
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
    watchlist, stats, lotsMap, lastLotRefresh, initialized,
    profitableItemIds, loadWatchlistAndStats, loadAllLots,
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

  const handleClick = (id: number) => {
    navigate('/app/monitoring', { state: { scrollTo: id } })
  }

  // Лоты ещё грузятся — скелетон
  if (lastLotRefresh === null) {
    return (
      <Box sx={feedBarSx}>
        <FeedLabel lastRefresh={null} hasItems={false} />
        <Box sx={{ width: 1, height: 52, bgcolor: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
        <Box sx={{ display: 'flex', gap: 1.25, overflowX: 'hidden', flex: 1 }}>
          {[0, 1, 2, 3].map(i => (
            <Skeleton
              key={i}
              variant="rounded"
              width={172}
              height={62}
              sx={{ flexShrink: 0, bgcolor: 'rgba(255,255,255,0.05)', borderRadius: '10px' }}
            />
          ))}
        </Box>
      </Box>
    )
  }

  // Лоты загружены, но выгодных нет — скрываем бар
  if (profitableItemIds.length === 0) return null

  // Вычисляем детальные данные только для выгодных позиций
  const feedItems = watchlist
    .filter(e => profitableItemIds.includes(e.id))
    .flatMap(entry => {
      const s    = stats[entry.id]
      const lots = lotsMap[entry.id]
      if (!s?.sell_options || !lots) return []
      const normal = s.sell_options.find(o => o.label === 'normal')
      if (!normal) return []
      const count = lots.filter(l => {
        if (l.is_expiring || l.buyout_price <= 0) return false
        if (entry.quality_filter !== null && l.quality_name !== QLT_NAMES[entry.quality_filter]) return false
        if (entry.enchant_filter !== null && l.enchant_level !== entry.enchant_filter) return false
        return Math.round(normal.price_per_unit * (1 - FEED_COMMISSION) - Math.floor(l.buyout_price / l.amount)) > 0
      }).length
      if (count === 0) return []
      return [{ entry, count }]
    })
    .sort((a, b) => b.count - a.count)

  // Промежуточное состояние: profitableItemIds устарел, lotsMap уже обновился
  if (feedItems.length === 0) return null

  return (
    <Box sx={feedBarSx}>
      <FeedLabel lastRefresh={lastLotRefresh} hasItems={feedItems.length > 0} />

      {/* Разделитель */}
      <Box sx={{ width: 1, height: 52, bgcolor: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

      {/* Карточки */}
      <Box sx={{
        display:    'flex',
        gap:        1.25,
        overflowX:  'auto',
        flex:       1,
        pb:         0.25,
        '&::-webkit-scrollbar':       { height: '3px' },
        '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.09)', borderRadius: '2px' },
      }}>
        {feedItems.map(({ entry, count }) => (
          <Box
            key={entry.id}
            onClick={() => handleClick(entry.id)}
            sx={{
              flexShrink:   0,
              width:        172,
              p:            '10px 10px 8px',
              borderRadius: '10px',
              border:       '1px solid rgba(62,213,152,0.3)',
              background:   'rgba(62,213,152,0.035)',
              cursor:       'pointer',
              transition:   'background 0.15s, border-color 0.15s, transform 0.1s',
              '&:hover': {
                background:  'rgba(62,213,152,0.09)',
                borderColor: 'rgba(62,213,152,0.65)',
                transform:   'translateY(-1px)',
              },
              '&:active': { transform: 'translateY(0)' },
            }}
          >
            {/* Иконка + название */}
            <Box sx={{ display: 'flex', gap: 0.875, alignItems: 'flex-start', mb: 0.625 }}>
              <Avatar
                src={iconUrl(entry.icon_path) ?? undefined}
                variant="rounded"
                sx={{
                  width: 30, height: 30, flexShrink: 0,
                  bgcolor:      'rgba(255,255,255,0.04)',
                  border:       '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '5px',
                  mt:           0.125,
                }}
              >
                {!entry.icon_path && (entry.name_ru?.[0] ?? '?')}
              </Avatar>
              <Typography sx={{
                fontSize:        '0.72rem',
                fontWeight:      600,
                lineHeight:      1.3,
                overflow:        'hidden',
                display:         '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                flex:            1,
              }}>
                {entry.name_ru || entry.name_en || entry.item_id}
              </Typography>
            </Box>

            {/* Качество + заточка + бейдж */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {entry.quality_filter !== null && (
                <Typography sx={{ fontSize: '0.6rem', color: 'primary.main', fontWeight: 600, lineHeight: 1 }}>
                  {QLT_NAMES[entry.quality_filter]}
                </Typography>
              )}
              {entry.enchant_filter !== null && (
                <Typography sx={{ fontSize: '0.62rem', color: 'primary.main', fontWeight: 700, lineHeight: 1 }}>
                  +{entry.enchant_filter}
                </Typography>
              )}
              <Box sx={{ ml: 'auto' }}>
                <Box sx={{
                  bgcolor:      'success.main',
                  color:        '#000',
                  borderRadius: '5px',
                  px:           0.875,
                  py:           0.25,
                  fontSize:     '0.68rem',
                  fontWeight:   700,
                  lineHeight:   1.45,
                }}>
                  {count}
                </Box>
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
