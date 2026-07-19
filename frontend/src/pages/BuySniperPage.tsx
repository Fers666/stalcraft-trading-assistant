import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Button, Dialog, DialogTitle, DialogContent, DialogActions,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer,
  TextField, InputAdornment, Skeleton, Alert, Chip,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import SearchIcon from '@mui/icons-material/Search'
import api from '../api/client'
import { formatPrice, iconUrl, qualityColor, qualityKeyByValue } from '../utils/i18n'
import { tokens, fs } from '../theme'
import ItemIcon from '../components/ui/ItemIcon'
import ArmDeleteButton from '../components/ui/ArmDeleteButton'
import StatusLine from '../components/ui/StatusLine'
import Kick from '../components/ui/Kick'
import { useToast } from '../components/ui/Toast'

// ─── Закупки // BUY SNIPER ───────────────────────────────────────────────────
// Снайпер выгодной покупки: пользователь задаёт порог ₽/шт по записи Избранного,
// когда самый дешёвый лот на рынке падает ≤ порога — приходит Telegram-алерт.
// Триггер-цена (current_min) читается сервером из Redis (buymin:*); подсветка
// «горит» = current_min ≤ target_price. Данные напрямую через axios, без стора.

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый',
  3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
}

interface BuyAlert {
  id: number
  watchlist_id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  region: string
  quality_filter: number | null
  enchant_filter: number | null
  target_price: number
  is_active: boolean
  current_min: number | null
  current_amount: number | null
  created_at: string
}

interface WatchlistEntry {
  id: number
  item_id: string
  name_ru: string | null
  name_en: string | null
  icon_path: string | null
  region: string
  quality_filter: number | null
  enchant_filter: number | null
}

interface PriceWindow {
  min: number | null
  median: number | null
  max: number | null
  count: number
  days: number
}

const nameOf = (e: { name_ru: string | null; name_en: string | null; item_id: string }): string =>
  e.name_ru || e.name_en || e.item_id

// .chip.mono — регион: mono, приглушённая рамка
function RegionChip({ region }: { region: string }) {
  return (
    <Box
      component="span"
      className="mono"
      sx={{
        display: 'inline-flex', alignItems: 'center',
        fontSize: fs.f11, fontWeight: 500, padding: '2px 8px',
        border: `1px solid ${tokens.borderHi}`, borderRadius: 1, color: tokens.text1,
      }}
    >
      {region}
    </Box>
  )
}

// Качество (цвет по шкале) + заточка (+N золотом)
function QualityCell({ quality, enchant }: { quality: number | null; enchant: number | null }) {
  const showEnchant = enchant != null && enchant > 0
  if (quality === null && !showEnchant) {
    return <Box component="span" sx={{ color: tokens.text2 }}>любое</Box>
  }
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      {quality !== null && (
        <Box component="span" sx={{ fontSize: fs.f11, fontWeight: 600, color: qualityColor(QLT_NAMES[quality]) ?? tokens.text2 }}>
          {QLT_NAMES[quality] ?? `кач. ${quality}`}
        </Box>
      )}
      {showEnchant && (
        <Box component="span" className="mono" sx={{ fontSize: fs.f105, fontWeight: 700, color: tokens.goldAccent }}>
          +{enchant}
        </Box>
      )}
    </Box>
  )
}

// Строка окна цен (min/медиана/max) в диалоге добавления
function PriceWindowStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Box sx={{ background: tokens.bg2, padding: '8px 10px', border: `1px solid ${tokens.border}`, borderRadius: 1, minWidth: 0 }}>
      <Box component="span" sx={{ display: 'block', fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f10, letterSpacing: '0.12em', textTransform: 'uppercase', color: tokens.text2, mb: '2px' }}>
        {label}
      </Box>
      <Box component="span" className="mono" sx={{ display: 'block', fontSize: fs.f14, fontWeight: 500, whiteSpace: 'nowrap', color: tone ?? tokens.text0 }}>
        {value}
      </Box>
    </Box>
  )
}

export default function BuySniperPage() {
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [alerts, setAlerts]   = useState<BuyAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [tgLinked, setTgLinked] = useState<boolean | null>(null)

  // Диалог добавления
  const [addOpen, setAddOpen]       = useState(false)
  const [watchlist, setWatchlist]   = useState<WatchlistEntry[]>([])
  const [selected, setSelected]     = useState<WatchlistEntry | null>(null)
  const [pw, setPw]                 = useState<PriceWindow | null>(null)
  const [pwLoading, setPwLoading]   = useState(false)
  const [addPrice, setAddPrice]     = useState('')
  const [addError, setAddError]     = useState<string | null>(null)
  const [addSearch, setAddSearch]   = useState('')

  // Диалог редактирования порога
  const [editAlert, setEditAlert]   = useState<BuyAlert | null>(null)
  const [editPrice, setEditPrice]   = useState('')
  const [editError, setEditError]   = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await api.get<BuyAlert[]>('/buy-sniper/')
      setAlerts(data)
    } catch {
      setAlerts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    api.get<{ is_linked: boolean }>('/telegram/status')
      .then(({ data }) => setTgLinked(data.is_linked))
      .catch(() => setTgLinked(null))
  }, [])

  const addedIds = useMemo(() => new Set(alerts.map((a) => a.watchlist_id)), [alerts])
  const available = useMemo(
    () => watchlist.filter((w) => !addedIds.has(w.id)),
    [watchlist, addedIds],
  )
  const availableFiltered = useMemo(() => {
    const q = addSearch.trim().toLowerCase()
    if (!q) return available
    return available.filter(
      (w) => nameOf(w).toLowerCase().includes(q) || w.item_id.toLowerCase().includes(q),
    )
  }, [available, addSearch])

  const litCount = useMemo(
    () => alerts.filter((a) => a.is_active && a.current_min != null && a.current_min <= a.target_price).length,
    [alerts],
  )

  const openAdd = async () => {
    setSelected(null)
    setPw(null)
    setAddPrice('')
    setAddError(null)
    setAddSearch('')
    setAddOpen(true)
    try {
      const { data } = await api.get<WatchlistEntry[]>('/watchlist/')
      setWatchlist(data)
    } catch {
      setWatchlist([])
    }
  }

  const selectEntry = async (entry: WatchlistEntry) => {
    setSelected(entry)
    setPw(null)
    setAddPrice('')
    setAddError(null)
    setPwLoading(true)
    try {
      const { data } = await api.get<PriceWindow>('/buy-sniper/price-window', {
        params: { watchlist_id: entry.id, days: 3 },
      })
      setPw(data)
      if (data.median != null) setAddPrice(String(Math.round(data.median)))
    } catch {
      setPw({ min: null, median: null, max: null, count: 0, days: 3 })
    } finally {
      setPwLoading(false)
    }
  }

  const handleAdd = async () => {
    if (!selected) return
    const target = Math.round(Number(addPrice))
    if (!Number.isFinite(target) || target <= 0) {
      setAddError('Укажи порог цены больше нуля')
      return
    }
    try {
      await api.post('/buy-sniper/', { watchlist_id: selected.id, target_price: target })
      setAddOpen(false)
      showToast(`«${nameOf(selected)}» добавлен в закупки`)
      load()
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (status === 409) setAddError('Эта карточка уже добавлена в закупки')
      else if (status === 403) setAddError('Раздел «Закупки» недоступен на вашем тарифе')
      else setAddError(detail || 'Ошибка добавления')
    }
  }

  const openEdit = (alert: BuyAlert) => {
    setEditAlert(alert)
    setEditPrice(String(alert.target_price))
    setEditError(null)
  }

  const handleEdit = async () => {
    if (!editAlert) return
    const target = Math.round(Number(editPrice))
    if (!Number.isFinite(target) || target <= 0) {
      setEditError('Укажи порог цены больше нуля')
      return
    }
    try {
      const { data } = await api.put<BuyAlert>(`/buy-sniper/${editAlert.id}`, { target_price: target })
      setAlerts((prev) => prev.map((a) => (a.id === editAlert.id ? { ...a, target_price: data.target_price } : a)))
      setEditAlert(null)
      showToast('Порог обновлён')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setEditError(detail || 'Ошибка сохранения')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/buy-sniper/${id}`)
      setAlerts((prev) => prev.filter((a) => a.id !== id))
      showToast('Закупка удалена')
    } catch {
      showToast('Не удалось удалить закупку')
    }
  }

  const txtHead = { textAlign: 'left' as const, fontFamily: tokens.fontUi }
  const numHead = { textAlign: 'right' as const }

  return (
    <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1, minWidth: 0 }}>
      {/* .pg-h */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '14px 18px 12px' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Kick>Закупки // Buy Sniper</Kick>
          <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
            Снайпер выгодных цен
          </Typography>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
            Задай порог ₽/шт по товарам из Избранного — как только самый дешёвый лот падает до твоей цены, придёт алерт в Telegram «пора покупать».
          </Typography>
        </Box>
        <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="contained" size="small" startIcon={<AddIcon sx={{ fontSize: 16 }} />} onClick={openAdd}>
            Добавить закупку
          </Button>
        </Box>
      </Box>

      {tgLinked === false && (
        <Box sx={{ px: '18px', pb: '4px' }}>
          <Alert severity="warning">
            Telegram не привязан — алерты о выгодной цене приходить не будут.{' '}
            <Box
              component="button"
              type="button"
              onClick={() => navigate('/app/settings')}
              sx={{ background: 'none', border: 0, p: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
            >
              Привязать в Настройках
            </Box>
          </Alert>
        </Box>
      )}

      {loading ? (
        <TableContainer>
          <Table size="small">
            <TableBody>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7} sx={{ p: '6px 10px' }}>
                    <Skeleton variant="rectangular" height={28} sx={{ bgcolor: tokens.bg2 }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : alerts.length === 0 ? (
        /* пустое состояние */
        <Box sx={{ minHeight: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', textAlign: 'center', padding: '40px' }}>
          <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.12em', textTransform: 'uppercase', color: tokens.text1 }}>
            Закупок пока нет
          </Box>
          <Box component="span" sx={{ fontSize: fs.f12, color: tokens.text2, maxWidth: '52ch' }}>
            Добавь товар из Избранного и задай цену, за которую готов купить — терминал будет следить за рынком и сообщит, когда лот подешевеет до порога.
          </Box>
          <Button variant="contained" size="small" onClick={openAdd} sx={{ mt: '4px' }}>
            Добавить первую закупку
          </Button>
        </Box>
      ) : (
        <>
          <StatusLine
            columns={2}
            metrics={[
              { label: 'Закупок', value: alerts.length.toLocaleString('ru-RU') },
              { label: 'Горит сейчас', value: litCount.toLocaleString('ru-RU'), tone: litCount > 0 ? 'gold' : 'default' },
            ]}
          />

          <TableContainer>
            <Table size="small" aria-label="Закупки">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ ...txtHead, width: '30%' }}>Товар</TableCell>
                  <TableCell sx={txtHead}>Качество / Заточка</TableCell>
                  <TableCell sx={txtHead}>Регион</TableCell>
                  <TableCell sx={numHead}>Порог /шт</TableCell>
                  <TableCell sx={numHead}>Текущая мин. /шт</TableCell>
                  <TableCell sx={txtHead}>Статус</TableCell>
                  <TableCell sx={{ width: 150 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {alerts.map((a) => {
                  const lit = a.is_active && a.current_min != null && a.current_min <= a.target_price
                  return (
                    <TableRow key={a.id}>
                      <TableCell sx={txtHead}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                          <ItemIcon
                            src={iconUrl(a.icon_path) ?? undefined}
                            name={nameOf(a)}
                            quality={qualityKeyByValue(a.quality_filter)}
                          />
                          <Box sx={{ minWidth: 0, lineHeight: 1.25 }}>
                            <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 500, color: tokens.text0 }}>
                              {nameOf(a)}
                            </Typography>
                            <Typography noWrap className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>
                              {a.item_id}
                            </Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell sx={txtHead}>
                        <QualityCell quality={a.quality_filter} enchant={a.enchant_filter} />
                      </TableCell>
                      <TableCell sx={txtHead}>
                        <RegionChip region={a.region} />
                      </TableCell>
                      <TableCell sx={{ color: tokens.goldAccent, fontWeight: 600 }}>{formatPrice(a.target_price)}</TableCell>
                      <TableCell sx={lit
                        ? { color: tokens.goldHighlight, fontWeight: 700, textShadow: `0 0 14px ${tokens.goldGlow}` }
                        : (a.current_min == null ? { color: tokens.text2 } : undefined)}>
                        {a.current_min == null ? '—' : formatPrice(a.current_min)}
                      </TableCell>
                      <TableCell sx={txtHead}>
                        {lit ? (
                          <Chip label="горит" size="small" color="primary" sx={{ height: 20 }} />
                        ) : a.is_active ? (
                          <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2 }}>ждёт цену</Box>
                        ) : (
                          <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2 }}>пауза</Box>
                        )}
                      </TableCell>
                      <TableCell sx={{ textAlign: 'right', p: '4px 10px' }}>
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={<EditIcon sx={{ fontSize: 14 }} />}
                            onClick={() => openEdit(a)}
                            sx={{ height: 28, px: '8px' }}
                          >
                            Порог
                          </Button>
                          <ArmDeleteButton
                            onConfirm={() => handleDelete(a.id)}
                            aria-label={`Удалить закупку «${nameOf(a)}»`}
                          />
                        </Box>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {/* ── Диалог добавления ─────────────────────────────────────── */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Добавить закупку</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
          {addError && <Alert severity="error" onClose={() => setAddError(null)}>{addError}</Alert>}

          {/* Выбор карточки Избранного */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <Kick component="label">Товар из Избранного</Kick>
            {selected ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '6px 9px', background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, borderRadius: 1 }}>
                <ItemIcon src={iconUrl(selected.icon_path) ?? undefined} name={nameOf(selected)} quality={qualityKeyByValue(selected.quality_filter)} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>
                    {nameOf(selected)}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center', mt: '2px' }}>
                    <QualityCell quality={selected.quality_filter} enchant={selected.enchant_filter} />
                    <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{selected.region}</Box>
                  </Box>
                </Box>
                <Button variant="outlined" size="small" onClick={() => { setSelected(null); setPw(null); setAddPrice('') }} sx={{ height: 24 }}>
                  Изменить
                </Button>
              </Box>
            ) : (
              <>
                {available.length > 0 && (
                  <TextField
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    size="small"
                    fullWidth
                    placeholder="Поиск по названию"
                    sx={{ mb: '6px' }}
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchIcon sx={{ fontSize: 16, color: tokens.text2 }} />
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                )}
                <Box sx={{ background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: 1, maxHeight: 220, overflowY: 'auto' }}>
                {available.length === 0 ? (
                  <Box sx={{ padding: '14px 10px', color: tokens.text2, fontSize: fs.f12, textAlign: 'center' }}>
                    {watchlist.length === 0
                      ? 'В Избранном пока нет товаров. Добавь их в Каталоге.'
                      : 'Все товары из Избранного уже в закупках.'}
                  </Box>
                ) : availableFiltered.length === 0 ? (
                  <Box sx={{ padding: '14px 10px', color: tokens.text2, fontSize: fs.f12, textAlign: 'center' }}>
                    По запросу «{addSearch.trim()}» ничего не найдено.
                  </Box>
                ) : (
                  availableFiltered.map((w) => (
                    <Box
                      key={w.id}
                      component="button"
                      type="button"
                      onClick={() => selectEntry(w)}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                        padding: '6px 9px', textAlign: 'left', cursor: 'pointer',
                        background: 'none', border: 0,
                        transition: `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                        '&:hover': { background: tokens.goldDim },
                      }}
                    >
                      <ItemIcon src={iconUrl(w.icon_path) ?? undefined} name={nameOf(w)} quality={qualityKeyByValue(w.quality_filter)} />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography noWrap sx={{ fontSize: fs.f125, color: tokens.text0 }}>{nameOf(w)}</Typography>
                        <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center', mt: '1px' }}>
                          <QualityCell quality={w.quality_filter} enchant={w.enchant_filter} />
                          <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{w.region}</Box>
                        </Box>
                      </Box>
                    </Box>
                  ))
                )}
                </Box>
              </>
            )}
          </Box>

          {/* Окно цен + порог — только после выбора */}
          {selected && (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <Kick>Цены продаж за 3 дня</Kick>
                {pwLoading ? (
                  <Skeleton variant="rectangular" height={52} sx={{ bgcolor: tokens.bg2 }} />
                ) : pw && pw.count > 0 ? (
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                    <PriceWindowStat label="Мин" value={formatPrice(pw.min)} />
                    <PriceWindowStat label="Медиана" value={formatPrice(pw.median != null ? Math.round(pw.median) : null)} tone={tokens.goldAccent} />
                    <PriceWindowStat label="Макс" value={formatPrice(pw.max)} />
                  </Box>
                ) : (
                  <Box sx={{ padding: '8px 10px', background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: 1, color: tokens.text2, fontSize: fs.f12 }}>
                    За последние 3 дня продаж не найдено — задай порог по своему ориентиру.
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <Kick component="label">Порог ₽/шт</Kick>
                <TextField
                  type="number"
                  value={addPrice}
                  onChange={(e) => setAddPrice(e.target.value)}
                  size="small"
                  className="mono"
                  placeholder="цена, за которую готов купить"
                  slotProps={{
                    htmlInput: { min: 1, step: 1 },
                    input: { endAdornment: <InputAdornment position="end">₽</InputAdornment> },
                  }}
                />
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setAddOpen(false)} variant="outlined" size="small">Отмена</Button>
          <Button variant="contained" size="small" onClick={handleAdd} disabled={!selected || pwLoading}>Добавить</Button>
        </DialogActions>
      </Dialog>

      {/* ── Диалог редактирования порога ──────────────────────────── */}
      <Dialog open={!!editAlert} onClose={() => setEditAlert(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Изменить порог</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
          {editError && <Alert severity="error" onClose={() => setEditError(null)}>{editError}</Alert>}
          {editAlert && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <ItemIcon src={iconUrl(editAlert.icon_path) ?? undefined} name={nameOf(editAlert)} quality={qualityKeyByValue(editAlert.quality_filter)} />
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>{nameOf(editAlert)}</Typography>
                <Box sx={{ display: 'flex', gap: '6px', alignItems: 'center', mt: '2px' }}>
                  <QualityCell quality={editAlert.quality_filter} enchant={editAlert.enchant_filter} />
                  <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{editAlert.region}</Box>
                </Box>
              </Box>
            </Box>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <Kick component="label">Порог ₽/шт</Kick>
            <TextField
              type="number"
              value={editPrice}
              onChange={(e) => setEditPrice(e.target.value)}
              size="small"
              className="mono"
              autoFocus
              slotProps={{
                htmlInput: { min: 1, step: 1 },
                input: { endAdornment: <InputAdornment position="end">₽</InputAdornment> },
              }}
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditAlert(null)} variant="outlined" size="small">Отмена</Button>
          <Button variant="contained" size="small" onClick={handleEdit}>Сохранить</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
