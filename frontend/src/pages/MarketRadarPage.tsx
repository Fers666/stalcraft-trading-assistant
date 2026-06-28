import { useState, useEffect } from 'react'
import {
  Box, Typography, Card, Chip, CircularProgress, Avatar, Tooltip, alpha, TablePagination,
} from '@mui/material'
import api from '../api/client'
import { formatPrice, iconUrl, qualityColor } from '../utils/i18n'
import { tokens } from '../theme'

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран',  4: 'Мастер',   5: 'Легендарный',
}

interface MarketRadarItem {
  item_id: string
  quality_filter: number | null
  enchant_filter: number | null
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  watchers_count: number
  new_watchers_24h: number
  avg_price_24h: number | null
  sales_volume_24h: number | null
  bulk_spike: boolean | null
  price_window: '24h' | '7d'
  profitable_offers_count: number | null
}

interface MarketRadarResponse {
  top_items: MarketRadarItem[]
  total_active_watchers: number
  unique_items_tracked: number
  calculated_at: string
  total_count: number
  page: number
  page_size: number
}

export default function MarketRadarPage() {
  const [data, setData]           = useState<MarketRadarResponse | null>(null)
  const [loading, setLoading]     = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [denied, setDenied]       = useState(false)
  const [error, setError]         = useState(false)
  const [page, setPage]           = useState(0)

  useEffect(() => {
    let cancelled = false
    setListLoading(true)
    api.get('/market-radar/', { params: { page: page + 1, page_size: 20 } })
      .then(({ data }) => { if (!cancelled) setData(data) })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 403) setDenied(true)
        else setError(true)
      })
      .finally(() => { if (!cancelled) { setLoading(false); setListLoading(false) } })
    return () => { cancelled = true }
  }, [page])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (denied) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Аддон не активирован</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          «Радар рынка» доступен как отдельный аддон — обратитесь к администратору, чтобы получить доступ.
        </Typography>
      </Box>
    )
  }

  if (error || !data) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Не удалось загрузить данные</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Попробуйте обновить страницу позже.
        </Typography>
      </Box>
    )
  }

  return (
    <Box>
      {/* Заголовок */}
      <Box sx={{ mb: 2.5, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', letterSpacing: '0.14em', fontWeight: 600, lineHeight: 1, mb: 0.4 }}>
            РАДАР РЫНКА
          </Typography>
          <Typography variant="h5" fontWeight={700}>
            Топ отслеживаемых предметов
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Chip
            label={`${data.total_active_watchers} активных подписок`}
            size="small" variant="outlined"
            sx={{ height: 22, fontSize: 11, color: 'text.secondary' }}
          />
          <Chip
            label={`${data.unique_items_tracked} уникальных предметов`}
            size="small" variant="outlined"
            sx={{ height: 22, fontSize: 11, color: tokens.gold, borderColor: tokens.gold }}
          />
        </Box>
      </Box>

      {data.top_items.length === 0 ? (
        <Box sx={{ textAlign: 'center', mt: 8 }}>
          <Typography variant="h6" color="text.secondary">Пока нет данных</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Никто из пользователей ещё не отслеживает предметы в Избранном.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ position: 'relative' }}>
          {listLoading && (
            <Box sx={{
              position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center',
              alignItems: 'center', bgcolor: alpha('#080808', 0.5), zIndex: 1, borderRadius: 1,
            }}>
              <CircularProgress size={32} />
            </Box>
          )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {data.top_items.map((item, idx) => (
            <Card key={`${item.item_id}-${item.quality_filter ?? 'any'}-${item.enchant_filter ?? 'any'}`} sx={{ overflow: 'hidden' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5 }}>

                {/* Ранг */}
                <Typography sx={{
                  width: 28, flexShrink: 0, textAlign: 'center',
                  fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
                  fontSize: '1rem', color: idx < 3 ? tokens.gold : 'text.disabled',
                }}>
                  {idx + 1}
                </Typography>

                {/* Иконка */}
                <Avatar
                  src={iconUrl(item.icon_path) ?? undefined}
                  variant="rounded"
                  sx={{ width: 44, height: 44, bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', flexShrink: 0 }}
                >
                  {!item.icon_path && (item.name_ru?.[0] ?? item.name_en?.[0] ?? '?')}
                </Avatar>

                {/* Название + качество/заточка */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" fontWeight={700} noWrap>
                    {item.name_ru ?? item.name_en ?? item.item_id}
                    {item.enchant_filter != null && item.enchant_filter > 0 && (
                      <Typography component="span" sx={{ ml: 0.5, fontSize: '0.65rem', color: 'primary.main', fontWeight: 700 }}>
                        +{item.enchant_filter}
                      </Typography>
                    )}
                    {item.enchant_filter === 0 && (
                      <Typography component="span" sx={{ ml: 0.5, fontSize: '0.65rem', color: 'text.disabled', fontWeight: 400 }}>
                        Не точёный
                      </Typography>
                    )}
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mt: 0.2 }}>
                    {item.quality_filter !== null ? (
                      <Chip
                        label={QLT_NAMES[item.quality_filter] ?? `qlt${item.quality_filter}`}
                        size="small" variant="outlined"
                        sx={{
                          height: 14, fontSize: 9,
                          borderColor: qualityColor(QLT_NAMES[item.quality_filter]) ?? undefined,
                          color: qualityColor(QLT_NAMES[item.quality_filter]) ?? undefined,
                        }}
                      />
                    ) : item.enchant_filter === null && (
                      <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', fontStyle: 'italic' }} noWrap>
                        любое качество / любая заточка
                      </Typography>
                    )}
                    <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled', fontFamily: 'monospace' }} noWrap>
                      {item.item_id}
                    </Typography>
                  </Box>
                </Box>

                {/* Watchers */}
                <Box sx={{ textAlign: 'right', flexShrink: 0, minWidth: 76 }}>
                  <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>WATCHERS</Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                    <Typography sx={{ fontSize: '0.95rem', fontWeight: 700 }}>{item.watchers_count}</Typography>
                    {item.new_watchers_24h > 0 && (
                      <Tooltip title="Новых за 24ч">
                        <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: tokens.success }}>
                          +{item.new_watchers_24h}
                        </Typography>
                      </Tooltip>
                    )}
                  </Box>
                </Box>

                {/* Цена-ориентир */}
                <Box sx={{ textAlign: 'right', flexShrink: 0, minWidth: 92 }}>
                  <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>ЦЕНА</Typography>
                  <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: item.avg_price_24h == null ? 'text.disabled' : 'text.primary' }}>
                    {item.avg_price_24h != null ? formatPrice(item.avg_price_24h) : 'нет данных'}
                  </Typography>
                  <Typography sx={{ fontSize: '0.5rem', color: 'text.disabled' }}>
                    {item.price_window === '7d' ? 'за 7д' : 'за 24ч'}
                  </Typography>
                </Box>

                {/* Объём */}
                <Box sx={{ textAlign: 'right', flexShrink: 0, minWidth: 80 }}>
                  <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>ОБЪЁМ</Typography>
                  <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: item.sales_volume_24h == null ? 'text.disabled' : 'text.primary' }}>
                    {item.sales_volume_24h != null ? item.sales_volume_24h : 'нет данных'}
                  </Typography>
                  <Typography sx={{ fontSize: '0.5rem', color: 'text.disabled' }}>
                    {item.price_window === '7d' ? 'за 7д' : 'за 24ч'}
                  </Typography>
                </Box>

                {/* Выгодные предложения */}
                <Box sx={{ textAlign: 'right', flexShrink: 0, minWidth: 84 }}>
                  <Typography sx={{ fontSize: '0.55rem', color: 'text.disabled', letterSpacing: '0.08em' }}>ВЫГОДНЫХ</Typography>
                  <Typography sx={{
                    fontSize: '0.85rem', fontWeight: 700,
                    color: item.profitable_offers_count == null
                      ? 'text.disabled'
                      : item.profitable_offers_count > 0 ? tokens.success : 'text.primary',
                  }}>
                    {item.profitable_offers_count != null ? item.profitable_offers_count : 'нет данных'}
                  </Typography>
                </Box>

                {/* Bulk spike */}
                <Box sx={{ flexShrink: 0, minWidth: 28, display: 'flex', justifyContent: 'center' }}>
                  {item.bulk_spike && (
                    <Tooltip title="Всплеск оптовых сделок за 24ч">
                      <Chip
                        label="SPIKE" size="small"
                        sx={{
                          height: 18, fontSize: 9, fontWeight: 700,
                          bgcolor: alpha(tokens.goldAccent, 0.15), color: tokens.goldAccent,
                          border: `1px solid ${alpha(tokens.goldAccent, 0.4)}`,
                        }}
                      />
                    </Tooltip>
                  )}
                </Box>
              </Box>
            </Card>
          ))}
        </Box>
        </Box>
      )}

      {data.total_count > 0 && (
        <TablePagination
          component="div"
          count={data.total_count}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={20}
          labelRowsPerPage="Строк:"
          labelDisplayedRows={({ from, to, count }) => `${from}–${to} из ${count}`}
        />
      )}
    </Box>
  )
}
