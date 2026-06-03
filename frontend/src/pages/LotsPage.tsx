import { useState, useEffect, useMemo } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TablePagination,
  Chip, CircularProgress, Alert, FormControl, InputLabel, Select, MenuItem,
  List, ListItem, ListItemButton, ListItemText, Paper, Tooltip, Avatar,
  IconButton,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import HistoryIcon from '@mui/icons-material/History'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import api from '../api/client'
import { translateCategory, formatPrice, iconUrl } from '../utils/i18n'

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

interface HistoryEntry {
  item_id: string
  name: string
  category: string | null
  icon_path: string | null
}

type SortKey = 'buyout_price' | 'amount' | 'price_per_unit' | 'hours_remaining' | 'enchant_level'
type SortDir = 'asc' | 'desc'

const REGIONS = ['RU', 'EU', 'NA', 'SEA']
const HISTORY_KEY = 'lots_search_history'
const HISTORY_MAX = 10
const ROWS_PER_PAGE_OPTIONS = [25, 50, 100]

// Порядок качеств для сортировки фильтра
const QUALITY_ORDER = ['Обычный', 'Необычный', 'Особый', 'Ветеран', 'Мастер', 'Легендарный']

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(entry: HistoryEntry) {
  const next = [entry, ...loadHistory().filter((h) => h.item_id !== entry.item_id)].slice(0, HISTORY_MAX)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

function sortLots(lots: Lot[], key: SortKey, dir: SortDir): Lot[] {
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

const COLS: { key: SortKey | null; label: string }[] = [
  { key: 'buyout_price',    label: 'Цена выкупа'  },
  { key: 'amount',          label: 'Количество'    },
  { key: 'price_per_unit',  label: 'Цена / шт'    },
  { key: null,              label: 'Качество'      },
  { key: 'enchant_level',   label: 'Заточка'       },
  { key: 'hours_remaining', label: 'Осталось'      },
  { key: null,              label: 'Статус'        },
]

export default function LotsPage() {
  const [query, setQuery]               = useState('')
  const [region, setRegion]             = useState('RU')
  const [suggestions, setSuggestions]   = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [result, setResult]             = useState<LotsResponse | null>(null)
  const [loading, setLoading]           = useState(false)
  const [searching, setSearching]       = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryEntry[]>(loadHistory)

  const [filterQuality, setFilterQuality] = useState<string>('all')
  const [filterEnchant, setFilterEnchant] = useState<string>('all')
  const [sortKey, setSortKey]             = useState<SortKey>('buyout_price')
  const [sortDir, setSortDir]             = useState<SortDir>('asc')
  const [page, setPage]                   = useState(0)
  const [rowsPerPage, setRowsPerPage]     = useState(25)

  // Уникальные значения из загруженных лотов → опции фильтров
  const qualityOptions = useMemo(() => {
    if (!result) return []
    const vals = [...new Set(result.lots.map((l) => l.quality_name).filter(Boolean) as string[])]
    return vals.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
  }, [result])

  const enchantOptions = useMemo(() => {
    if (!result) return []
    return [...new Set(result.lots.map((l) => l.enchant_level).filter((v): v is number => v != null))].sort((a, b) => a - b)
  }, [result])

  // Показываем фильтр только если есть что выбирать
  const showQualityFilter = qualityOptions.length > 1
  const showEnchantFilter = enchantOptions.length > 0

  // Пайплайн: фильтр → сортировка → пагинация
  const filteredSorted = useMemo(() => {
    if (!result) return []
    const filtered = result.lots.filter((l) => {
      if (filterQuality !== 'all' && l.quality_name !== filterQuality) return false
      if (filterEnchant !== 'all' && String(l.enchant_level) !== filterEnchant) return false
      return true
    })
    return sortLots(filtered, sortKey, sortDir)
  }, [result, filterQuality, filterEnchant, sortKey, sortDir])

  const pageLots = filteredSorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)

  // Сброс страницы при смене фильтра или сортировки
  useEffect(() => { setPage(0) }, [filterQuality, filterEnchant, sortKey, sortDir])

  // Сброс фильтров при новом результате
  useEffect(() => {
    setFilterQuality('all')
    setFilterEnchant('all')
    setPage(0)
  }, [result])

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
  const handleHistoryClick = (entry: HistoryEntry) => fetchLots({ item_id: entry.item_id, name_ru: entry.name, name_en: null, category: entry.category, icon_path: entry.icon_path }, region)
  const handleRegionChange = (newRegion: string)   => { setRegion(newRegion); if (selectedItem) fetchLots(selectedItem, newRegion) }
  const handleRefresh      = ()                    => { if (selectedItem) fetchLots(selectedItem, region, true) }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortArrow = ({ k }: { k: SortKey }) =>
    sortKey !== k ? <ArrowUpwardIcon sx={{ fontSize: 11, ml: 0.5, opacity: 0.2 }} /> :
    sortDir === 'asc'
      ? <ArrowUpwardIcon sx={{ fontSize: 11, ml: 0.5, color: 'primary.main' }} />
      : <ArrowDownwardIcon sx={{ fontSize: 11, ml: 0.5, color: 'primary.main' }} />

  const showHistory = !result && !loading && history.length > 0 && suggestions.length === 0

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 1 }}>Поиск лотов</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Активные лоты без добавления в Избранное. Данные из кэша, обновляются каждые 5 мин.
      </Typography>

      {/* Поиск */}
      <Box sx={{ display: 'flex', gap: 2, mb: 1 }}>
        <Box sx={{ flexGrow: 1, position: 'relative' }}>
          <TextField
            placeholder="Введите название предмета..."
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
      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>}

      {result && !loading && (
        <Card>
          <CardContent>
            {/* Заголовок */}
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
                    {translateCategory(selectedItem?.category ?? null)} · {result.region} · Лотов на аукционе: {result.total}
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Tooltip title="Получить свежие данные из API (обойти кэш)">
                  <IconButton size="small" onClick={handleRefresh}>
                    <RefreshIcon fontSize="small" />
                  </IconButton>
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

            {/* Фильтры — только когда есть смысл */}
            {(showQualityFilter || showEnchantFilter) && (
              <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                {showQualityFilter && (
                  <FormControl size="small" sx={{ minWidth: 160 }}>
                    <InputLabel>Качество</InputLabel>
                    <Select value={filterQuality} label="Качество" onChange={(e) => setFilterQuality(e.target.value)}>
                      <MenuItem value="all">Все качества ({result.lots.length})</MenuItem>
                      {qualityOptions.map((q) => {
                        const count = result.lots.filter((l) => l.quality_name === q).length
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
                        const count = result.lots.filter((l) => l.enchant_level === e).length
                        return <MenuItem key={e} value={String(e)}>+{e} ({count})</MenuItem>
                      })}
                    </Select>
                  </FormControl>
                )}
                {(filterQuality !== 'all' || filterEnchant !== 'all') && (
                  <Chip label="Сбросить" size="small"
                    onClick={() => { setFilterQuality('all'); setFilterEnchant('all') }}
                    sx={{ cursor: 'pointer' }}
                  />
                )}
                {filteredSorted.length !== result.lots.length && (
                  <Typography variant="caption" color="text.secondary">
                    Показано: {filteredSorted.length} из {result.lots.length}
                  </Typography>
                )}
              </Box>
            )}

            {filteredSorted.length === 0 && (
              <Alert severity="info">Нет лотов, соответствующих фильтрам</Alert>
            )}

            {filteredSorted.length > 0 && (
              <>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        {COLS.map(({ key, label }) => (
                          <TableCell
                            key={label}
                            onClick={key ? () => handleSort(key) : undefined}
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
                                  <Tooltip title="Лоты с остатком менее 2 часов помечены как истекающие — их цена может быть нерыночной">
                                    <InfoOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled', ml: 0.5 }} />
                                  </Tooltip>
                                </>
                              ) : label}
                              {key && <SortArrow k={key} />}
                            </Box>
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {pageLots.map((lot, i) => {
                        const globalIdx = page * rowsPerPage + i
                        return (
                          <TableRow key={globalIdx} hover sx={{ opacity: lot.is_expiring ? 0.55 : 1 }}>
                            <TableCell>
                              <Typography variant="body2" fontWeight={600}
                                color={globalIdx === 0 && !lot.is_expiring ? 'primary.main' : 'inherit'}>
                                {formatPrice(lot.buyout_price)}
                              </Typography>
                            </TableCell>
                            <TableCell>{lot.amount} шт.</TableCell>
                            <TableCell>{formatPrice(Math.floor(lot.buyout_price / lot.amount))}</TableCell>
                            <TableCell>
                              {lot.quality_name
                                ? <Chip label={lot.quality_name} size="small" variant="outlined" />
                                : <Typography variant="caption" color="text.disabled">—</Typography>}
                            </TableCell>
                            <TableCell>
                              {lot.enchant_level != null
                                ? <Chip label={`+${lot.enchant_level}`} size="small" color="primary" variant="outlined" />
                                : <Typography variant="caption" color="text.disabled">—</Typography>}
                            </TableCell>
                            <TableCell>
                              {lot.hours_remaining != null ? `${lot.hours_remaining.toFixed(1)} ч` : '—'}
                            </TableCell>
                            <TableCell>
                              {lot.is_expiring
                                ? <Chip label="Истекает" size="small" color="error" variant="outlined" />
                                : <Chip label="Активен" size="small" color="success" variant="outlined" />}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>

                <TablePagination
                  component="div"
                  count={filteredSorted.length}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0) }}
                  rowsPerPageOptions={ROWS_PER_PAGE_OPTIONS}
                  labelRowsPerPage="Строк:"
                  labelDisplayedRows={({ from, to, count }) => `${from}–${to} из ${count}`}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  )
}
