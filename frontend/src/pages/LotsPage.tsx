import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Box, Typography, TextField, InputAdornment, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TablePagination,
  Chip, CircularProgress, Alert, FormControl, InputLabel, Select, MenuItem,
  List, ListItem, ListItemButton, ListItemText, Paper, Tooltip, Avatar,
  IconButton, Snackbar, Collapse, Divider,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import HistoryIcon from '@mui/icons-material/History'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import BookmarkAddedIcon from '@mui/icons-material/BookmarkAdded'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import api from '../api/client'
import { translateCategory, formatPrice, iconUrl } from '../utils/i18n'
import { CATEGORY_TREE } from '../utils/categories'

// ─── Типы ────────────────────────────────────────────────────────────────────

interface Item {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
}

interface Lot {
  item_id: string
  amount: number
  buyout_price: number
  start_price: number
  start_time: string
  end_time: string
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  quality_value: number | null
  enchant_level: number | null
}

interface LotsResponse {
  item_id: string
  region: string
  total: number
  lots: Lot[]
  from_cache: boolean
  cache_note: string
}

interface CategoryLot {
  item_id: string
  item_name_ru: string | null
  item_name_en: string | null
  icon_path: string | null
  amount: number
  buyout_price: number
  start_price: number
  start_time: string
  end_time: string
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  quality_value: number | null
  enchant_level: number | null
}

interface CategoryLotsResponse {
  category: string
  region: string
  items_total: number
  lots_total: number
  lots: CategoryLot[]
}

interface HistoryEntry {
  item_id: string
  name: string
  category: string | null
  icon_path: string | null
}

type SortKey = 'buyout_price' | 'amount' | 'price_per_unit' | 'hours_remaining' | 'enchant_level'
type SortDir = 'asc' | 'desc'

// ─── Константы ───────────────────────────────────────────────────────────────

const REGIONS = ['RU', 'EU', 'NA', 'SEA']
const QL_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый', 3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}
const QUALITY_CHIP_COLOR: Record<string, string> = {
  'Обычный': '#555',
  'Необычный': '#4caf50',
  'Особый': '#2196f3',
  'Ветеран': '#9c27b0',
  'Мастер': '#ff9800',
  'Легендарный': '#f44336',
}
const HISTORY_KEY = 'lots_search_history'
const HISTORY_MAX = 10
const ROWS_PER_PAGE_OPTIONS = [25, 50, 100]
const QUALITY_ORDER = ['Обычный', 'Необычный', 'Особый', 'Ветеран', 'Мастер', 'Легендарный']

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(entry: HistoryEntry) {
  const next = [entry, ...loadHistory().filter((h) => h.item_id !== entry.item_id)].slice(0, HISTORY_MAX)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

function sortLots<T extends { buyout_price: number; amount: number; hours_remaining: number | null; enchant_level: number | null }>(
  lots: T[], key: SortKey, dir: SortDir,
): T[] {
  return [...lots].sort((a, b) => {
    let av: number, bv: number
    if (key === 'price_per_unit') {
      av = Math.floor(a.buyout_price / a.amount)
      bv = Math.floor(b.buyout_price / b.amount)
    } else if (key === 'hours_remaining') {
      av = a.hours_remaining ?? Infinity
      bv = b.hours_remaining ?? Infinity
    } else if (key === 'enchant_level') {
      av = a.enchant_level ?? -1
      bv = b.enchant_level ?? -1
    } else {
      av = a[key] as number
      bv = b[key] as number
    }
    return dir === 'asc' ? av - bv : bv - av
  })
}

// ─── Колонки таблицы лотов ───────────────────────────────────────────────────

const LOT_COLS: { key: SortKey | null; label: string }[] = [
  { key: 'buyout_price',    label: 'Цена выкупа' },
  { key: 'amount',          label: 'Количество'  },
  { key: 'price_per_unit',  label: 'Цена / шт'  },
  { key: null,              label: 'Качество'    },
  { key: 'enchant_level',   label: 'Заточка'     },
  { key: 'hours_remaining', label: 'Осталось'    },
  { key: null,              label: 'Статус'      },
]

// ─── Компонент ───────────────────────────────────────────────────────────────

export default function LotsPage() {
  const location = useLocation()
  const pendingQualityRef = useRef<string | null>(null)
  const pendingEnchantRef = useRef<string | null>(null)

  // Поиск конкретного предмета
  const [query, setQuery]               = useState('')
  const [region, setRegion]             = useState('RU')
  const [suggestions, setSuggestions]   = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [result, setResult]             = useState<LotsResponse | null>(null)
  const [loading, setLoading]           = useState(false)
  const [searching, setSearching]       = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryEntry[]>(loadHistory)

  // Категории
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups]     = useState<Set<string>>(new Set())
  const [catResult, setCatResult]               = useState<CategoryLotsResponse | null>(null)
  const [catLoading, setCatLoading]             = useState(false)
  const [catError, setCatError]                 = useState<string | null>(null)

  // Фильтры и сортировка (общие для обоих режимов)
  const [filterQuality, setFilterQuality] = useState<string>('all')
  const [filterEnchant, setFilterEnchant] = useState<string>('all')
  const [sortKey, setSortKey]             = useState<SortKey>('buyout_price')
  const [sortDir, setSortDir]             = useState<SortDir>('asc')
  const [page, setPage]                   = useState(0)
  const [rowsPerPage, setRowsPerPage]     = useState(25)

  // Watchlist
  const [wlStates, setWlStates] = useState<Record<string, 'loading' | 'added' | 'exists'>>({})
  const [snackbar, setSnackbar] = useState<string | null>(null)

  // ─── Инициализация из navigation state (переход из Избранного) ───────────
  useEffect(() => {
    const state = location.state as {
      item_id?: string
      name_ru?: string | null
      name_en?: string | null
      icon_path?: string | null
      region?: string
      quality_filter?: number | null
      enchant_filter?: number | null
    } | null
    if (!state?.item_id) return
    const item: Item = {
      item_id: state.item_id,
      name_ru: state.name_ru ?? null,
      name_en: state.name_en ?? null,
      category: null,
      icon_path: state.icon_path ?? null,
    }
    const reg = state.region ?? region
    if (state.region) setRegion(state.region)
    if (state.quality_filter != null) pendingQualityRef.current = QL_NAMES[state.quality_filter] ?? null
    if (state.enchant_filter != null) pendingEnchantRef.current = String(state.enchant_filter)
    fetchLots(item, reg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Загрузка лотов категории ──────────────────────────────────────────────
  const fetchCategoryLots = async (cat: string, reg: string) => {
    setCatLoading(true)
    setCatError(null)
    setCatResult(null)
    try {
      const { data } = await api.get('/lots', { params: { category: cat, region: reg } })
      setCatResult(data)
    } catch {
      setCatError('Ошибка загрузки лотов категории')
    } finally {
      setCatLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedCategory) { setCatResult(null); return }
    fetchCategoryLots(selectedCategory, region)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, region])

  // ─── Опции фильтров из активного результата ────────────────────────────────
  const activeLots = result ? result.lots : catResult ? catResult.lots : []

  const qualityOptions = useMemo(() => {
    const vals = [...new Set(activeLots.map((l) => l.quality_name).filter(Boolean) as string[])]
    return vals.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
  }, [activeLots])

  const enchantOptions = useMemo(() => {
    return [...new Set(
      activeLots.map((l) => l.enchant_level).filter((v): v is number => v != null)
    )].sort((a, b) => a - b)
  }, [activeLots])

  const showQualityFilter = qualityOptions.length > 1
  const showEnchantFilter = enchantOptions.length > 0

  // ─── Пайплайн фильтр → сортировка → пагинация ─────────────────────────────
  const filteredSorted = useMemo(() => {
    const filtered = activeLots.filter((l) => {
      if (filterQuality !== 'all' && l.quality_name !== filterQuality) return false
      if (filterEnchant !== 'all' && String(l.enchant_level) !== filterEnchant) return false
      return true
    })
    return sortLots(filtered, sortKey, sortDir)
  }, [activeLots, filterQuality, filterEnchant, sortKey, sortDir])

  const pageLots = filteredSorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)

  useEffect(() => { setPage(0) }, [filterQuality, filterEnchant, sortKey, sortDir])

  useEffect(() => {
    if (result === null && catResult === null) return
    setFilterQuality(pendingQualityRef.current ?? 'all')
    setFilterEnchant(pendingEnchantRef.current ?? 'all')
    pendingQualityRef.current = null
    pendingEnchantRef.current = null
    setPage(0)
    setWlStates({})
  }, [result, catResult])

  // ─── Поиск предмета ────────────────────────────────────────────────────────
  const handleQueryChange = async (value: string) => {
    setQuery(value)
    setSelectedItem(null)
    setResult(null)
    if (value.trim().length < 2) { setSuggestions([]); return }
    setSearching(true)
    try {
      const { data } = await api.get('/items', { params: { search: value.trim(), page_size: 8 } })
      setSuggestions(data.items)
    } catch { setSuggestions([]) }
    finally { setSearching(false) }
  }

  const fetchLots = async (item: Item, reg: string, forceRefresh = false) => {
    setSelectedItem(item)
    setQuery(item.name_ru || item.name_en || item.item_id)
    setSuggestions([])
    setError(null)
    setLoading(true)
    try {
      const { data } = await api.get(`/lots/${item.item_id}`, {
        params: { region: reg, ...(forceRefresh && { force_refresh: true }) },
      })
      setResult(data)
      saveHistory({ item_id: item.item_id, name: item.name_ru || item.name_en || item.item_id, category: item.category, icon_path: item.icon_path })
      setHistory(loadHistory())
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Нет активных лотов')
      setResult(null)
    } finally { setLoading(false) }
  }

  const handleSelect       = (item: Item)          => fetchLots(item, region)
  const handleHistoryClick = (entry: HistoryEntry) => fetchLots(
    { item_id: entry.item_id, name_ru: entry.name, name_en: null, category: entry.category, icon_path: entry.icon_path },
    region,
  )
  const handleRegionChange = (newRegion: string) => {
    setRegion(newRegion)
    if (selectedItem) fetchLots(selectedItem, newRegion)
  }
  const handleRefresh = () => {
    if (selectedItem) fetchLots(selectedItem, region, true)
    else if (selectedCategory) fetchCategoryLots(selectedCategory, region)
  }

  // ─── Выбор категории ───────────────────────────────────────────────────────
  const handleCategorySelect = (cat: string | null) => {
    setSelectedCategory(cat)
    setSelectedItem(null)
    setResult(null)
    setQuery('')
    setSuggestions([])
    setError(null)
    if (!cat) setCatResult(null)
  }

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  // ─── Watchlist ─────────────────────────────────────────────────────────────
  const wlKey = (itemId: string, lot: { quality_value: number | null; enchant_level: number | null }) =>
    `${itemId}_${lot.quality_value ?? 'n'}_${lot.enchant_level ?? 'n'}`

  const handleAddToWatchlist = async (itemId: string, lot: { quality_value: number | null; enchant_level: number | null }) => {
    const key = wlKey(itemId, lot)
    setWlStates((s) => ({ ...s, [key]: 'loading' }))
    try {
      await api.post('/watchlist/', { item_id: itemId, region, quality_filter: lot.quality_value ?? null, enchant_filter: lot.enchant_level ?? null })
      setWlStates((s) => ({ ...s, [key]: 'added' }))
      setSnackbar('Добавлено в Избранное')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) {
        setWlStates((s) => ({ ...s, [key]: 'exists' }))
        setSnackbar('Уже в Избранном')
      } else {
        setWlStates((s) => { const next = { ...s }; delete next[key]; return next })
        setSnackbar('Ошибка добавления')
      }
    }
  }

  // ─── Сортировка ────────────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortArrow = ({ k }: { k: SortKey }) =>
    sortKey !== k
      ? <ArrowUpwardIcon sx={{ fontSize: 11, ml: 0.5, opacity: 0.2 }} />
      : sortDir === 'asc'
        ? <ArrowUpwardIcon  sx={{ fontSize: 11, ml: 0.5, color: 'primary.main' }} />
        : <ArrowDownwardIcon sx={{ fontSize: 11, ml: 0.5, color: 'primary.main' }} />

  // ─── Вспомогательный рендер ────────────────────────────────────────────────

  const WlButton = ({ itemId, lot }: { itemId: string; lot: { quality_name: string | null; quality_value: number | null; enchant_level: number | null } }) => {
    const key = wlKey(itemId, lot)
    const st = wlStates[key]
    const enchantLabel = lot.enchant_level === 0 ? 'Не точёный' : lot.enchant_level != null ? `+${lot.enchant_level}` : null
    const label = lot.quality_name && enchantLabel
      ? `${lot.quality_name} ${enchantLabel}`
      : lot.quality_name ?? enchantLabel ?? 'Без фильтров'
    return (
      <Tooltip title={st === 'added' || st === 'exists' ? 'Уже в Избранном' : `В Избранное: ${label}`}>
        <span>
          <IconButton
            size="small"
            onClick={() => handleAddToWatchlist(itemId, lot)}
            disabled={st === 'loading' || st === 'added' || st === 'exists'}
            sx={{ color: (st === 'added' || st === 'exists') ? 'primary.main' : 'text.disabled' }}
          >
            {st === 'loading'
              ? <CircularProgress size={16} />
              : (st === 'added' || st === 'exists')
                ? <BookmarkAddedIcon fontSize="small" />
                : <BookmarkAddIcon  fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
    )
  }

  const FiltersBar = ({ total }: { total: number }) => (
    <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
      {showQualityFilter && (
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel>Качество</InputLabel>
          <Select value={filterQuality} label="Качество" onChange={(e) => setFilterQuality(e.target.value)}>
            <MenuItem value="all">Все качества ({total})</MenuItem>
            {qualityOptions.map((q) => {
              const count = activeLots.filter((l) => l.quality_name === q).length
              return <MenuItem key={q} value={q}>{q} ({count})</MenuItem>
            })}
          </Select>
        </FormControl>
      )}
      {showEnchantFilter && (
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Заточка</InputLabel>
          <Select value={filterEnchant} label="Заточка" onChange={(e) => setFilterEnchant(e.target.value)}>
            <MenuItem value="all">Все заточки</MenuItem>
            {enchantOptions.map((e) => {
              const count = activeLots.filter((l) => l.enchant_level === e).length
              return (
                <MenuItem key={e} value={String(e)}>
                  {e === 0 ? `Не точёный (${count})` : `+${e} (${count})`}
                </MenuItem>
              )
            })}
          </Select>
        </FormControl>
      )}
      {(filterQuality !== 'all' || filterEnchant !== 'all') && (
        <Chip
          label="Сбросить"
          size="small"
          onClick={() => { setFilterQuality('all'); setFilterEnchant('all') }}
          sx={{ cursor: 'pointer' }}
        />
      )}
      {filteredSorted.length !== activeLots.length && (
        <Typography variant="caption" color="text.secondary">
          Показано: {filteredSorted.length} из {activeLots.length}
        </Typography>
      )}
    </Box>
  )

  const showHistory = !result && !loading && !selectedCategory && history.length > 0 && suggestions.length === 0

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 1 }}>Поиск лотов</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Активные лоты без добавления в Избранное. Данные из кэша, обновляются каждые 5 мин.
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>

        {/* ── Боковая панель категорий ─────────────────────────────────── */}
        <Box sx={{
          width: 210,
          flexShrink: 0,
          bgcolor: 'background.paper',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
          maxHeight: '80vh',
          overflowY: 'auto',
          position: 'sticky',
          top: 16,
        }}>
          <List dense disablePadding>
            {CATEGORY_TREE.map((group, idx) => {
              const isSelected  = selectedCategory === group.id
              const hasChildren = !!group.children?.length
              const isExpanded  = hasChildren && group.id != null && expandedGroups.has(group.id)

              return (
                <Box key={String(group.id)}>
                  {idx === 1 && <Divider />}
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => {
                      handleCategorySelect(group.id)
                      if (hasChildren && group.id != null) toggleGroup(group.id)
                    }}
                    sx={{ pl: 2, pr: 1 }}
                  >
                    <ListItemText
                      primary={group.label}
                      primaryTypographyProps={{
                        variant: 'body2',
                        sx: { fontWeight: isSelected ? 700 : 400, color: isSelected ? 'primary.main' : 'text.primary' },
                      }}
                    />
                    {hasChildren && group.id != null && (
                      isExpanded
                        ? <ExpandLessIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                        : <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                    )}
                  </ListItemButton>

                  {hasChildren && group.id != null && (
                    <Collapse in={isExpanded} unmountOnExit>
                      <List dense disablePadding>
                        {group.children!.map((child) => {
                          const childSelected = selectedCategory === child.id
                          return (
                            <ListItemButton
                              key={child.id}
                              selected={childSelected}
                              onClick={() => handleCategorySelect(child.id)}
                              sx={{ pl: 4, pr: 1 }}
                            >
                              <ListItemText
                                primary={child.label}
                                primaryTypographyProps={{
                                  variant: 'body2',
                                  sx: { color: childSelected ? 'primary.main' : 'text.secondary', fontWeight: childSelected ? 600 : 400 },
                                }}
                              />
                            </ListItemButton>
                          )
                        })}
                      </List>
                    </Collapse>
                  )}
                </Box>
              )
            })}
          </List>
        </Box>

        {/* ── Основная область ─────────────────────────────────────────── */}
        <Box sx={{ flex: 1, minWidth: 0 }}>

          {/* Поиск + регион */}
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <Box sx={{ flexGrow: 1, position: 'relative' }}>
              <TextField
                placeholder="Поиск конкретного предмета..."
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                size="small"
                fullWidth
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        {searching ? <CircularProgress size={16} /> : <SearchIcon fontSize="small" />}
                      </InputAdornment>
                    ),
                  },
                }}
              />
              {suggestions.length > 0 && (
                <Paper sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, mt: 0.5 }}>
                  <List dense disablePadding>
                    {suggestions.map((item) => (
                      <ListItem key={item.item_id} disablePadding>
                        <ListItemButton onClick={() => handleSelect(item)}>
                          <Avatar src={iconUrl(item.icon_path) ?? undefined} variant="rounded"
                            sx={{ width: 24, height: 24, mr: 1, bgcolor: 'background.default', flexShrink: 0 }}>
                            {!item.icon_path && (item.name_ru?.[0] ?? '?')}
                          </Avatar>
                          <ListItemText
                            primary={<Typography variant="body2">{item.name_ru || item.name_en}</Typography>}
                            secondary={<Typography variant="caption">{translateCategory(item.category)}</Typography>}
                          />
                        </ListItemButton>
                      </ListItem>
                    ))}
                  </List>
                </Paper>
              )}
            </Box>
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <InputLabel>Регион</InputLabel>
              <Select value={region} label="Регион" onChange={(e) => handleRegionChange(e.target.value)}>
                {REGIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>

          {/* История */}
          {showHistory && (
            <Box sx={{ mb: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <HistoryIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                <Typography variant="caption" color="text.secondary">Недавние запросы</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                {history.map((entry) => (
                  <Card key={entry.item_id} onClick={() => handleHistoryClick(entry)}
                    sx={{ cursor: 'pointer', minWidth: 150, maxWidth: 200, transition: 'box-shadow 0.15s', '&:hover': { boxShadow: 4 } }}>
                    <CardContent sx={{ p: '12px !important', display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Avatar src={iconUrl(entry.icon_path) ?? undefined} variant="rounded"
                        sx={{ width: 44, height: 44, bgcolor: 'background.default', flexShrink: 0 }}>
                        {!entry.icon_path && (entry.name[0] ?? '?')}
                      </Avatar>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={500} noWrap>{entry.name}</Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {translateCategory(entry.category)}
                        </Typography>
                      </Box>
                    </CardContent>
                  </Card>
                ))}
              </Box>
            </Box>
          )}

          {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}

          <Snackbar
            open={snackbar !== null}
            autoHideDuration={2500}
            onClose={() => setSnackbar(null)}
            message={snackbar}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          />

          {/* ── Лоты конкретного предмета (из поиска / истории) ──────── */}
          {(loading || result) && (
            <>
              {loading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>}
              {result && !loading && (
                <Card>
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        {selectedItem?.icon_path && (
                          <Avatar src={iconUrl(selectedItem.icon_path) ?? undefined} variant="rounded"
                            sx={{ width: 36, height: 36, bgcolor: 'background.default' }} />
                        )}
                        <Box>
                          <Typography variant="subtitle1" fontWeight={700}>
                            {selectedItem?.name_ru || result.item_id}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {translateCategory(selectedItem?.category ?? null)} · {result.region} · Лотов: {result.total}
                          </Typography>
                        </Box>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Tooltip title="Обновить данные из API">
                          <IconButton size="small" onClick={handleRefresh}><RefreshIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title={result.cache_note}>
                          <Chip
                            label={result.from_cache ? 'из кэша' : 'свежие данные'}
                            size="small"
                            color={result.from_cache ? 'default' : 'success'}
                            icon={<InfoOutlinedIcon />}
                          />
                        </Tooltip>
                      </Box>
                    </Box>

                    {(showQualityFilter || showEnchantFilter) && <FiltersBar total={result.lots.length} />}
                    {filteredSorted.length === 0
                      ? <Alert severity="info">Нет лотов, соответствующих фильтрам</Alert>
                      : <LotsTable
                          lots={pageLots as Lot[]}
                          page={page}
                          rowsPerPage={rowsPerPage}
                          totalFiltered={filteredSorted.length}
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSort}
                          SortArrow={SortArrow}
                          onSetPage={setPage}
                          onSetRowsPerPage={(v) => { setRowsPerPage(v); setPage(0) }}
                          renderWl={(lot, idx) => (
                            <WlButton
                              itemId={selectedItem!.item_id}
                              lot={lot}
                              key={idx}
                            />
                          )}
                          showItemCol={false}
                        />
                    }
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* ── Лоты по категории ─────────────────────────────────────── */}
          {!result && !loading && selectedCategory && (
            <>
              {catLoading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>}
              {catError  && <Alert severity="error">{catError}</Alert>}
              {catResult && !catLoading && (
                <Card>
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                      <Box>
                        <Typography variant="subtitle1" fontWeight={700}>
                          {CATEGORY_TREE.flatMap(g => [g, ...(g.children ?? [])]).find(g => g.id === selectedCategory)?.label ?? selectedCategory}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {region} · Предметов: {catResult.items_total} · Лотов: {catResult.lots_total}
                        </Typography>
                      </Box>
                      <Tooltip title="Обновить данные из API">
                        <IconButton size="small" onClick={handleRefresh}><RefreshIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    </Box>

                    {catResult.lots_total === 0
                      ? <Alert severity="info">В этой категории нет активных лотов</Alert>
                      : <>
                          {(showQualityFilter || showEnchantFilter) && <FiltersBar total={catResult.lots_total} />}
                          {filteredSorted.length === 0
                            ? <Alert severity="info">Нет лотов, соответствующих фильтрам</Alert>
                            : <LotsTable
                                lots={pageLots as CategoryLot[]}
                                page={page}
                                rowsPerPage={rowsPerPage}
                                totalFiltered={filteredSorted.length}
                                sortKey={sortKey}
                                sortDir={sortDir}
                                onSort={handleSort}
                                SortArrow={SortArrow}
                                onSetPage={setPage}
                                onSetRowsPerPage={(v) => { setRowsPerPage(v); setPage(0) }}
                                renderWl={(lot, idx) => (
                                  <WlButton
                                    itemId={(lot as CategoryLot).item_id}
                                    lot={lot}
                                    key={idx}
                                  />
                                )}
                                showItemCol
                              />
                          }
                        </>
                    }
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}

// ─── Таблица лотов (общая для обоих режимов) ─────────────────────────────────

interface LotRow {
  item_id?: string
  item_name_ru?: string | null
  item_name_en?: string | null
  icon_path?: string | null
  amount: number
  buyout_price: number
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
  quality_value: number | null
}

function LotsTable({
  lots, page, rowsPerPage, totalFiltered, sortKey: _sortKey, sortDir: _sortDir, onSort, SortArrow,
  onSetPage, onSetRowsPerPage, renderWl, showItemCol,
}: {
  lots: LotRow[]
  page: number
  rowsPerPage: number
  totalFiltered: number
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  SortArrow: (props: { k: SortKey }) => JSX.Element
  onSetPage: (p: number) => void
  onSetRowsPerPage: (v: number) => void
  renderWl: (lot: LotRow, idx: number) => JSX.Element
  showItemCol: boolean
}) {
  return (
    <>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              {showItemCol && <TableCell>Предмет</TableCell>}
              {LOT_COLS.map(({ key, label }) => (
                <TableCell
                  key={label}
                  onClick={key ? () => onSort(key) : undefined}
                  sx={{
                    cursor: key ? 'pointer' : 'default',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    '&:hover': key ? { bgcolor: 'action.hover' } : undefined,
                  }}
                >
                  <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
                    {label === 'Осталось' ? (
                      <>
                        {label}
                        <Tooltip title="Лоты с остатком менее 2 часов помечены как истекающие">
                          <InfoOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled', ml: 0.5 }} />
                        </Tooltip>
                      </>
                    ) : label}
                    {key && <SortArrow k={key} />}
                  </Box>
                </TableCell>
              ))}
              <TableCell sx={{ width: 40 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {lots.map((lot, i) => {
              const globalIdx = page * rowsPerPage + i
              return (
                <TableRow key={globalIdx} hover sx={{ opacity: lot.is_expiring ? 0.55 : 1 }}>
                  {showItemCol && (
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                        <Avatar
                          src={iconUrl(lot.icon_path ?? null) ?? undefined}
                          variant="rounded"
                          sx={{ width: 24, height: 24, bgcolor: 'background.default', flexShrink: 0 }}
                        >
                          {!(lot.icon_path) && ((lot.item_name_ru?.[0] ?? lot.item_name_en?.[0] ?? '?'))}
                        </Avatar>
                        <Typography variant="body2" noWrap sx={{ maxWidth: 160 }}>
                          {lot.item_name_ru || lot.item_name_en || lot.item_id}
                        </Typography>
                      </Box>
                    </TableCell>
                  )}
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}
                      color={globalIdx === 0 && !lot.is_expiring ? 'primary.main' : 'inherit'}>
                      {formatPrice(lot.buyout_price)}
                    </Typography>
                  </TableCell>
                  <TableCell>{lot.amount} шт.</TableCell>
                  <TableCell>{formatPrice(Math.floor(lot.buyout_price / lot.amount))}</TableCell>
                  <TableCell>
                    {lot.quality_name && QUALITY_CHIP_COLOR[lot.quality_name]
                      ? <Chip
                          label={lot.quality_name}
                          size="small"
                          variant="outlined"
                          sx={{
                            fontSize: '0.65rem',
                            height: 18,
                            borderColor: QUALITY_CHIP_COLOR[lot.quality_name],
                            color: QUALITY_CHIP_COLOR[lot.quality_name],
                          }}
                        />
                      : <Typography variant="caption" color="text.disabled">—</Typography>}
                  </TableCell>
                  <TableCell>
                    {lot.enchant_level === 0
                      ? <Chip label="Не точёный" size="small" variant="outlined" sx={{ color: 'text.secondary' }} />
                      : lot.enchant_level != null
                        ? <Chip label={`+${lot.enchant_level}`} size="small" color="primary" variant="outlined" />
                        : <Typography variant="caption" color="text.disabled">—</Typography>}
                  </TableCell>
                  <TableCell>
                    {lot.hours_remaining != null ? `${lot.hours_remaining.toFixed(1)} ч` : '—'}
                  </TableCell>
                  <TableCell>
                    {lot.is_expiring
                      ? <Chip label="Истекает" size="small" color="error"    variant="outlined" />
                      : <Chip label="Активен"  size="small" color="success"  variant="outlined" />}
                  </TableCell>
                  <TableCell sx={{ p: '4px 8px' }}>
                    {renderWl(lot, i)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={totalFiltered}
        page={page}
        onPageChange={(_, p) => onSetPage(p)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => onSetRowsPerPage(parseInt(e.target.value, 10))}
        rowsPerPageOptions={ROWS_PER_PAGE_OPTIONS}
        labelRowsPerPage="Строк:"
        labelDisplayedRows={({ from, to, count }) => `${from}–${to} из ${count}`}
      />
    </>
  )
}
