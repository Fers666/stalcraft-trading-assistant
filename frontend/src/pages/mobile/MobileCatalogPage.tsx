import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Button, Chip, Skeleton, Alert,
  MenuItem, Select, FormControl, InputLabel, IconButton,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import api from '../../api/client'
import { translateCategory, iconUrl, qualityKeyFromColor } from '../../utils/i18n'
import { CATEGORY_TREE } from '../../utils/categories'
import { useFeedStore } from '../../store/feedStore'
import { tokens, fs } from '../../theme'
import { Region } from '../../constants/regions'
import CategoryTree from '../../components/ui/CategoryTree'
import QualityChip from '../../components/ui/QualityChip'
import RegionSelect from '../../components/ui/RegionSelect'
import ItemIcon from '../../components/ui/ItemIcon'
import Kick from '../../components/ui/Kick'
import Pager from '../../components/ui/Pager'
import { useToast } from '../../components/ui/Toast'
import BottomSheet from '../../components/mobile/BottomSheet'
import DCard from '../../components/mobile/ui/DCard'
import StatusGrid from '../../components/mobile/ui/StatusGrid'

// Каталог (мобайл) — тот же дата-слой, что десктопный CatalogPage (api /items,
// /watchlist POST, feedStore.watchlist). Таблица → .dcard-стопка; дерево
// категорий и добавление в избранное → BottomSheet; StatusLine → StatusGrid.

const PAGE_SIZE = 50

interface Item {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  color: string | null
  quality_name: string | null
  icon_path: string | null
  can_be_batch_traded: boolean
}

const QUALITY_OPTIONS = [
  { value: null,  label: 'Любое' },
  { value: 0,     label: 'Обычный' },
  { value: 1,     label: 'Необычный' },
  { value: 2,     label: 'Особый' },
  { value: 3,     label: 'Ветеран' },
  { value: 4,     label: 'Мастер' },
  { value: 5,     label: 'Легендарный' },
]

const ENCHANT_OPTIONS = [
  { value: null, label: 'Любая' },
  { value: 0,    label: 'Не точёный' },
  ...Array.from({ length: 15 }, (_, i) => ({ value: i + 1, label: `+${i + 1}` })),
]

function isArtefact(category: string | null): boolean {
  return !!category && category.startsWith('artefact')
}

function categoryLabel(id: string | null): string {
  if (id == null) return 'Все предметы'
  for (const g of CATEGORY_TREE) {
    if (g.id === id) return g.label
    for (const c of g.children ?? []) if (c.id === id) return c.label
  }
  return id
}

// Иконка-закладка (stroke) — эталон catalog.html
const BookmarkAdd = () => (
  <Box component="svg" width="14" height="16" viewBox="0 0 12 14" fill="none" aria-hidden="true" sx={{ display: 'block' }}>
    <path d="M2 1.5h8a.5.5 0 0 1 .5.5v10.6L6 9.6l-4.5 3V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6 3.8v3M4.5 5.3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Box>
)
const BookmarkOk = () => (
  <Box component="svg" width="14" height="16" viewBox="0 0 12 14" fill="none" aria-hidden="true" sx={{ display: 'block' }}>
    <path d="M2 1.5h8a.5.5 0 0 1 .5.5v10.6L6 9.6l-4.5 3V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="m3.9 5.4 1.6 1.6 2.8-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Box>
)

export default function MobileCatalogPage() {
  const { showToast } = useToast()
  const watchlist = useFeedStore((s) => s.watchlist)

  const [search, setSearch]             = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [category, setCategory]         = useState<string | null>(null)
  const [items, setItems]               = useState<Item[]>([])
  const [total, setTotal]               = useState(0)
  const [page, setPage]                 = useState(1)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const [catOpen, setCatOpen] = useState(false)

  // Шит добавления в watchlist
  const [dialogItem, setDialogItem]       = useState<Item | null>(null)
  const [region, setRegion]               = useState<Region>('RU')
  const [qualityFilter, setQualityFilter] = useState<number | null>(null)
  const [enchantFilter, setEnchantFilter] = useState<number | null>(null)
  const [adding, setAdding]               = useState(false)
  const [addError, setAddError]           = useState<string | null>(null)

  const [sessionAdded, setSessionAdded] = useState<Set<string>>(new Set())
  const addedIds = useMemo(() => {
    const s = new Set(sessionAdded)
    watchlist.forEach((w) => s.add(w.item_id))
    return s
  }, [watchlist, sessionAdded])

  const loadItems = useCallback(async (cat: string | null, sq: string, p: number) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = { page: p, page_size: PAGE_SIZE }
      if (cat) params.category = cat
      if (sq)  params.search = sq
      const { data } = await api.get('/items', { params })
      setItems(data.items)
      setTotal(data.total)
    } catch {
      setError('Ошибка загрузки данных')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadItems(category, activeSearch, page)
  }, [category, activeSearch, page, loadItems])

  const handleSearch = () => { setPage(1); setActiveSearch(search) }
  const handleReset  = () => { setSearch(''); setActiveSearch(''); setPage(1) }

  const handleCategorySelect = (cat: string | null) => {
    setCategory(cat)
    setPage(1)
    setCatOpen(false)
  }

  const openDialog = (item: Item) => {
    setAddError(null)
    setDialogItem(item)
    setQualityFilter(null)
    setEnchantFilter(null)
  }

  const handleAdd = async () => {
    if (!dialogItem) return
    setAdding(true)
    setAddError(null)
    try {
      const payload: Record<string, unknown> = { item_id: dialogItem.item_id, region }
      if (isArtefact(dialogItem.category)) {
        payload.quality_filter = qualityFilter
        payload.enchant_filter = enchantFilter
      }
      await api.post('/watchlist/', payload)

      let suffix = ''
      if (isArtefact(dialogItem.category)) {
        const qLabel = QUALITY_OPTIONS.find(o => o.value === qualityFilter)?.label ?? 'Любое'
        const eLabel = enchantFilter === 0 ? ' Не точёный' : enchantFilter != null ? ` +${enchantFilter}` : ''
        suffix = ` [${qLabel}${eLabel}]`
      } else if (dialogItem.quality_name) {
        suffix = ` [${dialogItem.quality_name}]`
      }
      setSessionAdded((prev) => new Set(prev).add(dialogItem.item_id))
      showToast(`«${dialogItem.name_ru || dialogItem.item_id}»${suffix} добавлен в избранное (${region})`)
      setDialogItem(null)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setAddError(msg || 'Ошибка добавления')
    } finally {
      setAdding(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Box>
      {/* .pg-h */}
      <Box sx={{ pb: '12px' }}>
        <Kick>Каталог // Item Database</Kick>
        <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}>
          Каталог предметов
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', lineHeight: 1.5 }}>
          База предметов аукциона STALZONE. Ищи по имени, фильтруй по категории, добавляй в избранное.
        </Typography>
      </Box>

      {/* Поиск */}
      <TextField
        size="small"
        fullWidth
        type="search"
        placeholder="Поиск по названию…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        sx={{ mb: '8px' }}
        slotProps={{
          input: {
            sx: { fontSize: '16px', height: 46 },
            startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: tokens.text2 }} /></InputAdornment>,
            endAdornment: search ? (
              <InputAdornment position="end">
                <IconButton size="small" onClick={handleReset} aria-label="Очистить поиск"><ClearIcon sx={{ fontSize: 16 }} /></IconButton>
              </InputAdornment>
            ) : undefined,
          },
        }}
      />

      {/* Категория + Найти */}
      <Box sx={{ display: 'flex', gap: '8px', mb: '10px' }}>
        <Button variant="outlined" onClick={() => setCatOpen(true)} sx={{ flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'flex-start' }}>
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {categoryLabel(category)}
          </Box>
        </Button>
        <Button variant="contained" onClick={handleSearch} disabled={loading} sx={{ flex: 1, minHeight: 44 }}>Найти</Button>
      </Box>

      {/* Статус */}
      <StatusGrid
        cols={3}
        sx={{ mb: '10px' }}
        items={[
          { k: 'Найдено',  v: total.toLocaleString('ru-RU'), tone: 'gold' },
          { k: 'Страница', v: `${page} / ${totalPages}` },
          { k: 'Поиск',    v: activeSearch ? `«${activeSearch}»` : '—' },
        ]}
      />

      {error && <Alert severity="error" sx={{ mb: '10px' }} onClose={() => setError(null)}>{error}</Alert>}

      {/* Список */}
      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} variant="rectangular" height={72} sx={{ bgcolor: tokens.bg2 }} />
          ))}
        </Box>
      ) : items.length === 0 ? (
        <Box sx={{ p: '32px 20px', textAlign: 'center', color: tokens.text2, fontSize: fs.f12, lineHeight: 1.5 }}>
          {activeSearch
            ? <>Ничего не найдено по запросу «{activeSearch}»{category ? ` в категории «${categoryLabel(category)}»` : ''}.</>
            : <>В категории «{categoryLabel(category)}» пока нет предметов.</>}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map((item) => {
            const added = addedIds.has(item.item_id)
            return (
              <DCard
                key={item.id}
                icon={<ItemIcon src={iconUrl(item.icon_path) ?? undefined} name={item.name_ru ?? item.name_en ?? item.item_id} quality={qualityKeyFromColor(item.color)} size={32} />}
                name={item.name_ru || item.name_en || item.item_id}
                sub={translateCategory(item.category)}
                chips={
                  <>
                    {item.quality_name && <QualityChip color={qualityKeyFromColor(item.color)} label={item.quality_name} />}
                    {item.can_be_batch_traded && <Chip label="пачки" size="small" />}
                  </>
                }
                right={
                  <Box
                    component="button"
                    type="button"
                    aria-label={added ? 'Уже отслеживается — добавить ещё вариант' : 'В избранное'}
                    onClick={() => openDialog(item)}
                    sx={{
                      width: 44, height: 44, display: 'grid', placeItems: 'center',
                      background: 'none', border: '1px solid transparent', borderRadius: '2px', cursor: 'pointer',
                      color: added ? tokens.goldAccent : tokens.text2,
                      transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                      '&:active': { background: tokens.bg2, borderColor: tokens.borderHi },
                    }}
                  >
                    {added ? <BookmarkOk /> : <BookmarkAdd />}
                  </Box>
                }
              />
            )
          })}
        </Box>
      )}

      {!loading && items.length > 0 && (
        <Pager page={page} count={totalPages} onChange={(p) => { setPage(p); window.scrollTo(0, 0) }} />
      )}

      {/* Шит категорий */}
      <BottomSheet open={catOpen} onClose={() => setCatOpen(false)} title="Категории">
        <CategoryTree
          selected={category}
          onSelect={handleCategorySelect}
          ariaLabel="Категории каталога"
          sx={{ position: 'static', top: 'auto', maxHeight: 'none', border: 'none', background: 'transparent' }}
        />
      </BottomSheet>

      {/* Шит добавления */}
      <BottomSheet
        open={!!dialogItem}
        onClose={() => setDialogItem(null)}
        title="В избранное"
        footer={
          <Box sx={{ display: 'flex', gap: '8px', '& > *': { flex: 1 } }}>
            <Button variant="outlined" onClick={() => setDialogItem(null)} sx={{ minHeight: 44 }}>Отмена</Button>
            <Button variant="contained" onClick={handleAdd} disabled={adding} sx={{ minHeight: 44 }}>Добавить</Button>
          </Box>
        }
      >
        {dialogItem && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {addError && <Alert severity="error" onClose={() => setAddError(null)}>{addError}</Alert>}

            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', pb: '12px', borderBottom: `1px solid ${tokens.border}` }}>
              <ItemIcon src={iconUrl(dialogItem.icon_path) ?? undefined} name={dialogItem.name_ru ?? dialogItem.item_id} quality={qualityKeyFromColor(dialogItem.color)} size={38} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>{dialogItem.name_ru || dialogItem.item_id}</Typography>
                <Typography noWrap className="mono" sx={{ fontSize: fs.f11, color: tokens.text2 }}>{dialogItem.item_id}</Typography>
              </Box>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <Kick component="label">Регион</Kick>
              <RegionSelect value={region} onChange={setRegion} sx={{ width: '100%' }} />
            </Box>

            {isArtefact(dialogItem.category) && (
              <>
                <FormControl size="small" fullWidth>
                  <InputLabel>Качество</InputLabel>
                  <Select
                    value={qualityFilter ?? ''}
                    label="Качество"
                    onChange={(e) => setQualityFilter(e.target.value === '' ? null : Number(e.target.value))}
                  >
                    {QUALITY_OPTIONS.map((o) => <MenuItem key={String(o.value)} value={o.value ?? ''}>{o.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth>
                  <InputLabel>Заточка</InputLabel>
                  <Select
                    value={enchantFilter ?? ''}
                    label="Заточка"
                    onChange={(e) => setEnchantFilter(e.target.value === '' ? null : Number(e.target.value))}
                  >
                    {ENCHANT_OPTIONS.map((o) => <MenuItem key={String(o.value)} value={o.value ?? ''}>{o.label}</MenuItem>)}
                  </Select>
                </FormControl>
              </>
            )}
          </Box>
        )}
      </BottomSheet>
    </Box>
  )
}
