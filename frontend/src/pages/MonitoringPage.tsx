import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, List, ListItemButton, ListItemText, ListItemAvatar,
  Chip, Skeleton, Divider, Button, TextField, InputAdornment, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Tooltip,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import LotStatCard from '../components/LotStatCard'
import ItemIcon from '../components/ui/ItemIcon'
import Kick from '../components/ui/Kick'
import { useToast } from '../components/ui/Toast'
import api from '../api/client'
import { useFeedStore, type FeedWatchlistEntry } from '../store/feedStore'
import { useAuthStore } from '../store/authStore'
import { qualityColor, iconUrl } from '../utils/i18n'
import { tokens, fs } from '../theme'

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

// Обезличенная подсказка для пустого «Избранного» (GET /watchlist/suggestions) —
// без числовых счётчиков, только мягкие флаги has_profitable/is_popular.
interface Suggestion {
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  has_profitable: boolean
  is_popular: boolean
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const matchesSearch = (entry: FeedWatchlistEntry, query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    (entry.name_ru?.toLowerCase().includes(q) ?? false) ||
    (entry.name_en?.toLowerCase().includes(q) ?? false) ||
    entry.item_id.toLowerCase().includes(q)
  )
}

export default function MonitoringPage() {
  const location = useLocation()
  const navigate  = useNavigate()

  const {
    watchlist, initialized, loadWatchlistAndStats, removeEntry,
    minProfitMarginPercent, profitableItemIds, feedItems,
  } = useFeedStore()

  // Число выгодных лотов на предмет (для бейджа .f-sig «+N» в сайдбаре).
  // feedItems наполняется поллингом GlobalFeed (loadAllLots) из того же
  // источника signals, что и profitableItemIds — счётчики согласованы.
  const goodCountById = useMemo(() => {
    const m = new Map<number, number>()
    for (const fi of feedItems) m.set(fi.entry.id, fi.count)
    return m
  }, [feedItems])
  const watchlistLimit = useAuthStore(s => s.user?.watchlist_limit ?? null)
  const hasFavoritesOverride = useAuthStore(s => s.user?.favorites_limit_override != null)
  const isAtWatchlistLimit = watchlistLimit !== null && watchlist.length >= watchlistLimit

  const [selectedId, setSelectedId]   = useState<number | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<FeedWatchlistEntry | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const itemRefs = useRef(new Map<number, HTMLElement>())
  const handledScrollKeyRef = useRef<string | null>(null)

  // Рекомендованные (выгодные) — наверх. Порядок пересчитывается только при
  // изменении состава избранного (явное действие), НЕ при 30-сек поллинге
  // profitableItemIds — иначе список тасуется под рукой (§5.1).
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

  // Начальный выбор: товар из сигнала ленты (scrollTo, по watchlist-id),
  // либо предмет из Радара «Карточка» (item_id + quality/enchant), либо первый.
  useEffect(() => {
    if (sortedWatchlist.length === 0 || selectedId !== null) return
    const state = location.state as {
      scrollTo?: number; item_id?: string; quality_filter?: number | null; enchant_filter?: number | null
    } | null
    const scrollTo = state?.scrollTo
    let target: number | null = null
    if (scrollTo != null && sortedWatchlist.some(e => e.id === scrollTo)) {
      target = scrollTo
    } else if (state?.item_id) {
      const byId = sortedWatchlist.filter(e => e.item_id === state.item_id)
      const exact = byId.find(e =>
        (state.quality_filter == null || e.quality_filter === state.quality_filter) &&
        (state.enchant_filter == null || e.enchant_filter === state.enchant_filter),
      )
      target = (exact ?? byId[0])?.id ?? null
    }
    setSelectedId(target ?? sortedWatchlist[0].id)
  }, [sortedWatchlist, location.state, selectedId])

  // Клик по сигналу из ленты, когда страница уже открыта — переключаем выбор.
  useEffect(() => {
    const scrollTo = (location.state as { scrollTo?: number } | null)?.scrollTo
    if (scrollTo == null || location.key === handledScrollKeyRef.current) return
    if (watchlist.some(e => e.id === scrollTo)) {
      handledScrollKeyRef.current = location.key
      setSelectedId(scrollTo)
    }
  }, [location, watchlist])

  // scroll-к-выбранному предмету (напр. переход из ленты) — уважая reduced-motion (§3.4)
  useEffect(() => {
    if (selectedId == null) return
    const el = itemRefs.current.get(selectedId)
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' })
  }, [selectedId])

  const selected = watchlist.find(e => e.id === selectedId) ?? null

  const handleViewLots = () => {
    if (!selected) return
    navigate('/app/lots', {
      state: {
        item_id: selected.item_id,
        name_ru: selected.name_ru,
        name_en: selected.name_en,
        icon_path: selected.icon_path,
        region: selected.region,
        quality_filter: selected.quality_filter,
        enchant_filter: selected.enchant_filter,
      },
    })
  }

  const handleDeleteConfirm = async () => {
    if (!deleteEntry) return
    await api.delete(`/watchlist/${deleteEntry.id}`)
    removeEntry(deleteEntry.id)
    if (selectedId === deleteEntry.id) {
      const remaining = sortedWatchlist.filter(e => e.id !== deleteEntry.id)
      setSelectedId(remaining[0]?.id ?? null)
    }
    setDeleteEntry(null)
  }

  // ── Онбординг пустого «Избранного»: подсказки предметов ────────────────────
  const { showToast } = useToast()
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [addingItemId, setAddingItemId] = useState<string | null>(null)
  const isEmpty = initialized && watchlist.length === 0

  useEffect(() => {
    // Список стал непустым — сбрасываем подсказки, чтобы при возврате в пустое
    // состояние (удалили всё обратно) они перезапросились, а не остались устаревшими.
    if (!isEmpty) {
      if (suggestions !== null) setSuggestions(null)
      return
    }
    if (suggestions !== null) return
    let cancelled = false
    api.get<Suggestion[]>('/watchlist/suggestions')
      .then(({ data }) => { if (!cancelled) setSuggestions(data) })
      .catch(() => { if (!cancelled) setSuggestions([]) })
    return () => { cancelled = true }
  }, [isEmpty, suggestions])

  const handleAddSuggestion = async (s: Suggestion) => {
    setAddingItemId(s.item_id)
    try {
      await api.post('/watchlist/', { item_id: s.item_id, region: 'RU' })
      showToast(`«${s.name_ru || s.name_en || s.item_id}» добавлен в избранное (RU)`)
      setSuggestions(prev => prev?.filter(x => x.item_id !== s.item_id) ?? null)
      await loadWatchlistAndStats()
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) {
        // уже в избранном — просто убираем карточку
        setSuggestions(prev => prev?.filter(x => x.item_id !== s.item_id) ?? null)
      } else {
        const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        showToast(msg || 'Ошибка добавления')
      }
    } finally {
      setAddingItemId(null)
    }
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', minHeight: 0 }}>

      {/* ── Центральная часть ───────────────────────────────────── */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {!initialized ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <Skeleton variant="rectangular" height={220} sx={{ bgcolor: tokens.bg2 }} />
            <Skeleton variant="rectangular" height={280} sx={{ bgcolor: tokens.bg2 }} />
          </Box>
        ) : watchlist.length === 0 ? (
          <Box sx={{ maxWidth: 760, mx: 'auto', mt: 6, px: 2 }}>
            {/* Объяснитель механики — закрывает «непонятно, как работает Избранное» */}
            <Box sx={{ textAlign: 'center', mb: 3 }}>
              <Kick sx={{ color: tokens.gold }}>Избранное пусто</Kick>
              <Typography sx={{
                fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16,
                color: tokens.text0, letterSpacing: '0.04em', mt: 1, mb: 1,
              }}>
                Отслеживай товар — портал сам находит выгодные лоты
              </Typography>
              <Typography sx={{ fontFamily: tokens.fontUi, fontSize: fs.f13, color: tokens.text1, lineHeight: 1.6 }}>
                Добавь предмет в Избранное → мы следим за аукционом и считаем прибыль от&nbsp;перепродажи →
                сигнал о выгодном лоте приходит в ленту.
              </Typography>
            </Box>

            {/* Подсказки предметов с добавлением в один клик */}
            <Kick sx={{ display: 'block', mb: 1.5 }}>Начни с популярного</Kick>
            {suggestions === null ? (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} variant="rectangular" height={56} sx={{ bgcolor: tokens.bg2 }} />
                ))}
              </Box>
            ) : suggestions.length > 0 ? (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}>
                {suggestions.map((s) => {
                  const name = s.name_ru || s.name_en || s.item_id
                  const badge = s.has_profitable
                    ? { label: 'Есть выгодные лоты', color: tokens.goldAccent, bg: tokens.goldDim, border: tokens.goldLine }
                    : s.is_popular
                      ? { label: 'Популярное', color: tokens.text1, bg: tokens.bg2, border: tokens.borderHi }
                      : null
                  return (
                    <Box key={s.item_id} sx={{
                      display: 'flex', alignItems: 'center', gap: 1, p: 1,
                      background: tokens.bg1, border: `1px solid ${tokens.border}`,
                      borderRadius: `${tokens.radiusLg / 2}px`,
                    }}>
                      <ItemIcon src={iconUrl(s.icon_path) ?? undefined} name={name} size={32} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography sx={{
                          fontFamily: tokens.fontUi, fontSize: fs.f125, fontWeight: 600, color: tokens.text0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {name}
                        </Typography>
                        {badge && (
                          <Box component="span" sx={{
                            display: 'inline-block', mt: 0.25, px: 0.5, py: '1px',
                            fontFamily: tokens.fontUi, fontSize: fs.f10, letterSpacing: '0.03em',
                            color: badge.color, background: badge.bg,
                            border: `1px solid ${badge.border}`, borderRadius: `${tokens.radiusLg / 2}px`,
                          }}>
                            {badge.label}
                          </Box>
                        )}
                      </Box>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={addingItemId === s.item_id}
                        onClick={() => handleAddSuggestion(s)}
                        sx={{ flexShrink: 0, minWidth: 88 }}
                      >
                        {addingItemId === s.item_id ? 'Добавляю…' : 'Добавить'}
                      </Button>
                    </Box>
                  )
                })}
              </Box>
            ) : (
              <Typography sx={{ fontFamily: tokens.fontUi, fontSize: fs.f13, color: tokens.text2, textAlign: 'center', py: 2 }}>
                Пока нечего предложить — открой каталог и выбери предмет вручную.
              </Typography>
            )}

            {/* Вторичный путь — весь каталог */}
            <Box sx={{ textAlign: 'center', mt: 3 }}>
              <Button variant="text" onClick={() => navigate('/app/catalog')}>
                Смотреть весь каталог →
              </Button>
            </Box>
          </Box>
        ) : !selected ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <Skeleton variant="rectangular" height={220} sx={{ bgcolor: tokens.bg2 }} />
            <Skeleton variant="rectangular" height={280} sx={{ bgcolor: tokens.bg2 }} />
          </Box>
        ) : (
          <LotStatCard
            itemId={selected.item_id}
            region={selected.region}
            qualityFilter={selected.quality_filter}
            enchantFilter={selected.enchant_filter}
            itemName={selected.name_ru ?? selected.name_en ?? selected.item_id}
            iconPath={selected.icon_path}
            minProfitMarginPercent={minProfitMarginPercent}
            fullWidth
            onViewLots={handleViewLots}
            onDelete={() => setDeleteEntry(selected)}
          />
        )}
      </Box>

      {/* ── Правый sidebar — список избранного ──────────────────── */}
      <Box sx={{
        width: 272, flexShrink: 0,
        border: `1px solid ${tokens.border}`,
        borderRadius: `${tokens.radiusLg / 2}px`,
        background: tokens.bg1,
        overflow: 'hidden',
        position: 'sticky',
        top: 'var(--sc-top-offset, 156px)',
        maxHeight: 'calc(100vh - var(--sc-top-offset, 156px) - 16px)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <Box sx={{ p: 1.5, borderBottom: `1px solid ${tokens.border}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
            <Kick sx={{ color: isAtWatchlistLimit ? tokens.danger : (watchlistLimit !== null ? tokens.goldAccent : tokens.text2) }}>
              Избранное · {watchlist.length}{watchlistLimit !== null ? `/${watchlistLimit}` : ''}
            </Kick>
            {hasFavoritesOverride && (
              <Tooltip title="Администратор установил индивидуальный лимит избранного">
                <Chip
                  label="Расширенный лимит"
                  size="small"
                  color="primary"
                  sx={{ height: 18, fontSize: fs.f10, '& .MuiChip-label': { px: 0.75 } }}
                />
              </Tooltip>
            )}
          </Box>
          <TextField
            size="small"
            fullWidth
            placeholder="Поиск по имени…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            slotProps={{
              input: {
                sx: { fontSize: fs.f125, height: 34 },
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16, color: tokens.text2 }} />
                  </InputAdornment>
                ),
                endAdornment: searchQuery ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setSearchQuery('')} sx={{ p: 0.25 }} aria-label="Очистить поиск">
                      <ClearIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
        </Box>

        {!initialized ? (
          <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rectangular" height={42} sx={{ bgcolor: tokens.bg2 }} />
            ))}
          </Box>
        ) : visibleWatchlist.length === 0 ? (
          <Box sx={{ p: '18px 12px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12 }}>
            {searchQuery.trim()
              ? <>Ничего не найдено по запросу «{searchQuery.trim()}». Проверь написание или сбрось поиск.</>
              : 'Список пуст.'}
          </Box>
        ) : (
          <List dense disablePadding sx={{
            overflowY: 'auto',
            scrollbarWidth: 'thin', scrollbarColor: `${tokens.goldSoft} transparent`,
            '&::-webkit-scrollbar': { width: 8 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: `linear-gradient(180deg, ${tokens.goldSoft}, ${tokens.gold})`,
              border: `2px solid ${tokens.bg2}`,
              backgroundClip: 'padding-box',
            },
          }}>
            {visibleWatchlist.map((entry, idx) => {
              const isSelected = entry.id === selectedId
              const goodCount  = goodCountById.get(entry.id) ?? 0
              return (
                <Box
                  key={entry.id}
                  ref={(el: HTMLElement | null) => {
                    if (el) itemRefs.current.set(entry.id, el)
                    else itemRefs.current.delete(entry.id)
                  }}
                >
                  {idx > 0 && <Divider sx={{ opacity: 0.4 }} />}
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => setSelectedId(entry.id)}
                    sx={{
                      py: 0.75, px: 1.25,
                      borderLeft: '2px solid transparent',
                      transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                      '&:hover': { background: tokens.bg2 },
                      '&:active': { background: tokens.bg3 },
                      '&.Mui-selected': { background: tokens.goldDim, borderLeftColor: tokens.goldHighlight },
                      '&.Mui-selected:hover': { background: tokens.goldDim },
                    }}
                  >
                    <ListItemAvatar sx={{ minWidth: 36 }}>
                      <ItemIcon
                        src={iconUrl(entry.icon_path) ?? undefined}
                        name={entry.name_ru ?? entry.name_en ?? String(entry.item_id)}
                        size={28}
                      />
                    </ListItemAvatar>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                          <Typography noWrap sx={{
                            fontSize: fs.f125,
                            fontWeight: isSelected ? 700 : 500,
                            color: isSelected ? tokens.goldAccent : tokens.text0,
                          }}>
                            {entry.name_ru ?? entry.name_en ?? entry.item_id}
                            {entry.enchant_filter != null && entry.enchant_filter > 0 && (
                              <Box component="span" className="mono" sx={{ ml: 0.5, fontSize: fs.f105, color: tokens.goldAccent, fontWeight: 700 }}>
                                +{entry.enchant_filter}
                              </Box>
                            )}
                          </Typography>
                        </Box>
                      }
                      secondary={
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.25 }}>
                          <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{entry.region}</Box>
                          {entry.quality_filter !== null && (
                            <Box component="span" sx={{ fontSize: fs.f105, fontWeight: 600, color: qualityColor(QLT_NAMES[entry.quality_filter]) ?? tokens.text2 }}>
                              {QLT_NAMES[entry.quality_filter] ?? `кач. ${entry.quality_filter}`}
                            </Box>
                          )}
                        </Box>
                      }
                    />
                    {/* .f-right — выгодность показывается только здесь (не красит строку) */}
                    {goodCount > 0 && (
                      <Box sx={{ flex: 'none', textAlign: 'right', ml: 1 }}>
                        <Box
                          component="span"
                          className="mono"
                          title="Выгодных лотов"
                          sx={{
                            display: 'inline-block', fontSize: fs.f105, fontWeight: 700,
                            color: tokens.success, background: tokens.successDim,
                            border: `1px solid ${tokens.successLine}`,
                            px: '5px', borderRadius: `${tokens.radiusLg / 2}px`,
                          }}
                        >
                          +{goodCount}
                        </Box>
                      </Box>
                    )}
                  </ListItemButton>
                </Box>
              )
            })}
          </List>
        )}
      </Box>

      {/* Диалог удаления из Избранного — единственный допустимый случай модалки
          (потеря истории наблюдения невосстановима, §5.1) */}
      <Dialog open={!!deleteEntry} onClose={() => setDeleteEntry(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          <Typography fontWeight={700}>Убрать из Избранного?</Typography>
          <Typography variant="caption" color="text.secondary">
            {deleteEntry?.name_ru || deleteEntry?.item_id}
            {deleteEntry?.quality_filter != null ? ` · ${QLT_NAMES[deleteEntry.quality_filter] ?? `кач. ${deleteEntry.quality_filter}`}` : ''}
            {deleteEntry?.enchant_filter != null ? ` · +${deleteEntry.enchant_filter}` : ''}
            {deleteEntry ? ` · ${deleteEntry.region}` : ''}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Typography variant="body2" color="text.secondary">
            Товар и его история наблюдения будут удалены из мониторинга. Ты сможешь добавить его снова из Каталога.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteEntry(null)} color="inherit">Отмена</Button>
          <Button variant="contained" color="error" onClick={handleDeleteConfirm}>Убрать</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
