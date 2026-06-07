import { useEffect, useState } from 'react'
import {
  Box, Typography, Card, CardContent, Grid2, Chip, CircularProgress,
  Alert, FormControl, InputLabel, Select, MenuItem, Tooltip, Avatar,
} from '@mui/material'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import api from '../api/client'
import { translateCategory, formatPrice, iconUrl } from '../utils/i18n'

interface OpportunityItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
  region: string
  current_price: number | null
  avg_price_24h: number | null
  min_price_24h: number | null
  opportunity_pct: number | null
  lot_count: number | null
  scanned_at: string | null
  min_price_at: string | null
  hours_since_min: number | null
}

const REGIONS = ['RU', 'EU', 'NA', 'SEA']

function fmtHoursAgo(hours: number | null): string {
  if (hours == null) return ''
  if (hours < 1) return 'только что'
  if (hours < 2) return '~1 ч назад'
  if (hours < 24) return `~${Math.round(hours)} ч назад`
  const days = hours / 24
  return days < 2 ? '~1 день назад' : `~${Math.round(days)} дн. назад`
}

export default function FeedPage() {
  const [items, setItems]   = useState<OpportunityItem[]>([])
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
      setError('Нет данных — глобальный скан ещё не накопил статистику за 24ч')
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
            MARKET SCAN // TOP OPPORTUNITIES 24H
          </Typography>
          <Typography variant="h5" fontWeight={700}>Лента возможностей</Typography>
          <Typography variant="caption" color="text.secondary">
            Предметы вне Избранного, которые сейчас продаются заметно дешевле своей средней — добавь в Избранное и попробуй заработать
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
                        <Typography variant="caption" color="text.secondary" display="block">Цена сейчас</Typography>
                        <Typography variant="body2" fontWeight={700} color="primary.main">
                          {formatPrice(item.current_price)}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          {item.lot_count ?? 0} лотов
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography variant="caption" color="text.secondary" display="block">Средняя / мин. за 24ч</Typography>
                        <Typography variant="body2">
                          {formatPrice(item.avg_price_24h != null ? Math.round(item.avg_price_24h) : null)} / {formatPrice(item.min_price_24h)}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          мин. {fmtHoursAgo(item.hours_since_min)}
                        </Typography>
                      </Box>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {item.opportunity_pct != null && (
                        <Tooltip title="Насколько текущая цена ниже средней за 24ч — выгодный момент для закупки прямо сейчас">
                          <Chip
                            size="small"
                            icon={<LocalOfferIcon />}
                            label={`сейчас −${item.opportunity_pct.toFixed(1)}% от средней`}
                            color="success"
                            variant="outlined"
                            sx={{ height: 20, fontSize: 11 }}
                          />
                        </Tooltip>
                      )}
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
