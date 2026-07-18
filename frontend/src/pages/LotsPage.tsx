import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, TextField, InputAdornment, Chip, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  FormControl, InputLabel, Select, MenuItem, List, ListItem,
  ListItemButton, ListItemText, Paper, Tooltip, IconButton, Skeleton,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import HistoryIcon from '@mui/icons-material/History'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import BookmarkAddedIcon from '@mui/icons-material/BookmarkAdded'
import api from '../api/client'
import { translateCategory, iconUrl, qualityKeyByValue } from '../utils/i18n'
import { fmtN, fmtP } from '../utils/format'
import { CATEGORY_TREE } from '../utils/categories'
import { useAuthStore } from '../store/authStore'
import { TIER_LABELS } from '../constants/tiers'
import { Region } from '../constants/regions'
import { tokens, fs } from '../theme'
import CategoryTree from '../components/ui/CategoryTree'
import QualityChip from '../components/ui/QualityChip'
import RegionSelect from '../components/ui/RegionSelect'
import ItemIcon from '../components/ui/ItemIcon'
import Kick from '../components/ui/Kick'
import SortHeader from '../components/ui/SortHeader'
import PageLock from '../components/ui/PageLock'
import { useToast } from '../components/ui/Toast'

// ─── Типы ────────────────────────────────────────────────────────────────────

interface Item {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
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
  quality_name: string | null
  quality_value: number | null
  enchant_level: number | null
}

interface LotsResponse {
  item_id: string
  region: string
  total: number
  lots: Lot[]
  from_cache: boolean
  cache_note: string
}

interface CategoryLot {
  item_id: string
  item_name_ru: string | null
  item_name_en: string | null
  icon_path: string | null
  amount: number
  buyout_price: number
  start_price: number
  start_time: string
  end_time: string
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  quality_value: number | null
  enchant_level: number | null
}

interface CategoryLotsResponse {
  category: string
  region: string
  items_total: number
  lots_total: number
  lots: CategoryLot[]
}

interface HistoryEntry {
  item_id: string
  name: string
  category: string | null
  icon_path: string | null
}

type SortKey = 'buyout_price' | 'amount' | 'price_per_unit' | 'hours_remaining' | 'enchant_level'
type SortDir = 'asc' | 'desc'

// ─── Константы ───────────────────────────────────────────────────────────────

const QL_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый', 3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}
const HISTORY_KEY = 'lots_search_history'
const HISTORY_MAX = 10
const ROWS_PER_PAGE_OPTIONS = [25, 50, 100]
const QUALITY_ORDER = ['Обычный', 'Необычный', 'Особый', 'Ветеран', 'Мастер', 'Легендарный']

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(entry: HistoryEntry) {
  const next = [entry, ...loadHistory().filter((h) => h.item_id !== entry.item_id)].slice(0, HISTORY_MAX)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

function sortLots<T extends { buyout_price: number; amount: number; hours_remaining: number | null; enchant_level: number | null }>(
  lots: T[], key: SortKey, dir: SortDir,
): T[] {
  return [...lots].sort((a, b) => {
    let av: number, bv: number
    if (key === 'price_per_unit') {
      av = Math.floor(a.buyout_price / a.amount)
      bv = Math.floor(b.buyout_price / b.amount)
    } else if (key === 'hours_remaining') {
      av = a.hours_remaining ?? Infinity
      bv = b.hours_remaining ?? Infinity
    } else if (key === 'enchant_level') {
      av = a.enchant_level ?? -1
      bv = b.enchant_level ?? -1
    } else {
      av = a[key] as number
      bv = b[key] as number
    }
    return dir === 'asc' ? av - bv : bv - av
  })
}

// ─── Компонент ───────────────────────────────────────────────────────────────

export default function LotsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const user = useAuthStore((s) => s.user)

  const pendingQualityRef = useRef<string | null>(null)
  const pendingEnchantRef = useRef<string | null>(null)
  const navStateAppliedRef = useRef(false)
  const preserveFiltersRef = useRef(false)

  // Поиск конкретного предмета
  const [query, setQuery]               = useState('')
  const [region, setRegion]             = useState<Region>('RU')
  const [suggestions, setSuggestions]   = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [result, setResult]             = useState<LotsResponse | null>(null)
  const [loading, setLoading]           = useState(false)
  const [searching, setSearching]       = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryEntry[]>(loadHistory)

  // Категории
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [catResult, setCatResult]               = useState<CategoryLotsResponse | null>(null)
  const [catLoading, setCatLoading]             = useState(false)
  const [catError, setCatError]                 = useState<string | null>(null)

  // Фильтры и сортировка (общие для обоих режимов)
  const [filterQuality, setFilterQuality] = useState<string>('all')
  const [filterEnchant, setFilterEnchant] = useState<string>('all')
  const [sortKey, setSortKey]             = useState<SortKey>('buyout_price')
  const [sortDir, setSortDir]             = useState<SortDir>('asc')
  const [page, setPage]                   = useState(0)
  const [rowsPerPage, setRowsPerPage]     = useState(25)

  // Watchlist
  const [wlStates, setWlStates] = useState<Record<string, 'loading' | 'added' | 'exists'>>({})

  // Гейт доступа (реальное поле auction_access; is_admin обходит) — нужен и на
  // прямой заход по URL, не только скрытие пункта в навбаре.
  const gated = !!user && !user.is_admin && user.auction_access === false

  // ─── Инициализация из navigation state (переход из Избранного) ───────────
  useEffect(() => {
    if (navStateAppliedRef.current) return
    navStateAppliedRef.current = true
    const state = location.state as {
      item_id?: string
      name_ru?: string | null
      name_en?: string | null
      icon_path?: string | null
      region?: string
      quality_filter?: number | null
      enchant_filter?: number | null
    } | null
    if (!state?.item_id) return
    const item: Item = {
      item_id: state.item_id,
      name_ru: state.name_ru ?? null,
      name_en: state.name_en ?? null,
      category: null,
      icon_path: state.icon_path ?? null,
    }
    const reg = (state.region as Region) ?? region
    if (state.region) setRegion(state.region as Region)
    if (state.quality_filter != null) pendingQualityRef.current = QL_NAMES[state.quality_filter] ?? null
    if (state.enchant_filter != null) pendingEnchantRef.current = String(state.enchant_filter)
    fetchLots(item, reg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Загрузка лотов категории ──────────────────────────────────────────────
  const fetchCategoryLots = async (cat: string, reg: string) => {
    setCatLoading(true)
    setCatError(null)
    setCatResult(null)
    try {
      const { data } = await api.get('/lots', { params: { category: cat, region: reg } })
      setCatResult(data)
    } catch {
      setCatError('Ошибка загрузки лотов категории')
    } finally {
      setCatLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedCategory) { setCatResult(null); return }
    fetchCategoryLots(selectedCategory, region)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, region])

  // ─── Опции фильтров из активного результата ────────────────────────────────
  const activeLots = result ? result.lots : catResult ? catResult.lots : []

  const qualityOptions = useMemo(() => {
    const vals = [...new Set(activeLots.map((l) => l.quality_name).filter(Boolean) as string[])]
    return vals.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
  }, [activeLots])

  const enchantOptions = useMemo(() => {
    return [...new Set(
      activeLots.map((l) => l.enchant_level).filter((v): v is number => v != null)
    )].sort((a, b) => a - b)
  }, [activeLots])

  const showQualityFilter = qualityOptions.length > 1
  const showEnchantFilter = enchantOptions.length > 0

  // ─── Пайплайн фильтр → сортировка → пагинация ─────────────────────────────
  const filteredSorted = useMemo(() => {
    const filtered = activeLots.filter((l) => {
      if (filterQuality !== 'all' && l.quality_name !== filterQuality) return false
      if (filterEnchant !== 'all' && String(l.enchant_level) !== filterEnchant) return false
      return true
    })
    return sortLots(filtered, sortKey, sortDir)
  }, [activeLots, filterQuality, filterEnchant, sortKey, sortDir])

  // Лучшая цена — у значения минимального выкупа (не у первой строки, §5.3)
  const minBuyout = useMemo(
    () => filteredSorted.reduce((m, l) => Math.min(m, l.buyout_price), Infinity),
    [filteredSorted],
  )

  const pageLots = filteredSorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)

  useEffect(() => { setPage(0) }, [filterQuality, filterEnchant, sortKey, sortDir])

  useEffect(() => {
    if (result === null && catResult === null) return
    if (preserveFiltersRef.current) {
      preserveFiltersRef.current = false
    } else {
      setFilterQuality(pendingQualityRef.current ?? 'all')
      setFilterEnchant(pendingEnchantRef.current ?? 'all')
      pendingQualityRef.current = null
      pendingEnchantRef.current = null
    }
    setPage(0)
    setWlStates({})
  }, [result, catResult])

  // ─── Поиск предмета ────────────────────────────────────────────────────────
  const handleQueryChange = async (value: string) => {
    setQuery(value)
    setSelectedItem(null)
    setResult(null)
    if (value.trim().length < 2) { setSuggestions([]); return }
    setSearching(true)
    try {
      const { data } = await api.get('/items', { params: { search: value.trim(), page_size: 8 } })
      setSuggestions(data.items)
    } catch { setSuggestions([]) }
    finally { setSearching(false) }
  }

  const fetchLots = async (item: Item, reg: string, forceRefresh = false) => {
    setSelectedItem(item)
    setQuery(item.name_ru || item.name_en || item.item_id)
    setSuggestions([])
    setError(null)
    setLoading(true)
    try {
      const { data } = await api.get(`/lots/${item.item_id}`, {
        params: { region: reg, ...(forceRefresh && { force_refresh: true }) },
      })
      setResult(data)
      saveHistory({ item_id: item.item_id, name: item.name_ru || item.name_en || item.item_id, category: item.category, icon_path: item.icon_path })
      setHistory(loadHistory())
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Нет активных лотов')
      setResult(null)
    } finally { setLoading(false) }
  }

  const handleSelect       = (item: Item)          => fetchLots(item, region)
  const handleHistoryClick = (entry: HistoryEntry) => fetchLots(
    { item_id: entry.item_id, name_ru: entry.name, name_en: null, category: entry.category, icon_path: entry.icon_path },
    region,
  )
  const handleRegionChange = (newRegion: Region) => {
    setRegion(newRegion)
    if (selectedItem) {
      preserveFiltersRef.current = true
      fetchLots(selectedItem, newRegion)
    }
  }
  const handleRefresh = () => {
    if (selectedItem) {
      preserveFiltersRef.current = true
      fetchLots(selectedItem, region, true)
    } else if (selectedCategory) {
      preserveFiltersRef.current = true
      fetchCategoryLots(selectedCategory, region)
    }
  }

  // ─── Выбор категории ───────────────────────────────────────────────────────
  const handleCategorySelect = (cat: string | null) => {
    setSelectedCategory(cat)
    setSelectedItem(null)
    setResult(null)
    setQuery('')
    setSuggestions([])
    setError(null)
    if (!cat) setCatResult(null)
  }

  // ─── Watchlist ─────────────────────────────────────────────────────────────
  const wlKey = (itemId: string, lot: { quality_value: number | null; enchant_level: number | null }) =>
    `${itemId}_${lot.quality_value ?? 'n'}_${lot.enchant_level ?? 'n'}`

  const handleAddToWatchlist = async (itemId: string, lot: { quality_value: number | null; enchant_level: number | null }) => {
    const key = wlKey(itemId, lot)
    setWlStates((s) => ({ ...s, [key]: 'loading' }))
    try {
      await api.post('/watchlist/', { item_id: itemId, region, quality_filter: lot.quality_value ?? null, enchant_filter: lot.enchant_level ?? null })
      setWlStates((s) => ({ ...s, [key]: 'added' }))
      showToast('Добавлено в Избранное')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) {
        setWlStates((s) => ({ ...s, [key]: 'exists' }))
        showToast('Уже в Избранном')
      } else {
        setWlStates((s) => { const next = { ...s }; delete next[key]; return next })
        showToast('Ошибка добавления')
      }
    }
  }

  // ─── Сортировка ────────────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  // Рендер-функция кнопки «в избранное» (не компонент — избегаем ремаунта строк)
  const renderWlButton = (itemId: string, lot: { quality_name: string | null; quality_value: number | null; enchant_level: number | null }) => {
    const key = wlKey(itemId, lot)
    const st = wlStates[key]
    const enchantLabel = lot.enchant_level === 0 ? 'Не точёный' : lot.enchant_level != null ? `+${lot.enchant_level}` : null
    const label = lot.quality_name && enchantLabel
      ? `${lot.quality_name} ${enchantLabel}`
      : lot.quality_name ?? enchantLabel ?? 'Без фильтров'
    const done = st === 'added' || st === 'exists'
    return (
      <Tooltip title={done ? 'Уже в Избранном' : `В Избранное: ${label}`}>
        <span>
          <IconButton
            size="small"
            onClick={() => handleAddToWatchlist(itemId, lot)}
            disabled={st === 'loading' || done}
            aria-label={done ? 'Уже в Избранном' : 'В Избранное'}
            sx={{ color: done ? tokens.goldAccent : tokens.text2 }}
          >
            {st === 'loading'
              ? <Skeleton variant="rectangular" width={16} height={16} sx={{ bgcolor: tokens.bg3 }} />
              : done
                ? <BookmarkAddedIcon fontSize="small" />
                : <BookmarkAddIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
    )
  }

  const showHistory = !result && !loading && !selectedCategory && history.length > 0 && suggestions.length === 0
  const catLabel = CATEGORY_TREE.flatMap(g => [g, ...(g.children ?? [])]).find(g => g.id === selectedCategory)?.label ?? selectedCategory

  // ─── Гейт: тариф без доступа к лотам ──────────────────────────────────────
  if (gated) {
    return (
      <Box sx={{ padding: '0 16px 20px' }}>
        <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1 }}>
          <PageLock
            title="Поиск лотов"
            tierLabel={TIER_LABELS.advanced_plus}
            description={<>Твой тариф — {TIER_LABELS[user!.tier as keyof typeof TIER_LABELS] ?? user!.tier}. Живые лоты по любому предмету аукциона открываются на тарифе {TIER_LABELS.advanced_plus} и выше.</>}
            ctaLabel="Сменить тариф"
            onCta={() => navigate('/app/settings')}
          />
        </Box>
      </Box>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  const hasResult = loading || result || (selectedCategory && !result)

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '272px minmax(0, 1fr)',
        gap: '12px',
        alignItems: 'start',
        '@media (max-width:1360px)': { gridTemplateColumns: '256px minmax(0, 1fr)' },
      }}
    >
      <CategoryTree selected={selectedCategory} onSelect={handleCategorySelect} ariaLabel="Категории лотов" />

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>

        {/* ── Панель поиска ─────────────────────────────────────────── */}
        <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1 }}>
          <Box sx={{ padding: '14px 18px 12px' }}>
            <Kick>Поиск лотов // Lot Scanner</Kick>
            <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
              Поиск лотов
            </Typography>
            <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
              Живые лоты по предмету или категории — без добавления в Избранное. Кэш обновляется каждые 5 минут.
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', gap: '8px', padding: '0 18px 14px' }}>
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <TextField
                placeholder="Найти предмет — от 2 символов…"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                size="small"
                fullWidth
                type="search"
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        {searching ? <Skeleton variant="circular" width={16} height={16} sx={{ bgcolor: tokens.bg2 }} /> : <SearchIcon fontSize="small" />}
                      </InputAdornment>
                    ),
                  },
                }}
              />
              {suggestions.length > 0 && (
                <Paper sx={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, background: tokens.bg3, border: `1px solid ${tokens.borderHi}` }}>
                  <List dense disablePadding>
                    {suggestions.map((item) => (
                      <ListItem key={item.item_id} disablePadding>
                        <ListItemButton onClick={() => handleSelect(item)} sx={{ gap: '9px' }}>
                          <ItemIcon src={iconUrl(item.icon_path) ?? undefined} name={item.name_ru ?? item.name_en ?? item.item_id} />
                          <ListItemText
                            primary={<Typography sx={{ fontSize: fs.f125, color: tokens.text0 }} noWrap>{item.name_ru || item.name_en}</Typography>}
                            secondary={<Typography className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }} noWrap>{translateCategory(item.category)}</Typography>}
                          />
                        </ListItemButton>
                      </ListItem>
                    ))}
                  </List>
                </Paper>
              )}
            </Box>
            <RegionSelect value={region} onChange={handleRegionChange} sx={{ minWidth: 90, height: 40 }} />
          </Box>

          {/* История запросов */}
          {showHistory && (
            <Box sx={{ padding: '0 18px 18px' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '7px', pb: '10px', color: tokens.text2 }}>
                <HistoryIcon sx={{ fontSize: 14 }} />
                <Kick>История запросов</Kick>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {history.map((entry) => (
                  <Box
                    key={entry.item_id}
                    component="button"
                    type="button"
                    onClick={() => handleHistoryClick(entry)}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: '10px', minWidth: 200, padding: '9px 12px',
                      background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: 1, textAlign: 'left', cursor: 'pointer',
                      transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                      '&:hover': { background: tokens.bg3, borderColor: tokens.borderHi },
                    }}
                  >
                    <ItemIcon src={iconUrl(entry.icon_path) ?? undefined} name={entry.name} size={36} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 500, color: tokens.text0, maxWidth: 200 }}>{entry.name}</Typography>
                      <Typography noWrap className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{translateCategory(entry.category)}</Typography>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>

        {error && <Alert severity="warning">{error}</Alert>}

        {/* ── Лоты конкретного предмета (из поиска / истории) ──────── */}
        {(loading || result) && (
          <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1 }}>
            {loading ? (
              <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} variant="rectangular" height={34} sx={{ bgcolor: tokens.bg2 }} />
                ))}
              </Box>
            ) : result && (
              <>
                <ResultHeader
                  icon={<ItemIcon src={iconUrl(selectedItem?.icon_path ?? null) ?? undefined} name={selectedItem?.name_ru ?? result.item_id} size={44} />}
                  title={selectedItem?.name_ru || result.item_id}
                  subtitle={selectedItem?.name_en ?? undefined}
                  itemId={result.item_id}
                  chips={[translateCategory(selectedItem?.category ?? null), region, `${fmtN(result.total)} лот.`]}
                  fromCache={result.from_cache}
                  cacheNote={result.cache_note}
                  onRefresh={handleRefresh}
                />
                {(showQualityFilter || showEnchantFilter) && (
                  <LotsFiltersBar
                    activeLots={activeLots}
                    total={result.lots.length}
                    shownCount={filteredSorted.length}
                    qualityOptions={qualityOptions}
                    enchantOptions={enchantOptions}
                    showQuality={showQualityFilter}
                    showEnchant={showEnchantFilter}
                    filterQuality={filterQuality}
                    filterEnchant={filterEnchant}
                    onQuality={setFilterQuality}
                    onEnchant={setFilterEnchant}
                  />
                )}
                {filteredSorted.length === 0
                  ? <Alert severity="info" sx={{ m: 2 }}>Нет лотов, соответствующих фильтрам</Alert>
                  : <LotsTable
                      lots={pageLots as Lot[]}
                      page={page} rowsPerPage={rowsPerPage} totalFiltered={filteredSorted.length}
                      minBuyout={minBuyout} sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onSetPage={setPage} onSetRowsPerPage={(v) => { setRowsPerPage(v); setPage(0) }}
                      renderWl={(lot) => renderWlButton(selectedItem!.item_id, lot)}
                      showItemCol={false}
                    />}
              </>
            )}
          </Box>
        )}

        {/* ── Лоты по категории ─────────────────────────────────────── */}
        {!result && !loading && selectedCategory && (
          <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1 }}>
            {catLoading ? (
              <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} variant="rectangular" height={34} sx={{ bgcolor: tokens.bg2 }} />
                ))}
              </Box>
            ) : catError ? (
              <Alert severity="error" sx={{ m: 2 }}>{catError}</Alert>
            ) : catResult && (
              <>
                <ResultHeader
                  title={catLabel ?? ''}
                  chips={[region, `${fmtN(catResult.items_total)} предм.`, `${fmtN(catResult.lots_total)} лот.`]}
                  onRefresh={handleRefresh}
                />
                {catResult.lots_total === 0
                  ? <Alert severity="info" sx={{ m: 2 }}>В этой категории нет активных лотов</Alert>
                  : <>
                      {(showQualityFilter || showEnchantFilter) && (
                        <LotsFiltersBar
                          activeLots={activeLots}
                          total={catResult.lots_total}
                          shownCount={filteredSorted.length}
                          qualityOptions={qualityOptions}
                          enchantOptions={enchantOptions}
                          showQuality={showQualityFilter}
                          showEnchant={showEnchantFilter}
                          filterQuality={filterQuality}
                          filterEnchant={filterEnchant}
                          onQuality={setFilterQuality}
                          onEnchant={setFilterEnchant}
                        />
                      )}
                      {filteredSorted.length === 0
                        ? <Alert severity="info" sx={{ m: 2 }}>Нет лотов, соответствующих фильтрам</Alert>
                        : <LotsTable
                            lots={pageLots as CategoryLot[]}
                            page={page} rowsPerPage={rowsPerPage} totalFiltered={filteredSorted.length}
                            minBuyout={minBuyout} sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                            onSetPage={setPage} onSetRowsPerPage={(v) => { setRowsPerPage(v); setPage(0) }}
                            renderWl={(lot) => renderWlButton((lot as CategoryLot).item_id, lot)}
                            showItemCol
                          />}
                    </>}
              </>
            )}
          </Box>
        )}

        {/* Пустое состояние без гейта: загрузка user или ничего не выбрано */}
        {!hasResult && !showHistory && !user && (
          <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1, p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} variant="rectangular" height={34} sx={{ bgcolor: tokens.bg2 }} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

// ─── Шапка результата (.pg-h с иконкой, чипами, обновлением, кэш-чипом) ───────

function ResultHeader({
  icon, title, subtitle, itemId, chips, fromCache, cacheNote, onRefresh,
}: {
  icon?: JSX.Element
  title: string
  subtitle?: string
  itemId?: string
  chips: string[]
  fromCache?: boolean
  cacheNote?: string
  onRefresh: () => void
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '14px 18px 12px' }}>
      {icon}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: '9px', flexWrap: 'wrap' }}>
          <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1 }}>{title}</Typography>
          {subtitle && <Box component="span" sx={{ fontSize: fs.f12, color: tokens.text2 }}>{subtitle}</Box>}
          {itemId && (
            <Box component="span" className="mono" sx={{ fontSize: fs.f11, color: tokens.text2, border: `1px solid ${tokens.border}`, padding: '1px 6px', borderRadius: 1 }}>{itemId}</Box>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: '6px', mt: '7px', flexWrap: 'wrap' }}>
          {chips.map((c, i) => (
            <Chip key={i} label={c} size="small" className={i === 0 && !itemId ? undefined : 'mono'} />
          ))}
        </Box>
      </Box>
      <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Tooltip title="Обновить данные из API">
          <IconButton size="small" onClick={onRefresh} aria-label="Обновить"><RefreshIcon fontSize="small" /></IconButton>
        </Tooltip>
        {fromCache != null && (
          <Tooltip title={cacheNote ?? ''}>
            <Chip
              label={fromCache ? 'из кэша' : 'свежие данные'}
              size="small"
              color={fromCache ? 'default' : 'success'}
              className="mono"
              icon={<InfoOutlinedIcon />}
            />
          </Tooltip>
        )}
      </Box>
    </Box>
  )
}

// ─── Панель фильтров (вынесена из тела — не ремаунтится, §5.3) ────────────────

function LotsFiltersBar({
  activeLots, total, shownCount, qualityOptions, enchantOptions,
  showQuality, showEnchant, filterQuality, filterEnchant, onQuality, onEnchant,
}: {
  activeLots: { quality_name: string | null; enchant_level: number | null }[]
  total: number
  shownCount: number
  qualityOptions: string[]
  enchantOptions: number[]
  showQuality: boolean
  showEnchant: boolean
  filterQuality: string
  filterEnchant: string
  onQuality: (v: string) => void
  onEnchant: (v: string) => void
}) {
  const dirty = filterQuality !== 'all' || filterEnchant !== 'all'
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0 18px 12px', flexWrap: 'wrap' }}>
      {showQuality && (
        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel>Качество</InputLabel>
          <Select value={filterQuality} label="Качество" onChange={(e) => onQuality(e.target.value)}>
            <MenuItem value="all">Все качества ({total})</MenuItem>
            {qualityOptions.map((q) => {
              const count = activeLots.filter((l) => l.quality_name === q).length
              return <MenuItem key={q} value={q}>{q} ({count})</MenuItem>
            })}
          </Select>
        </FormControl>
      )}
      {showEnchant && (
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Заточка</InputLabel>
          <Select value={filterEnchant} label="Заточка" onChange={(e) => onEnchant(e.target.value)}>
            <MenuItem value="all">Все заточки</MenuItem>
            {enchantOptions.map((e) => {
              const count = activeLots.filter((l) => l.enchant_level === e).length
              return <MenuItem key={e} value={String(e)}>{e === 0 ? `Не точёный (${count})` : `+${e} (${count})`}</MenuItem>
            })}
          </Select>
        </FormControl>
      )}
      {dirty && (
        <Chip label="Сбросить" size="small" onClick={() => { onQuality('all'); onEnchant('all') }} sx={{ cursor: 'pointer' }} />
      )}
      {shownCount !== activeLots.length && (
        <Box component="span" className="mono" sx={{ ml: 'auto', fontSize: fs.f11, color: tokens.text2 }}>
          показано: <Box component="b" sx={{ color: tokens.text1, fontWeight: 500 }}>{fmtN(shownCount)}</Box> из {fmtN(activeLots.length)}
        </Box>
      )}
    </Box>
  )
}

// ─── Таблица лотов (общая для обоих режимов) ─────────────────────────────────

interface LotRow {
  item_id?: string
  item_name_ru?: string | null
  item_name_en?: string | null
  icon_path?: string | null
  amount: number
  buyout_price: number
  hours_remaining: number | null
  is_expiring: boolean
  quality_name: string | null
  enchant_level: number | null
  quality_value: number | null
}

const SORTABLE: { key: SortKey; label: string }[] = [
  { key: 'buyout_price',    label: 'Цена выкупа' },
  { key: 'amount',          label: 'Количество'  },
  { key: 'price_per_unit',  label: 'Цена / шт'  },
]

const thxSx = {
  padding: '6px 10px',
  fontFamily: tokens.fontHead,
  fontWeight: 600,
  fontSize: fs.f105,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: tokens.text2,
  background: tokens.bg2,
  borderBottom: `1px solid ${tokens.borderHi}`,
} as const

function LotsTable({
  lots, page, rowsPerPage, totalFiltered, minBuyout, sortKey, sortDir, onSort,
  onSetPage, onSetRowsPerPage, renderWl, showItemCol,
}: {
  lots: LotRow[]
  page: number
  rowsPerPage: number
  totalFiltered: number
  minBuyout: number
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  onSetPage: (p: number) => void
  onSetRowsPerPage: (v: number) => void
  renderWl: (lot: LotRow) => JSX.Element
  showItemCol: boolean
}) {
  const from = page * rowsPerPage
  const to = Math.min(totalFiltered, from + rowsPerPage)

  return (
    <>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              {showItemCol && <TableCell component="th" sx={{ ...thxSx, textAlign: 'left' }}>Предмет</TableCell>}
              {SORTABLE.map(({ key, label }) => (
                <SortHeader key={key} label={label} active={sortKey === key} direction={sortDir} onSort={() => onSort(key)} />
              ))}
              <TableCell component="th" sx={thxSx}>Качество</TableCell>
              <SortHeader label="Заточка" active={sortKey === 'enchant_level'} direction={sortDir} onSort={() => onSort('enchant_level')} />
              <SortHeader
                label={
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    Осталось
                    <Tooltip title="Лоты с остатком менее 2 часов помечены как истекающие">
                      <InfoOutlinedIcon sx={{ fontSize: 12 }} />
                    </Tooltip>
                  </Box>
                }
                active={sortKey === 'hours_remaining'} direction={sortDir} onSort={() => onSort('hours_remaining')}
              />
              <TableCell component="th" sx={thxSx}>Статус</TableCell>
              <TableCell component="th" sx={{ ...thxSx, width: 48 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {lots.map((lot, i) => {
              const isBest = lot.buyout_price === minBuyout
              return (
                <TableRow key={from + i} hover sx={{ opacity: lot.is_expiring ? 0.6 : 1 }}>
                  {showItemCol && (
                    <TableCell sx={{ textAlign: 'left', fontFamily: tokens.fontUi }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                        <ItemIcon src={iconUrl(lot.icon_path ?? null) ?? undefined} name={lot.item_name_ru ?? lot.item_name_en ?? lot.item_id ?? '?'} />
                        <Typography noWrap sx={{ fontSize: fs.f125, color: tokens.text0, maxWidth: 160 }}>
                          {lot.item_name_ru || lot.item_name_en || lot.item_id}
                        </Typography>
                      </Box>
                    </TableCell>
                  )}
                  <TableCell sx={isBest ? { color: tokens.goldHighlight, fontWeight: 700, textShadow: `0 0 14px ${tokens.goldGlow}` } : undefined}>
                    {fmtP(lot.buyout_price)}
                  </TableCell>
                  <TableCell>{fmtN(lot.amount)}</TableCell>
                  <TableCell>{fmtP(Math.floor(lot.buyout_price / lot.amount))}</TableCell>
                  <TableCell sx={{ textAlign: 'left' }}>
                    {lot.quality_name
                      ? <QualityChip color={qualityKeyByValue(lot.quality_value)} label={lot.quality_name} />
                      : <Box component="span" sx={{ color: tokens.text2 }}>—</Box>}
                  </TableCell>
                  <TableCell sx={{ color: lot.enchant_level ? tokens.text0 : tokens.text2 }}>
                    {lot.enchant_level == null ? '—' : lot.enchant_level === 0 ? 'не точёный' : `+${lot.enchant_level}`}
                  </TableCell>
                  <TableCell sx={{ color: lot.is_expiring ? tokens.warning : tokens.text2 }}>
                    {lot.hours_remaining != null ? `${lot.hours_remaining.toFixed(1)} ч` : '—'}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'left' }}>
                    <Chip
                      label={lot.is_expiring ? 'Истекает' : 'Активен'}
                      size="small"
                      color={lot.is_expiring ? 'warning' : 'success'}
                      className="mono"
                    />
                  </TableCell>
                  <TableCell sx={{ p: '4px 8px', textAlign: 'right' }}>{renderWl(lot)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* .tfoot-line — реальная пагинация: диапазон + строк на страницу */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px',
          padding: '8px 12px 10px', borderTop: `1px solid ${tokens.border}`,
          fontFamily: tokens.fontMono, fontSize: fs.f11, color: tokens.text2, fontVariantNumeric: 'tabular-nums',
        }}
      >
        <PgBtn label="‹" ariaLabel="Предыдущая страница" disabled={page === 0} onClick={() => onSetPage(page - 1)} />
        <Box component="span">{fmtN(from + 1)}–{fmtN(to)} из {fmtN(totalFiltered)}</Box>
        <PgBtn label="›" ariaLabel="Следующая страница" disabled={to >= totalFiltered} onClick={() => onSetPage(page + 1)} />
        <Box component="span">· строк на стр:</Box>
        <Select
          value={rowsPerPage}
          onChange={(e) => onSetRowsPerPage(Number(e.target.value))}
          size="small"
          className="mono"
          aria-label="Строк на страницу"
          sx={{ height: 24, background: tokens.bg2, fontFamily: tokens.fontMono, fontSize: fs.f11, color: tokens.text1, '& .MuiSelect-select': { py: 0 } }}
        >
          {ROWS_PER_PAGE_OPTIONS.map((v) => <MenuItem key={v} value={v} className="mono">{v}</MenuItem>)}
        </Select>
      </Box>
    </>
  )
}

function PgBtn({ label, ariaLabel, disabled, onClick }: { label: string; ariaLabel: string; disabled: boolean; onClick: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      sx={{
        width: 24, height: 24, display: 'inline-grid', placeItems: 'center',
        color: tokens.text1, border: `1px solid ${tokens.border}`, borderRadius: 1, cursor: 'pointer',
        background: 'none',
        transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
        '&:hover': { color: tokens.text0, borderColor: tokens.borderHi, background: tokens.bg2 },
        '&:disabled': { opacity: 0.35, cursor: 'default', color: tokens.text2, background: 'transparent', borderColor: tokens.border },
      }}
    >
      {label}
    </Box>
  )
}
