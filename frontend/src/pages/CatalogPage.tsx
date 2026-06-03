import { useState, useCallback } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Button, Chip, CircularProgress, MenuItem, Select, FormControl,
  InputLabel, Alert, Avatar, Dialog, DialogTitle, DialogContent,
  DialogActions,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import HistoryIcon from '@mui/icons-material/History'
import api from '../api/client'
import { translateCategory, iconUrl } from '../utils/i18n'

const HISTORY_KEY = 'catalog_search_history'
const HISTORY_MAX = 10

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(query: string) {
  const next = [query, ...loadHistory().filter((q) => q !== query)].slice(0, HISTORY_MAX)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

interface Item {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
  can_be_batch_traded: boolean
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

const QUALITY_OPTIONS = [
  { value: null,  label: 'Любое' },
  { value: 0,     label: 'Обычный' },
  { value: 1,     label: 'Необычный' },
  { value: 2,     label: 'Особый' },
  { value: 3,     label: 'Ветеран' },
  { value: 4,     label: 'Мастер' },
  { value: 5,     label: 'Легендарный' },
]

const ENCHANT_OPTIONS = [
  { value: null, label: 'Любая' },
  ...Array.from({ length: 15 }, (_, i) => ({ value: i + 1, label: `+${i + 1}` })),
]

export default function CatalogPage() {
  const [search, setSearch]   = useState('')
  const [items, setItems]     = useState<Item[]>([])
  const [total, setTotal]     = useState(0)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>(loadHistory)

  // Диалог добавления
  const [dialogItem, setDialogItem]       = useState<Item | null>(null)
  const [region, setRegion]               = useState('RU')
  const [qualityFilter, setQualityFilter] = useState<number | null>(null)
  const [enchantFilter, setEnchantFilter] = useState<number | null>(null)
  const [adding, setAdding]               = useState(false)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/items', { params: { search: q.trim(), page_size: 50 } })
      setItems(data.items)
      setTotal(data.total)
      saveHistory(q.trim())
      setHistory(loadHistory())
    } catch {
      setError('Ошибка поиска')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSearch = useCallback(() => doSearch(search), [doSearch, search])

  const handleHistoryClick = (q: string) => {
    setSearch(q)
    doSearch(q)
  }

  const openDialog = (item: Item) => {
    setDialogItem(item)
    setQualityFilter(null)
    setEnchantFilter(null)
  }

  const handleAdd = async () => {
    if (!dialogItem) return
    setAdding(true)
    setSuccess(null)
    setError(null)
    try {
      await api.post('/watchlist/', {
        item_id: dialogItem.item_id,
        region,
        quality_filter: qualityFilter,
        enchant_filter: enchantFilter,
      })
      const qLabel = QUALITY_OPTIONS.find(o => o.value === qualityFilter)?.label ?? 'Любое'
      const eLabel = enchantFilter != null ? ` +${enchantFilter}` : ''
      setSuccess(`${dialogItem.name_ru || dialogItem.item_id} [${qLabel}${eLabel}] добавлен в избранное (${region})`)
      setDialogItem(null)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Ошибка добавления')
    } finally {
      setAdding(false)
    }
  }

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, mb: 0.5 }}>
          ITEM DATABASE // 2 236+ ENTRIES
        </Typography>
        <Typography variant="h5" fontWeight={700}>Каталог предметов</Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField
          placeholder="Поиск по названию..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          size="small"
          sx={{ flexGrow: 1 }}
          slotProps={{
            input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> },
          }}
        />
        <Button variant="contained" onClick={handleSearch} disabled={loading}>
          {loading ? <CircularProgress size={20} /> : 'Найти'}
        </Button>
      </Box>

      {/* История поиска */}
      {items.length === 0 && !loading && history.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <HistoryIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.secondary">Недавние запросы</Typography>
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {history.map((q) => (
              <Chip
                key={q}
                label={q}
                size="small"
                icon={<SearchIcon />}
                onClick={() => handleHistoryClick(q)}
                sx={{ cursor: 'pointer' }}
              />
            ))}
          </Box>
        </Box>
      )}

      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}
      {error   && <Alert severity="error"   sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {items.length > 0 && (
        <Card>
          <CardContent sx={{ p: 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ px: 2, pt: 1.5, display: 'block' }}>
              Найдено: {total}
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Название</TableCell>
                    <TableCell>Категория</TableCell>
                    <TableCell>Пачки</TableCell>
                    <TableCell align="right"></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Avatar
                            src={iconUrl(item.icon_path) ?? undefined}
                            variant="rounded"
                            sx={{ width: 28, height: 28, bgcolor: 'background.default', flexShrink: 0 }}
                          >
                            {!item.icon_path && (item.name_ru?.[0] ?? '?')}
                          </Avatar>
                          <Box>
                            <Typography variant="body2" fontWeight={500}>
                              {item.name_ru || item.name_en}
                            </Typography>
                            {item.name_en && item.name_ru && (
                              <Typography variant="caption" color="text.secondary">{item.name_en}</Typography>
                            )}
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {translateCategory(item.category)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {item.can_be_batch_traded
                          ? <Chip label="Да" size="small" color="success" variant="outlined" />
                          : <Chip label="Нет" size="small" variant="outlined" />}
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={() => openDialog(item)}
                          variant="outlined"
                        >
                          Избранное
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Диалог добавления в watchlist */}
      <Dialog open={!!dialogItem} onClose={() => setDialogItem(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          <Typography fontWeight={700}>{dialogItem?.name_ru || dialogItem?.item_id}</Typography>
          <Typography variant="caption" color="text.secondary">{dialogItem?.item_id}</Typography>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>

          <FormControl size="small" fullWidth>
            <InputLabel>Регион</InputLabel>
            <Select value={region} label="Регион" onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel>Качество</InputLabel>
            <Select
              value={qualityFilter ?? ''}
              label="Качество"
              onChange={(e) => setQualityFilter(e.target.value === '' ? null : Number(e.target.value))}
            >
              {QUALITY_OPTIONS.map((o) => (
                <MenuItem key={String(o.value)} value={o.value ?? ''}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel>Заточка</InputLabel>
            <Select
              value={enchantFilter ?? ''}
              label="Заточка"
              onChange={(e) => setEnchantFilter(e.target.value === '' ? null : Number(e.target.value))}
            >
              {ENCHANT_OPTIONS.map((o) => (
                <MenuItem key={String(o.value)} value={o.value ?? ''}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogItem(null)} color="inherit">Отмена</Button>
          <Button
            variant="contained"
            onClick={handleAdd}
            disabled={adding}
            startIcon={adding ? <CircularProgress size={16} /> : <AddIcon />}
          >
            Добавить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
