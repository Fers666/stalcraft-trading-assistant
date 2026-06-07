import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  Alert, FormControl, InputLabel, Select, MenuItem, Tooltip, Avatar,
  IconButton, Snackbar, Button, Dialog, DialogTitle, DialogContent,
  DialogActions, List, ListItem, ListItemAvatar, ListItemText, Divider,
} from '@mui/material'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import BookmarkAddedIcon from '@mui/icons-material/BookmarkAdded'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VisibilityIcon from '@mui/icons-material/Visibility'
import api from '../api/client'
import { translateCategory, formatPrice, iconUrl } from '../utils/i18n'

interface OpportunityItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
  region: string
  quality: number | null
  enchant: number | null
  variant_label: string | null
  current_price: number | null
  avg_price_24h: number | null
  min_price_24h: number | null
  est_profit_pct: number | null
  est_profit_per_unit: number | null
  lot_count: number | null
  scanned_at: string | null
  min_price_at: string | null
  hours_since_min: number | null
}

interface ExcludedItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
  region: string
  excluded_at: string | null
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

function fmtHoursAgo(hours: number | null): string {
  if (hours == null) return ''
  if (hours < 1) return 'только что'
  if (hours < 2) return '~1 ч назад'
  if (hours < 24) return `~${Math.round(hours)} ч назад`
  const days = hours / 24
  return days < 2 ? '~1 день назад' : `~${Math.round(days)} дн. назад`
}

export default function FeedPage() {
  const navigate = useNavigate()
  const [items, setItems]   = useState<OpportunityItem[]>([])
  const [region, setRegion] = useState('RU')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [snackbar, setSnackbar] = useState<string | null>(null)

  const [wlStates, setWlStates] = useState<Record<string, 'loading' | 'added' | 'exists'>>({})
  const [hidingIds, setHidingIds] = useState<Set<string>>(new Set())

  const [excludedOpen, setExcludedOpen] = useState(false)
  const [excluded, setExcluded] = useState<ExcludedItem[]>([])
  const [excludedLoading, setExcludedLoading] = useState(false)
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set())

  const load = async (r: string) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/monitoring/feed', { params: { region: r, limit: 30 } })
      setItems(data)
    } catch {
      setError('Нет данных — глобальный скан ещё не накопил статистику за 24ч')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(region) }, [region])

  // ─── В Избранное ───────────────────────────────────────────────────────────
  const handleAddToWatchlist = async (item: OpportunityItem) => {
    setWlStates((s) => ({ ...s, [item.item_id]: 'loading' }))
    try {
      await api.post('/watchlist/', { item_id: item.item_id, region: item.region, quality_filter: item.quality ?? 0, enchant_filter: item.enchant ?? 0 })
      setWlStates((s) => ({ ...s, [item.item_id]: 'added' }))
      setSnackbar('Добавлено в Избранное')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) {
        setWlStates((s) => ({ ...s, [item.item_id]: 'exists' }))
        setSnackbar('Уже в Избранном')
      } else {
        setWlStates((s) => { const next = { ...s }; delete next[item.item_id]; return next })
        setSnackbar('Ошибка добавления')
      }
    }
  }

  // ─── Перейти в лоты ────────────────────────────────────────────────────────
  const handleViewLots = (item: OpportunityItem) => {
    navigate('/app/lots', {
      state: {
        item_id: item.item_id,
        name_ru: item.name_ru,
        name_en: item.name_en,
        icon_path: item.icon_path,
        region: item.region,
        quality_filter: item.quality ?? 0,
        enchant_filter: item.enchant ?? 0,
      },
    })
  }

  // ─── Скрыть из ленты ───────────────────────────────────────────────────────
  const handleExclude = async (item: OpportunityItem) => {
    setHidingIds((s) => new Set(s).add(item.item_id))
    try {
      await api.post('/monitoring/feed/exclude', { item_id: item.item_id, region: item.region })
      setItems((prev) => prev.filter((i) => i.item_id !== item.item_id))
      setSnackbar('Скрыто из ленты — вернуть можно в списке скрытых')
    } catch {
      setSnackbar('Ошибка скрытия')
    } finally {
      setHidingIds((s) => { const next = new Set(s); next.delete(item.item_id); return next })
    }
  }

  // ─── Скрытые из ленты: список + восстановление ─────────────────────────────
  const loadExcluded = async () => {
    setExcludedLoading(true)
    try {
      const { data } = await api.get('/monitoring/feed/excluded', { params: { region } })
      setExcluded(data)
    } catch {
      setSnackbar('Не удалось загрузить список скрытых')
    } finally {
      setExcludedLoading(false)
    }
  }

  const openExcluded = () => {
    setExcludedOpen(true)
    loadExcluded()
  }

  const handleRestore = async (item: ExcludedItem) => {
    setRestoringIds((s) => new Set(s).add(item.item_id))
    try {
      await api.delete(`/monitoring/feed/exclude/${item.item_id}`, { params: { region: item.region } })
      setExcluded((prev) => prev.filter((i) => i.item_id !== item.item_id))
      setSnackbar('Возвращено в ленту')
      load(region)
    } catch {
      setSnackbar('Ошибка восстановления')
    } finally {
      setRestoringIds((s) => { const next = new Set(s); next.delete(item.item_id); return next })
    }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Box>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, mb: 0.5 }}>
            MARKET SCAN // TOP OPPORTUNITIES 24H
          </Typography>
          <Typography variant="h5" fontWeight={700}>Лента возможностей</Typography>
          <Typography variant="caption" color="text.secondary">
            Предметы вне Избранного: купить сейчас и продать позже по средней цене с прибылью (за вычетом 5% комиссии аукциона)
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Button size="small" startIcon={<VisibilityOffIcon />} onClick={openExcluded} sx={{ color: 'text.secondary' }}>
            Скрытые
          </Button>
          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel>Регион</InputLabel>
            <Select value={region} label="Регион" onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </Select>
          </FormControl>
        </Box>
      </Box>

      {error && <Alert severity="info" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>}

      {!loading && !error && (
        <Grid2 container spacing={2}>
          {items.map((item) => {
            const url = iconUrl(item.icon_path)
            const wlState = wlStates[item.item_id]
            const hiding = hidingIds.has(item.item_id)

            return (
              <Grid2 size={{ xs: 12, sm: 6, md: 4, xl: 3 }} key={item.item_id}>
                <Card sx={{ height: '100%', opacity: hiding ? 0.4 : 1, transition: 'opacity 0.2s' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
                      <Avatar
                        src={url ?? undefined}
                        variant="rounded"
                        sx={{ width: 40, height: 40, bgcolor: 'background.default' }}
                      >
                        {!url && (item.name_ru?.[0] ?? '?')}
                      </Avatar>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                          <Typography variant="subtitle2" fontWeight={700} noWrap>
                            {item.name_ru || item.name_en || item.item_id}
                          </Typography>
                          {item.variant_label && (
                            <Chip
                              label={item.variant_label}
                              size="small"
                              variant="outlined"
                              color="secondary"
                              sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
                            />
                          )}
                        </Box>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {translateCategory(item.category)}
                        </Typography>
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block">Цена сейчас (за 1 шт.)</Typography>
                        <Typography variant="body2" fontWeight={700} color="primary.main">
                          {formatPrice(item.current_price)}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          {item.lot_count ?? 0} лотов
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography variant="caption" color="text.secondary" display="block">Средняя / мин. за 24ч</Typography>
                        <Typography variant="body2">
                          {formatPrice(item.avg_price_24h != null ? Math.round(item.avg_price_24h) : null)} / {formatPrice(item.min_price_24h)}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          мин. {fmtHoursAgo(item.hours_since_min)}
                        </Typography>
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                      {item.est_profit_pct != null && (
                        <Tooltip title={
                          `Купить сейчас за ${formatPrice(item.current_price)}, продать по средней цене 24ч ` +
                          `(${formatPrice(item.avg_price_24h != null ? Math.round(item.avg_price_24h) : null)}), ` +
                          `после вычета 5% комиссии аукциона на руки ~${formatPrice(item.est_profit_per_unit)} прибыли с 1 шт.`
                        }>
                          <Chip
                            size="small"
                            icon={<LocalOfferIcon />}
                            label={`+${item.est_profit_pct.toFixed(1)}% после комиссии`}
                            color="success"
                            variant="outlined"
                            sx={{ height: 20, fontSize: 11 }}
                          />
                        </Tooltip>
                      )}

                      <Box sx={{ display: 'flex', gap: 0.25 }}>
                        <Tooltip title="Перейти в лоты">
                          <IconButton size="small" onClick={() => handleViewLots(item)} sx={{ color: 'text.disabled' }}>
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={wlState === 'added' || wlState === 'exists' ? 'Уже в Избранном' : 'В Избранное'}>
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => handleAddToWatchlist(item)}
                              disabled={wlState === 'loading' || wlState === 'added' || wlState === 'exists'}
                              sx={{ color: (wlState === 'added' || wlState === 'exists') ? 'primary.main' : 'text.disabled' }}
                            >
                              {wlState === 'loading'
                                ? <CircularProgress size={16} />
                                : (wlState === 'added' || wlState === 'exists')
                                  ? <BookmarkAddedIcon fontSize="small" />
                                  : <BookmarkAddIcon fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Скрыть из ленты">
                          <span>
                            <IconButton size="small" onClick={() => handleExclude(item)} disabled={hiding} sx={{ color: 'text.disabled' }}>
                              {hiding ? <CircularProgress size={16} /> : <VisibilityOffIcon fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    </Box>
                  </CardContent>
                </Card>
              </Grid2>
            )
          })}
        </Grid2>
      )}

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar}
      />

      <Dialog open={excludedOpen} onClose={() => setExcludedOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Скрытые из ленты ({region})</DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          {excludedLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} /></Box>
          )}
          {!excludedLoading && excluded.length === 0 && (
            <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }} variant="body2">
              Скрытых предметов нет
            </Typography>
          )}
          {!excludedLoading && excluded.length > 0 && (
            <List dense disablePadding>
              {excluded.map((item, i) => {
                const url = iconUrl(item.icon_path)
                const restoring = restoringIds.has(item.item_id)
                return (
                  <Box key={item.item_id}>
                    {i > 0 && <Divider component="li" />}
                    <ListItem
                      secondaryAction={
                        <Tooltip title="Вернуть в ленту">
                          <span>
                            <IconButton edge="end" size="small" onClick={() => handleRestore(item)} disabled={restoring}>
                              {restoring ? <CircularProgress size={16} /> : <VisibilityIcon fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>
                      }
                    >
                      <ListItemAvatar>
                        <Avatar src={url ?? undefined} variant="rounded" sx={{ width: 32, height: 32, bgcolor: 'background.default' }}>
                          {!url && (item.name_ru?.[0] ?? '?')}
                        </Avatar>
                      </ListItemAvatar>
                      <ListItemText
                        primary={item.name_ru || item.name_en || item.item_id}
                        secondary={translateCategory(item.category)}
                        primaryTypographyProps={{ variant: 'body2', fontWeight: 600, noWrap: true }}
                        secondaryTypographyProps={{ variant: 'caption' }}
                      />
                    </ListItem>
                  </Box>
                )
              })}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExcludedOpen(false)}>Закрыть</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
