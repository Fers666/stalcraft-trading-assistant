import { useState, useCallback, useEffect } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Card,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Button, Chip, CircularProgress, MenuItem, Select, FormControl,
  InputLabel, Alert, Avatar, Dialog, DialogTitle, DialogContent,
  DialogActions, List, ListItemButton, ListItemText, Collapse,
  Pagination, Divider,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import api from '../api/client'
import { translateCategory, iconUrl } from '../utils/i18n'
import { CATEGORY_TREE } from '../utils/categories'

const PAGE_SIZE = 50

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
  const [search, setSearch]             = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [category, setCategory]         = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [items, setItems]               = useState<Item[]>([])
  const [total, setTotal]               = useState(0)
  const [page, setPage]                 = useState(1)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [success, setSuccess]           = useState<string | null>(null)

  // Диалог добавления в watchlist
  const [dialogItem, setDialogItem]       = useState<Item | null>(null)
  const [region, setRegion]               = useState('RU')
  const [qualityFilter, setQualityFilter] = useState<number | null>(null)
  const [enchantFilter, setEnchantFilter] = useState<number | null>(null)
  const [adding, setAdding]               = useState(false)

  const loadItems = useCallback(async (cat: string | null, sq: string, p: number) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = { page: p, page_size: PAGE_SIZE }
      if (cat) params.category = cat
      if (sq)  params.search = sq
      const { data } = await api.get('/items', { params })
      setItems(data.items)
      setTotal(data.total)
    } catch {
      setError('Ошибка загрузки данных')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadItems(category, activeSearch, page)
  }, [category, activeSearch, page, loadItems])

  const handleSearch = () => {
    setPage(1)
    setActiveSearch(search)
  }

  const handleCategorySelect = (cat: string | null) => {
    setCategory(cat)
    setPage(1)
  }

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <Box>
      {/* Header */}
      <Box sx={{ mb: 3 }}>
        <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, mb: 0.5 }}>
          ITEM DATABASE // {total > 0 ? `${total} ITEMS` : '2 236+ ENTRIES'}
        </Typography>
        <Typography variant="h5" fontWeight={700}>Каталог предметов</Typography>
      </Box>

      {/* Search bar */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
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
        {activeSearch && (
          <Button variant="outlined" color="inherit" onClick={() => { setSearch(''); setActiveSearch(''); setPage(1) }}>
            Сбросить
          </Button>
        )}
      </Box>

      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}
      {error   && <Alert severity="error"   sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {/* Двухколоночный layout */}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>

        {/* Левый сайдбар — дерево категорий */}
        <Box sx={{
          width: 230,
          flexShrink: 0,
          bgcolor: 'background.paper',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
          maxHeight: '72vh',
          overflowY: 'auto',
        }}>
          <List dense disablePadding>
            {CATEGORY_TREE.map((group, idx) => {
              const isSelected  = category === group.id
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
                          const childSelected = category === child.id
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

        {/* Правая часть — список предметов */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          )}

          {!loading && items.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
              <Typography>Ничего не найдено</Typography>
            </Box>
          )}

          {!loading && items.length > 0 && (
            <>
              <Card>
                <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Найдено: {total}
                    {totalPages > 1 && ` · стр. ${page} из ${totalPages}`}
                    {activeSearch && ` · поиск: «${activeSearch}»`}
                  </Typography>
                </Box>
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
                              ? <Chip label="Да"  size="small" color="success" variant="outlined" />
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
              </Card>

              {totalPages > 1 && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Pagination
                    count={totalPages}
                    page={page}
                    onChange={(_, p) => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    color="primary"
                    size="small"
                  />
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>

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
