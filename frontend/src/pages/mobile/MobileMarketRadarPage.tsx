import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Skeleton } from '@mui/material'
import api from '../../api/client'
import { iconUrl, qualityKeyByValue } from '../../utils/i18n'
import { fmtN, fmtCompact } from '../../utils/format'
import { tokens, fs } from '../../theme'
import { useAuthStore } from '../../store/authStore'
import Kick from '../../components/ui/Kick'
import ItemIcon from '../../components/ui/ItemIcon'
import QualityChip from '../../components/ui/QualityChip'
import PageLock from '../../components/ui/PageLock'
import { useToast } from '../../components/ui/Toast'
import DCard from '../../components/mobile/ui/DCard'

// Радар рынка (мобайл) — рейтинг-DCard вместо фиксированных колонок ~820px
// (десктоп MarketRadarPage). Тот же эндпоинт /market-radar/, тот же гейт аддона
// has_market_radar_addon → PageLock. Действия «Лоты»/«Карточка» — навигация с state.

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран',  4: 'Мастер',   5: 'Легендарный',
}
const PAGE_SIZE = 20

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
}

export default function MobileMarketRadarPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const hasAddon = useAuthStore(s => s.user?.has_market_radar_addon ?? false)

  const [data, setData]       = useState<MarketRadarResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied]   = useState(false)
  const [error, setError]     = useState(false)
  const [page, setPage]       = useState(0)

  useEffect(() => {
    if (!hasAddon) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    api.get('/market-radar/', { params: { page: page + 1, page_size: PAGE_SIZE } })
      .then(({ data }) => { if (!cancelled) setData(data) })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 403) setDenied(true); else setError(true)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, hasAddon])

  if (!hasAddon || denied) {
    return (
      <PageLock
        title="Доступно как отдельный аддон"
        description="Радар показывает, за чем следят все трейдеры терминала: топ предметов по подпискам, всплески оптовых сделок и выгодные лоты. Подключается администратором отдельно от тарифа."
        ctaLabel="Как подключить"
        onCta={() => showToast('Аддон подключает администратор — напишите в поддержку терминала')}
      />
    )
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Не удалось загрузить данные</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Попробуйте обновить страницу позже.</Typography>
      </Box>
    )
  }

  const total = data?.total_count ?? 0
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to   = Math.min((page + 1) * PAGE_SIZE, total)

  const navState = (it: MarketRadarItem) => ({
    item_id: it.item_id, name_ru: it.name_ru, name_en: it.name_en,
    icon_path: it.icon_path, quality_filter: it.quality_filter, enchant_filter: it.enchant_filter,
  })

  return (
    <Box>
      <Box sx={{ pb: '12px' }}>
        <Kick>Радар рынка // Market Radar</Kick>
        <Typography sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}>
          Топ отслеживаемых
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '5px', lineHeight: 1.5 }}>
          За чем следят трейдеры площадки: рейтинг по подпискам, всплески оптовых сделок и выгодные лоты прямо сейчас.
        </Typography>
        {data && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px', mt: '10px' }}>
            <Box component="span" className="mono" sx={{ fontSize: fs.f11, padding: '2px 8px', borderRadius: '2px', color: tokens.text1, border: `1px solid ${tokens.borderHi}` }}>
              {fmtN(data.total_active_watchers)} подписок
            </Box>
            <Box component="span" className="mono" sx={{ fontSize: fs.f11, padding: '2px 8px', borderRadius: '2px', color: tokens.goldAccent, border: `1px solid ${tokens.goldLine}`, background: tokens.goldDim }}>
              {fmtN(data.unique_items_tracked)} предметов
            </Box>
          </Box>
        )}
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} variant="rectangular" height={110} sx={{ bgcolor: tokens.bg2 }} />)}
        </Box>
      ) : !data || data.top_items.length === 0 ? (
        <Box sx={{ padding: '44px 20px', textAlign: 'center' }}>
          <Typography sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f14, letterSpacing: '0.1em', textTransform: 'uppercase', color: tokens.text1 }}>Пока нет данных</Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '6px' }}>Никто из пользователей ещё не отслеживает предметы в Избранном.</Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.top_items.map((it, idx) => {
            const globalIdx = page * PAGE_SIZE + idx
            const rank = String(globalIdx + 1).padStart(2, '0')
            const name = it.name_ru ?? it.name_en ?? it.item_id
            const win = it.price_window === '7d' ? 'за 7д' : 'за 24ч'
            const rankColor = globalIdx === 0 ? tokens.goldHighlight : globalIdx < 3 ? tokens.goldAccent : tokens.text2
            return (
              <DCard
                key={`${it.item_id}-${it.quality_filter ?? 'any'}-${it.enchant_filter ?? 'any'}`}
                onClick={() => navigate('/app/lots', { state: navState(it) })}
                icon={<ItemIcon src={iconUrl(it.icon_path) ?? undefined} name={name} quality={qualityKeyByValue(it.quality_filter)} size={32} />}
                name={
                  <>
                    <Box component="span" className="mono" sx={{ color: rankColor, fontWeight: 700, mr: '6px', ...(globalIdx === 0 ? { textShadow: `0 0 14px ${tokens.goldGlow}` } : null) }}>{rank}</Box>
                    {name}
                    {it.enchant_filter != null && it.enchant_filter > 0 && (
                      <Box component="span" className="mono" sx={{ ml: 0.5, color: tokens.goldAccent, fontWeight: 700 }}>+{it.enchant_filter}</Box>
                    )}
                  </>
                }
                sub={<span>{it.item_id}</span>}
                chips={
                  <>
                    {it.quality_filter != null && (
                      <QualityChip color={qualityKeyByValue(it.quality_filter)} label={QLT_NAMES[it.quality_filter] ?? `кач. ${it.quality_filter}`} />
                    )}
                    {it.bulk_spike && (
                      <Box component="span" className="mono" sx={{ fontSize: fs.f10, fontWeight: 700, letterSpacing: '0.08em', color: tokens.warning, background: tokens.warningDim, border: `1px solid ${tokens.warningLine}`, padding: '2px 7px', borderRadius: '2px' }}>SPIKE</Box>
                    )}
                  </>
                }
                kv={[
                  { label: 'Следят', value: <>{fmtN(it.watchers_count)}{it.new_watchers_24h > 0 && <Box component="span" sx={{ ml: '4px', color: tokens.success, fontWeight: 700 }}>+{it.new_watchers_24h}</Box>}</> },
                  { label: `Цена ${win}`, value: it.avg_price_24h != null ? fmtCompact(it.avg_price_24h) : '—', tone: it.avg_price_24h != null ? 'gold' : 'dim' },
                  { label: `Объём ${win}`, value: it.sales_volume_24h != null ? `${fmtN(it.sales_volume_24h)} шт` : '—', tone: it.sales_volume_24h != null ? 'default' : 'dim' },
                  { label: 'Выгодных лотов', value: it.profitable_offers_count != null ? fmtN(it.profitable_offers_count) : '—', tone: it.profitable_offers_count && it.profitable_offers_count > 0 ? 'pos' : 'dim' },
                ]}
                footer={
                  <>
                    <Button variant="outlined" size="small" onClick={(e) => { e.stopPropagation(); navigate('/app/lots', { state: navState(it) }) }} sx={{ minHeight: 36 }}>Лоты</Button>
                    <Button variant="outlined" size="small" onClick={(e) => { e.stopPropagation(); navigate('/app/monitoring', { state: navState(it) }) }} sx={{ minHeight: 36 }}>Карточка</Button>
                  </>
                }
              />
            )
          })}
        </Box>
      )}

      {total > PAGE_SIZE && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', pt: '14px' }}>
          <Box component="button" type="button" aria-label="Назад" disabled={page <= 0}
            onClick={() => { setPage(p => Math.max(0, p - 1)); window.scrollTo(0, 0) }}
            sx={{ minWidth: 44, minHeight: 40, display: 'grid', placeItems: 'center', color: tokens.text1, background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: '2px', cursor: 'pointer', '&:disabled': { opacity: 0.4 } }}>‹</Box>
          <Box component="span" className="mono" sx={{ fontSize: fs.f12, color: tokens.text2 }}>{from}–{to} / {fmtN(total)}</Box>
          <Box component="button" type="button" aria-label="Вперёд" disabled={to >= total}
            onClick={() => { setPage(p => p + 1); window.scrollTo(0, 0) }}
            sx={{ minWidth: 44, minHeight: 40, display: 'grid', placeItems: 'center', color: tokens.text1, background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: '2px', cursor: 'pointer', '&:disabled': { opacity: 0.4 } }}>›</Box>
        </Box>
      )}
    </Box>
  )
}
