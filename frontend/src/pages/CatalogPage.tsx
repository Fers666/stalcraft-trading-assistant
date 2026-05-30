import { useState, useCallback } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Button, Chip, CircularProgress, MenuItem, Select, FormControl,
  InputLabel, Alert,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import api from '../api/client'

interface Item {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  can_be_batch_traded: boolean
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

export default function CatalogPage() {
  const [search, setSearch]     = useState('')
  const [region, setRegion]     = useState('RU')
  const [items, setItems]       = useState<Item[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(false)
  const [adding, setAdding]     = useState<string | null>(null)
  const [success, setSuccess]   = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)

  const handleSearch = useCallback(async () => {
    if (!search.trim()) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/items', { params: { search: search.trim(), page_size: 50 } })
      setItems(data.items)
      setTotal(data.total)
    } catch {
      setError('Ошибка поиска')
    } finally {
      setLoading(false)
    }
  }, [search])

  const handleAdd = async (item: Item) => {
    setAdding(item.item_id)
    setSuccess(null)
    setError(null)
    try {
      await api.post('/watchlist/', { item_id: item.item_id, region })
      setSuccess(`${item.name_ru || item.item_id} добавлен в watchlist (${region})`)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Ошибка добавления')
    } finally {
      setAdding(null)
    }
  }

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Каталог предметов</Typography>

      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField
          placeholder="Поиск по названию..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          size="small"
          sx={{ flexGrow: 1 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
          }}
        />
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>Регион</InputLabel>
          <Select value={region} label="Регион" onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="contained" onClick={handleSearch} disabled={loading}>
          {loading ? <CircularProgress size={20} /> : 'Найти'}
        </Button>
      </Box>

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
                    <TableCell>ID</TableCell>
                    <TableCell>Категория</TableCell>
                    <TableCell>Пачки</TableCell>
                    <TableCell align="right"></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>
                        <Typography variant="body2" fontWeight={500}>{item.name_ru}</Typography>
                        <Typography variant="caption" color="text.secondary">{item.name_en}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'primary.main' }}>
                          {item.item_id}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">{item.category}</Typography>
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
                          onClick={() => handleAdd(item)}
                          disabled={adding === item.item_id}
                          variant="outlined"
                        >
                          Watchlist
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
    </Box>
  )
}
