/**
 * «Лента» — таблица живых лотов, которые выгодно купить и перепродать.
 * Эталон вёрстки — design/v5/app/feed.html.
 *
 * Набор — не только артефакты: снаряжение высоких рангов, части предметов,
 * премиум и сезонные пропуска (docs/tasks/feed-gear-expansion.md). Группы
 * фильтруются СЕРВЕРОМ (параметр category): клиентская эмуляция через
 * item_id[] упиралась в кап в 50 значений, а предметов в наборе 382.
 *
 * Строка = ОДИН лот: три выгодных лота «Ломоть Мастер +15» дают три строки.
 * Качество и заточка — часть идентичности товара, сравнение всегда в рамках
 * одинакового варианта.
 *
 * Тарифы без полного доступа получают витрину (showcase): фиксированный набор
 * из feed_rows_limit строк, фильтры и сортировка закрыты замком.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, MenuItem, Select, IconButton, Tooltip } from '@mui/material'

import { tokens, fs } from '../theme'
import { useAuthStore } from '../store/authStore'
import { TIER_LABELS } from '../constants/tiers'
import { fmtN, fmtP, fmtCompact } from '../utils/format'
import { qualityKeyByValue, iconUrl } from '../utils/i18n'
import {
  fetchFeedLots, fetchFeedSummary, fetchFeedFilters, fmtSellTime,
  feedGroupLabel, feedGroupOrder,
  type FeedLot, type FeedLotsResponse, type FeedSummaryResponse,
  type FeedFiltersResponse, type FeedSortKey,
} from '../api/feed'

import Panel from '../components/ui/Panel'
import Kick from '../components/ui/Kick'
import Pager from '../components/ui/Pager'
import SortHeader from '../components/ui/SortHeader'
import StatusLine from '../components/ui/StatusLine'
import QualityChip from '../components/ui/QualityChip'
import ItemIcon from '../components/ui/ItemIcon'
import RiskChip from '../components/ui/RiskChip'
import TierGate from '../components/ui/TierGate'
import PageLock from '../components/ui/PageLock'
import ArtifactModal from '../components/ArtifactModal'
import ItemSearch, { type SearchItem } from '../components/ui/ItemSearch'

const PAGE_SIZES = [25, 50, 100]
/** Период обновления таблицы. Частоту опроса внешнего API это не меняет:
 *  /feed/lots читает готовый срез из своей БД (см. endpoints/feed.py). */
const REFRESH_MS = 30_000
const MIN_PROFIT_OPTIONS = [0, 5, 10, 15, 25, 50]
/** Лот считается истекающим, когда осталось меньше 2 ч (EXPIRY_THRESHOLD_HOURS). */
const EXPIRING_HOURS = 2
/** Строка «свежая», если лента заметила лот не позже 5 минут назад. */
const FRESH_MINUTES = 5

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

type RiskLevel = 'lo' | 'md' | 'hi'
const RISK_LEVEL: Record<string, RiskLevel> = { low: 'lo', medium: 'md', high: 'hi' }
const RISK_LABEL: Record<string, string> = { low: 'низкий', medium: 'средний', high: 'высокий' }

/** Колонки таблицы: ключ сортировки бэкенда + подпись + тултип. */
const COLUMNS: { key: FeedSortKey | 'name'; label: string; tip: string; align: 'left' | 'right' }[] = [
  { key: 'name', label: 'Предмет', tip: 'Предмет, качество и заточка — один вариант товара', align: 'left' },
  { key: 'buyout_per_unit', label: 'Лот', tip: 'Цена за штуку · количество · итог к оплате', align: 'right' },
  { key: 'profit_pct', label: 'Опора', tip: 'Опорная цена — медиана реальных сделок за 7 дней, взвешенная по свежести', align: 'right' },
  { key: 'profit_total', label: 'Продать быстро', tip: 'Прибыль со всего лота по нижней цене (опора −6 %), за вычетом комиссии 5 %. Рядом — сколько лот будет продаваться и с какой вероятностью уйдёт за 6 часов', align: 'right' },
  { key: 'ev_profit', label: 'Продать дороже', tip: 'Та же сделка по верхней цене (опора +6 %), если готов подождать. Прибыль это разность «продажа минус закупка», поэтому +12 % к цене часто умножают её в разы — платится вероятностью', align: 'right' },
  { key: 'volatility', label: 'Рынок', tip: 'Волатильность 7 д, риск и тренд. Тренд — метка, а не поправка к цене', align: 'right' },
  { key: 'sales_per_day', label: 'Ликвидность', tip: 'Сделок в день и за сколько дней рынок переварит нынешнее предложение', align: 'right' },
  { key: 'time_left', label: 'Время', tip: 'Сколько лоту осталось жить (максимум 48 ч) и когда его заметила лента', align: 'right' },
]

function fmtLeft(hours: number | null): string {
  if (hours === null || hours <= 0) return '—'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return h >= 1 ? `${h}ч ${String(m).padStart(2, '0')}м` : `${m}м`
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
}

function fmtSeen(iso: string): string {
  const m = minutesSince(iso)
  return m <= 0 ? 'только что' : `${m} м`
}

function d1(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(1)
}

/** Ячейка «значение + подпись» — .tc из прототипа. */
function Cell({ value, sub, tone, subTone }: {
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'g' | 'a' | 'r'
  subTone?: 'g' | 'a' | 'r'
}) {
  const color = (t?: string) =>
    t === 'g' ? tokens.success : t === 'a' ? tokens.warning : t === 'r' ? tokens.danger : undefined
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
      <Box sx={{
        fontFamily: tokens.fontMono, fontSize: fs.f13, fontWeight: 600,
        color: color(tone) ?? tokens.text0, lineHeight: 1.2,
      }}>{value}</Box>
      {sub !== undefined && (
        <Box sx={{
          fontFamily: tokens.fontMono, fontSize: fs.f105,
          color: color(subTone) ?? tokens.text2, lineHeight: 1.2,
        }}>{sub}</Box>
      )}
    </Box>
  )
}

function TrendMark({ trend, pct }: { trend: string | null; pct: number | null }) {
  if (!trend || trend === 'unknown') return null
  const up = trend === 'rising'
  const flat = trend === 'stable'
  const color = flat ? tokens.text2 : up ? tokens.success : tokens.danger
  const sign = flat ? '·' : up ? '▲' : '▼'
  return (
    <Box component="span" sx={{ color, fontSize: fs.f105, ml: '6px', fontFamily: tokens.fontMono }}>
      {sign}{pct !== null && !flat ? ` ${Math.abs(pct).toFixed(1)} %` : ''}
    </Box>
  )
}

/** .fchip — чип-тумблер группы набора со счётчиком (.fc-n). */
function CatChip({ label, count, on, onToggle }: {
  label: string
  count: number
  on: boolean
  onToggle: () => void
}) {
  return (
    <Box
      component="button" type="button" aria-pressed={on} onClick={onToggle}
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: '7px', height: 26, px: '10px',
        cursor: 'pointer', borderRadius: '2px',
        fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11,
        letterSpacing: '.06em', textTransform: 'uppercase',
        color: on ? tokens.goldAccent : tokens.text1,
        bgcolor: on ? tokens.goldDim : tokens.bg2,
        border: `1px solid ${on ? tokens.goldLine : tokens.border}`,
        transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
        '&:hover': { color: tokens.text0, borderColor: tokens.borderHi },
      }}
    >
      {label}
      <Box component="span" sx={{
        fontFamily: tokens.fontMono, fontSize: fs.f105,
        fontVariantNumeric: 'tabular-nums', color: on ? tokens.goldAccent : tokens.text2,
      }}>
        {fmtN(count)}
      </Box>
    </Box>
  )
}

export default function FeedPage() {
  const navigate = useNavigate()
  // Сводка и списки фильтров закрыты гейтом feed_access — витрине их не
  // запрашиваем вовсе, чтобы не долбиться в 403 каждые 30 секунд.
  const feedAccess = useAuthStore(s => s.user?.feed_access ?? false)

  const [data, setData] = useState<FeedLotsResponse | null>(null)
  const [summary, setSummary] = useState<FeedSummaryResponse | null>(null)
  const [filters, setFilters] = useState<FeedFiltersResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  // Умолчание — ожидаемая прибыль в час, а не валовая: сортировка по
  // profit_total систематически поднимала наверх лоты, которые не продаются
  // (docs/tasks/ev-ranking.md §1).
  const [sort, setSort] = useState<FeedSortKey>('ev_profit')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  // Предмет выбирается поиском по каталогу: селект на 382 позиции нечитаем.
  const [item, setItem] = useState<SearchItem | null>(null)
  const [qltFilter, setQltFilter] = useState<number | ''>('')
  const [ptnFilter, setPtnFilter] = useState<number | ''>('')
  const [minProfit, setMinProfit] = useState<number>(0)
  // Группы (чипы .fchip прототипа). Пустой набор = «Все»: так чип «Все» и
  // сброс фильтров — одно и то же состояние.
  const [cats, setCats] = useState<string[]>([])

  const [modalLot, setModalLot] = useState<FeedLot | null>(null)

  const showcase = data?.showcase ?? false
  const rowsLimit = data?.rows_limit ?? null

  const lotsCountOf = useCallback(
    (itemId: string) => filters?.items.find(it => it.item_id === itemId)?.lots_count,
    [filters],
  )

  // Порядок чипов канонический (FEED_GROUPS), а не серверный «по убыванию
  // счётчика»: таблица переспрашивает сервер раз в 30 секунд, и чипы,
  // отсортированные счётчиком, прыгали бы под курсором.
  const catChips = useMemo(
    () => [...(filters?.categories ?? [])].sort(
      (a, b) => feedGroupOrder(String(a.value)) - feedGroupOrder(String(b.value)),
    ),
    [filters],
  )

  const catsLabel = useMemo(
    () => cats.map(feedGroupLabel).join(' · '),
    [cats],
  )

  // Предмет и группы — взаимоисключающие области поиска, а не вложенные
  // фильтры: сервер соединяет их через AND, и выбор предмета не из выбранной
  // группы давал бы пустую таблицу при двух горящих фильтрах.
  const pickItem = (next: SearchItem | null) => {
    setItem(next)
    if (next) setCats([])
    setPage(1)
  }

  const toggleCat = (group: string) => {
    setCats(prev => (prev.includes(group) ? prev.filter(x => x !== group) : [...prev, group]))
    setItem(null)
    setPage(1)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchFeedLots({
        page, page_size: pageSize, sort, order,
        item_id: item ? [item.item_id] : undefined,
        // Серверный фильтр групп: клиентский список item_id[] капнут 50
        // значениями, а в одной группе «Части» предметов больше.
        category: !item && cats.length > 0 ? cats : undefined,
        qlt: qltFilter !== '' ? [qltFilter] : undefined,
        ptn: ptnFilter !== '' ? [ptnFilter] : undefined,
        min_profit_pct: minProfit > 0 ? minProfit : undefined,
      })
      setData(res)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, sort, order, item, cats, qltFilter, ptnFilter, minProfit])

  // Срез ленты живёт минуты — таблица переспрашивает сервер раз в 30 с.
  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!feedAccess) return
    fetchFeedSummary().then(setSummary).catch(() => setSummary(null))
    fetchFeedFilters().then(setFilters).catch(() => setFilters(null))
  }, [feedAccess])

  const onSort = (key: FeedSortKey) => {
    if (showcase) return
    if (sort === key) setOrder(o => (o === 'desc' ? 'asc' : 'desc'))
    else { setSort(key); setOrder('desc') }
    setPage(1)
  }

  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total_count / data.page_size)) : 1),
    [data],
  )

  const snapshotLabel = useMemo(() => {
    if (!data?.snapshot_at) return '—'
    const d = new Date(data.snapshot_at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }, [data])

  // Аукцион может отдавать застывший снимок: лоты видны, но новых не появляется
  // часами. Показывать их как «купить прямо сейчас» нельзя — в игре они давно
  // выкуплены. Срез при этом остаётся свежим (мы перечитываем снимок каждый
  // цикл), поэтому одной строки «срез 23:47» тут недостаточно.
  const frozenSince = useMemo(() => {
    if (!data?.market_frozen_since) return null
    const d = new Date(data.market_frozen_since)
    return {
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      hours: Math.floor((Date.now() - d.getTime()) / 3_600_000),
    }
  }, [data])

  // Через navigation state, а не через query: страница лотов инициализируется
  // только из location.state (LotsPage / MobileLotsPage), query-параметры она не
  // читает — по `?item=` открывалась пустая страница. Контракт тот же, что у
  // «Радара рынка», плюс качество и заточку варианта из строки ленты.
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

  const onRowClick = (lot: FeedLot) => {
    // В витрине строка ведёт на CTA тарифа, а не в карточку.
    if (showcase) { navigate('/app/settings'); return }
    setModalLot(lot)
  }

  const renderRow = (lot: FeedLot) => {
    const qKey = qualityKeyByValue(lot.qlt)
    const expiring = lot.hours_remaining !== null && lot.hours_remaining < EXPIRING_HOURS
    const fresh = minutesSince(lot.first_seen_at) <= FRESH_MINUTES

    const name = lot.name_ru ?? lot.name_en ?? lot.item_id
    const aria =
      `Лот: ${name} ${QLT_NAMES[lot.qlt] ?? `кач. ${lot.qlt}`} +${lot.ptn}, ` +
      `${fmtP(lot.buyout_per_unit)} за штуку, ×${lot.amount}, ` +
      `прибыль +${fmtN(lot.profit_total)} рублей (${d1(lot.profit_pct)} %)`

    return (
      <Box
        component="tr"
        key={lot.lot_key}
        tabIndex={0}
        aria-label={aria}
        onClick={() => onRowClick(lot)}
        onKeyDown={e => { if (e.key === 'Enter') onRowClick(lot) }}
        sx={{
          cursor: 'pointer',
          borderTop: `1px solid ${tokens.border}`,
          '&:hover': { bgcolor: tokens.bg2 },
          '&:focus-visible': { outline: `1px solid ${tokens.goldLine}`, outlineOffset: -1 },
          '& > td': { p: '8px 10px', verticalAlign: 'middle' },
        }}
      >
        <td>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <ItemIcon src={iconUrl(lot.icon_path) ?? undefined} name={name} quality={qKey} size={26} />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <Box sx={{
                fontSize: fs.f125, fontWeight: 600, color: tokens.text0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{name}</Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <QualityChip color={qKey} label={QLT_NAMES[lot.qlt] ?? `кач. ${lot.qlt}`} />
                <Box component="span" sx={{
                  fontFamily: tokens.fontMono, fontSize: fs.f105,
                  color: lot.ptn ? tokens.text1 : tokens.text2,
                  border: `1px solid ${tokens.border}`, borderRadius: '2px', px: '4px',
                }}>+{lot.ptn}</Box>
              </Box>
            </Box>
          </Box>
        </td>
        <td><Cell value={fmtP(lot.buyout_per_unit)} sub={`×${fmtN(lot.amount)} · ${fmtP(lot.buyout_price)}`} /></td>
        <td><Cell value={fmtP(lot.ref_price)} sub={`безуб. ${fmtN(lot.breakeven_per_unit)}`} /></td>
        <td>
          {/* Срок печатаем только вместе с измеренной вероятностью: без страты
              est_sell_hours приходит эвристикой (pricing.base_option), и
              показывать её рядом с измеренными сроками нельзя. Фолбэк — процент
              прибыли, величина посчитанная, а не предсказанная. */}
          <Cell
            tone="g" subTone="g"
            value={`+${fmtP(lot.profit_total)}`}
            sub={
              lot.p_sold_6h != null
                ? `${fmtSellTime(lot.est_sell_hours)} · ${lot.p_sold_6h} % за 6 ч`
                : `+${d1(lot.profit_pct)} %`
            }
          />
        </td>
        <td>
          {/* Прибыль верхнего сценария — арифметика (цена × количество минус
              комиссия), она есть всегда. А срок и вероятность берутся из кривой
              дожития: у снаряжения страты набирают объём неделями, и до тех пор
              подпись честно пустая. Зелёным её не красим — зелёное здесь
              означает измеренную величину. */}
          <Cell
            tone={lot.profit_total_slow != null ? 'g' : undefined}
            subTone={lot.p_sold_6h_slow != null ? 'g' : undefined}
            value={lot.profit_total_slow != null ? `+${fmtP(lot.profit_total_slow)}` : '—'}
            sub={
              lot.p_sold_6h_slow != null
                ? `${fmtSellTime(lot.est_sell_hours_slow)} · ${lot.p_sold_6h_slow} % за 6 ч`
                : 'прогноз не измерен'
            }
          />
        </td>
        <td>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {/* Окно риска подписано (7Д): в карточке артефакта рядом живёт чип
                  30Д, и без окна «средний» против «низкий» читается как ошибка.
                  Без волатильности бэкенд отдаёт risk='medium' по умолчанию —
                  такой «средний» не показываем, это не измерение. */}
              {lot.volatility_7d !== null && (
                <RiskChip
                  level={RISK_LEVEL[lot.risk] ?? 'md'}
                  label={<>7Д {RISK_LABEL[lot.risk] ?? lot.risk}</>}
                />
              )}
              <TrendMark trend={lot.trend_24h} pct={lot.trend_24h_pct} />
            </Box>
            <Box sx={{ fontFamily: tokens.fontMono, fontSize: fs.f105, color: tokens.text2 }}>
              vol {d1(lot.volatility_7d)} %
              {lot.trend_7d_pct !== null && ` · 7д ${lot.trend_7d_pct > 0 ? '+' : '−'}${d1(Math.abs(lot.trend_7d_pct))} %`}
            </Box>
          </Box>
        </td>
        <td>
          <Cell
            value={`${d1(lot.sales_per_day)} сд/дн`}
            sub={lot.supply_coverage_days !== null ? `запас ${d1(lot.supply_coverage_days)} дн` : '—'}
          />
        </td>
        <td>
          <Cell
            value={fmtLeft(lot.hours_remaining)} tone={expiring ? 'a' : undefined}
            sub={`замечен ${fmtSeen(lot.first_seen_at)}`} subTone={fresh ? 'g' : undefined}
          />
        </td>
        <td onClick={e => e.stopPropagation()}>
          <Tooltip title="Все лоты предмета">
            <IconButton
              size="small" onClick={() => openLots(lot)}
              aria-label={`Все лоты предмета ${name}`}
              sx={{ color: tokens.text2, '&:hover': { color: tokens.gold, bgcolor: 'transparent' } }}
            >
              <Box component="span" sx={{ fontSize: fs.f125, fontFamily: tokens.fontMono }}>↗</Box>
            </IconButton>
          </Tooltip>
        </td>
      </Box>
    )
  }

  const lots = data?.lots ?? []
  const hasRows = lots.length > 0

  // ── Фильтры ───────────────────────────────────────────────────────────────
  const selectSx = {
    minWidth: 132, height: 28,
    fontSize: fs.f12, bgcolor: tokens.bg2,
    '& .MuiOutlinedInput-notchedOutline': { borderColor: tokens.border },
  }

  const filterBar = (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
      p: '8px 12px', bgcolor: tokens.bg1, border: `1px solid ${tokens.border}`,
      // Липнет под навбар только при полном доступе: в витрине фильтры
      // нерабочие, а прилипал бы весь гейт с замком — он бы уехал из-под
      // своего оверлея и закрыл шапку таблицы.
      ...(showcase ? null : {
        position: 'sticky', top: 'var(--sc-top-offset, 48px)', zIndex: 30,
      }),
    }}>
      {/* .fchips — группы набора со счётчиками. Первой строкой панели, а не
          последней: пока у снаряжения нет измеренной вероятности продажи, оно
          лежит хвостом под артефактами (сортировка по ev_profit, nulls_last), и
          чипы — единственный способ его увидеть. Счётчики приходят с
          /feed/filters и считаются по персональному порогу, поэтому не
          обнуляются при переключении самих чипов. */}
      {catChips.length > 0 && (
        <Box sx={{
          flexBasis: '100%', display: 'flex', alignItems: 'center', gap: '6px',
          flexWrap: 'wrap', mb: '2px', pb: '8px', borderBottom: `1px solid ${tokens.border}`,
        }}>
          <Kick>Группы</Kick>
          <CatChip
            label="Все" count={filters?.total_count ?? 0} on={cats.length === 0 && !item}
            onToggle={() => { setCats([]); setItem(null); setPage(1) }}
          />
          {catChips.map(c => {
            const group = String(c.value)
            return (
              <CatChip
                key={group} label={c.label} count={c.count} on={cats.includes(group)}
                onToggle={() => toggleCat(group)}
              />
            )
          })}
        </Box>
      )}

      {/* Высота 28 — как у соседних селектов панели: разнобой в одной строке
          фильтров читается как сбой вёрстки. */}
      <ItemSearch
        value={item} onChange={pickItem} lotsCount={lotsCountOf}
        placeholder="Найти предмет…"
        sx={{
          width: 240,
          '& .MuiInputBase-root': { height: 28 },
          '& .MuiInputBase-input': { py: 0 },
        }}
      />
      <Select
        size="small" displayEmpty value={qltFilter} sx={selectSx}
        onChange={e => { setQltFilter(e.target.value === '' ? '' : Number(e.target.value)); setPage(1) }}
      >
        <MenuItem value="">Любое качество</MenuItem>
        {(filters?.qualities ?? []).map(q => (
          <MenuItem key={String(q.value)} value={Number(q.value)}>{q.label} · {q.count}</MenuItem>
        ))}
      </Select>
      <Select
        size="small" displayEmpty value={ptnFilter} sx={selectSx}
        onChange={e => { setPtnFilter(e.target.value === '' ? '' : Number(e.target.value)); setPage(1) }}
      >
        <MenuItem value="">Любая заточка</MenuItem>
        {(filters?.enchants ?? []).map(p => (
          <MenuItem key={String(p.value)} value={Number(p.value)}>{p.label} · {p.count}</MenuItem>
        ))}
      </Select>
      {/* .fsep — вертикальный волосок. Строкой '1px', а не числом: в sx MUI
          числовое width:1 означает 100 % и даёт полосу во всю панель. */}
      <Box sx={{ width: '1px', alignSelf: 'stretch', bgcolor: tokens.border, mx: '4px' }} />
      <Kick>Мин. профит</Kick>
      <Select
        size="small" value={minProfit} sx={{ ...selectSx, minWidth: 92 }}
        onChange={e => { setMinProfit(Number(e.target.value)); setPage(1) }}
      >
        {MIN_PROFIT_OPTIONS.map(v => (
          <MenuItem key={v} value={v}>{v === 0 ? 'по профилю' : `${v} %`}</MenuItem>
        ))}
      </Select>
    </Box>
  )

  // ── Сайдбар ───────────────────────────────────────────────────────────────
  const best = summary?.best_lot ?? null
  const sidebar = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Panel title="Сводка 24ч">
        <StatusLine
          columns={2}
          metrics={[
            { label: 'Выгодных лотов', value: fmtN(summary?.profitable_lots ?? 0) },
            { label: 'Средний профит', value: summary?.avg_profit_pct !== null && summary?.avg_profit_pct !== undefined ? `+${d1(summary.avg_profit_pct)}` : '—', unit: '%', tone: 'g' },
            // unit не задаём: fmtCompact уже возвращает строку с «₽» («5,9 млн ₽»).
            { label: 'Потенциал', value: fmtCompact(summary?.total_profit ?? 0), tone: 'g' },
            { label: 'Сделок 24ч', value: fmtN(summary?.sales_24h ?? 0) },
          ]}
        />
        {best && (
          <Box sx={{ mt: '12px', pt: '12px', borderTop: `1px solid ${tokens.border}` }}>
            <Kick>Лучший лот сейчас</Kick>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', mt: '6px' }}>
              <ItemIcon
                src={iconUrl(best.icon_path) ?? undefined} size={26}
                name={best.name_ru ?? best.item_id} quality={qualityKeyByValue(best.qlt)}
              />
              <Box sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0, minWidth: 0 }}>
                {best.name_ru ?? best.name_en ?? best.item_id}
              </Box>
            </Box>
            <Box sx={{
              fontFamily: tokens.fontMono, fontWeight: 700, fontSize: fs.f28,
              color: tokens.goldHighlight, textShadow: `0 0 22px ${tokens.goldGlow}`, mt: '6px',
            }}>
              +{fmtP(best.profit_total)}
            </Box>
            <Box sx={{ fontFamily: tokens.fontMono, fontSize: fs.f105, color: tokens.text2 }}>
              +{d1(best.profit_pct)} % · лот {fmtP(best.buyout_price)} × {fmtN(best.amount)} шт
            </Box>
          </Box>
        )}
      </Panel>
    </Box>
  )

  // ── Таблица ───────────────────────────────────────────────────────────────
  const table = (
    <Box sx={{ overflowX: 'auto' }}>
      <Box component="table" sx={{
        width: '100%', borderCollapse: 'collapse',
        '& thead th': {
          p: '8px 10px', bgcolor: tokens.bg2,
          borderBottom: `1px solid ${tokens.border}`, whiteSpace: 'nowrap',
        },
      }}>
        <thead>
          <tr>
            {/* Tooltip вокруг SortHeader не вешаем: компонент не форвардит ref,
                MUI Tooltip на нём не работает. Подсказки колонок — отдельной задачей. */}
            {COLUMNS.map(col => (
              <SortHeader
                key={col.key}
                label={col.label}
                align={col.align}
                active={!showcase && sort === col.key}
                direction={order}
                onSort={() => col.key !== 'name' && onSort(col.key as FeedSortKey)}
              />
            ))}
            <Box component="th" sx={{ width: 44 }} />
          </tr>
        </thead>
        <tbody>
          {hasRows
            ? lots.map(lot => renderRow(lot))
            : !loading && (
              <Box component="tr">
                <Box component="td" colSpan={8} sx={{ p: '32px 12px', textAlign: 'center' }}>
                  <Box sx={{ fontSize: fs.f14, fontWeight: 600, color: tokens.text1 }}>
                    {data && data.total_available === 0
                      ? 'Сейчас выгодных лотов нет'
                      : cats.length > 0
                        ? `В группе «${catsLabel}» выгодных лотов сейчас нет`
                        : 'По текущим фильтрам выгодных лотов нет'}
                  </Box>
                  <Box sx={{ fontSize: fs.f12, color: tokens.text2, mt: '6px' }}>
                    {data && data.total_available === 0
                      ? 'Лента обходит рынок непрерывно — загляните позже.'
                      : 'Снизьте минимальный профит или сбросьте фильтры.'}
                  </Box>
                </Box>
              </Box>
            )}
        </tbody>
      </Box>
    </Box>
  )

  const footer = !showcase && hasRows && (
    <Box sx={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', flexWrap: 'wrap', p: '10px 12px',
      borderTop: `1px solid ${tokens.border}`,
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Kick>Показывать</Kick>
        <Select
          size="small" value={pageSize} sx={{ ...selectSx, minWidth: 72 }}
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
        >
          {PAGE_SIZES.map(v => <MenuItem key={v} value={v}>{v}</MenuItem>)}
        </Select>
      </Box>
      <Pager page={page} count={totalPages} onChange={setPage} />
      <Box sx={{ fontFamily: tokens.fontMono, fontSize: fs.f105, color: tokens.text2 }}>
        срез {snapshotLabel} · прибыль от медианы сделок 7 д минус комиссия 5 % ·{' '}
        {fmtN(data?.total_count ?? 0)} выгодных лотов
      </Box>
    </Box>
  )

  return (
    <Box sx={{
      // В витрине сводки нет (ручка /feed/summary закрыта гейтом) — колонка
      // сайдбара не резервируется, иначе таблица прижимается к пустоте.
      display: 'grid',
      gridTemplateColumns: { xs: '1fr', lg: showcase ? '1fr' : '1fr 272px' },
      gap: '12px', alignItems: 'start',
    }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
        <Panel>
          <Kick>Лента // MARKET FEED</Kick>
          <Typography sx={{
            fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26,
            color: tokens.text0, mt: '4px',
          }}>
            Что выгодно купить прямо сейчас
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', mt: '6px' }}>
            <Box sx={{
              width: 6, height: 6, borderRadius: '50%',
              bgcolor: frozenSince ? tokens.warning : tokens.success,
              boxShadow: `0 0 8px ${frozenSince ? tokens.warning : tokens.success}`,
            }} />
            <Box sx={{ fontFamily: tokens.fontMono, fontSize: fs.f105, color: tokens.text2 }}>
              срез {snapshotLabel} · {fmtN(data?.total_available ?? 0)} выгодных лотов на рынке
              {/* Выбранная группа — в шапке, а не только в чипе: чипов семь,
                  и в свёрнутой панели активный не бросается в глаза. */}
              {cats.length > 0 && (
                <Box component="span" sx={{ color: tokens.goldAccent }}> · {catsLabel}</Box>
              )}
              {item && (
                <Box component="span" sx={{ color: tokens.goldAccent }}>
                  {' '}· {item.name_ru ?? item.name_en ?? item.item_id}
                </Box>
              )}
            </Box>
          </Box>
        </Panel>

        {frozenSince && (
          <Panel sx={{
            borderColor: tokens.warningLine,
            background: tokens.warningDim,
            // Panel — голый контейнер без внутренних отступов, содержимое
            // приносит их с собой (ср. соседние панели с таблицей).
            p: '12px',
          }}>
            <Kick sx={{ color: tokens.warning }}>Данные аукциона заморожены</Kick>
            <Typography sx={{
              fontFamily: tokens.fontUi, fontSize: fs.f125, color: tokens.text0, mt: '4px',
            }}>
              Игровой API отдаёт снимок от {frozenSince.time} — новых лотов нет уже{' '}
              {frozenSince.hours} ч.
            </Typography>
            <Typography sx={{
              fontFamily: tokens.fontUi, fontSize: fs.f105, color: tokens.text2, mt: '6px',
            }}>
              Лоты ниже, скорее всего, давно выкуплены: в игре торговля идёт, но до нас
              она не доходит. Покупать по этой выдаче нельзя, пока сбой не устранят на
              стороне разработчиков игры.
            </Typography>
          </Panel>
        )}

        {showcase
          ? <TierGate gated tierLabel={TIER_LABELS.advanced_max}
              kicker="Фильтры и сортировка" ctaLabel="Открыть на «Макс»"
              onCta={() => navigate('/app/settings')}>{filterBar}</TierGate>
          : filterBar}

        <Panel sx={{ p: 0 }}>
          {table}
          {footer}
        </Panel>

        {showcase && (
          <PageLock
            tierLabel={TIER_LABELS.advanced_max}
            title={`Вся лента — на тарифе «${TIER_LABELS.advanced_max}»`}
            description={
              `Показано ${fmtN(rowsLimit ?? 0)} из ${fmtN(data?.total_available ?? 0)} выгодных лотов, ` +
              'найденных прямо сейчас: из середины ценового диапазона выбраны самые прибыльные. ' +
              `На «${TIER_LABELS.advanced_max}» открываются все строки, фильтры и сортировка.`
            }
            ctaLabel="Сменить тариф"
            onCta={() => navigate('/app/settings')}
          />
        )}
      </Box>

      {/* Сводка 24 ч — только при полном доступе (§Р2.4): под гейтом она
          показывала бы нули из 403-ответа, т.е. врала бы. */}
      {!showcase && sidebar}

      {modalLot && (
        <ArtifactModal
          open
          lot={modalLot}
          onClose={() => setModalLot(null)}
          onViewLots={() => { const l = modalLot; setModalLot(null); openLots(l) }}
        />
      )}
    </Box>
  )
}
