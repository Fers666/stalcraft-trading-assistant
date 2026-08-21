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
  fetchFeedLots, fetchFeedSummary, fetchFeedFilters, fmtSellTime,
  feedGroupLabel, feedGroupOrder, feedTierLabel, feedTierOrder,
  type FeedLot, type FeedLotsResponse, type FeedSummaryResponse,
  type FeedFiltersResponse, type FeedSortKey,
} from '../../api/feed'

import Kick from '../../components/ui/Kick'
import ItemIcon from '../../components/ui/ItemIcon'
import ItemSearch, { type SearchItem } from '../../components/ui/ItemSearch'
import QualityChip from '../../components/ui/QualityChip'
import RiskChip from '../../components/ui/RiskChip'
import PageLock from '../../components/ui/PageLock'
import LockIcon from '../../components/ui/LockIcon'
import { useToast } from '../../components/ui/Toast'
import BottomSheet from '../../components/mobile/BottomSheet'
import DCard from '../../components/mobile/ui/DCard'
import StatusGrid from '../../components/mobile/ui/StatusGrid'
import ArtifactModal from '../../components/ArtifactModal'

// «Лента» (мобайл) — тот же дата-слой, что десктопный FeedPage
// (/feed/lots с серверной пагинацией, /feed/summary, /feed/filters), но
// карточки .dcard вместо семи колонок и фильтры в шите. Строка = ОДИН лот:
// три выгодных лота «Ломоть Мастер +15» дают три карточки.
// Набор — не только артефакты (docs/tasks/feed-gear-expansion.md): группы
// фильтруются серверным параметром category, предмет выбирается поиском.
// Чипы групп живут НА СТРАНИЦЕ, а не в шите: пока у снаряжения нет измеренной
// вероятности продажи, оно лежит хвостом под артефактами (сортировка по
// ev_profit, nulls_last), и спрятанный в шит переключатель — единственный
// способ его увидеть — не находится.
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
  { label: 'Ожидаемая ↓',   key: 'ev_profit',       order: 'desc' },
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

/** Чип группы для мобильной ленты прокрутки — .fchip с тач-высотой 36. */
function MobileCatChip({ label, count, on, onToggle }: {
  label: string
  count: number
  on: boolean
  onToggle: () => void
}) {
  return (
    <Box
      component="button" type="button" aria-pressed={on} onClick={onToggle}
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: '7px', flex: 'none',
        minHeight: 36, px: '12px', cursor: 'pointer', borderRadius: '2px',
        fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11,
        letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
        color: on ? tokens.goldAccent : tokens.text1,
        bgcolor: on ? tokens.goldDim : tokens.bg2,
        border: `1px solid ${on ? tokens.goldLine : tokens.border}`,
      }}
    >
      {label}
      <Box component="span" className="mono" sx={{
        fontSize: fs.f105, color: on ? tokens.goldAccent : tokens.text2,
      }}>
        {fmtN(count)}
      </Box>
    </Box>
  )
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
  // Предмет — поиском по каталогу: селект на 382 позиции на телефоне нечитаем.
  const [item, setItem]             = useState<SearchItem | null>(null)
  const [qltFilter, setQltFilter]   = useState('all')
  const [ptnFilter, setPtnFilter]   = useState('all')
  const [minProfit, setMinProfit]   = useState(0)
  // Группы набора (чипы .fchip десктопной панели). Пустой набор = «Все».
  const [cats, setCats]             = useState<string[]>([])
  const [tiers, setTiers]           = useState<string[]>([])

  const [filtOpen, setFiltOpen] = useState(false)
  const [modalLot, setModalLot] = useState<FeedLot | null>(null)

  const sort = SORTS[sortIndex]
  const showcase = data?.showcase ?? false
  // Аукцион может отдавать застывший снимок: лоты видны, но новых не появляется
  // часами, и «срез» при этом остаётся свежим — мы перечитываем тот же снимок
  // каждый цикл. Одной строки среза тут мало, нужна явная плашка.
  const frozenSince = data?.market_frozen_since ?? null
  const frozenHours = frozenSince
    ? Math.floor((Date.now() - new Date(frozenSince).getTime()) / 3_600_000)
    : 0
  const rowsLimit = data?.rows_limit ?? null
  const lots = data?.lots ?? []

  const lotsCountOf = useCallback(
    (itemId: string) => filters?.items.find(it => it.item_id === itemId)?.lots_count,
    [filters],
  )

  // Канонический порядок чипов: сервер сортирует группы по счётчику, и на
  // обновлении раз в 30 секунд чипы прыгали бы под пальцем.
  const catChips = useMemo(
    () => [...(filters?.categories ?? [])].sort(
      (a, b) => feedGroupOrder(String(a.value)) - feedGroupOrder(String(b.value)),
    ),
    [filters],
  )

  const catsLabel = useMemo(() => cats.map(feedGroupLabel).join(' · '), [cats])

  // Порядок канонический (быстро → долго), как и на десктопе: тиры — шкала.
  const tierChips = useMemo(
    () => [...(filters?.tiers ?? [])].sort(
      (a, b) => feedTierOrder(String(a.value)) - feedTierOrder(String(b.value)),
    ),
    [filters],
  )

  const load = useCallback(async () => {
    try {
      const res = await fetchFeedLots({
        page, page_size: PAGE_SIZE, sort: sort.key, order: sort.order,
        item_id: item ? [item.item_id] : undefined,
        // Серверный фильтр групп: список item_id[] капнут 50 значениями, а в
        // группе «Части» предметов больше.
        category: !item && cats.length > 0 ? cats : undefined,
        tier: tiers.length > 0 ? tiers : undefined,
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
  }, [page, sort, item, cats, tiers, qltFilter, ptnFilter, minProfit])

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

  // Группы переключаются НА СТРАНИЦЕ и применяются сразу — черновика у них
  // нет: чип, который надо «применить», перестаёт читаться как переключатель
  // раздела ленты. Предмет и группы взаимоисключающи (сервер соединяет их
  // через AND: предмет не из выбранной группы дал бы пустой список при двух
  // горящих фильтрах).
  const toggleTier = (tier: string) => {
    setTiers(prev => (prev.includes(tier) ? prev.filter(x => x !== tier) : [...prev, tier]))
    setPage(1)
  }

  const toggleCat = (group: string) => {
    setCats(prev => (prev.includes(group) ? prev.filter(x => x !== group) : [...prev, group]))
    setItem(null)
    setPage(1)
  }

  // ── Черновик фильтров (применяется по кнопке — как в остальных шитах) ──────
  const [draftSort, setDraftSort]       = useState(0)
  const [draftItem, setDraftItem]       = useState<SearchItem | null>(null)
  const [draftQlt, setDraftQlt]         = useState('all')
  const [draftPtn, setDraftPtn]         = useState('all')
  const [draftProfit, setDraftProfit]   = useState(0)

  const openFilters = () => {
    if (showcase) {
      showToast(`Фильтры и сортировка — на тарифе «${TIER_LABELS.advanced_max}»`)
      return
    }
    setDraftSort(sortIndex)
    setDraftItem(item)
    setDraftQlt(qltFilter)
    setDraftPtn(ptnFilter)
    setDraftProfit(minProfit)
    setFiltOpen(true)
  }

  const applyFilters = () => {
    setSortIndex(draftSort)
    setItem(draftItem)
    if (draftItem) setCats([])
    setQltFilter(draftQlt)
    setPtnFilter(draftPtn)
    setMinProfit(draftProfit)
    setPage(1)
    setFiltOpen(false)
  }

  const filtersDirty = item !== null || qltFilter !== 'all' || ptnFilter !== 'all'
    || minProfit > 0

  // ── Карточка лота ─────────────────────────────────────────────────────────
  const renderCard = (lot: FeedLot) => {
    const name = lot.name_ru ?? lot.name_en ?? lot.item_id
    const qKey = qualityKeyByValue(lot.qlt)
    const qName = lot.quality_name ?? QLT_NAMES[lot.qlt] ?? `кач. ${lot.qlt}`
    const expiring = lot.hours_remaining !== null && lot.hours_remaining < EXPIRING_HOURS

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
            {/* Тир, по которому посчитана прибыль справа. Без него «+12 %» на
                строке тира «Долго» неотличимо от такого же на «Быстро», а
                сбывается оно вдвое реже. */}
            <Box
              component="span"
              sx={{
                fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f10,
                letterSpacing: '.06em', textTransform: 'uppercase',
                color: lot.tier_used === 'premium' ? tokens.goldHighlight
                  : lot.tier_used === 'normal' ? tokens.goldAccent : tokens.text2,
                border: `1px solid ${lot.tier_used === 'premium' ? tokens.goldHighlight
                  : lot.tier_used === 'normal' ? tokens.goldAccent : tokens.text2}`,
                borderRadius: '2px', px: '4px', lineHeight: 1.5, opacity: 0.9,
              }}
            >{feedTierLabel(lot.tier_used)}</Box>
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
          // Два сценария продажи — то, ради чего лента и нужна: сколько лот
          // будет продаваться и что даёт ожидание. != null, а не !== null:
          // строгое сравнение пропускает undefined, и строка отрисовалась бы
          // как «undefined %», если поле пропадёт из ответа.
          ...(lot.p_sold_6h != null
            ? [{
                label: `Продать · ${feedTierLabel(lot.tier_used).toLowerCase()}`,
                value: `+${fmtP(lot.profit_total)} · ${fmtSellTime(lot.est_sell_hours)} · ${lot.p_sold_6h} %`,
                ...(lot.p_sold_6h < 50 ? { tone: 'neg' as const } : { tone: 'pos' as const }),
              }]
            : [{ label: 'Прибыль со всего лота', value: `+${fmtP(lot.profit_total)}`, tone: 'pos' as const }]),
          ...(lot.profit_total_slow != null
            ? [{
                label: 'Продать дороже',
                value: `+${fmtP(lot.profit_total_slow)}${lot.p_sold_6h_slow != null
                  ? ` · ${fmtSellTime(lot.est_sell_hours_slow)} · ${lot.p_sold_6h_slow} %` : ''}`,
                tone: 'pos' as const,
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
        <Kick>Лента // Market Feed</Kick>
        <Typography
          component="h1"
          sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}
        >
          Что выгодно купить прямо сейчас
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', lineHeight: 1.5 }}>
          Артефакты, снаряжение, части и пропуска в одном списке: прибыль уже за вычетом
          комиссии 5 %, качество и заточка сравниваются отдельно.
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', mt: '8px' }}>
          <Box
            aria-hidden
            sx={{
              width: 6, height: 6,
              background: frozenSince ? tokens.warning : tokens.success,
              boxShadow: `0 0 8px ${frozenSince ? tokens.warning : tokens.success}`,
            }}
          />
          <Box className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
            срез {hhmm(data?.snapshot_at)} · {fmtN(data?.total_available ?? 0)} выгодных лотов на рынке
            {cats.length > 0 && (
              <Box component="span" sx={{ color: tokens.goldAccent }}> · {catsLabel}</Box>
            )}
          </Box>
        </Box>
      </Box>

      {frozenSince && (
        <Box sx={{
          border: `1px solid ${tokens.warningLine}`, background: tokens.warningDim,
          borderRadius: 1, p: '10px 12px', mb: '12px',
        }}>
          <Kick sx={{ color: tokens.warning }}>Данные аукциона заморожены</Kick>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text0, mt: '4px', lineHeight: 1.5 }}>
            Игровой API отдаёт снимок от {hhmm(frozenSince)} — новых лотов нет уже{' '}
            {frozenHours} ч.
          </Typography>
          <Typography sx={{ fontSize: fs.f105, color: tokens.text2, mt: '6px', lineHeight: 1.5 }}>
            Лоты ниже, скорее всего, давно выкуплены: в игре торговля идёт, но до нас она
            не доходит. Покупать по этой выдаче нельзя, пока сбой не устранят на стороне
            разработчиков игры.
          </Typography>
        </Box>
      )}

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

      {/* Группы набора — лента горизонтальной прокрутки. Единственный способ
          увидеть снаряжение, пока у него нет измеренной вероятности продажи,
          поэтому переключатель на виду, а не в шите фильтров. В витрине чипов
          нет: /feed/filters под гейтом, а фильтры всё равно игнорируются. */}
      {!showcase && catChips.length > 0 && (
        <Box
          role="group" aria-label="Группы предметов"
          sx={{
            display: 'flex', gap: '6px', mb: '10px', pb: '2px',
            overflowX: 'auto', scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          <MobileCatChip
            label="Все" count={filters?.total_count ?? 0}
            on={cats.length === 0 && !item}
            onToggle={() => { setCats([]); setItem(null); setPage(1) }}
          />
          {catChips.map(c => (
            <MobileCatChip
              key={String(c.value)} label={c.label} count={c.count}
              on={cats.includes(String(c.value))}
              onToggle={() => toggleCat(String(c.value))}
            />
          ))}
        </Box>
      )}

      {/* Тиры — отдельный ряд: ось «как быстро перепродать» ортогональна оси
          «что за предмет», и в общем ряду они читались бы как один список. */}
      {!showcase && tierChips.length > 0 && (
        <Box
          role="group" aria-label="Срок продажи"
          sx={{
            display: 'flex', gap: '6px', mb: '10px', pb: '2px',
            overflowX: 'auto', scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          <MobileCatChip
            label="Любой" count={filters?.total_count ?? 0}
            on={tiers.length === 0}
            onToggle={() => { setTiers([]); setPage(1) }}
          />
          {tierChips.map(t => (
            <MobileCatChip
              key={String(t.value)} label={t.label} count={t.count}
              on={tiers.includes(String(t.value))}
              onToggle={() => toggleTier(String(t.value))}
            />
          ))}
        </Box>
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
              ? 'Сейчас выгодных лотов нет'
              : cats.length > 0
                ? `В группе «${catsLabel}» выгодных лотов сейчас нет`
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

          {/* Предмет — поиском по каталогу: в наборе 382 предмета, список
              выбора здесь был бы бесконечной простынёй. Выбор предмета
              сбрасывает группы (применяется в applyFilters). */}
          <Box>
            <Kick sx={{ display: 'block', mb: '8px' }}>Предмет</Kick>
            <ItemSearch value={draftItem} onChange={setDraftItem} lotsCount={lotsCountOf} fullWidth />
          </Box>

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
