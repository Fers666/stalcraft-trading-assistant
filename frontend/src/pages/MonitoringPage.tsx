import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, List, ListItemButton, ListItemText, ListItemAvatar,
  Avatar, Chip, CircularProgress, Divider, Button, TextField, InputAdornment, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import LotStatCard from '../components/LotStatCard'
import SalesHistoryCharts from '../components/SalesHistoryCharts'
import api from '../api/client'
import { useFeedStore, type FeedWatchlistEntry } from '../store/feedStore'
import { useAuthStore } from '../store/authStore'
import { qualityColor } from '../utils/i18n'
import { tokens } from '../theme'

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

export default function MonitoringPage() {
  const location = useLocation()
  const navigate  = useNavigate()

  const {
    watchlist, initialized, loadWatchlistAndStats, removeEntry,
    minProfitMarginPercent, profitableItemIds,
  } = useFeedStore()
  const watchlistLimit = useAuthStore(s => s.user?.watchlist_limit ?? null)
  const isAtWatchlistLimit = watchlistLimit !== null && watchlist.length >= watchlistLimit

  const [selectedId, setSelectedId]   = useState<number | null>(null)
  const [deleteEntry, setDeleteEntry] = useState<FeedWatchlistEntry | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const itemRefs = useRef(new Map<number, HTMLElement>())
  const handledScrollKeyRef = useRef<string | null>(null)

  // Рекомендованные (выгодные) лоты — в начало списка
  const sortedWatchlist = [...watchlist].sort((a, b) => {
    const aRec = profitableItemIds.includes(a.id) ? 0 : 1
    const bRec = profitableItemIds.includes(b.id) ? 0 : 1
    return aRec - bRec
  })

  const matchesSearch = (entry: FeedWatchlistEntry, query: string) => {
    const q = query.trim().toLowerCase()
    if (!q) return false
    return (
      (entry.name_ru?.toLowerCase().includes(q) ?? false) ||
      (entry.name_en?.toLowerCase().includes(q) ?? false) ||
      entry.item_id.toLowerCase().includes(q)
    )
  }

  // При вводе поиска — скроллим к первому совпадению
  useEffect(() => {
    if (!searchQuery.trim()) return
    const match = sortedWatchlist.find(e => matchesSearch(e, searchQuery))
    if (match) {
      itemRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [searchQuery])

  useEffect(() => {
    if (!initialized) loadWatchlistAndStats()
  }, [initialized, loadWatchlistAndStats])

  // Начальный выбор: товар из сигнала ленты (scrollTo) или первый в списке
  useEffect(() => {
    if (sortedWatchlist.length === 0 || selectedId !== null) return
    const scrollTo = (location.state as { scrollTo?: number } | null)?.scrollTo
    const target = scrollTo != null && sortedWatchlist.some(e => e.id === scrollTo) ? scrollTo : sortedWatchlist[0].id
    setSelectedId(target)
  }, [sortedWatchlist, location.state, selectedId])

  // Клик по сигналу из ленты, когда страница уже открыта — переключаем выбор.
  // Привязано к location.key (уникален на каждую навигацию), а не к watchlist —
  // иначе периодическое обновление watchlist (каждые 5 мин из GlobalFeed) повторно
  // срабатывало на старый scrollTo и сбрасывало выбор пользователя обратно на сигнал.
  useEffect(() => {
    const scrollTo = (location.state as { scrollTo?: number } | null)?.scrollTo
    if (scrollTo == null || location.key === handledScrollKeyRef.current) return
    if (watchlist.some(e => e.id === scrollTo)) {
      handledScrollKeyRef.current = location.key
      setSelectedId(scrollTo)
    }
  }, [location, watchlist])

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

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', minHeight: 0 }}>

      {/* ── Центральная часть ───────────────────────────────────── */}
      <Box sx={{ flex: 1, minWidth: 0 }}>

        {/* Заголовок */}
        <Box sx={{ mb: 2.5 }}>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, lineHeight: 1, mb: 0.4 }}>
            ИЗБРАННОЕ
          </Typography>
          <Typography variant="h5" fontWeight={700} noWrap>
            {selected
              ? (selected.name_ru ?? selected.name_en ?? selected.item_id)
              : 'Избранное'}
          </Typography>
        </Box>

        {!initialized ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
            <CircularProgress />
          </Box>
        ) : watchlist.length === 0 ? (
          <Box sx={{ textAlign: 'center', mt: 8 }}>
            <Typography variant="h6" color="text.secondary">Избранное пусто</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Добавьте товары в разделе «Каталог», чтобы видеть статистику и историю продаж
            </Typography>
            <Button
              variant="contained" sx={{ mt: 2 }}
              onClick={() => navigate('/app/catalog')}
            >
              Перейти в Каталог
            </Button>
          </Box>
        ) : !selected ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Карточка статистики — на всю ширину центральной области */}
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

            {/* 4 графика истории продаж */}
            <Box>
              <SalesHistoryCharts
                itemId={selected.item_id}
                region={selected.region}
                qualityFilter={selected.quality_filter}
                enchantFilter={selected.enchant_filter}
              />
            </Box>
          </Box>
        )}
      </Box>

      {/* ── Правый sidebar — список избранного ──────────────────── */}
      <Box sx={{
        width: 260, flexShrink: 0,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        bgcolor: 'rgba(255,255,255,0.02)',
        overflow: 'hidden',
        position: 'sticky',
        top: '156px',
      }}>
        <Box sx={{ p: 1.5, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{
            fontSize: '0.6rem',
            color: isAtWatchlistLimit ? tokens.danger : (watchlistLimit !== null ? tokens.gold : 'text.disabled'),
            fontWeight: 600, letterSpacing: '0.1em', mb: 1,
          }}>
            ИЗБРАННОЕ · {watchlist.length}{watchlistLimit !== null ? `/${watchlistLimit}` : ''}
          </Typography>
          <TextField
            size="small"
            fullWidth
            placeholder="Поиск..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            slotProps={{
              input: {
                sx: { fontSize: '0.75rem', height: 32 },
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                  </InputAdornment>
                ),
                endAdornment: searchQuery && (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setSearchQuery('')} sx={{ p: 0.25 }}>
                      <ClearIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>

        {!initialized ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : (
          <List dense disablePadding sx={{
            maxHeight: 'calc(100vh - 200px)', overflowY: 'auto',
            scrollbarWidth: 'thin', scrollbarColor: 'rgba(217,175,55,0.45) transparent',
            '&::-webkit-scrollbar': { width: 8 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              background: `linear-gradient(180deg, ${tokens.goldSoft}, ${tokens.gold})`,
              borderRadius: '8px',
              border: `2px solid ${tokens.bg2}`,
              backgroundClip: 'padding-box',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: tokens.goldAccent,
              backgroundClip: 'padding-box',
            },
          }}>
            {sortedWatchlist.map((entry, idx) => {
              const isSelected  = entry.id === selectedId
              const isProfitable = profitableItemIds.includes(entry.id)
              const isMatch = matchesSearch(entry, searchQuery)
              return (
                <Box
                  key={entry.id}
                  ref={(el: HTMLElement | null) => {
                    if (el) itemRefs.current.set(entry.id, el)
                    else itemRefs.current.delete(entry.id)
                  }}
                >
                  {idx > 0 && <Divider sx={{ opacity: 0.3 }} />}
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => setSelectedId(entry.id)}
                    sx={{
                      py: 0.75, px: 1.5,
                      borderLeft: isProfitable && !isSelected ? '2px solid #4caf50' : '2px solid transparent',
                      bgcolor: isProfitable && !isSelected ? 'rgba(76,175,80,0.04)' : undefined,
                      outline: isMatch ? '1px solid #D9AF37' : 'none',
                      outlineOffset: '-1px',
                      ...(isMatch ? { bgcolor: 'rgba(217,175,55,0.12)' } : {}),
                      '&.Mui-selected': {
                        bgcolor: 'rgba(217,175,55,0.08)',
                        borderLeft: '2px solid #D9AF37',
                      },
                      '&.Mui-selected:hover': { bgcolor: 'rgba(217,175,55,0.12)' },
                      '&:hover': isProfitable && !isSelected ? { bgcolor: 'rgba(76,175,80,0.08)' } : {},
                    }}
                  >
                    <ListItemAvatar sx={{ minWidth: 36 }}>
                      <Avatar
                        variant="rounded"
                        sx={{
                          width: 28, height: 28, borderRadius: '5px',
                          bgcolor: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          fontSize: '0.7rem', color: '#7C7C7C',
                          fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
                        }}
                      >
                        {(entry.name_ru ?? entry.name_en ?? String(entry.item_id))?.[0]?.toUpperCase() ?? '?'}
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          {isProfitable && (
                            <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#4caf50', flexShrink: 0 }} />
                          )}
                        <Typography sx={{ fontSize: '0.72rem', fontWeight: isSelected ? 700 : 400, color: isSelected ? 'primary.main' : isProfitable ? '#4caf50' : 'text.primary' }} noWrap>
                          {entry.name_ru ?? entry.name_en ?? entry.item_id}
                          {entry.enchant_filter != null && entry.enchant_filter > 0 && (
                            <Typography component="span" sx={{ ml: 0.5, fontSize: '0.65rem', color: 'primary.main', fontWeight: 700 }}>
                              +{entry.enchant_filter}
                            </Typography>
                          )}
                        </Typography>
                        </Box>
                      }
                      secondary={
                        <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.2 }}>
                          <Chip label={entry.region} size="small" variant="outlined" sx={{ height: 13, fontSize: 9 }} />
                          {entry.quality_filter !== null && (
                            <Chip
                              label={QLT_NAMES[entry.quality_filter] ?? `qlt${entry.quality_filter}`}
                              size="small" variant="outlined"
                              sx={{
                                height: 13, fontSize: 9,
                                borderColor: qualityColor(QLT_NAMES[entry.quality_filter]) ?? undefined,
                                color: qualityColor(QLT_NAMES[entry.quality_filter]) ?? undefined,
                              }}
                            />
                          )}
                        </Box>
                      }
                    />
                  </ListItemButton>
                </Box>
              )
            })}
          </List>
        )}
      </Box>

      {/* Диалог удаления из Избранного */}
      <Dialog
        open={!!deleteEntry}
        onClose={() => setDeleteEntry(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Typography fontWeight={700}>Удалить из Избранного?</Typography>
          <Typography variant="caption" color="text.secondary">
            {deleteEntry?.name_ru || deleteEntry?.item_id}
            {deleteEntry?.quality_filter != null ? ` · кач. ${deleteEntry.quality_filter}` : ''}
            {deleteEntry?.enchant_filter != null ? ` · +${deleteEntry.enchant_filter}` : ''}
            {deleteEntry ? ` · ${deleteEntry.region}` : ''}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <Typography variant="body2" color="text.secondary">
            Товар будет удалён из мониторинга. Вы сможете добавить его снова из Каталога.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteEntry(null)} color="inherit">Отмена</Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteConfirm}
          >
            Удалить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
