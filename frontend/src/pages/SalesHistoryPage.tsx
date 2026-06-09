import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, List, ListItemButton, ListItemText, ListItemAvatar,
  Avatar, Chip, CircularProgress, Divider, Button, IconButton, Tooltip,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import SearchIcon from '@mui/icons-material/Search'
import LotStatCard from '../components/LotStatCard'
import SalesHistoryCharts from '../components/SalesHistoryCharts'
import { useFeedStore } from '../store/feedStore'
import { iconUrl } from '../utils/i18n'

interface LocationState {
  itemId?: string
  region?: string
  qualityFilter?: number | null
  enchantFilter?: number | null
  itemName?: string
}

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

export default function SalesHistoryPage() {
  const location = useLocation()
  const navigate  = useNavigate()
  const incoming  = (location.state ?? {}) as LocationState

  const { watchlist, initialized, loadWatchlistAndStats, minProfitMarginPercent, profitableItemIds } = useFeedStore()

  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    if (!initialized) loadWatchlistAndStats()
  }, [initialized, loadWatchlistAndStats])

  useEffect(() => {
    if (watchlist.length === 0) return
    if (selectedId !== null) return

    if (incoming.itemId) {
      const match = watchlist.find(e =>
        e.item_id === incoming.itemId &&
        e.region === (incoming.region ?? e.region) &&
        e.quality_filter === (incoming.qualityFilter ?? null) &&
        e.enchant_filter === (incoming.enchantFilter ?? null)
      )
      if (match) { setSelectedId(match.id); return }
    }
    setSelectedId(watchlist[0].id)
  }, [watchlist, incoming, selectedId])

  const selected = watchlist.find(e => e.id === selectedId) ?? null

  const handleViewLots = () => {
    if (!selected) return
    navigate('/app/lots', {
      state: {
        item_id: selected.item_id,
        region: selected.region,
        name_ru: selected.name_ru,
      },
    })
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', minHeight: 0 }}>

      {/* ── Центральная часть ───────────────────────────────────── */}
      <Box sx={{ flex: 1, minWidth: 0 }}>

        {/* Заголовок с кнопками */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2.5 }}>
          <Tooltip title="Назад в Избранное">
            <IconButton
              size="small"
              onClick={() => navigate('/app/monitoring')}
              sx={{ color: 'text.secondary', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 1 }}
            >
              <ArrowBackIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>

          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, lineHeight: 1, mb: 0.4 }}>
              ИСТОРИЯ ПРОДАЖ
            </Typography>
            <Typography variant="h5" fontWeight={700} noWrap>
              {selected
                ? (selected.name_ru ?? selected.name_en ?? selected.item_id)
                : 'История продаж'}
            </Typography>
          </Box>

          {selected && (
            <Tooltip title="Все лоты этого предмета">
              <Button
                variant="outlined"
                size="small"
                startIcon={<SearchIcon sx={{ fontSize: 14 }} />}
                onClick={handleViewLots}
                sx={{
                  flexShrink: 0,
                  fontSize: '0.7rem', height: 28,
                  borderColor: 'rgba(255,255,255,0.15)',
                  color: 'text.secondary',
                  '&:hover': { borderColor: 'rgba(255,255,255,0.3)' },
                }}
              >
                Все лоты
              </Button>
            </Tooltip>
          )}
        </Box>

        {!initialized ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
            <CircularProgress />
          </Box>
        ) : watchlist.length === 0 ? (
          <Box sx={{ textAlign: 'center', mt: 8 }}>
            <Typography variant="h6" color="text.secondary">Избранное пусто</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Добавьте товары в разделе «Каталог», чтобы видеть историю продаж
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
            />

            {/* 4 графика истории продаж */}
            <Box>
              <Typography sx={{ fontSize: '0.65rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em', mb: 2 }}>
                ИСТОРИЯ ПРОДАЖ
              </Typography>
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

      {/* ── Правый sidebar — список лотов ───────────────────────── */}
      <Box sx={{
        width: 260, flexShrink: 0,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        bgcolor: 'rgba(255,255,255,0.02)',
        overflow: 'hidden',
        position: 'sticky',
        top: 16,
      }}>
        <Box sx={{ p: 1.5, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', fontWeight: 600, letterSpacing: '0.1em' }}>
            ИЗБРАННОЕ · {watchlist.length}
          </Typography>
        </Box>

        {!initialized ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : (
          <List dense disablePadding sx={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
            {watchlist.map((entry, idx) => {
              const isSelected  = entry.id === selectedId
              const isProfitable = profitableItemIds.includes(entry.id)
              return (
                <Box key={entry.id}>
                  {idx > 0 && <Divider sx={{ opacity: 0.3 }} />}
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => setSelectedId(entry.id)}
                    sx={{
                      py: 0.75, px: 1.5,
                      borderLeft: isProfitable && !isSelected ? '2px solid #4caf50' : '2px solid transparent',
                      bgcolor: isProfitable && !isSelected ? 'rgba(76,175,80,0.04)' : undefined,
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
                        src={iconUrl(entry.icon_path) ?? undefined}
                        variant="rounded"
                        sx={{ width: 28, height: 28, borderRadius: '5px', bgcolor: 'rgba(255,255,255,0.04)' }}
                      >
                        {!entry.icon_path && (entry.name_ru?.[0] ?? '?')}
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
                              sx={{ height: 13, fontSize: 9 }}
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
    </Box>
  )
}
