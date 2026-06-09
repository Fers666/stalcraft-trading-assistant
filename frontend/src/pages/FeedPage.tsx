import { useState, useEffect, useCallback } from 'react'
import {
  Box, Typography, Button, IconButton, Tooltip, CircularProgress, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Avatar, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, InputAdornment, MenuItem, Select, FormControl, InputLabel,
  Tab, Tabs, ListItemButton, ListItemText, Collapse,
  Snackbar,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'
import { iconUrl } from '../utils/i18n'
import { CATEGORY_TREE } from '../utils/categories'
import { useFeedPageStore, type SortField } from '../store/feedPageStore'

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

const QUALITY_OPTIONS = [
  { value: null, label: 'Любое' },
  { value: 0,    label: 'Обычный' },
  { value: 1,    label: 'Необычный' },
  { value: 2,    label: 'Особый' },
  { value: 3,    label: 'Ветеран' },
  { value: 4,    label: 'Мастер' },
  { value: 5,    label: 'Легендарный' },
]

const ENCHANT_OPTIONS = [
  { value: null, label: 'Любая' },
  { value: 0,    label: 'Не точёный' },
  ...Array.from({ length: 15 }, (_, i) => ({ value: i + 1, label: `+${i + 1}` })),
]

interface CatalogItem {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  category: string | null
  color: string | null
}

const SORT_LABELS: Record<SortField, string> = {
  sales_7d:              'Прод./нед.',
  sales_24h:             'Прод./сут.',
  profitable_lots_count: 'Выгодных лотов',
  avg_profit:            'Ср. прибыль',
  name_ru:               'Название',
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export default function FeedPage() {
  const {
    loading, error, sortBy, sortOrder,
    fetchItems, addItem, addBatch, removeItem, promoteItem,
    setSortBy, setSortOrder, sortedItems,
  } = useFeedPageStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [tab, setTab]               = useState(0)   // 0 = один товар, 1 = группа
  const [toast, setToast]           = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Один товар
  const [search, setSearch]   = useState('')
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedItem, setSelectedItem]   = useState<CatalogItem | null>(null)
  const [region, setRegion]               = useState('RU')
  const [qualityFilter, setQualityFilter] = useState<number | null>(null)
  const [enchantFilter, setEnchantFilter] = useState<number | null>(null)
  const [adding, setAdding]               = useState(false)

  // Группа товаров
  const [batchCategory, setBatchCategory]           = useState<string | null>(null)
  const [batchRegion, setBatchRegion]               = useState('RU')
  const [batchQuality, setBatchQuality]             = useState<number | null>(null)
  const [batchEnchant, setBatchEnchant]             = useState<number | null>(null)
  const [expandedGroups, setExpandedGroups]         = useState<Set<string>>(new Set())
  const [batchAdding, setBatchAdding]               = useState(false)

  useEffect(() => { fetchItems() }, [fetchItems])

  const handleSearch = useCallback(async (q: string) => {
    setSearch(q)
    if (q.length < 2) { setSearchResults([]); return }
    setSearchLoading(true)
    try {
      const { data } = await api.get('/items', { params: { search: q, page_size: 20 } })
      setSearchResults(data.items || [])
    } catch {
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }, [])

  const handleAddOne = async () => {
    if (!selectedItem) return
    setAdding(true)
    setActionError(null)
    try {
      await addItem({
        item_id: selectedItem.item_id,
        region,
        quality_filter: qualityFilter,
        enchant_filter: enchantFilter,
      })
      setToast(`«${selectedItem.name_ru || selectedItem.item_id}» добавлен в Ленту`)
      setDialogOpen(false)
      resetDialog()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionError(detail === 'Already in feed' ? 'Уже в Ленте' : (detail || 'Ошибка добавления'))
    } finally {
      setAdding(false)
    }
  }

  const handleAddBatch = async () => {
    if (!batchCategory) return
    setBatchAdding(true)
    setActionError(null)
    try {
      const result = await addBatch({
        category: batchCategory,
        region: batchRegion,
        quality_filter: batchQuality,
        enchant_filter: batchEnchant,
      })
      setToast(`Добавлено ${result.added} товаров (${result.skipped} уже есть)`)
      setDialogOpen(false)
      resetDialog()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setActionError(detail || 'Ошибка добавления группы')
    } finally {
      setBatchAdding(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await removeItem(id)
    } catch {
      setToast('Ошибка удаления')
    }
  }

  const handlePromote = async (id: number, name: string | null) => {
    try {
      await promoteItem(id)
      setToast(`«${name || ''}» добавлен в Мониторинг`)
    } catch {
      setToast('Ошибка перемещения')
    }
  }

  function resetDialog() {
    setSearch(''); setSearchResults([]); setSelectedItem(null)
    setRegion('RU'); setQualityFilter(null); setEnchantFilter(null)
    setBatchCategory(null); setBatchRegion('RU'); setBatchQuality(null); setBatchEnchant(null)
    setActionError(null); setTab(0)
  }

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(field)
      setSortOrder('desc')
    }
  }

  const SortArrow = ({ field }: { field: SortField }) => {
    if (sortBy !== field) return null
    return sortOrder === 'desc'
      ? <KeyboardArrowDownIcon sx={{ fontSize: 14, verticalAlign: 'middle', ml: 0.3 }} />
      : <KeyboardArrowUpIcon   sx={{ fontSize: 14, verticalAlign: 'middle', ml: 0.3 }} />
  }

  const items = sortedItems()

  return (
    <Box>
      {/* ── Шапка ───────────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2.5 }}>
        <Typography variant="h5" fontWeight={700}>Лента</Typography>
        <Button
          variant="contained" startIcon={<AddIcon />}
          onClick={() => setDialogOpen(true)}
        >
          Добавить товар
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* ── Таблица ──────────────────────────────────────────────── */}
      {loading && items.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
          <CircularProgress />
        </Box>
      ) : items.length === 0 ? (
        <Box sx={{
          textAlign: 'center', mt: 8, color: 'text.disabled',
          border: '1px dashed', borderColor: 'divider', borderRadius: 2, py: 6,
        }}>
          <Typography variant="h6" gutterBottom>Лента пуста</Typography>
          <Typography variant="body2">
            Добавьте товары для фонового мониторинга — они будут обновляться автоматически
          </Typography>
        </Box>
      ) : (
        <TableContainer sx={{ borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, fontSize: '0.72rem', color: 'text.secondary' } }}>
                <TableCell>Товар</TableCell>
                {(Object.keys(SORT_LABELS) as SortField[]).filter(f => f !== 'name_ru').map(field => (
                  <TableCell
                    key={field}
                    align="right"
                    sx={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                    onClick={() => toggleSort(field)}
                  >
                    {SORT_LABELS[field]}<SortArrow field={field} />
                  </TableCell>
                ))}
                <TableCell align="right">Обновлено</TableCell>
                <TableCell align="right" sx={{ width: 90 }}>Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  sx={{ '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' } }}
                >
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Avatar
                        src={iconUrl(item.icon_path) ?? undefined}
                        variant="square"
                        sx={{ width: 32, height: 32, borderRadius: 1 }}
                      />
                      <Box>
                        <Typography variant="body2" fontWeight={600} sx={{ lineHeight: 1.2 }}>
                          {item.name_ru || item.item_id}
                        </Typography>
                        <Typography variant="caption" color="text.disabled">
                          {item.region}
                          {item.quality_filter != null && ` · кач. ${item.quality_filter}`}
                          {item.enchant_filter != null && ` · точ. +${item.enchant_filter}`}
                        </Typography>
                      </Box>
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2">{item.sales_7d}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2">{item.sales_24h}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    {item.profitable_lots_count > 0 ? (
                      <Chip
                        label={item.profitable_lots_count}
                        size="small"
                        sx={{
                          bgcolor: 'rgba(217,175,55,0.15)',
                          color: '#D9AF37',
                          fontWeight: 700, height: 20, fontSize: '0.7rem',
                        }}
                      />
                    ) : (
                      <Typography variant="body2" color="text.disabled">—</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {item.avg_profit > 0 ? (
                      <Typography variant="body2" sx={{ color: '#4caf50', fontWeight: 600 }}>
                        +{fmt(Math.round(item.avg_profit))}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.disabled">—</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="caption" color="text.disabled">
                      {item.last_collected_at
                        ? new Date(item.last_collected_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                      <Tooltip title="Добавить в Мониторинг">
                        <IconButton
                          size="small"
                          onClick={() => handlePromote(item.id, item.name_ru)}
                          sx={{ color: 'primary.main' }}
                        >
                          <ArrowForwardIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Удалить из Ленты">
                        <IconButton
                          size="small"
                          onClick={() => handleDelete(item.id)}
                          sx={{ color: 'text.disabled', '&:hover': { color: 'error.main' } }}
                        >
                          <DeleteIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* ── Диалог добавления ───────────────────────────────────── */}
      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); resetDialog() }}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { bgcolor: 'background.paper' } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>Добавить товар в Ленту</DialogTitle>

        <Tabs
          value={tab}
          onChange={(_, v) => { setTab(v); setActionError(null) }}
          sx={{ px: 3, borderBottom: '1px solid', borderColor: 'divider', mb: 0 }}
        >
          <Tab label="Один товар" />
          <Tab label="Группа товаров" />
        </Tabs>

        <DialogContent>
          {actionError && (
            <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert>
          )}

          {tab === 0 ? (
            /* ── Один товар ── */
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label="Поиск по каталогу"
                size="small"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      {searchLoading
                        ? <CircularProgress size={16} />
                        : <SearchIcon sx={{ fontSize: 18, color: 'text.disabled' }} />}
                    </InputAdornment>
                  ),
                }}
                autoFocus
              />

              {searchResults.length > 0 && !selectedItem && (
                <Box sx={{
                  maxHeight: 220, overflowY: 'auto',
                  border: '1px solid', borderColor: 'divider', borderRadius: 1,
                }}>
                  {searchResults.map((item) => (
                    <Box
                      key={item.item_id}
                      onClick={() => { setSelectedItem(item); setSearchResults([]) }}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 1.5,
                        px: 2, py: 1, cursor: 'pointer',
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
                        borderBottom: '1px solid', borderColor: 'divider',
                        '&:last-child': { borderBottom: 'none' },
                      }}
                    >
                      <Avatar
                        src={iconUrl(item.icon_path) ?? undefined}
                        variant="square"
                        sx={{ width: 28, height: 28, borderRadius: 0.5 }}
                      />
                      <Box>
                        <Typography variant="body2">{item.name_ru || item.item_id}</Typography>
                        <Typography variant="caption" color="text.disabled">{item.item_id}</Typography>
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}

              {selectedItem && (
                <Box sx={{
                  display: 'flex', alignItems: 'center', gap: 1.5,
                  p: 1.5, bgcolor: 'rgba(217,175,55,0.06)',
                  border: '1px solid rgba(217,175,55,0.2)', borderRadius: 1,
                }}>
                  <Avatar
                    src={iconUrl(selectedItem.icon_path) ?? undefined}
                    variant="square"
                    sx={{ width: 36, height: 36, borderRadius: 1 }}
                  />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {selectedItem.name_ru || selectedItem.item_id}
                    </Typography>
                  </Box>
                  <Button
                    size="small" variant="text"
                    sx={{ color: 'text.disabled', minWidth: 0 }}
                    onClick={() => setSelectedItem(null)}
                  >
                    ✕
                  </Button>
                </Box>
              )}

              <FormControl size="small">
                <InputLabel>Регион</InputLabel>
                <Select value={region} label="Регион" onChange={(e) => setRegion(e.target.value)}>
                  {REGIONS.map(r => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                </Select>
              </FormControl>

              <FormControl size="small">
                <InputLabel>Качество</InputLabel>
                <Select
                  value={qualityFilter ?? ''}
                  label="Качество"
                  onChange={(e) => setQualityFilter(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {QUALITY_OPTIONS.map(o => (
                    <MenuItem key={o.label} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small">
                <InputLabel>Заточка</InputLabel>
                <Select
                  value={enchantFilter ?? ''}
                  label="Заточка"
                  onChange={(e) => setEnchantFilter(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {ENCHANT_OPTIONS.map(o => (
                    <MenuItem key={o.label} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          ) : (
            /* ── Группа товаров ── */
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Выберите категорию или подкатегорию — все товары из неё будут добавлены в Ленту
              </Typography>

              <Box sx={{
                maxHeight: 260, overflowY: 'auto',
                border: '1px solid', borderColor: 'divider', borderRadius: 1,
              }}>
                {CATEGORY_TREE.filter(g => g.id !== null).map((group) => (
                  <Box key={group.id}>
                    <ListItemButton
                      selected={batchCategory === group.id}
                      onClick={() => {
                        if (group.children) {
                          setExpandedGroups(prev => {
                            const n = new Set(prev)
                            n.has(group.id!) ? n.delete(group.id!) : n.add(group.id!)
                            return n
                          })
                        } else {
                          setBatchCategory(group.id)
                        }
                      }}
                      sx={{ py: 0.8, px: 2 }}
                    >
                      <ListItemText
                        primary={group.label}
                        primaryTypographyProps={{ variant: 'body2', fontWeight: batchCategory === group.id ? 700 : 400 }}
                      />
                      {group.children && (
                        expandedGroups.has(group.id!)
                          ? <ExpandLessIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                          : <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                      )}
                    </ListItemButton>
                    {group.children && (
                      <Collapse in={expandedGroups.has(group.id!)}>
                        {group.children.map(child => (
                          <ListItemButton
                            key={child.id}
                            selected={batchCategory === child.id}
                            onClick={() => setBatchCategory(child.id)}
                            sx={{ py: 0.6, pl: 4, pr: 2 }}
                          >
                            <ListItemText
                              primary={child.label}
                              primaryTypographyProps={{ variant: 'body2', fontWeight: batchCategory === child.id ? 700 : 400 }}
                            />
                          </ListItemButton>
                        ))}
                      </Collapse>
                    )}
                  </Box>
                ))}
              </Box>

              {batchCategory && (
                <Typography variant="caption" sx={{ color: 'primary.main' }}>
                  Выбрано: <strong>{batchCategory}</strong>
                </Typography>
              )}

              <FormControl size="small">
                <InputLabel>Регион</InputLabel>
                <Select value={batchRegion} label="Регион" onChange={(e) => setBatchRegion(e.target.value)}>
                  {REGIONS.map(r => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                </Select>
              </FormControl>

              <FormControl size="small">
                <InputLabel>Качество (для всей группы)</InputLabel>
                <Select
                  value={batchQuality ?? ''}
                  label="Качество (для всей группы)"
                  onChange={(e) => setBatchQuality(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {QUALITY_OPTIONS.map(o => (
                    <MenuItem key={o.label} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small">
                <InputLabel>Заточка (для всей группы)</InputLabel>
                <Select
                  value={batchEnchant ?? ''}
                  label="Заточка (для всей группы)"
                  onChange={(e) => setBatchEnchant(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {ENCHANT_OPTIONS.map(o => (
                    <MenuItem key={o.label} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            variant="text" color="inherit"
            onClick={() => { setDialogOpen(false); resetDialog() }}
          >
            Отмена
          </Button>
          {tab === 0 ? (
            <Button
              variant="contained"
              onClick={handleAddOne}
              disabled={!selectedItem || adding}
            >
              {adding ? 'Добавление...' : 'Добавить'}
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={handleAddBatch}
              disabled={!batchCategory || batchAdding}
            >
              {batchAdding ? 'Добавление...' : 'Добавить группу'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* ── Toast ───────────────────────────────────────────────── */}
      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}
