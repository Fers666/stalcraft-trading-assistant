import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Box, Typography, TextField, InputAdornment, Button,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  MenuItem, Select, FormControl, InputLabel, Alert, Dialog, DialogTitle,
  DialogContent, DialogActions, Skeleton, Tooltip,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'
import { translateCategory, iconUrl, qualityKeyFromColor } from '../utils/i18n'
import { CATEGORY_TREE } from '../utils/categories'
import { useFeedStore } from '../store/feedStore'
import { tokens, fs } from '../theme'
import { Region } from '../constants/regions'
import CategoryTree from '../components/ui/CategoryTree'
import QualityChip from '../components/ui/QualityChip'
import RegionSelect from '../components/ui/RegionSelect'
import ItemIcon from '../components/ui/ItemIcon'
import Kick from '../components/ui/Kick'
import StatusLine from '../components/ui/StatusLine'
import Pager from '../components/ui/Pager'
import { useToast } from '../components/ui/Toast'

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

// Quality/enchant фильтры имеют смысл только для артефактов — у них additional.qlt/ptn
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

// Иконка-закладка (stroke) — эталон catalog.html BM_ADD / BM_OK
const BookmarkAdd = () => (
  <Box component="svg" width="13" height="15" viewBox="0 0 12 14" fill="none" aria-hidden="true" sx={{ display: 'block' }}>
    <path d="M2 1.5h8a.5.5 0 0 1 .5.5v10.6L6 9.6l-4.5 3V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6 3.8v3M4.5 5.3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Box>
)
const BookmarkOk = () => (
  <Box component="svg" width="13" height="15" viewBox="0 0 12 14" fill="none" aria-hidden="true" sx={{ display: 'block' }}>
    <path d="M2 1.5h8a.5.5 0 0 1 .5.5v10.6L6 9.6l-4.5 3V2a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="m3.9 5.4 1.6 1.6 2.8-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Box>
)

export default function CatalogPage() {
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

  // Диалог добавления в watchlist
  const [dialogItem, setDialogItem]       = useState<Item | null>(null)
  const [region, setRegion]               = useState<Region>('RU')
  const [qualityFilter, setQualityFilter] = useState<number | null>(null)
  const [enchantFilter, setEnchantFilter] = useState<number | null>(null)
  const [adding, setAdding]               = useState(false)
  const [addError, setAddError]           = useState<string | null>(null)

  // Предметы, уже отслеживаемые (по item_id): из избранного + добавленные в сессии
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

  const handleSearch = () => {
    setPage(1)
    setActiveSearch(search)
  }

  const handleReset = () => { setSearch(''); setActiveSearch(''); setPage(1) }

  const handleCategorySelect = (cat: string | null) => {
    setCategory(cat)
    setPage(1)
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
  const tcellText = { textAlign: 'left', fontFamily: tokens.fontUi } as const

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
      <CategoryTree selected={category} onSelect={handleCategorySelect} ariaLabel="Категории каталога" />

      {/* .panel */}
      <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1, minWidth: 0 }}>
        {/* .pg-h */}
        <Box sx={{ padding: '14px 18px 12px' }}>
          <Kick>Каталог // Item Database</Kick>
          <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
            Каталог предметов
          </Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
            База предметов аукциона STALZONE: поиск по имени, фильтр по категории, добавление в избранное для отслеживания цен.
          </Typography>
        </Box>

        {/* .toolrow */}
        <Box sx={{ display: 'flex', gap: '8px', padding: '0 18px 14px' }}>
          <TextField
            placeholder="Поиск по названию или английскому имени…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            size="small"
            type="search"
            sx={{ flex: 1, minWidth: 0 }}
            slotProps={{
              input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> },
            }}
          />
          <Button variant="contained" size="small" onClick={handleSearch} disabled={loading}>Найти</Button>
          {activeSearch && <Button variant="outlined" size="small" onClick={handleReset}>Сбросить</Button>}
        </Box>

        {/* .statusline */}
        <StatusLine
          columns={4}
          metrics={[
            { label: 'Найдено',   value: total.toLocaleString('ru-RU'), tone: 'gold' },
            { label: 'Категория', value: categoryLabel(category) },
            { label: 'Поиск',     value: activeSearch ? `«${activeSearch}»` : '—' },
            { label: 'Страница',  value: `${page} / ${totalPages}` },
          ]}
        />

        {error && <Alert severity="error" sx={{ m: '12px 18px' }} onClose={() => setError(null)}>{error}</Alert>}

        {/* Таблица */}
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ ...tcellText, width: '37%' }}>Название</TableCell>
                <TableCell sx={tcellText}>Категория</TableCell>
                <TableCell sx={tcellText}>Качество</TableCell>
                <TableCell sx={tcellText}>Пачки</TableCell>
                <TableCell sx={{ width: 56 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5} sx={{ p: '6px 10px' }}>
                      <Skeleton variant="rectangular" height={28} sx={{ bgcolor: tokens.bg2 }} />
                    </TableCell>
                  </TableRow>
                ))
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} sx={{ textAlign: 'center', fontFamily: tokens.fontUi, color: tokens.text2, py: '22px' }}>
                    {activeSearch
                      ? <>Ничего не найдено по запросу «{activeSearch}»{category ? ` в категории «${categoryLabel(category)}»` : ''}.</>
                      : <>В категории «{categoryLabel(category)}» пока нет предметов.</>}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => {
                  const added = addedIds.has(item.item_id)
                  return (
                    <TableRow key={item.id} hover>
                      <TableCell sx={tcellText}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                          <ItemIcon
                            src={iconUrl(item.icon_path) ?? undefined}
                            name={item.name_ru ?? item.name_en ?? item.item_id}
                            quality={qualityKeyFromColor(item.color)}
                          />
                          <Box sx={{ minWidth: 0, lineHeight: 1.25 }}>
                            <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 500, color: tokens.text0 }}>
                              {item.name_ru || item.name_en}
                            </Typography>
                            {item.name_en && item.name_ru && (
                              <Typography noWrap sx={{ fontSize: fs.f105, color: tokens.text2 }}>{item.name_en}</Typography>
                            )}
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ ...tcellText, fontSize: fs.f11, color: tokens.text2 }}>
                        {translateCategory(item.category)}
                      </TableCell>
                      <TableCell sx={tcellText}>
                        {item.quality_name
                          ? <QualityChip color={qualityKeyFromColor(item.color)} label={item.quality_name} />
                          : <Box component="span" sx={{ color: tokens.text2 }}>—</Box>}
                      </TableCell>
                      <TableCell sx={{ ...tcellText, color: item.can_be_batch_traded ? tokens.text0 : tokens.text2 }}>
                        {item.can_be_batch_traded ? 'да' : '—'}
                      </TableCell>
                      <TableCell sx={{ textAlign: 'right', p: '4px 10px' }}>
                        <Tooltip title={added ? 'Уже отслеживается — добавить ещё вариант' : 'В избранное'}>
                          <Box
                            component="button"
                            type="button"
                            aria-label={added ? 'Уже отслеживается — добавить ещё вариант' : 'В избранное'}
                            onClick={() => openDialog(item)}
                            sx={{
                              width: 30, height: 30, display: 'inline-grid', placeItems: 'center',
                              background: 'none', border: '1px solid transparent', borderRadius: 1, cursor: 'pointer',
                              color: added ? tokens.goldAccent : tokens.text2,
                              transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                              '&:hover': { color: tokens.goldAccent, background: tokens.bg2, borderColor: tokens.borderHi },
                            }}
                          >
                            {added ? <BookmarkOk /> : <BookmarkAdd />}
                          </Box>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {!loading && items.length > 0 && (
          <Pager
            page={page}
            count={totalPages}
            onChange={(p) => {
              setPage(p)
              window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
            }}
          />
        )}
      </Box>

      {/* Диалог добавления в watchlist */}
      <Dialog open={!!dialogItem} onClose={() => setDialogItem(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Box component="span">{dialogItem?.name_ru || dialogItem?.item_id}</Box>
            <Box component="span" className="mono" sx={{ fontSize: fs.f11, color: tokens.text2, fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
              {dialogItem?.item_id}
            </Box>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
          {addError && <Alert severity="error" onClose={() => setAddError(null)}>{addError}</Alert>}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <Kick component="label">Регион</Kick>
            <RegionSelect value={region} onChange={setRegion} sx={{ width: '100%' }} />
          </Box>

          {/* Quality/enchant — только для артефактов */}
          {isArtefact(dialogItem?.category ?? null) && (
            <>
              <FormControl size="small" fullWidth>
                <InputLabel>Качество</InputLabel>
                <Select
                  value={qualityFilter ?? ''}
                  label="Качество"
                  onChange={(e) => setQualityFilter(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {QUALITY_OPTIONS.map((o) => (
                    <MenuItem key={String(o.value)} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size="small" fullWidth>
                <InputLabel>Заточка</InputLabel>
                <Select
                  value={enchantFilter ?? ''}
                  label="Заточка"
                  onChange={(e) => setEnchantFilter(e.target.value === '' ? null : Number(e.target.value))}
                >
                  {ENCHANT_OPTIONS.map((o) => (
                    <MenuItem key={String(o.value)} value={o.value ?? ''}>{o.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogItem(null)} variant="outlined" size="small">Отмена</Button>
          <Button variant="contained" size="small" onClick={handleAdd} disabled={adding}>Добавить</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
