import { useState, useEffect, useMemo } from 'react'
import {
  Box, Typography, Button, Dialog, DialogTitle, DialogContent, DialogActions,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer,
  TextField, InputAdornment, Skeleton, Alert,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'
import { formatPrice, iconUrl, qualityKeyFromColor } from '../utils/i18n'
import { tokens, fs } from '../theme'
import { Region } from '../constants/regions'
import ItemIcon from '../components/ui/ItemIcon'
import ArmDeleteButton from '../components/ui/ArmDeleteButton'
import RegionSelect from '../components/ui/RegionSelect'
import StatusLine from '../components/ui/StatusLine'
import Kick from '../components/ui/Kick'
import { useToast } from '../components/ui/Toast'

// ─── Склад // PURCHASE LEDGER ────────────────────────────────────────────────
// Эталон: design/v5/app/inventory.html. Учёт купленного: закупка против текущей
// медианы рынка. ВАЖНО (backend-surface): медиана по произвольным предметам
// склада на клиенте недоступна — /inventory её не отдаёт, в сторах её тоже нет
// (как медиана сайдбара Избранного). Пока backend не даст surface — колонки
// «Медиана /шт», «P&L», «Текущая оценка», «P&L по складу» показывают «—», а не
// фабрикуют число. Формула на будущее: unrealized = (median − buy) × qty.

interface InventoryItem {
  id: number
  item_id: string
  region: string
  quantity: number
  avg_buy_price_per_unit: number | null
  added_at: string
}

interface ItemMeta {
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  color: string | null
}

interface SearchItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  color: string | null
}

function fmtDM(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

// .chip.mono — регион: mono, приглушённая рамка (base.css:235-242)
function RegionChip({ region }: { region: string }) {
  return (
    <Box
      component="span"
      className="mono"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: fs.f11,
        fontWeight: 500,
        padding: '2px 8px',
        border: `1px solid ${tokens.borderHi}`,
        borderRadius: 1,
        color: tokens.text1,
      }}
    >
      {region}
    </Box>
  )
}

export default function InventoryPage() {
  const { showToast } = useToast()

  const [items, setItems]   = useState<InventoryItem[]>([])
  const [meta, setMeta]     = useState<Record<string, ItemMeta>>({})
  const [loading, setLoading] = useState(true)

  // Модалка добавления
  const [open, setOpen]         = useState(false)
  const [search, setSearch]     = useState('')
  const [results, setResults]   = useState<SearchItem[]>([])
  const [selected, setSelected] = useState<SearchItem | null>(null)
  const [qty, setQty]           = useState('1')
  const [price, setPrice]       = useState('')
  const [region, setRegion]     = useState<Region>('RU')
  const [addError, setAddError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await api.get<InventoryItem[]>('/inventory')
      setItems(data)
      // обогащение метаданными (имя/иконка/качество) — /inventory их не отдаёт
      const ids = [...new Set(data.map((i) => i.item_id))]
      const entries = await Promise.all(ids.map(async (id) => {
        try {
          const { data: m } = await api.get<ItemMeta>(`/items/${id}`)
          return [id, m] as const
        } catch {
          return [id, null] as const
        }
      }))
      const map: Record<string, ItemMeta> = {}
      for (const [id, m] of entries) if (m) map[id] = m
      setMeta(map)
    } catch {
      setItems([])
      setMeta({})
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // живой поиск предметов в модалке — от 2 символов, дебаунс 250 мс
  useEffect(() => {
    if (!open) return
    const q = search.trim()
    if (q.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/items', { params: { search: q, page_size: 8 } })
        setResults(data.items)
      } catch {
        setResults([])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search, open])

  const openAdd = () => {
    setSelected(null)
    setSearch('')
    setResults([])
    setQty('1')
    setPrice('')
    setRegion('RU')
    setAddError(null)
    setOpen(true)
  }

  const handleAdd = async () => {
    if (!selected) return
    const qn = Math.round(Number(qty))
    const q = Number.isFinite(qn) && qn >= 1 ? qn : 1
    const pn = Math.round(Number(price))
    const buy = price.trim() !== '' && Number.isFinite(pn) && pn > 0 ? pn : null
    try {
      await api.post('/inventory', {
        item_id: selected.item_id,
        region,
        quantity: q,
        avg_buy_price_per_unit: buy,
      })
      setOpen(false)
      showToast(`«${selected.name_ru || selected.name_en || selected.item_id}» добавлен на склад`)
      load()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setAddError(msg || 'Ошибка добавления')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/inventory/${id}`)
      setItems((prev) => prev.filter((i) => i.id !== id))
      showToast('Позиция удалена со склада')
    } catch {
      setAddError('Не удалось удалить позицию')
    }
  }

  // Итоги: вложено считается по позициям с ценой; оценка/P&L — только при
  // наличии медианы (backend-surface), иначе «—».
  const invested = useMemo(
    () => items.reduce((s, i) => (i.avg_buy_price_per_unit != null ? s + i.avg_buy_price_per_unit * i.quantity : s), 0),
    [items],
  )

  const nameOf = (id: string): string => {
    const m = meta[id]
    return m?.name_ru || m?.name_en || id
  }

  const numHead = { textAlign: 'right' as const }
  const txtHead = { textAlign: 'left' as const, fontFamily: tokens.fontUi }
  const dim = { color: tokens.text2 }

  return (
    <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1, minWidth: 0 }}>
      {/* .pg-h */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '14px 18px 12px' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Kick>Склад // Purchase Ledger</Kick>
          <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
            Учёт купленного
          </Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
            Считай реальную прибыль: закупочная цена против текущей медианы рынка — по каждой позиции и по складу целиком.
          </Typography>
        </Box>
        <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="contained" size="small" startIcon={<AddIcon sx={{ fontSize: 16 }} />} onClick={openAdd}>
            Добавить товар
          </Button>
        </Box>
      </Box>

      {loading ? (
        <TableContainer>
          <Table size="small">
            <TableBody>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9} sx={{ p: '6px 10px' }}>
                    <Skeleton variant="rectangular" height={28} sx={{ bgcolor: tokens.bg2 }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : items.length === 0 ? (
        /* .inv-empty */
        <Box sx={{ minHeight: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', textAlign: 'center', padding: '40px' }}>
          <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.12em', textTransform: 'uppercase', color: tokens.text1 }}>
            Склад пуст
          </Box>
          <Box component="span" sx={{ fontSize: fs.f12, color: tokens.text2, maxWidth: '48ch' }}>
            Добавь купленные товары — терминал сравнит закупку с текущей медианой рынка и посчитает прибыль по каждой позиции.
          </Box>
          <Button variant="contained" size="small" onClick={openAdd} sx={{ mt: '4px' }}>
            Добавить первый товар
          </Button>
        </Box>
      ) : (
        <>
          <StatusLine
            columns={4}
            metrics={[
              { label: 'Позиций',         value: items.length.toLocaleString('ru-RU') },
              { label: 'Вложено',         value: formatPrice(invested) },
              { label: 'Текущая оценка',  value: '—', tone: 'gold' },
              { label: 'P&L по складу',   value: '—' },
            ]}
          />

          <TableContainer>
            <Table size="small" aria-label="Позиции склада">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ ...txtHead, width: '24%' }}>Товар</TableCell>
                  <TableCell sx={txtHead}>Регион</TableCell>
                  <TableCell sx={numHead}>Кол-во</TableCell>
                  <TableCell sx={numHead}>Цена покупки /шт</TableCell>
                  <TableCell sx={numHead}>Сумма</TableCell>
                  <TableCell sx={numHead}>Добавлен</TableCell>
                  <TableCell sx={numHead}>Медиана /шт</TableCell>
                  <TableCell sx={numHead}>P&L</TableCell>
                  <TableCell sx={{ width: 110 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => {
                  const m = meta[item.item_id]
                  const buy = item.avg_buy_price_per_unit
                  const sum = buy != null ? buy * item.quantity : null
                  return (
                    <TableRow key={item.id}>
                      <TableCell sx={txtHead}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                          <ItemIcon
                            src={iconUrl(m?.icon_path) ?? undefined}
                            name={nameOf(item.item_id)}
                            quality={qualityKeyFromColor(m?.color)}
                          />
                          <Box sx={{ minWidth: 0, lineHeight: 1.25 }}>
                            <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 500, color: tokens.text0 }}>
                              {nameOf(item.item_id)}
                            </Typography>
                            <Typography noWrap className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
                              {item.item_id}
                            </Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell sx={txtHead}>
                        <RegionChip region={item.region} />
                      </TableCell>
                      <TableCell>{item.quantity.toLocaleString('ru-RU')}</TableCell>
                      <TableCell sx={buy == null ? dim : undefined}>{buy == null ? '—' : formatPrice(buy)}</TableCell>
                      <TableCell sx={sum == null ? dim : undefined}>{sum == null ? '—' : formatPrice(sum)}</TableCell>
                      <TableCell sx={{ color: tokens.text2 }}>{fmtDM(item.added_at)}</TableCell>
                      <TableCell sx={dim}>—</TableCell>
                      <TableCell sx={dim}>—</TableCell>
                      <TableCell sx={{ textAlign: 'right', p: '4px 10px' }}>
                        <ArmDeleteButton
                          onConfirm={() => handleDelete(item.id)}
                          aria-label={`Удалить «${nameOf(item.item_id)}» со склада`}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {/* Диалог добавления */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Добавить на склад</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
          {addError && <Alert severity="error" onClose={() => setAddError(null)}>{addError}</Alert>}

          {/* Предмет: поиск → результаты → выбранный */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <Kick component="label">Предмет</Kick>
            {selected ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '6px 9px', background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, borderRadius: 1 }}>
                <ItemIcon
                  src={iconUrl(selected.icon_path) ?? undefined}
                  name={selected.name_ru || selected.name_en || selected.item_id}
                  quality={qualityKeyFromColor(selected.color)}
                />
                <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>
                  {selected.name_ru || selected.name_en || selected.item_id}
                </Typography>
                <Button variant="outlined" size="small" onClick={() => { setSelected(null); setResults([]) }} sx={{ height: 24 }}>
                  Изменить
                </Button>
              </Box>
            ) : (
              <>
                <TextField
                  placeholder="Поиск по названию — от 2 символов…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  size="small"
                  type="search"
                  autoFocus
                  fullWidth
                  slotProps={{
                    input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> },
                  }}
                />
                {search.trim().length >= 2 && (
                  <Box sx={{ mt: '2px', background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: 1, maxHeight: 196, overflowY: 'auto' }}>
                    {results.length === 0 ? (
                      <Box sx={{ padding: '10px', color: tokens.text2, fontSize: fs.f12, textAlign: 'center' }}>
                        Ничего не найдено по запросу «{search.trim()}»
                      </Box>
                    ) : (
                      results.map((r) => (
                        <Box
                          key={r.item_id}
                          component="button"
                          type="button"
                          onClick={() => { setSelected(r); setResults([]) }}
                          sx={{
                            display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                            padding: '6px 9px', textAlign: 'left', cursor: 'pointer',
                            background: 'none', border: 0,
                            transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                            '&:hover': { background: tokens.goldDim },
                          }}
                        >
                          <ItemIcon
                            src={iconUrl(r.icon_path) ?? undefined}
                            name={r.name_ru || r.name_en || r.item_id}
                            quality={qualityKeyFromColor(r.color)}
                          />
                          <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: fs.f125, color: tokens.text0 }}>
                            {r.name_ru || r.name_en || r.item_id}
                          </Typography>
                          <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
                            {r.item_id}
                          </Box>
                        </Box>
                      ))
                    )}
                  </Box>
                )}
              </>
            )}
          </Box>

          {/* Количество + цена — 2 колонки */}
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <Kick component="label">Количество</Kick>
              <TextField
                type="number"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                size="small"
                className="mono"
                slotProps={{ htmlInput: { min: 1, step: 1 } }}
              />
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <Kick component="label">Цена покупки /шт</Kick>
              <TextField
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                size="small"
                className="mono"
                placeholder="для расчёта P&L"
                slotProps={{ htmlInput: { min: 0 } }}
              />
            </Box>
          </Box>

          {/* Регион — только RegionSelect (FORM-01) */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <Kick component="label">Регион</Kick>
            <RegionSelect value={region} onChange={setRegion} sx={{ width: '100%' }} />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setOpen(false)} variant="outlined" size="small">Отмена</Button>
          <Button variant="contained" size="small" onClick={handleAdd} disabled={!selected}>Добавить</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
