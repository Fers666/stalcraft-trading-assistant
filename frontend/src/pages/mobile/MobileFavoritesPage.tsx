import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Skeleton, TextField, InputAdornment, IconButton } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import ArrowBackIcon from '@mui/icons-material/ArrowBackIosNew'
import api from '../../api/client'
import { useFeedStore, QLT_NAMES, type FeedWatchlistEntry } from '../../store/feedStore'
import { useAuthStore } from '../../store/authStore'
import { qualityColor, iconUrl } from '../../utils/i18n'
import { tokens, fs } from '../../theme'
import Kick from '../../components/ui/Kick'
import ItemIcon from '../../components/ui/ItemIcon'
import ArmDeleteButton from '../../components/ui/ArmDeleteButton'
import DCard from '../../components/mobile/ui/DCard'
import MobileLotStatCard from '../../components/mobile/MobileLotStatCard'

// Избранное (мобайл) — master-detail: список избранного (.dcard + поиск) ⇄
// карточка предмета. Тот же дата-слой, что десктопный MonitoringPage (feedStore),
// расчёт карточки — через MobileLotStatCard/useLotStats. Выбор из ленты сигналов
// приходит через location.state.scrollTo (как GlobalFeed → MonitoringPage).

const matchesSearch = (entry: FeedWatchlistEntry, query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    (entry.name_ru?.toLowerCase().includes(q) ?? false) ||
    (entry.name_en?.toLowerCase().includes(q) ?? false) ||
    entry.item_id.toLowerCase().includes(q)
  )
}

const nameOf = (e: FeedWatchlistEntry) => e.name_ru ?? e.name_en ?? e.item_id

export default function MobileFavoritesPage() {
  const location = useLocation()
  const navigate = useNavigate()

  const {
    watchlist, initialized, loadWatchlistAndStats, removeEntry,
    minProfitMarginPercent, profitableItemIds, feedItems,
  } = useFeedStore()

  const watchlistLimit = useAuthStore(s => s.user?.watchlist_limit ?? null)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const handledScrollKeyRef = useRef<string | null>(null)

  const goodCountById = useMemo(() => {
    const m = new Map<number, number>()
    for (const fi of feedItems) m.set(fi.entry.id, fi.count)
    return m
  }, [feedItems])

  // Выгодные — наверх; порядок пересчитывается только при изменении состава.
  const sortedWatchlist = useMemo(() => {
    return [...watchlist].sort((a, b) => {
      const aRec = profitableItemIds.includes(a.id) ? 0 : 1
      const bRec = profitableItemIds.includes(b.id) ? 0 : 1
      return aRec - bRec
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist])

  const visibleWatchlist = useMemo(
    () => sortedWatchlist.filter(e => matchesSearch(e, searchQuery)),
    [sortedWatchlist, searchQuery],
  )

  useEffect(() => {
    if (!initialized) loadWatchlistAndStats()
  }, [initialized, loadWatchlistAndStats])

  // Выбор из сигнала ленты (scrollTo) или из Радара «Карточка» (item_id) → detail.
  useEffect(() => {
    const state = location.state as {
      scrollTo?: number; item_id?: string; quality_filter?: number | null; enchant_filter?: number | null
    } | null
    if (!state || location.key === handledScrollKeyRef.current) return
    let target: number | null = null
    if (state.scrollTo != null && watchlist.some(e => e.id === state.scrollTo)) {
      target = state.scrollTo
    } else if (state.item_id) {
      const byId = watchlist.filter(e => e.item_id === state.item_id)
      const exact = byId.find(e =>
        (state.quality_filter == null || e.quality_filter === state.quality_filter) &&
        (state.enchant_filter == null || e.enchant_filter === state.enchant_filter),
      )
      target = (exact ?? byId[0])?.id ?? null
    }
    if (target != null) {
      handledScrollKeyRef.current = location.key
      setSelectedId(target)
    }
  }, [location, watchlist])

  const selected = watchlist.find(e => e.id === selectedId) ?? null

  const handleDelete = async () => {
    if (!selected) return
    await api.delete(`/watchlist/${selected.id}`)
    removeEntry(selected.id)
    setSelectedId(null)
  }

  // ── DETAIL ─────────────────────────────────────────────────
  if (selected) {
    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', pb: '12px' }}>
          <Button
            onClick={() => setSelectedId(null)}
            startIcon={<ArrowBackIcon sx={{ fontSize: '13px !important' }} />}
            sx={{
              minHeight: 40, px: '12px', color: tokens.text1, background: tokens.bg2,
              border: `1px solid ${tokens.border}`, borderRadius: '2px',
              fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f12, letterSpacing: '0.05em',
              '&:hover': { background: tokens.bg3 },
            }}
          >
            К списку
          </Button>
          <ArmDeleteButton
            onConfirm={handleDelete}
            label="Убрать"
            armedLabel="Точно убрать?"
            aria-label={`Убрать «${nameOf(selected)}» из Избранного`}
            sx={{ ml: 'auto', minHeight: 40 }}
          />
        </Box>

        <MobileLotStatCard
          itemId={selected.item_id}
          region={selected.region}
          qualityFilter={selected.quality_filter}
          enchantFilter={selected.enchant_filter}
          itemName={nameOf(selected)}
          iconPath={selected.icon_path}
          minProfitMarginPercent={minProfitMarginPercent}
        />
      </Box>
    )
  }

  // ── LIST ───────────────────────────────────────────────────
  return (
    <Box>
      <Box sx={{ pb: '12px' }}>
        <Kick sx={{ color: watchlistLimit !== null ? tokens.goldAccent : tokens.text2 }}>
          Избранное · {watchlist.length}{watchlistLimit !== null ? `/${watchlistLimit}` : ''}
        </Kick>
        <Typography sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}>
          Твои предметы
        </Typography>
      </Box>

      <TextField
        size="small"
        fullWidth
        placeholder="Поиск по имени…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        sx={{ mb: '12px' }}
        slotProps={{
          input: {
            sx: { fontSize: '16px', height: 46 },
            startAdornment: (
              <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: tokens.text2 }} /></InputAdornment>
            ),
            endAdornment: searchQuery ? (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setSearchQuery('')} aria-label="Очистить поиск"><ClearIcon sx={{ fontSize: 16 }} /></IconButton>
              </InputAdornment>
            ) : undefined,
          },
        }}
      />

      {!initialized ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} variant="rectangular" height={62} sx={{ bgcolor: tokens.bg2 }} />
          ))}
        </Box>
      ) : watchlist.length === 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', textAlign: 'center', p: '40px 24px', minHeight: 220 }}>
          <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.1em', textTransform: 'uppercase', color: tokens.text1 }}>
            Избранное пусто
          </Box>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, maxWidth: '46ch' }}>
            Добавь предметы из Каталога — здесь появится их аналитика: медиана, графики, выгодные лоты.
          </Typography>
          <Button variant="contained" onClick={() => navigate('/app/catalog')} sx={{ mt: '4px' }}>Перейти в Каталог</Button>
        </Box>
      ) : visibleWatchlist.length === 0 ? (
        <Box sx={{ p: '24px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>
          Ничего не найдено по «{searchQuery.trim()}». Проверь написание или сбрось поиск.
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visibleWatchlist.map((entry) => {
            const goodCount = goodCountById.get(entry.id) ?? 0
            const qName = entry.quality_filter !== null ? (QLT_NAMES[entry.quality_filter] ?? `кач. ${entry.quality_filter}`) : null
            const qCol = entry.quality_filter !== null ? (qualityColor(QLT_NAMES[entry.quality_filter]) ?? tokens.text2) : tokens.text2
            return (
              <DCard
                key={entry.id}
                onClick={() => { setSelectedId(entry.id); window.scrollTo(0, 0) }}
                icon={<ItemIcon src={iconUrl(entry.icon_path) ?? undefined} name={nameOf(entry)} size={32} />}
                name={
                  <>
                    {nameOf(entry)}
                    {entry.enchant_filter != null && entry.enchant_filter > 0 && (
                      <Box component="span" className="mono" sx={{ ml: 0.5, color: tokens.goldAccent, fontWeight: 700 }}>+{entry.enchant_filter}</Box>
                    )}
                  </>
                }
                sub={
                  <Box component="span">
                    {entry.region}
                    {qName && <Box component="span" sx={{ ml: '6px', color: qCol, fontWeight: 600 }}>{qName}</Box>}
                  </Box>
                }
                right={goodCount > 0
                  ? <Box className="mono" sx={{ fontSize: fs.f105, fontWeight: 700, color: tokens.success, background: tokens.successDim, border: `1px solid ${tokens.successLine}`, px: '5px', borderRadius: '2px' }}>+{goodCount}</Box>
                  : undefined}
              />
            )
          })}
        </Box>
      )}
    </Box>
  )
}
