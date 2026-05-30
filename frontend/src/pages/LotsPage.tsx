import { useState } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Button, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Chip, CircularProgress, Alert, FormControl, InputLabel, Select, MenuItem,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'

interface Lot {
  item_id: string
  amount: number
  buyout_price: number
  start_price: number
  start_time: string
  end_time: string
  hours_remaining: number | null
  is_expiring: boolean
}

interface LotsResponse {
  item_id: string
  region: string
  total: number
  lots: Lot[]
  from_cache: boolean
  cache_note: string
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']
const fmt = (n: number) => n.toLocaleString('ru-RU')

export default function LotsPage() {
  const [itemId, setItemId]     = useState('')
  const [region, setRegion]     = useState('RU')
  const [result, setResult]     = useState<LotsResponse | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const handleSearch = async () => {
    if (!itemId.trim()) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get(`/lots/${itemId.trim()}`, { params: { region } })
      setResult(data)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Товар не найден или нет лотов')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Быстрый поиск лотов</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Просмотр активных лотов без добавления в watchlist. Данные из кэша (обновляются каждые 5 мин).
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <TextField
          placeholder="ID предмета (напр. m02wr)"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
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

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {result && (
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                  {result.item_id} · {result.region}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Всего на аукционе: {result.total} · {result.cache_note}
                </Typography>
              </Box>
            </Box>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Цена выкупа</TableCell>
                    <TableCell>Кол-во</TableCell>
                    <TableCell>Цена/шт</TableCell>
                    <TableCell>Осталось</TableCell>
                    <TableCell>Статус</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {result.lots.map((lot, i) => (
                    <TableRow key={i} hover sx={{ opacity: lot.is_expiring ? 0.6 : 1 }}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600} color={i === 0 ? 'primary.main' : 'inherit'}>
                          {fmt(lot.buyout_price)} ₽
                        </Typography>
                      </TableCell>
                      <TableCell>{lot.amount} шт.</TableCell>
                      <TableCell>
                        {fmt(Math.floor(lot.buyout_price / lot.amount))} ₽
                      </TableCell>
                      <TableCell>
                        {lot.hours_remaining != null
                          ? `${lot.hours_remaining.toFixed(1)} ч`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {lot.is_expiring
                          ? <Chip label="Истекает" size="small" color="error" variant="outlined" />
                          : <Chip label="Активен" size="small" color="success" variant="outlined" />}
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
