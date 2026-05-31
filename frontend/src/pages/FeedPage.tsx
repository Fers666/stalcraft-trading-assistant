import { useEffect, useState } from 'react'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  Alert, FormControl, InputLabel, Select, MenuItem, Tooltip, Avatar,
} from '@mui/material'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import TrendingDownIcon from '@mui/icons-material/TrendingDown'
import api from '../api/client'
import { translateCategory, formatPrice, iconUrl } from '../utils/i18n'

interface FeedItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
  region: string
  lot_count: number | null
  liquid_lot_count: number | null
  best_price: number | null
  avg_price: number | null
  price_change_pct: number | null
  tradability_score: number | null
  scanned_at: string | null
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

export default function FeedPage() {
  const [items, setItems]   = useState<FeedItem[]>([])
  const [region, setRegion] = useState('RU')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  const load = async (r: string) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/monitoring/feed', { params: { region: r, limit: 30 } })
      setItems(data)
    } catch {
      setError('Нет данных — глобальный скан ещё не завершил первый цикл (раз в час)')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(region) }, [region])

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Box>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, mb: 0.5 }}>
            MARKET FEED // TOP BY TRADABILITY
          </Typography>
          <Typography variant="h5" fontWeight={700}>Лента предметов</Typography>
          <Typography variant="caption" color="text.secondary">
            Топ по торгуемости — предметы вне Избранного, обновляется раз в час
          </Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>Регион</InputLabel>
          <Select value={region} label="Регион" onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
          </Select>
        </FormControl>
      </Box>

      {error && <Alert severity="info" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>}

      {!loading && !error && (
        <Grid2 container spacing={2}>
          {items.map((item) => {
            const url = iconUrl(item.icon_path)
            const priceUp = item.price_change_pct != null && item.price_change_pct > 0
            const priceDown = item.price_change_pct != null && item.price_change_pct < 0

            return (
              <Grid2 size={{ xs: 12, sm: 6, md: 4, xl: 3 }} key={item.item_id}>
                <Card sx={{ height: '100%' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
                      <Avatar
                        src={url ?? undefined}
                        variant="rounded"
                        sx={{ width: 40, height: 40, bgcolor: 'background.default' }}
                      >
                        {!url && (item.name_ru?.[0] ?? '?')}
                      </Avatar>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" fontWeight={700} noWrap>
                          {item.name_ru || item.name_en || item.item_id}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {translateCategory(item.category)}
                        </Typography>
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block">Лучшая цена</Typography>
                        <Typography variant="body2" fontWeight={700} color="primary.main">
                          {formatPrice(item.best_price)}
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography variant="caption" color="text.secondary" display="block">Лотов</Typography>
                        <Typography variant="body2">
                          {item.liquid_lot_count ?? 0} / {item.lot_count ?? 0}
                        </Typography>
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {item.price_change_pct != null && (
                        <Tooltip title="Изменение цены с прошлого скана">
                          <Chip
                            size="small"
                            icon={priceUp ? <TrendingUpIcon /> : priceDown ? <TrendingDownIcon /> : undefined}
                            label={`${item.price_change_pct > 0 ? '+' : ''}${item.price_change_pct.toFixed(1)}%`}
                            color={priceUp ? 'error' : priceDown ? 'success' : 'default'}
                            variant="outlined"
                            sx={{ height: 20, fontSize: 11 }}
                          />
                        </Tooltip>
                      )}
                      <Tooltip title="Скор торгуемости: чем выше — тем активнее рынок">
                        <Chip
                          size="small"
                          label={`★ ${item.tradability_score?.toFixed(0) ?? 0}`}
                          variant="outlined"
                          color="primary"
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      </Tooltip>
                    </Box>
                  </CardContent>
                </Card>
              </Grid2>
            )
          })}
        </Grid2>
      )}
    </Box>
  )
}
