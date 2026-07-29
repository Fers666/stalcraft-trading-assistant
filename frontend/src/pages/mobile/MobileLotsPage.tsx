import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box, Typography, TextField, InputAdornment, Button, Chip, Alert, Skeleton,
  MenuItem, Select, FormControl, InputLabel, IconButton, ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import RefreshIcon from '@mui/icons-material/Refresh'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import TuneIcon from '@mui/icons-material/Tune'
import api from '../../api/client'
import { translateCategory, iconUrl, qualityKeyByValue } from '../../utils/i18n'
import { fmtN, fmtP, fmtCompact } from '../../utils/format'
import { useAuthStore } from '../../store/authStore'
import { TIER_LABELS } from '../../constants/tiers'
import { Region } from '../../constants/regions'
import { tokens, fs } from '../../theme'
import { sortLots, type SortKey, type SortDir } from '../../utils/lots'
import QualityChip from '../../components/ui/QualityChip'
import RegionSelect from '../../components/ui/RegionSelect'
import ItemIcon from '../../components/ui/ItemIcon'
import Kick from '../../components/ui/Kick'
import PageLock from '../../components/ui/PageLock'
import { useToast } from '../../components/ui/Toast'
import BottomSheet from '../../components/mobile/BottomSheet'
import DCard from '../../components/mobile/ui/DCard'
import StatusGrid from '../../components/mobile/ui/StatusGrid'

// Лоты (мобайл) — тот же дата-слой, что десктопный LotsPage (api /items, /lots,
// /watchlist POST, sortLots из utils/lots, история в localStorage). Раскладка по
// прототипу lots.html: поиск с автодополнением + история → результат → шит
// фильтров (сортировка/качество/заточка) → .dcard-лоты. Гейт auction_access →
// PageLock. Просмотр по категории (десктоп) на мобиле не переносится — прототип
// сфокусирован на поиске конкретного предмета.

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

interface HistoryEntry {
  item_id: string
  name: string
  category: string | null
  icon_path: string | null
}

const QL_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый', 3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}
const HISTORY_KEY = 'lots_search_history'
const HISTORY_MAX = 10
const RPP = 25
const QUALITY_ORDER = ['Обычный', 'Необычный', 'Особый', 'Ветеран', 'Мастер', 'Легендарный']

const SORTS: { label: string; key: SortKey; dir: SortDir }[] = [
  { label: 'Цена ↑',       key: 'buyout_price',   dir: 'asc'  },
  { label: 'Цена ↓',       key: 'buyout_price',   dir: 'desc' },
  { label: 'Цена/шт ↑',    key: 'price_per_unit', dir: 'asc'  },
  { label: 'Скоро истекут', key: 'hours_remaining', dir: 'asc' },
  { label: 'Кол-во ↓',     key: 'amount',         dir: 'desc' },
]

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}
function saveHistory(entry: HistoryEntry) {
  const next = [entry, ...loadHistory().filter((h) => h.item_id !== entry.item_id)].slice(0, HISTORY_MAX)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
}

export default function MobileLotsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const user = useAuthStore((s) => s.user)

  const navStateAppliedRef = useRef(false)
  const pendingQualityRef = useRef<string | null>(null)
  const pendingEnchantRef = useRef<string | null>(null)

  const [query, setQuery]               = useState('')
  const [region, setRegion]             = useState<Region>('RU')
  const [suggestions, setSuggestions]   = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [result, setResult]             = useState<LotsResponse | null>(null)
  const [loading, setLoading]           = useState(false)
  const [searching, setSearching]       = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [history, setHistory]           = useState<HistoryEntry[]>(loadHistory)

  const [filterQuality, setFilterQuality] = useState<string>('all')
  const [filterEnchant, setFilterEnchant] = useState<string>('all')
  const [sortIndex, setSortIndex]         = useState(0)
  const [page, setPage]                   = useState(0)

  const [filtOpen, setFiltOpen] = useState(false)
  const [wlStates, setWlStates] = useState<Record<string, 'loading' | 'added' | 'exists'>>({})

  const gated = !!user && !user.is_admin && user.auction_access === false

  const sort = SORTS[sortIndex]
  const lots = result?.lots ?? []

  const qualityOptions = useMemo(() => {
    const vals = [...new Set(lots.map((l) => l.quality_name).filter(Boolean) as string[])]
    return vals.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
  }, [lots])
  const enchantOptions = useMemo(
    () => [...new Set(lots.map((l) => l.enchant_level).filter((v): v is number => v != null))].sort((a, b) => a - b),
    [lots],
  )

  const filteredSorted = useMemo(() => {
    const filtered = lots.filter((l) => {
      if (filterQuality !== 'all' && l.quality_name !== filterQuality) return false
      if (filterEnchant !== 'all' && String(l.enchant_level) !== filterEnchant) return false
      return true
    })
    return sortLots(filtered, sort.key, sort.dir)
  }, [lots, filterQuality, filterEnchant, sort])

  const minBuyout = useMemo(
    () => filteredSorted.reduce((m, l) => Math.min(m, l.buyout_price), Infinity),
    [filteredSorted],
  )

  const pageLots = filteredSorted.slice(page * RPP, page * RPP + RPP)
  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / RPP))

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
      setFilterQuality(pendingQualityRef.current ?? 'all')
      setFilterEnchant(pendingEnchantRef.current ?? 'all')
      pendingQualityRef.current = null
      pendingEnchantRef.current = null
      setSortIndex(0)
      setPage(0)
      setWlStates({})
      saveHistory({ item_id: item.item_id, name: item.name_ru || item.name_en || item.item_id, category: item.category, icon_path: item.icon_path })
      setHistory(loadHistory())
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg || 'Нет активных лотов')
      setResult(null)
    } finally { setLoading(false) }
  }

  // Инициализация из navigation state (переход из Избранного / Радара)
  useEffect(() => {
    if (navStateAppliedRef.current) return
    navStateAppliedRef.current = true
    const state = location.state as {
      item_id?: string; name_ru?: string | null; name_en?: string | null
      icon_path?: string | null; region?: string
      quality_filter?: number | null; enchant_filter?: number | null
    } | null
    if (!state?.item_id) return
    const item: Item = {
      item_id: state.item_id, name_ru: state.name_ru ?? null, name_en: state.name_en ?? null,
      category: null, icon_path: state.icon_path ?? null,
    }
    const reg = (state.region as Region) ?? region
    if (state.region) setRegion(state.region as Region)
    if (state.quality_filter != null) pendingQualityRef.current = QL_NAMES[state.quality_filter] ?? null
    if (state.enchant_filter != null) pendingEnchantRef.current = String(state.enchant_filter)
    fetchLots(item, reg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const handleRegionChange = (newRegion: Region) => {
    setRegion(newRegion)
    if (selectedItem) fetchLots(selectedItem, newRegion)
  }

  const handleRefresh = () => { if (selectedItem) fetchLots(selectedItem, region, true) }

  // Watchlist
  const wlKey = (itemId: string, lot: { quality_value: number | null; enchant_level: number | null }) =>
    `${itemId}_${lot.quality_value ?? 'n'}_${lot.enchant_level ?? 'n'}`

  const handleAddToWatchlist = async (itemId: string, lot: Lot) => {
    const key = wlKey(itemId, lot)
    setWlStates((s) => ({ ...s, [key]: 'loading' }))
    try {
      await api.post('/watchlist/', { item_id: itemId, region, quality_filter: lot.quality_value ?? null, enchant_filter: lot.enchant_level ?? null })
      setWlStates((s) => ({ ...s, [key]: 'added' }))
      showToast('Добавлено в Избранное')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 409) { setWlStates((s) => ({ ...s, [key]: 'exists' })); showToast('Уже в Избранном') }
      else { setWlStates((s) => { const n = { ...s }; delete n[key]; return n }); showToast('Ошибка добавления') }
    }
  }

  // Черновик фильтров (применяется по кнопке — как в прототипе)
  const [draftSort, setDraftSort]       = useState(0)
  const [draftQuality, setDraftQuality] = useState('all')
  const [draftEnchant, setDraftEnchant] = useState('all')
  const openFilters = () => {
    setDraftSort(sortIndex)
    setDraftQuality(filterQuality)
    setDraftEnchant(filterEnchant)
    setFiltOpen(true)
  }
  const applyFilters = () => {
    setSortIndex(draftSort)
    setFilterQuality(draftQuality)
    setFilterEnchant(draftEnchant)
    setPage(0)
    setFiltOpen(false)
  }

  const filtersDirty = filterQuality !== 'all' || filterEnchant !== 'all'

  // ── Гейт ────────────────────────────────────────────────────────────────
  if (gated) {
    return (
      <Box>
        <PageLock
          title="Поиск лотов"
          tierLabel={TIER_LABELS.advanced_plus}
          description={<>Твой тариф — {TIER_LABELS[user!.tier as keyof typeof TIER_LABELS] ?? user!.tier}. Живые лоты по любому предмету аукциона открываются на тарифе {TIER_LABELS.advanced_plus} и выше.</>}
          ctaLabel="Сменить тариф"
          onCta={() => navigate('/app/settings')}
        />
      </Box>
    )
  }

  const showHistory = !result && !loading && suggestions.length === 0 && history.length > 0

  return (
    <Box>
      {/* .pg-h */}
      <Box sx={{ pb: '12px' }}>
        <Kick>Поиск лотов // Lot Scanner</Kick>
        <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}>
          Поиск лотов
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', lineHeight: 1.5 }}>
          Живые лоты по предмету — без добавления в Избранное. Кэш обновляется каждые 5 минут.
        </Typography>
      </Box>

      {/* Поиск + регион */}
      <Box sx={{ display: 'flex', gap: '8px', mb: '10px' }}>
        <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <TextField
            size="small"
            fullWidth
            type="search"
            placeholder="Найти предмет — от 2 символов…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            slotProps={{
              input: {
                sx: { fontSize: '16px', height: 46 },
                startAdornment: <InputAdornment position="start">{searching ? <Skeleton variant="circular" width={16} height={16} sx={{ bgcolor: tokens.bg2 }} /> : <SearchIcon sx={{ fontSize: 18, color: tokens.text2 }} />}</InputAdornment>,
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => { setQuery(''); setSuggestions([]) }} aria-label="Очистить"><ClearIcon sx={{ fontSize: 16 }} /></IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          {suggestions.length > 0 && (
            <Box sx={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, background: tokens.bg3, border: `1px solid ${tokens.borderHi}`, borderRadius: '2px', maxHeight: '52vh', overflowY: 'auto' }}>
              {suggestions.map((item) => (
                <Box
                  key={item.item_id}
                  component="button"
                  type="button"
                  onClick={() => fetchLots(item, region)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: '9px', width: '100%', minHeight: 48,
                    padding: '9px 12px', textAlign: 'left', cursor: 'pointer', background: 'none',
                    border: 0, borderBottom: `1px solid ${tokens.border}`,
                    '&:active': { background: tokens.goldDim },
                  }}
                >
                  <ItemIcon src={iconUrl(item.icon_path) ?? undefined} name={item.name_ru ?? item.name_en ?? item.item_id} size={30} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography noWrap sx={{ fontSize: fs.f125, color: tokens.text0 }}>{item.name_ru || item.name_en}</Typography>
                    <Typography noWrap className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{translateCategory(item.category)}</Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>
        <RegionSelect value={region} onChange={handleRegionChange} sx={{ minWidth: 84, height: 46 }} />
      </Box>

      {error && <Alert severity="warning" sx={{ mb: '10px' }}>{error}</Alert>}

      {/* История */}
      {showHistory && (
        <Box>
          <Kick sx={{ display: 'block', mb: '8px' }}>История запросов</Kick>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {history.map((entry) => (
              <DCard
                key={entry.item_id}
                onClick={() => fetchLots({ item_id: entry.item_id, name_ru: entry.name, name_en: null, category: entry.category, icon_path: entry.icon_path }, region)}
                icon={<ItemIcon src={iconUrl(entry.icon_path) ?? undefined} name={entry.name} size={32} />}
                name={entry.name}
                sub={translateCategory(entry.category)}
                right={<ChevronRightIcon sx={{ fontSize: 18, color: tokens.text2 }} />}
              />
            ))}
          </Box>
        </Box>
      )}

      {/* Загрузка результата */}
      {loading && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} variant="rectangular" height={78} sx={{ bgcolor: tokens.bg2 }} />
          ))}
        </Box>
      )}

      {/* Результат */}
      {result && selectedItem && !loading && (
        <>
          {/* Шапка результата */}
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '10px', background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: '2px', p: '12px', mb: '10px' }}>
            <ItemIcon src={iconUrl(selectedItem.icon_path) ?? undefined} name={selectedItem.name_ru ?? result.item_id} size={44} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f15, color: tokens.text0 }}>
                {selectedItem.name_ru || result.item_id}
              </Typography>
              <Typography noWrap sx={{ fontSize: fs.f11, color: tokens.text2, mb: '6px' }}>{translateCategory(selectedItem.category)}</Typography>
              <Box sx={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <Chip label={region} size="small" className="mono" />
                <Chip label={`${fmtN(result.total)} лот.`} size="small" className="mono" />
                <Chip label={result.from_cache ? 'из кэша' : 'свежие'} size="small" color={result.from_cache ? 'default' : 'success'} className="mono" />
              </Box>
            </Box>
            <IconButton onClick={handleRefresh} aria-label="Обновить"><RefreshIcon sx={{ fontSize: 18 }} /></IconButton>
          </Box>

          {/* Фильтры + сортировка */}
          <Box sx={{ display: 'flex', gap: '8px', mb: '10px' }}>
            <Button variant="outlined" onClick={openFilters} startIcon={<TuneIcon sx={{ fontSize: 16 }} />} sx={{ flex: 1, minHeight: 44 }}>
              {filtersDirty ? 'Фильтры · вкл' : 'Фильтры'}
            </Button>
            <Button variant="outlined" onClick={openFilters} sx={{ flex: 1, minHeight: 44 }}>{sort.label}</Button>
          </Box>

          {/* Статус */}
          <StatusGrid
            cols={3}
            sx={{ mb: '10px' }}
            items={[
              { k: 'Лотов',     v: fmtN(filteredSorted.length), tone: 'gold' },
              { k: 'Мин. выкуп', v: filteredSorted.length ? fmtCompact(minBuyout) : '—' },
              { k: 'Регион',    v: region },
            ]}
          />

          {/* Лоты */}
          {pageLots.length === 0 ? (
            <Box sx={{ p: '32px 20px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12, lineHeight: 1.5 }}>
              {lots.length ? 'Под фильтры ничего не подошло — сбрось качество или заточку.' : 'Активных лотов с выкупом сейчас нет.'}
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {pageLots.map((lot, i) => {
                const best = lot.buyout_price === minBuyout
                const key = wlKey(selectedItem.item_id, lot)
                const st = wlStates[key]
                const added = st === 'added' || st === 'exists'
                return (
                  <DCard
                    key={`${page}-${i}`}
                    lit={best}
                    icon={<ItemIcon src={iconUrl(selectedItem.icon_path) ?? undefined} name={selectedItem.name_ru ?? result.item_id} quality={qualityKeyByValue(lot.quality_value)} size={32} />}
                    name={
                      <Box component="span" className="mono" sx={best ? { color: tokens.goldHighlight, fontWeight: 700, textShadow: `0 0 14px ${tokens.goldGlow}` } : undefined}>
                        {fmtP(lot.buyout_price)}
                        {best && <Box component="span" sx={{ ml: '6px', fontFamily: tokens.fontHead, fontSize: fs.f10, fontWeight: 700, letterSpacing: '0.06em', color: tokens.goldAccent, background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, px: '5px', borderRadius: '2px', verticalAlign: 'middle' }}>ЛУЧШАЯ</Box>}
                      </Box>
                    }
                    sub={`${fmtN(lot.amount)} шт · ${fmtP(Math.floor(lot.buyout_price / lot.amount))}/шт`}
                    chips={
                      <>
                        {lot.quality_name && <QualityChip color={qualityKeyByValue(lot.quality_value)} label={lot.quality_name} />}
                        {lot.enchant_level != null && lot.enchant_level > 0 && (
                          <Box component="span" className="mono" sx={{ fontSize: fs.f105, fontWeight: 700, color: tokens.goldAccent, background: tokens.goldDim, px: '5px', borderRadius: '2px' }}>+{lot.enchant_level}</Box>
                        )}
                        <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: lot.is_expiring ? tokens.warning : tokens.text2, border: `1px solid ${lot.is_expiring ? tokens.warningLine : tokens.border}`, px: '6px', borderRadius: '2px' }}>
                          {lot.is_expiring ? 'истекает · ' : ''}{lot.hours_remaining != null ? `${lot.hours_remaining.toFixed(1)} ч` : '—'}
                        </Box>
                      </>
                    }
                    right={
                      added ? (
                        <Box component="span" sx={{ fontSize: fs.f105, fontWeight: 600, color: tokens.goldAccent, background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, px: '6px', py: '3px', borderRadius: '2px', whiteSpace: 'nowrap' }}>в избранном</Box>
                      ) : (
                        <Box
                          component="button"
                          type="button"
                          aria-label="В Избранное"
                          onClick={() => handleAddToWatchlist(selectedItem.item_id, lot)}
                          sx={{
                            width: 44, height: 44, display: 'grid', placeItems: 'center', background: 'none',
                            border: '1px solid transparent', borderRadius: '2px', cursor: 'pointer', color: tokens.text2,
                            '&:active': { background: tokens.bg2, borderColor: tokens.borderHi },
                          }}
                        >
                          <Box component="svg" width="14" height="16" viewBox="0 0 12 14" fill="none" aria-hidden="true" sx={{ display: 'block' }}>
                            <path d="M2 1.5h8a.5.5 0 0 1 .5.5v10.6L6 9.6l-4.5 3V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                            <path d="M6 3.8v3M4.5 5.3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                          </Box>
                        </Box>
                      )
                    }
                  />
                )
              })}
            </Box>
          )}

          {totalPages > 1 && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', pt: '14px', fontFamily: tokens.fontMono, fontSize: fs.f11, color: tokens.text2 }}>
              <Button variant="outlined" size="small" disabled={page === 0} onClick={() => { setPage((p) => p - 1); window.scrollTo(0, 0) }} sx={{ minWidth: 44, minHeight: 36 }}>‹</Button>
              <Box component="span">{fmtN(page * RPP + 1)}–{fmtN(Math.min(filteredSorted.length, (page + 1) * RPP))} / {fmtN(filteredSorted.length)}</Box>
              <Button variant="outlined" size="small" disabled={(page + 1) * RPP >= filteredSorted.length} onClick={() => { setPage((p) => p + 1); window.scrollTo(0, 0) }} sx={{ minWidth: 44, minHeight: 36 }}>›</Button>
            </Box>
          )}
        </>
      )}

      {/* Шит фильтров */}
      <BottomSheet
        open={filtOpen}
        onClose={() => setFiltOpen(false)}
        title="Фильтры"
        footer={<Button variant="contained" fullWidth onClick={applyFilters} sx={{ minHeight: 44 }}>Показать лоты</Button>}
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
              sx={{ gap: '6px', '& .MuiToggleButton-root': { justifyContent: 'flex-start', minHeight: 44, border: `1px solid ${tokens.border}`, borderRadius: '2px !important' } }}
            >
              {SORTS.map((s, i) => <ToggleButton key={i} value={i}>{s.label}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>

          {qualityOptions.length > 0 && (
            <FormControl size="small" fullWidth>
              <InputLabel>Качество</InputLabel>
              <Select value={draftQuality} label="Качество" onChange={(e) => setDraftQuality(e.target.value)}>
                <MenuItem value="all">Все качества</MenuItem>
                {qualityOptions.map((q) => {
                  const n = lots.filter((l) => l.quality_name === q).length
                  return <MenuItem key={q} value={q}>{q} ({n})</MenuItem>
                })}
              </Select>
            </FormControl>
          )}

          {enchantOptions.length > 0 && (
            <FormControl size="small" fullWidth>
              <InputLabel>Заточка</InputLabel>
              <Select value={draftEnchant} label="Заточка" onChange={(e) => setDraftEnchant(e.target.value)}>
                <MenuItem value="all">Все заточки</MenuItem>
                {enchantOptions.map((e) => {
                  const n = lots.filter((l) => l.enchant_level === e).length
                  return <MenuItem key={e} value={String(e)}>{e === 0 ? `Не точёный (${n})` : `+${e} (${n})`}</MenuItem>
                })}
              </Select>
            </FormControl>
          )}
        </Box>
      </BottomSheet>
    </Box>
  )
}
