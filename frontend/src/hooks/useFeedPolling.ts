import { useEffect } from 'react'
import { useFeedStore, type FeedItem, type FeedWatchlistEntry } from '../store/feedStore'

// Единый дата-слой ленты сигналов — извлечён из GlobalFeed без изменения логики.
// Три интервала опроса переносятся ДОСЛОВНО (частота Stalcraft API не меняется):
//   • stats (watchlist + настройки) — каждые 5 мин
//   • лоты (сигналы) — каждые 30 сек
//   • быстрый опрос, пока есть непроверенные позиции — каждые 30 сек
// За раз смонтирована ровно одна оболочка (десктоп GlobalFeed ИЛИ мобильный
// MobileSignals) → суммарная нагрузка на API не растёт.
export interface FeedPollingData {
  watchlist: FeedWatchlistEntry[]
  feedItems: FeedItem[]
  lastLotRefresh: Date | null
  initialized: boolean
}

export function useFeedPolling(): FeedPollingData {
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
    const hasPending = watchlist.some((e) => !e.last_successful_check)
    if (!hasPending) return
    const t = setInterval(() => loadWatchlistAndStats(true), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistIds, loadWatchlistAndStats])

  return { watchlist, feedItems, lastLotRefresh, initialized }
}
