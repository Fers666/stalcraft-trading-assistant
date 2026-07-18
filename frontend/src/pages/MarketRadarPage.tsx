import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, Button, Skeleton, Tooltip } from '@mui/material'
import api from '../api/client'
import { iconUrl, qualityKeyByValue } from '../utils/i18n'
import { fmtN, fmtCompact } from '../utils/format'
import { tokens, fs } from '../theme'
import { useAuthStore } from '../store/authStore'
import Panel from '../components/ui/Panel'
import Kick from '../components/ui/Kick'
import ItemIcon from '../components/ui/ItemIcon'
import QualityChip from '../components/ui/QualityChip'
import PageLock from '../components/ui/PageLock'
import { useToast } from '../components/ui/Toast'

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
  page: number
  page_size: number
}

// Шаблон колонок (шапка + строки) — .col-rk/.col-item/… из radar.html.
// Ширины совпадают ячейка-в-ячейку с прототипом; .col-act — трейлинг-ячейка
// действий «Лоты»/«Карточка» (по §5.4), которой нет в прототипе.
const COL = {
  rk:   { width: 34,  flex: 'none', textAlign: 'right' as const },
  item: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '11px' },
  w:    { width: 96,  flex: 'none', textAlign: 'right' as const },
  p:    { width: 150, flex: 'none', textAlign: 'right' as const },
  v:    { width: 130, flex: 'none', textAlign: 'right' as const },
  g:    { width: 96,  flex: 'none', textAlign: 'right' as const },
  s:    { width: 64,  flex: 'none', display: 'flex', justifyContent: 'flex-end' },
  act:  { width: 150, flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '6px' },
}

// .hk — киккер-заголовок колонки (Rajdhani 600, fs.f105, uppercase, text2)
function HeadCell({ label, colSx }: { label?: string; colSx: object }) {
  return (
    <Box
      component="span"
      sx={{
        ...colSx,
        fontFamily: tokens.fontHead,
        fontWeight: 600,
        fontSize: fs.f105,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: tokens.text2,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  )
}

// .rv — значение метрики (mono, tabular); .rvs — подпись под ним
function Metric({ value, sub, tone = 'default' }: { value: string; sub?: string; tone?: 'default' | 'g' | 'dim' }) {
  return (
    <>
      <Box
        component="span"
        className="mono"
        sx={{
          display: 'block',
          fontSize: fs.f14,
          fontWeight: tone === 'dim' ? 400 : 500,
          color: tone === 'g' ? tokens.success : tone === 'dim' ? tokens.text2 : tokens.text0,
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Box>
      {sub != null && (
        <Box
          component="span"
          className="mono"
          sx={{ display: 'block', fontSize: fs.f105, color: tokens.text2, whiteSpace: 'nowrap', mt: '1px' }}
        >
          {sub}
        </Box>
      )}
    </>
  )
}

// «—» пустой метрики: один общий тултип вместо повтора «нет данных» (§5.4)
function EmptyMetric() {
  return (
    <Tooltip title="Нет данных за выбранный период">
      <Box component="span" className="mono" sx={{ display: 'block', fontSize: fs.f14, fontWeight: 400, color: tokens.text2, cursor: 'default' }}>
        —
      </Box>
    </Tooltip>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '8px 16px', background: tokens.bg1 }}>
          <Skeleton variant="text" width={20} sx={{ bgcolor: tokens.bg2 }} />
          <Skeleton variant="rectangular" width={36} height={36} sx={{ bgcolor: tokens.bg2, flex: 'none' }} />
          <Skeleton variant="text" sx={{ bgcolor: tokens.bg2, flex: 1 }} />
          <Skeleton variant="text" width={60} sx={{ bgcolor: tokens.bg2 }} />
          <Skeleton variant="text" width={100} sx={{ bgcolor: tokens.bg2 }} />
          <Skeleton variant="text" width={80} sx={{ bgcolor: tokens.bg2 }} />
        </Box>
      ))}
    </>
  )
}

export default function MarketRadarPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const hasAddon = useAuthStore(s => s.user?.has_market_radar_addon ?? false)

  const [data, setData]               = useState<MarketRadarResponse | null>(null)
  const [loading, setLoading]         = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [denied, setDenied]           = useState(false)
  const [error, setError]             = useState(false)
  const [page, setPage]               = useState(0) // 0-based

  useEffect(() => {
    if (!hasAddon) { setLoading(false); return }
    let cancelled = false
    setListLoading(true)
    api.get('/market-radar/', { params: { page: page + 1, page_size: PAGE_SIZE } })
      .then(({ data }) => { if (!cancelled) setData(data) })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 403) setDenied(true)
        else setError(true)
      })
      .finally(() => { if (!cancelled) { setLoading(false); setListLoading(false) } })
    return () => { cancelled = true }
  }, [page, hasAddon])

  // ── Гейт аддона (реальное поле has_market_radar_addon) / отказ доступа ──────
  if (!hasAddon || denied) {
    return (
      <Panel>
        <PageLock
          title="Доступно как отдельный аддон"
          description="Радар показывает, за чем следят все трейдеры терминала: топ предметов по подпискам, всплески оптовых сделок и выгодные лоты. Подключается администратором отдельно от тарифа."
          ctaLabel="Как подключить"
          onCta={() => showToast('Аддон подключает администратор — напишите в поддержку терминала')}
        />
      </Panel>
    )
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Не удалось загрузить данные</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Попробуйте обновить страницу позже.
        </Typography>
      </Box>
    )
  }

  const total = data?.total_count ?? 0
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to   = Math.min((page + 1) * PAGE_SIZE, total)
  const calcTime = data?.calculated_at
    ? new Date(data.calculated_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : '—'

  // Переход с выбранным предметом (паттерн MonitoringPage.handleViewLots, §5.4)
  const navState = (it: MarketRadarItem) => ({
    item_id: it.item_id,
    name_ru: it.name_ru,
    name_en: it.name_en,
    icon_path: it.icon_path,
    quality_filter: it.quality_filter,
    enchant_filter: it.enchant_filter,
  })
  const openLots = (it: MarketRadarItem) => navigate('/app/lots', { state: navState(it) })
  const openCard = (it: MarketRadarItem) => navigate('/app/monitoring', { state: navState(it) })

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
      <Panel>
        {/* .pg-h — шапка страницы: киккер + h1 + подзаголовок + чипы-счётчики */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '14px 18px 12px' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Kick>Радар рынка // Market Radar</Kick>
            <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
              Топ отслеживаемых предметов
            </Typography>
            <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
              За чем следят трейдеры площадки: рейтинг предметов по подпискам в Избранном, всплески оптовых сделок и выгодные лоты прямо сейчас.
            </Typography>
          </Box>
          {data && (
            <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Box
                component="span"
                className="mono"
                sx={{
                  display: 'inline-flex', alignItems: 'center', fontSize: fs.f11, fontWeight: 500,
                  padding: '2px 8px', borderRadius: 1,
                  color: tokens.text1, border: `1px solid ${tokens.borderHi}`,
                }}
              >
                {fmtN(data.total_active_watchers)} активных подписок
              </Box>
              <Box
                component="span"
                className="mono"
                sx={{
                  display: 'inline-flex', alignItems: 'center', fontSize: fs.f11, fontWeight: 500,
                  padding: '2px 8px', borderRadius: 1,
                  color: tokens.goldAccent, border: `1px solid ${tokens.goldLine}`, background: tokens.goldDim,
                }}
              >
                {fmtN(data.unique_items_tracked)} уникальных предметов
              </Box>
            </Box>
          )}
        </Box>

        {/* .rlist — рейтинг: карточки-строки на 1px-щелях */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '1px', background: tokens.border, borderTop: `1px solid ${tokens.border}` }}>
          {/* .rhead — шапка колонок */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '6px 16px', background: tokens.bg2 }}>
            <HeadCell label="#" colSx={COL.rk} />
            <HeadCell label="Предмет" colSx={COL.item} />
            <HeadCell label="Следят" colSx={COL.w} />
            <HeadCell label="Цена 24ч" colSx={COL.p} />
            <HeadCell label="Объём продаж" colSx={COL.v} />
            <HeadCell label="Выгодных" colSx={COL.g} />
            <HeadCell colSx={COL.s} />
            <HeadCell colSx={COL.act} />
          </Box>

          {loading || listLoading ? (
            <SkeletonRows />
          ) : !data || data.top_items.length === 0 ? (
            <Box sx={{ padding: '44px 20px', textAlign: 'center', background: tokens.bg1 }}>
              <Typography sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f14, letterSpacing: '0.1em', textTransform: 'uppercase', color: tokens.text1 }}>
                Пока нет данных
              </Typography>
              <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '6px' }}>
                Никто из пользователей ещё не отслеживает предметы в Избранном.
              </Typography>
            </Box>
          ) : (
            data.top_items.map((it, idx) => {
              const globalIdx = page * PAGE_SIZE + idx
              const rank = String(globalIdx + 1).padStart(2, '0')
              const name = it.name_ru ?? it.name_en ?? it.item_id
              const windowLabel = it.price_window === '7d' ? 'за 7д' : 'за 24ч'
              return (
                <Box
                  key={`${it.item_id}-${it.quality_filter ?? 'any'}-${it.enchant_filter ?? 'any'}`}
                  onClick={() => openLots(it)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: '14px', padding: '8px 16px',
                    background: tokens.bg1, cursor: 'pointer',
                    transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                    '&:hover': { background: tokens.bg2 },
                    '&:active': { background: tokens.bg3 },
                    '&:hover .radar-act, &:focus-within .radar-act': { opacity: 1 },
                  }}
                >
                  {/* .rk — ранг: 01 c глоу, 02–03 золотые, дальше приглушённо (Rajdhani-витрина) */}
                  <Box
                    component="span"
                    sx={{
                      ...COL.rk,
                      fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f14,
                      fontVariantNumeric: 'tabular-nums',
                      color: globalIdx === 0 ? tokens.goldHighlight : globalIdx < 3 ? tokens.goldAccent : tokens.text2,
                      ...(globalIdx === 0 ? { textShadow: `0 0 14px ${tokens.goldGlow}` } : null),
                    }}
                  >
                    {rank}
                  </Box>

                  {/* .col-item — иконка + имя (+заточка) + качество + item_id */}
                  <Box sx={COL.item}>
                    <ItemIcon
                      src={iconUrl(it.icon_path) ?? undefined}
                      name={name}
                      quality={qualityKeyByValue(it.quality_filter)}
                      size={36}
                    />
                    <Box sx={{ minWidth: 0, lineHeight: 1.3 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 500, color: tokens.text0 }}>
                          {name}
                        </Typography>
                        {it.enchant_filter != null && it.enchant_filter > 0 && (
                          <Box component="span" className="mono" sx={{ flex: 'none', fontSize: fs.f105, fontWeight: 700, color: tokens.goldAccent, background: tokens.goldDim, padding: '0 4px', borderRadius: 1 }}>
                            +{it.enchant_filter}
                          </Box>
                        )}
                        {it.enchant_filter === 0 && (
                          <Box component="span" sx={{ flex: 'none', fontSize: fs.f105, color: tokens.text2 }}>
                            Не точёный
                          </Box>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', mt: '2px' }}>
                        {it.quality_filter != null && (
                          <QualityChip
                            color={qualityKeyByValue(it.quality_filter)}
                            label={QLT_NAMES[it.quality_filter] ?? `кач. ${it.quality_filter}`}
                            sx={{ padding: '0 6px', fontSize: fs.f105 }}
                          />
                        )}
                        <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
                          {it.item_id}
                        </Box>
                      </Box>
                    </Box>
                  </Box>

                  {/* .col-w — следят + новые за 24ч */}
                  <Box sx={COL.w}>
                    <Box component="span" className="mono" sx={{ fontSize: fs.f14, fontWeight: 500, color: tokens.text0 }}>
                      {fmtN(it.watchers_count)}
                    </Box>
                    {it.new_watchers_24h > 0 && (
                      <Tooltip title="Новых за 24ч">
                        <Box component="span" className="mono" sx={{ ml: '4px', fontSize: fs.f11, fontWeight: 700, color: tokens.success, cursor: 'default' }}>
                          +{it.new_watchers_24h}
                        </Box>
                      </Tooltip>
                    )}
                  </Box>

                  {/* .col-p — цена-ориентир + окно */}
                  <Box sx={COL.p}>
                    {it.avg_price_24h != null
                      ? <Metric value={fmtCompact(it.avg_price_24h)} sub={windowLabel} />
                      : <EmptyMetric />}
                  </Box>

                  {/* .col-v — объём продаж */}
                  <Box sx={COL.v}>
                    {it.sales_volume_24h != null
                      ? <Metric value={fmtN(it.sales_volume_24h)} sub={`шт ${windowLabel}`} />
                      : <EmptyMetric />}
                  </Box>

                  {/* .col-g — выгодных лотов */}
                  <Box sx={COL.g}>
                    {it.profitable_offers_count != null
                      ? <Metric value={fmtN(it.profitable_offers_count)} tone={it.profitable_offers_count > 0 ? 'g' : 'default'} />
                      : <EmptyMetric />}
                  </Box>

                  {/* .col-s — бейдж всплеска оптовых сделок */}
                  <Box sx={COL.s}>
                    {it.bulk_spike && (
                      <Tooltip title="Всплеск оптовых сделок за 24ч">
                        <Box
                          component="span"
                          className="mono"
                          sx={{
                            fontSize: fs.f10, fontWeight: 700, letterSpacing: '0.08em',
                            color: tokens.warning, background: tokens.warningDim, border: `1px solid ${tokens.warningLine}`,
                            padding: '2px 7px', borderRadius: 1, cursor: 'default',
                          }}
                        >
                          SPIKE
                        </Box>
                      </Tooltip>
                    )}
                  </Box>

                  {/* .col-act — действия «Лоты» / «Карточка» (§5.4) */}
                  <Box className="radar-act" sx={{ ...COL.act, opacity: 0, transition: `opacity ${tokens.motion.fast}ms ${tokens.motion.ease}` }}>
                    <Button
                      variant="outlined" size="small"
                      onClick={(e) => { e.stopPropagation(); openLots(it) }}
                      sx={{ height: 24, minWidth: 0, padding: '0 9px', fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                    >
                      Лоты
                    </Button>
                    <Button
                      variant="outlined" size="small"
                      onClick={(e) => { e.stopPropagation(); openCard(it) }}
                      sx={{ height: 24, minWidth: 0, padding: '0 9px', fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                    >
                      Карточка
                    </Button>
                  </Box>
                </Box>
              )
            })
          )}
        </Box>

        {/* .tfoot-line — итог + диапазон + пагинация (фикс 20) */}
        {total > 0 && (
          <Box
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px',
              padding: '8px 12px 10px', borderTop: `1px solid ${tokens.border}`,
              fontFamily: tokens.fontMono, fontSize: fs.f11, color: tokens.text2, fontVariantNumeric: 'tabular-nums',
            }}
          >
            <Box component="span" sx={{ mr: 'auto' }}>
              рассчитано {calcTime} · подписки всех пользователей терминала
            </Box>
            <Box component="span">{from}–{to} из {fmtN(total)}</Box>
            <Box
              component="button"
              type="button"
              aria-label="Предыдущая страница"
              disabled={page <= 0}
              onClick={() => { setPage(p => Math.max(0, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              sx={pgBtnSx}
            >
              ‹
            </Box>
            <Box
              component="button"
              type="button"
              aria-label="Следующая страница"
              disabled={to >= total}
              onClick={() => { setPage(p => p + 1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              sx={pgBtnSx}
            >
              ›
            </Box>
          </Box>
        )}
      </Panel>
    </Box>
  )
}

// .tfoot-line .pgbtn — квадратная кнопка перелистывания 24×24
const pgBtnSx = {
  width: 24, height: 24, display: 'inline-grid', placeItems: 'center',
  color: tokens.text1, border: `1px solid ${tokens.border}`, borderRadius: 1, cursor: 'pointer',
  fontFamily: tokens.fontMono, fontSize: fs.f125,
  transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
  '&:hover': { color: tokens.text0, borderColor: tokens.borderHi, background: tokens.bg2 },
  '&:disabled': { opacity: 0.35, cursor: 'default', color: tokens.text2, background: 'transparent', borderColor: tokens.border },
} as const
