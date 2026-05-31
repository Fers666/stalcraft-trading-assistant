import { useState, useEffect } from 'react'
import {
  Box, Typography, Card, CardContent, Button, TextField, Dialog,
  DialogTitle, DialogContent, DialogActions, CircularProgress,
  Table, TableHead, TableRow, TableCell, TableBody, Alert, Avatar,
  IconButton, Tooltip,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'
import { formatPrice, iconUrl } from '../utils/i18n'

interface InventoryItem {
  id: number
  item_id: string
  region: string
  quantity: number
  avg_buy_price_per_unit: number | null
  added_at: string
}

interface SearchItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
}

export default function InventoryPage() {
  const [items, setItems]   = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SearchItem[]>([])
  const [selected, setSelected] = useState<SearchItem | null>(null)
  const [qty, setQty]       = useState(1)
  const [price, setPrice]   = useState('')
  const [region, setRegion] = useState('RU')
  const [error, setError]   = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/inventory')
      setItems(data)
    } catch { setItems([]) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const handleSearch = async () => {
    if (!search.trim()) return
    const { data } = await api.get('/items', { params: { search: search.trim(), page_size: 10 } })
    setResults(data.items)
  }

  const handleAdd = async () => {
    if (!selected) return
    try {
      await api.post('/inventory', {
        item_id: selected.item_id,
        region,
        quantity: qty,
        avg_buy_price_per_unit: price ? Number(price) : null,
      })
      setOpen(false)
      setSelected(null)
      setSearch('')
      setResults([])
      setPrice('')
      setQty(1)
      load()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Ошибка добавления')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить с склада?')) return
    await api.delete(`/inventory/${id}`)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" fontWeight={700}>Склад</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
          Добавить товар
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {items.length === 0 ? (
        <Box sx={{ textAlign: 'center', mt: 8 }}>
          <Typography color="text.secondary">Склад пуст</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Добавьте купленные товары для отслеживания прибыли
          </Typography>
        </Box>
      ) : (
        <Card>
          <CardContent sx={{ p: 0 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Товар</TableCell>
                  <TableCell>Регион</TableCell>
                  <TableCell>Кол-во</TableCell>
                  <TableCell>Цена покупки</TableCell>
                  <TableCell>Добавлен</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'primary.main' }}>
                        {item.item_id}
                      </Typography>
                    </TableCell>
                    <TableCell>{item.region}</TableCell>
                    <TableCell>{item.quantity} шт.</TableCell>
                    <TableCell>{formatPrice(item.avg_buy_price_per_unit)}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(item.added_at).toLocaleDateString('ru-RU')}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Tooltip title="Удалить со склада">
                        <IconButton size="small" onClick={() => handleDelete(item.id)} sx={{ color: 'error.main' }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Диалог добавления */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Добавить на склад</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="Поиск по названию"
              size="small"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              fullWidth
            />
            <Button variant="outlined" onClick={handleSearch} sx={{ minWidth: 40, px: 1 }}>
              <SearchIcon />
            </Button>
          </Box>

          {results.length > 0 && !selected && (
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              {results.map((r) => (
                <Box
                  key={r.item_id}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                  onClick={() => { setSelected(r); setResults([]) }}
                >
                  <Avatar src={iconUrl(r.icon_path) ?? undefined} variant="rounded" sx={{ width: 24, height: 24 }} />
                  <Typography variant="body2">{r.name_ru || r.name_en}</Typography>
                </Box>
              ))}
            </Box>
          )}

          {selected && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, bgcolor: 'action.selected', borderRadius: 1 }}>
              <Avatar src={iconUrl(selected.icon_path) ?? undefined} variant="rounded" sx={{ width: 24, height: 24 }} />
              <Typography variant="body2" fontWeight={600}>{selected.name_ru || selected.name_en}</Typography>
              <Button size="small" onClick={() => setSelected(null)} sx={{ ml: 'auto' }}>Изменить</Button>
            </Box>
          )}

          <TextField label="Количество (шт.)" type="number" size="small" value={qty}
            onChange={(e) => setQty(Number(e.target.value))} inputProps={{ min: 1 }} />
          <TextField label="Цена покупки за штуку (₽)" type="number" size="small" value={price}
            onChange={(e) => setPrice(e.target.value)} helperText="Необязательно — для расчёта прибыли" />
          <TextField label="Регион" size="small" value={region} onChange={(e) => setRegion(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Отмена</Button>
          <Button variant="contained" onClick={handleAdd} disabled={!selected}>Добавить</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
