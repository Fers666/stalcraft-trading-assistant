import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Button, Select, MenuItem, FormControl, InputLabel,
  ToggleButtonGroup, ToggleButton, Skeleton,
} from '@mui/material'

import { tokens, fs } from '../../theme'
import { useAuthStore } from '../../store/authStore'
import { TIER_LABELS } from '../../constants/tiers'
import { fmtN, fmtP, fmtCompact } from '../../utils/format'
import { iconUrl, qualityKeyByValue } from '../../utils/i18n'
import {
  fetchFeedLots, fetchFeedSummary, fetchFeedFilters, profitPerHourTotal, feedCategoryLabel,
  type FeedLot, type FeedLotsResponse, type FeedSummaryResponse,
  type FeedFiltersResponse, type FeedSortKey,
} from '../../api/feed'

import Kick from '../../components/ui/Kick'
import ItemIcon from '../../components/ui/ItemIcon'
import QualityChip from '../../components/ui/QualityChip'
import RiskChip from '../../components/ui/RiskChip'
import PageLock from '../../components/ui/PageLock'
import LockIcon from '../../components/ui/LockIcon'
import { useToast } from '../../components/ui/Toast'
import BottomSheet from '../../components/mobile/BottomSheet'
import DCard from '../../components/mobile/ui/DCard'
import StatusGrid from '../../components/mobile/ui/StatusGrid'
import ArtifactModal from '../../components/ArtifactModal'

// «Лента артефактов» (мобайл) — тот же дата-слой, что десктопный FeedPage
// (/feed/lots с серверной пагинацией, /feed/summary, /feed/filters), но
// карточки .dcard вместо семи колонок и фильтры в шите. Строка = ОДИН лот:
// три выгодных лота «Ломоть Мастер +15» дают три карточки.
// Тарифы без полного доступа получают витрину (showcase): фиксированный набор
// из rows_limit строк, фильтры и сортировка закрыты, под списком — CTA.

const PAGE_SIZE = 25
/** Срез ленты живёт минуты. Частоту опроса внешнего API это не меняет. */
const REFRESH_MS = 30_000
const MIN_PROFIT_OPTIONS = [0, 5, 10, 15, 25, 50]
/** Лот считается истекающим, когда осталось меньше 2 ч. */
const EXPIRING_HOURS = 2

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

type RiskLevel = 'lo' | 'md' | 'hi'
const RISK_LEVEL: Record<string, RiskLevel> = { low: 'lo', medium: 'md', high: 'hi' }
const RISK_LABEL: Record<string, string> = { low: 'низкий', medium: 'средний', high: 'высокий' }

const SORTS: { label: string; key: FeedSortKey; order: 'asc' | 'desc' }[] = [
  { label: 'Прибыль ₽ ↓',   key: 'profit_total',    order: 'desc' },
  { label: 'Прибыль % ↓',   key: 'profit_pct',      order: 'desc' },
  { label: '₽/час ↓',       key: 'profit_per_hour', order: 'desc' },
  { label: 'Цена за шт ↑',  key: 'buyout_per_unit', order: 'asc'  },
  { label: 'Скоро истекут', key: 'time_left',       order: 'asc'  },
  { label: 'Ликвидность ↓', key: 'sales_per_day',   order: 'desc' },
]

const d1 = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v.toFixed(1)

function fmtLeft(hours: number | null): string {
  if (hours === null || hours <= 0) return '—'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return h >= 1 ? `${h}ч ${String(m).padStart(2, '0')}м` : `${m}м`
}

const hhmm = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function MobileFeedPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const feedAccess = useAuthStore(s => s.user?.feed_access ?? false)

  const [data, setData]       = useState<FeedLotsResponse | null>(null)
  const [summary, setSummary] = useState<FeedSummaryResponse | null>(null)
  const [filters, setFilters] = useState<FeedFiltersResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const [page, setPage]             = useState(1)
  const [sortIndex, setSortIndex]   = useState(0)
  const [itemFilter, setItemFilter] = useState('all')
  const [qltFilter, setQltFilter]   = useState('all')
  const [ptnFilter, setPtnFilter]   = useState('all')
  const [minProfit, setMinProfit]   = useState(0)
  // Группы артефактов (чипы .fchip десктопной панели). Пустой набор = «Все».
  const [cats, setCats]             = useState<string[]>([])

  const [filtOpen, setFiltOpen] = useState(false)
  const [modalLot, setModalLot] = useState<FeedLot | null>(null)

  const sort = SORTS[sortIndex]
  const showcase = data?.showcase ?? false
  const rowsLimit = data?.rows_limit ?? null
  const lots = data?.lots ?? []

  // Чип группы = набор item_id этой группы: у /feed/lots нет параметра
  // «категория», зато есть item_id[]. Выбранный артефакт старше групп.
  const catItemIds = useMemo(() => {
    if (cats.length === 0) return undefined
    const ids = (filters?.items ?? [])
      .filter(it => cats.includes(feedCategoryLabel(it.category)))
      .map(it => it.item_id)
    return ids.length > 0 ? ids : undefined
  }, [cats, filters])

  const load = useCallback(async () => {
    try {
      const res = await fetchFeedLots({
        page, page_size: PAGE_SIZE, sort: sort.key, order: sort.order,
        item_id: itemFilter !== 'all' ? [itemFilter] : catItemIds,
        qlt: qltFilter !== 'all' ? [Number(qltFilter)] : undefined,
        ptn: ptnFilter !== 'all' ? [Number(ptnFilter)] : undefined,
        min_profit_pct: minProfit > 0 ? minProfit : undefined,
      })
      setData(res)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [page, sort, itemFilter, catItemIds, qltFilter, ptnFilter, minProfit])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // Сводка и списки фильтров закрыты гейтом feed_access — витрине их не
  // запрашиваем вовсе, чтобы не долбиться в 403.
  useEffect(() => {
    if (!feedAccess) return
    fetchFeedSummary().then(setSummary).catch(() => setSummary(null))
    fetchFeedFilters().then(setFilters).catch(() => setFilters(null))
  }, [feedAccess])

  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total_count / data.page_size)) : 1),
    [data],
  )

  // navigation state, а не query: MobileLotsPage читает только location.state
  // (по `?item=` страница открывалась пустой). См. FeedPage.openLots.
  const openLots = (lot: FeedLot) => navigate('/app/lots', {
    state: {
      item_id: lot.item_id,
      name_ru: lot.name_ru,
      name_en: lot.name_en,
      icon_path: lot.icon_path,
      region: lot.region,
      quality_filter: lot.qlt,
      enchant_filter: lot.ptn,
    },
  })

  const openCard = (lot: FeedLot) => {
    // В витрине карточка не открывается — строка ведёт на CTA тарифа.
    if (showcase) { navigate('/app/settings'); return }
    setModalLot(lot)
  }

  // ── Черновик фильтров (применяется по кнопке — как в остальных шитах) ──────
  const [draftSort, setDraftSort]       = useState(0)
  const [draftItem, setDraftItem]       = useState('all')
  const [draftQlt, setDraftQlt]         = useState('all')
  const [draftPtn, setDraftPtn]         = useState('all')
  const [draftProfit, setDraftProfit]   = useState(0)
  const [draftCats, setDraftCats]       = useState<string[]>([])

  const openFilters = () => {
    if (showcase) {
      showToast(`Фильтры и сортировка — на тарифе «${TIER_LABELS.advanced_max}»`)
      return
    }
    setDraftSort(sortIndex)
    setDraftItem(itemFilter)
    setDraftQlt(qltFilter)
    setDraftPtn(ptnFilter)
    setDraftProfit(minProfit)
    setDraftCats(cats)
    setFiltOpen(true)
  }

  const applyFilters = () => {
    setSortIndex(draftSort)
    setItemFilter(draftItem)
    setQltFilter(draftQlt)
    setPtnFilter(draftPtn)
    setMinProfit(draftProfit)
    setCats(draftCats)
    setPage(1)
    setFiltOpen(false)
  }

  const filtersDirty = itemFilter !== 'all' || qltFilter !== 'all' || ptnFilter !== 'all'
    || minProfit > 0 || cats.length > 0

  // ── Карточка лота ─────────────────────────────────────────────────────────
  const renderCard = (lot: FeedLot) => {
    const name = lot.name_ru ?? lot.name_en ?? lot.item_id
    const qKey = qualityKeyByValue(lot.qlt)
    const qName = lot.quality_name ?? QLT_NAMES[lot.qlt] ?? `кач. ${lot.qlt}`
    const expiring = lot.hours_remaining !== null && lot.hours_remaining < EXPIRING_HOURS
    const pph = profitPerHourTotal(lot)

    return (
      <DCard
        key={lot.lot_key}
        onClick={() => openCard(lot)}
        icon={<ItemIcon src={iconUrl(lot.icon_path) ?? undefined} name={name} quality={qKey} size={32} />}
        name={
          <>
            {name}
            {lot.ptn > 0 && (
              <Box component="span" className="mono" sx={{ ml: '6px', color: tokens.goldAccent, fontWeight: 700 }}>
                +{lot.ptn}
              </Box>
            )}
          </>
        }
        sub={`${fmtP(lot.buyout_per_unit)}/шт · ×${fmtN(lot.amount)}`}
        right={
          <>
            <Box component="span" sx={{ display: 'block', fontSize: fs.f14, fontWeight: 700, color: tokens.success }}>
              +{fmtCompact(lot.profit_total)}
            </Box>
            <Box component="span" sx={{ display: 'block', fontSize: fs.f105, color: tokens.success }}>
              +{d1(lot.profit_pct)} %
            </Box>
          </>
        }
        chips={
          <>
            <QualityChip color={qKey} label={qName} />
            {/* Окно риска подписано (7Д) — в карточке артефакта рядом живёт чип 30Д.
                Без волатильности бэкенд отдаёт risk='medium' по умолчанию: такой
                «средний» не показываем, это не измерение. */}
            {lot.volatility_7d !== null && (
              <RiskChip
                level={RISK_LEVEL[lot.risk] ?? 'md'}
                label={<>7Д {RISK_LABEL[lot.risk] ?? lot.risk}</>}
              />
            )}
            <Box
              component="span"
              className="mono"
              sx={{
                fontSize: fs.f105,
                color: expiring ? tokens.warning : tokens.text2,
                border: `1px solid ${expiring ? tokens.warningLine : tokens.border}`,
                px: '6px', borderRadius: '2px',
              }}
            >
              {fmtLeft(lot.hours_remaining)}
            </Box>
          </>
        }
        kv={[
          { label: 'Итого к оплате', value: fmtP(lot.buyout_price) },
          { label: 'Опора · безубыток', value: `${fmtP(lot.ref_price)} · ${fmtN(lot.breakeven_per_unit)}` },
          { label: 'Прибыль со всего лота', value: `+${fmtP(lot.profit_total)}`, tone: 'pos' },
          ...(pph !== null
            ? [{ label: 'Прибыль в час', value: `${fmtCompact(Math.round(pph))}/ч`, tone: 'pos' as const }]
            : []),
          // Кривая дожития (фаза B): на мобильном места больше, поэтому строка
          // показывается всегда, когда измерена, — но окрашивается в
          // предупреждение только там, где исход реже, чем не наступает.
          ...(lot.p_sold_6h !== null
            ? [{
                label: 'Продастся за 6 ч',
                value: `${lot.p_sold_6h} %${lot.pct_sold_ever !== null && lot.pct_sold_ever < 95
                  ? ` · не продаётся ${(100 - lot.pct_sold_ever).toFixed(0)} %` : ''}`,
                ...(lot.p_sold_6h < 50 ? { tone: 'neg' as const } : {}),
              }]
            : []),
          {
            label: 'Ликвидность',
            value: `${d1(lot.sales_per_day)} сд/дн${
              lot.supply_coverage_days !== null ? ` · запас ${d1(lot.supply_coverage_days)} дн` : ''
            }`,
          },
          { label: 'Волатильность 7д', value: `${d1(lot.volatility_7d)} %` },
        ]}
        footer={
          <>
            <Button
              variant="outlined" size="small" sx={{ minHeight: 36 }}
              onClick={(e) => { e.stopPropagation(); openCard(lot) }}
            >
              Карточка
            </Button>
            <Button
              variant="outlined" size="small" sx={{ minHeight: 36 }}
              onClick={(e) => {
                e.stopPropagation()
                if (showcase) navigate('/app/settings')
                else openLots(lot)
              }}
            >
              Лоты
            </Button>
          </>
        }
      />
    )
  }

  const sheetSelectSx = { '& .MuiSelect-select': { fontSize: fs.f125 } }

  return (
    <Box>
      {/* .pg-h */}
      <Box sx={{ pb: '12px' }}>
        <Kick>Лента артефактов // Artefact Feed</Kick>
        <Typography
          component="h1"
          sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}
        >
          Что выгодно купить прямо сейчас
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', lineHeight: 1.5 }}>
          Все артефакты рынка в одном списке: прибыль уже за вычетом комиссии 5 %, качество и
          заточка сравниваются отдельно.
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', mt: '8px' }}>
          <Box
            aria-hidden
            sx={{ width: 6, height: 6, background: tokens.success, boxShadow: `0 0 8px ${tokens.success}` }}
          />
          <Box className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
            срез {hhmm(data?.snapshot_at)} · {fmtN(data?.total_available ?? 0)} выгодных лотов на рынке
          </Box>
        </Box>
      </Box>

      {/* Сводка 24ч — только при полном доступе */}
      {!showcase && summary && (
        <StatusGrid
          cols={2}
          sx={{ mb: '10px' }}
          items={[
            { k: 'Выгодных лотов', v: fmtN(summary.profitable_lots), tone: 'gold' },
            {
              k: 'Средний профит',
              v: summary.avg_profit_pct !== null ? `+${d1(summary.avg_profit_pct)}` : '—',
              unit: '%', tone: 'success',
            },
            { k: 'Потенциал', v: fmtCompact(summary.total_profit), tone: 'success' },
            { k: 'Сделок 24ч', v: fmtN(summary.sales_24h) },
          ]}
        />
      )}

      {/* Фильтры + сортировка. В витрине не прячем, а показываем закрытыми:
          замок на элементе управления продаёт тариф лучше, чем его отсутствие. */}
      <Box sx={{ display: 'flex', gap: '8px', mb: '10px' }}>
        <Button
          variant="outlined"
          onClick={openFilters}
          startIcon={showcase ? <LockIcon size={12} /> : undefined}
          aria-label={showcase ? `Фильтры — доступны на тарифе «${TIER_LABELS.advanced_max}»` : 'Фильтры'}
          sx={{ flex: 1, minHeight: 44, ...(showcase ? { color: tokens.text2 } : null) }}
        >
          {showcase ? 'Фильтры' : filtersDirty ? 'Фильтры · вкл' : 'Фильтры'}
        </Button>
        <Button
          variant="outlined"
          onClick={openFilters}
          startIcon={showcase ? <LockIcon size={12} /> : undefined}
          aria-label={showcase ? `Сортировка — доступна на тарифе «${TIER_LABELS.advanced_max}»` : 'Сортировка'}
          sx={{ flex: 1, minHeight: 44, ...(showcase ? { color: tokens.text2 } : null) }}
        >
          {showcase ? SORTS[0].label : sort.label}
        </Button>
      </Box>

      {/* Список */}
      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} variant="rectangular" height={150} sx={{ bgcolor: tokens.bg2 }} />
          ))}
        </Box>
      ) : lots.length === 0 ? (
        <Box sx={{ p: '36px 20px', textAlign: 'center' }}>
          <Typography sx={{ fontSize: fs.f14, fontWeight: 600, color: tokens.text1 }}>
            {data && data.total_available === 0
              ? 'Сейчас выгодных лотов артефактов нет'
              : 'По текущим фильтрам выгодных лотов нет'}
          </Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '6px', lineHeight: 1.5 }}>
            {data && data.total_available === 0
              ? 'Лента обходит рынок непрерывно — загляните позже.'
              : 'Снизьте минимальный профит или сбросьте фильтры.'}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {lots.map(lot => renderCard(lot))}
        </Box>
      )}

      {/* Пагинация — в витрине страница одна по построению */}
      {!showcase && totalPages > 1 && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', pt: '14px' }}>
          <Button
            variant="outlined" size="small" disabled={page <= 1}
            onClick={() => { setPage(p => Math.max(1, p - 1)); window.scrollTo(0, 0) }}
            sx={{ minWidth: 44, minHeight: 40 }}
            aria-label="Предыдущая страница"
          >
            ‹
          </Button>
          <Box component="span" className="mono" sx={{ fontSize: fs.f12, color: tokens.text2 }}>
            {page} / {totalPages} · {fmtN(data?.total_count ?? 0)} лотов
          </Box>
          <Button
            variant="outlined" size="small" disabled={page >= totalPages}
            onClick={() => { setPage(p => p + 1); window.scrollTo(0, 0) }}
            sx={{ minWidth: 44, minHeight: 40 }}
            aria-label="Следующая страница"
          >
            ›
          </Button>
        </Box>
      )}

      {/* Витрина: строки не размыты, под ними — честный счётчик и CTA */}
      {showcase && (
        <PageLock
          sx={{ minHeight: 0, pt: '24px' }}
          tierLabel={TIER_LABELS.advanced_max}
          title={`Вся лента — на тарифе «${TIER_LABELS.advanced_max}»`}
          description={
            `Показано ${fmtN(rowsLimit ?? lots.length)} из ${fmtN(data?.total_available ?? 0)} выгодных лотов, ` +
            'найденных прямо сейчас: из середины ценового диапазона выбраны самые прибыльные. ' +
            `На «${TIER_LABELS.advanced_max}» открываются все строки, фильтры и сортировка.`
          }
          ctaLabel="Сменить тариф"
          onCta={() => navigate('/app/settings')}
        />
      )}

      {/* Карточка артефакта — BottomSheet на мобильном (см. ArtifactModal) */}
      {modalLot && (
        <ArtifactModal
          open
          lot={modalLot}
          onClose={() => setModalLot(null)}
          onViewLots={() => { const l = modalLot; setModalLot(null); openLots(l) }}
        />
      )}

      {/* Шит фильтров */}
      <BottomSheet
        open={filtOpen}
        onClose={() => setFiltOpen(false)}
        title="Фильтры"
        footer={
          <Button variant="contained" fullWidth onClick={applyFilters} sx={{ minHeight: 44 }}>
            Показать лоты
          </Button>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Box>
            <Kick sx={{ display: 'block', mb: '8px' }}>Сортировка</Kick>
            <ToggleButtonGroup
              exclusive
              value={draftSort}
              onChange={(_, v) => { if (v != null) setDraftSort(v) }}
              orientation="vertical"
              fullWidth
              sx={{
                gap: '6px',
                '& .MuiToggleButton-root': {
                  justifyContent: 'flex-start', minHeight: 44,
                  border: `1px solid ${tokens.border}`, borderRadius: '2px !important',
                },
              }}
            >
              {SORTS.map((s, i) => <ToggleButton key={s.key + s.order} value={i}>{s.label}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>

          {/* Группы артефактов со счётчиками — мобильный вид чипов .fchips.
              Счётчики приходят с /feed/filters (только персональный порог),
              поэтому не обнуляются при переключении самих групп. */}
          {(filters?.categories.length ?? 0) > 0 && (
            <Box>
              <Kick sx={{ display: 'block', mb: '8px' }}>Группы</Kick>
              <ToggleButtonGroup
                value={draftCats}
                onChange={(_, v: string[]) => setDraftCats(v)}
                sx={{
                  flexWrap: 'wrap', gap: '6px',
                  '& .MuiToggleButton-root': {
                    minHeight: 36, px: '10px',
                    border: `1px solid ${tokens.border}`, borderRadius: '2px !important',
                  },
                }}
              >
                {(filters?.categories ?? []).map(c => (
                  <ToggleButton key={String(c.value)} value={String(c.value)}>
                    {c.label}
                    <Box component="span" className="mono" sx={{ ml: '7px', fontSize: fs.f105, color: tokens.text2 }}>
                      {fmtN(c.count)}
                    </Box>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              {draftCats.length === 0 && (
                <Box sx={{ fontSize: fs.f11, color: tokens.text2, mt: '6px' }}>
                  Ничего не выбрано — показываются все группы ({fmtN(filters?.total_count ?? 0)}).
                </Box>
              )}
            </Box>
          )}

          {(filters?.items.length ?? 0) > 0 && (
            <FormControl size="small" fullWidth sx={sheetSelectSx}>
              <InputLabel>Артефакт</InputLabel>
              <Select value={draftItem} label="Артефакт" onChange={(e) => setDraftItem(e.target.value)}>
                <MenuItem value="all">Все артефакты</MenuItem>
                {(filters?.items ?? []).map(it => (
                  <MenuItem key={it.item_id} value={it.item_id}>
                    {it.name_ru ?? it.name_en ?? it.item_id} ({it.lots_count})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          {(filters?.qualities.length ?? 0) > 0 && (
            <FormControl size="small" fullWidth sx={sheetSelectSx}>
              <InputLabel>Качество</InputLabel>
              <Select value={draftQlt} label="Качество" onChange={(e) => setDraftQlt(e.target.value)}>
                <MenuItem value="all">Любое качество</MenuItem>
                {(filters?.qualities ?? []).map(q => (
                  <MenuItem key={String(q.value)} value={String(q.value)}>{q.label} ({q.count})</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          {(filters?.enchants.length ?? 0) > 0 && (
            <FormControl size="small" fullWidth sx={sheetSelectSx}>
              <InputLabel>Заточка</InputLabel>
              <Select value={draftPtn} label="Заточка" onChange={(e) => setDraftPtn(e.target.value)}>
                <MenuItem value="all">Любая заточка</MenuItem>
                {(filters?.enchants ?? []).map(p => (
                  <MenuItem key={String(p.value)} value={String(p.value)}>{p.label} ({p.count})</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          <FormControl size="small" fullWidth sx={sheetSelectSx}>
            <InputLabel>Мин. профит</InputLabel>
            <Select
              value={String(draftProfit)}
              label="Мин. профит"
              onChange={(e) => setDraftProfit(Number(e.target.value))}
            >
              {MIN_PROFIT_OPTIONS.map(v => (
                <MenuItem key={v} value={String(v)}>{v === 0 ? 'По профилю' : `${v} %`}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box sx={{ fontSize: fs.f11, color: tokens.text2, lineHeight: 1.5 }}>
            «По профилю» — порог из «Критерия выгодности» настроек. Поднять его здесь можно,
            опустить ниже профиля — нет: убыточных и пограничных лотов в ленте не бывает.
          </Box>
        </Box>
      </BottomSheet>
    </Box>
  )
}
