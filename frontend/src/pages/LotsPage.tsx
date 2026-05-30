import { useState } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Button, Card, CardContent,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Chip, CircularProgress, Alert, FormControl, InputLabel, Select, MenuItem,
  List, ListItem, ListItemButton, ListItemText, Paper, Tooltip,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import api from '../api/client'
import { translateCategory, formatPrice } from '../utils/i18n'

interface Item {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
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

export default function LotsPage() {
  const [query, setQuery]         = useState('')
  const [region, setRegion]       = useState('RU')
  const [suggestions, setSuggestions] = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [result, setResult]       = useState<LotsResponse | null>(null)
  const [loading, setLoading]     = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  // Поиск по названию → список предметов
  const handleQueryChange = async (value: string) => {
    setQuery(value)
    setSelectedItem(null)
    setResult(null)
    if (value.trim().length < 2) { setSuggestions([]); return }

    setSearching(true)
    try {
      const { data } = await api.get('/items', { params: { search: value.trim(), page_size: 8 } })
      setSuggestions(data.items)
    } catch {
      setSuggestions([])
    } finally {
      setSearching(false)
    }
  }

  // Выбор предмета из подсказок → загрузка лотов
  const handleSelect = async (item: Item) => {
    setSelectedItem(item)
    setQuery(item.name_ru || item.name_en || item.item_id)
    setSuggestions([])
    setError(null)
    setLoading(true)
    try {
      const { data } = await api.get(`/lots/${item.item_id}`, { params: { region } })
      setResult(data)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Нет активных лотов')
    } finally {
      setLoading(false)
    }
  }

  const handleRegionChange = async (newRegion: string) => {
    setRegion(newRegion)
    if (!selectedItem) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get(`/lots/${selectedItem.item_id}`, { params: { region: newRegion } })
      setResult(data)
    } catch {
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 1 }}>Поиск лотов</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Активные лоты без добавления в Избранное. Данные из кэша, обновляются каждые 5 мин.
      </Typography>

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
                startAdornment: <InputAdornment position="start">
                  {searching ? <CircularProgress size={16} /> : <SearchIcon fontSize="small" />}
                </InputAdornment>,
              },
            }}
          />
          {/* Выпадающие подсказки */}
          {suggestions.length > 0 && (
            <Paper sx={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, mt: 0.5 }}>
              <List dense disablePadding>
                {suggestions.map((item) => (
                  <ListItem key={item.item_id} disablePadding>
                    <ListItemButton onClick={() => handleSelect(item)}>
                      <ListItemText
                        primary={item.name_ru || item.name_en}
                        secondary={translateCategory(item.category)}
                        primaryTypographyProps={{ variant: 'body2' }}
                        secondaryTypographyProps={{ variant: 'caption' }}
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

      {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>}

      {result && !loading && (
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {selectedItem?.name_ru || result.item_id}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {translateCategory(selectedItem?.category ?? null)} · {result.region} · Всего на аукционе: {result.total}
                </Typography>
              </Box>
              <Tooltip title={result.cache_note}>
                <Chip
                  label={result.from_cache ? 'из кэша' : 'свежие данные'}
                  size="small"
                  color={result.from_cache ? 'default' : 'success'}
                  icon={<InfoOutlinedIcon />}
                />
              </Tooltip>
            </Box>

            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Цена выкупа</TableCell>
                    <TableCell>Количество</TableCell>
                    <TableCell>Цена / шт</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        Осталось
                        <Tooltip title="Лоты с остатком менее 2 часов помечены как истекающие — их цена может быть нерыночной">
                          <InfoOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                        </Tooltip>
                      </Box>
                    </TableCell>
                    <TableCell>Статус</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {result.lots.map((lot, i) => (
                    <TableRow key={i} hover sx={{ opacity: lot.is_expiring ? 0.55 : 1 }}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600} color={i === 0 && !lot.is_expiring ? 'primary.main' : 'inherit'}>
                          {formatPrice(lot.buyout_price)}
                        </Typography>
                      </TableCell>
                      <TableCell>{lot.amount} шт.</TableCell>
                      <TableCell>{formatPrice(Math.floor(lot.buyout_price / lot.amount))}</TableCell>
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
