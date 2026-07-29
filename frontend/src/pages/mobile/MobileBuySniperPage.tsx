import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Button, TextField, InputAdornment, Skeleton, Alert,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import SearchIcon from '@mui/icons-material/Search'
import api from '../../api/client'
import { formatPrice, iconUrl, qualityKeyByValue } from '../../utils/i18n'
import { tokens, fs } from '../../theme'
import ItemIcon from '../../components/ui/ItemIcon'
import QualityChip from '../../components/ui/QualityChip'
import ArmDeleteButton from '../../components/ui/ArmDeleteButton'
import Kick from '../../components/ui/Kick'
import { useToast } from '../../components/ui/Toast'
import BottomSheet from '../../components/mobile/BottomSheet'
import DCard from '../../components/mobile/ui/DCard'
import StatusGrid from '../../components/mobile/ui/StatusGrid'

// Закупки (мобайл) — тот же дата-слой, что десктопный BuySniperPage (api /buy-sniper
// GET/POST/PUT/DELETE, /buy-sniper/price-window, /watchlist, /telegram/status).
// Таблица → .dcard (подсветка «горит»); добавление/редактирование порога →
// BottomSheet; StatusLine → StatusGrid.

const QLT_NAMES: Record<number, string> = {
  0: 'Обычный', 1: 'Необычный', 2: 'Особый', 3: 'Ветеран', 4: 'Мастер', 5: 'Легендарный',
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

// Качество+заточка как набор чипов
function QualityChips({ quality, enchant }: { quality: number | null; enchant: number | null }) {
  const showEnchant = enchant != null && enchant > 0
  return (
    <>
      {quality !== null && <QualityChip color={qualityKeyByValue(quality)} label={QLT_NAMES[quality] ?? `кач. ${quality}`} />}
      {showEnchant && (
        <Box component="span" className="mono" sx={{ fontSize: fs.f105, fontWeight: 700, color: tokens.goldAccent, background: tokens.goldDim, px: '5px', borderRadius: '2px' }}>+{enchant}</Box>
      )}
    </>
  )
}

export default function MobileBuySniperPage() {
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [alerts, setAlerts]     = useState<BuyAlert[]>([])
  const [loading, setLoading]   = useState(true)
  const [tgLinked, setTgLinked] = useState<boolean | null>(null)

  // Шит добавления
  const [addOpen, setAddOpen]     = useState(false)
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [selected, setSelected]   = useState<WatchlistEntry | null>(null)
  const [pw, setPw]               = useState<PriceWindow | null>(null)
  const [pwLoading, setPwLoading] = useState(false)
  const [addPrice, setAddPrice]   = useState('')
  const [addError, setAddError]   = useState<string | null>(null)
  const [addSearch, setAddSearch] = useState('')

  // Шит редактирования порога
  const [editAlert, setEditAlert] = useState<BuyAlert | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editError, setEditError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await api.get<BuyAlert[]>('/buy-sniper/')
      setAlerts(data)
    } catch { setAlerts([]) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    api.get<{ is_linked: boolean }>('/telegram/status')
      .then(({ data }) => setTgLinked(data.is_linked))
      .catch(() => setTgLinked(null))
  }, [])

  const addedIds = useMemo(() => new Set(alerts.map((a) => a.watchlist_id)), [alerts])
  const available = useMemo(() => watchlist.filter((w) => !addedIds.has(w.id)), [watchlist, addedIds])
  const availableFiltered = useMemo(() => {
    const q = addSearch.trim().toLowerCase()
    if (!q) return available
    return available.filter((w) => nameOf(w).toLowerCase().includes(q) || w.item_id.toLowerCase().includes(q))
  }, [available, addSearch])

  const litCount = useMemo(
    () => alerts.filter((a) => a.is_active && a.current_min != null && a.current_min <= a.target_price).length,
    [alerts],
  )

  const openAdd = async () => {
    setSelected(null); setPw(null); setAddPrice(''); setAddError(null); setAddSearch('')
    setAddOpen(true)
    try {
      const { data } = await api.get<WatchlistEntry[]>('/watchlist/')
      setWatchlist(data)
    } catch { setWatchlist([]) }
  }

  const selectEntry = async (entry: WatchlistEntry) => {
    setSelected(entry); setPw(null); setAddPrice(''); setAddError(null); setPwLoading(true)
    try {
      const { data } = await api.get<PriceWindow>('/buy-sniper/price-window', { params: { watchlist_id: entry.id, days: 3 } })
      setPw(data)
      if (data.median != null) setAddPrice(String(Math.round(data.median)))
    } catch { setPw({ min: null, median: null, max: null, count: 0, days: 3 }) }
    finally { setPwLoading(false) }
  }

  const handleAdd = async () => {
    if (!selected) return
    const target = Math.round(Number(addPrice))
    if (!Number.isFinite(target) || target <= 0) { setAddError('Укажи порог цены больше нуля'); return }
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

  const openEdit = (alert: BuyAlert) => { setEditAlert(alert); setEditPrice(String(alert.target_price)); setEditError(null) }

  const handleEdit = async () => {
    if (!editAlert) return
    const target = Math.round(Number(editPrice))
    if (!Number.isFinite(target) || target <= 0) { setEditError('Укажи порог цены больше нуля'); return }
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
    } catch { showToast('Не удалось удалить закупку') }
  }

  return (
    <Box>
      {/* .pg-h */}
      <Box sx={{ pb: '12px' }}>
        <Kick>Закупки // Buy Sniper</Kick>
        <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.04em', mt: '4px' }}>
          Снайпер выгодных цен
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', lineHeight: 1.5 }}>
          Задай порог ₽/шт по товарам из Избранного — как только самый дешёвый лот падает до твоей цены, придёт алерт в Telegram «пора покупать».
        </Typography>
        <Button variant="contained" fullWidth startIcon={<AddIcon sx={{ fontSize: 16 }} />} onClick={openAdd} sx={{ mt: '12px', minHeight: 44 }}>
          Добавить закупку
        </Button>
      </Box>

      {tgLinked === false && (
        <Alert severity="warning" sx={{ mb: '10px' }}>
          Telegram не привязан — алерты о выгодной цене приходить не будут.{' '}
          <Box component="button" type="button" onClick={() => navigate('/app/settings')} sx={{ background: 'none', border: 0, p: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
            Привязать в Настройках
          </Box>
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} variant="rectangular" height={120} sx={{ bgcolor: tokens.bg2 }} />)}
        </Box>
      ) : alerts.length === 0 ? (
        <Box sx={{ minHeight: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', textAlign: 'center', p: '32px 20px' }}>
          <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.1em', textTransform: 'uppercase', color: tokens.text1 }}>
            Закупок пока нет
          </Box>
          <Typography sx={{ fontSize: fs.f12, color: tokens.text2, maxWidth: '46ch', lineHeight: 1.5 }}>
            Добавь товар из Избранного и задай цену, за которую готов купить — терминал сообщит, когда лот подешевеет до порога.
          </Typography>
          <Button variant="contained" onClick={openAdd} sx={{ mt: '4px', minHeight: 44 }}>Добавить первую закупку</Button>
        </Box>
      ) : (
        <>
          <StatusGrid
            cols={2}
            sx={{ mb: '10px' }}
            items={[
              { k: 'Закупок',     v: alerts.length.toLocaleString('ru-RU') },
              { k: 'Горит сейчас', v: litCount.toLocaleString('ru-RU'), tone: litCount > 0 ? 'gold' : 'default' },
            ]}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {alerts.map((a) => {
              const lit = a.is_active && a.current_min != null && a.current_min <= a.target_price
              return (
                <DCard
                  key={a.id}
                  lit={lit}
                  icon={<ItemIcon src={iconUrl(a.icon_path) ?? undefined} name={nameOf(a)} quality={qualityKeyByValue(a.quality_filter)} size={32} />}
                  name={nameOf(a)}
                  sub={a.item_id}
                  chips={
                    <>
                      <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text1, border: `1px solid ${tokens.borderHi}`, px: '6px', borderRadius: '2px' }}>{a.region}</Box>
                      <QualityChips quality={a.quality_filter} enchant={a.enchant_filter} />
                      {lit ? (
                        <Box component="span" sx={{ fontFamily: tokens.fontHead, fontSize: fs.f10, fontWeight: 700, letterSpacing: '0.06em', color: tokens.goldAccent, background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, px: '6px', borderRadius: '2px' }}>ГОРИТ</Box>
                      ) : (
                        <Box component="span" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{a.is_active ? 'ждёт цену' : 'пауза'}</Box>
                      )}
                    </>
                  }
                  kv={[
                    { label: 'Порог /шт', value: formatPrice(a.target_price), tone: 'gold' },
                    { label: 'Текущая мин. /шт', value: a.current_min == null ? '—' : formatPrice(a.current_min), tone: lit ? 'gold' : a.current_min == null ? 'dim' : 'default' },
                  ]}
                  footer={
                    <>
                      <Button variant="outlined" startIcon={<EditIcon sx={{ fontSize: 14 }} />} onClick={() => openEdit(a)} sx={{ minHeight: 40 }}>Порог</Button>
                      <ArmDeleteButton onConfirm={() => handleDelete(a.id)} aria-label={`Удалить закупку «${nameOf(a)}»`} sx={{ minHeight: 40, justifyContent: 'center' }} />
                    </>
                  }
                />
              )
            })}
          </Box>
        </>
      )}

      {/* Шит добавления */}
      <BottomSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Добавить закупку"
        footer={selected ? (
          <Box sx={{ display: 'flex', gap: '8px', '& > *': { flex: 1 } }}>
            <Button variant="outlined" onClick={() => setAddOpen(false)} sx={{ minHeight: 44 }}>Отмена</Button>
            <Button variant="contained" onClick={handleAdd} disabled={pwLoading} sx={{ minHeight: 44 }}>Добавить</Button>
          </Box>
        ) : undefined}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {addError && <Alert severity="error" onClose={() => setAddError(null)}>{addError}</Alert>}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <Kick component="label">Товар из Избранного</Kick>
            {selected ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px', p: '8px 10px', background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, borderRadius: '2px' }}>
                <ItemIcon src={iconUrl(selected.icon_path) ?? undefined} name={nameOf(selected)} quality={qualityKeyByValue(selected.quality_filter)} size={36} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>{nameOf(selected)}</Typography>
                  <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{selected.region}</Box>
                </Box>
                <Button variant="outlined" size="small" onClick={() => { setSelected(null); setPw(null); setAddPrice('') }} sx={{ minHeight: 36 }}>Изменить</Button>
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
                    slotProps={{ input: { sx: { fontSize: '16px' }, startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 16, color: tokens.text2 }} /></InputAdornment> } }}
                  />
                )}
                <Box sx={{ background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: '2px', maxHeight: '44vh', overflowY: 'auto' }}>
                  {available.length === 0 ? (
                    <Box sx={{ p: '14px 12px', color: tokens.text2, fontSize: fs.f12, textAlign: 'center' }}>
                      {watchlist.length === 0 ? 'В Избранном пока нет товаров. Добавь их в Каталоге.' : 'Все товары из Избранного уже в закупках.'}
                    </Box>
                  ) : availableFiltered.length === 0 ? (
                    <Box sx={{ p: '14px 12px', color: tokens.text2, fontSize: fs.f12, textAlign: 'center' }}>По запросу «{addSearch.trim()}» ничего не найдено.</Box>
                  ) : (
                    availableFiltered.map((w) => (
                      <Box
                        key={w.id}
                        component="button"
                        type="button"
                        onClick={() => selectEntry(w)}
                        sx={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', minHeight: 48, p: '8px 10px', textAlign: 'left', cursor: 'pointer', background: 'none', border: 0, borderBottom: `1px solid ${tokens.border}`, '&:active': { background: tokens.goldDim } }}
                      >
                        <ItemIcon src={iconUrl(w.icon_path) ?? undefined} name={nameOf(w)} quality={qualityKeyByValue(w.quality_filter)} size={34} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography noWrap sx={{ fontSize: fs.f125, color: tokens.text0 }}>{nameOf(w)}</Typography>
                          <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{w.region}</Box>
                        </Box>
                      </Box>
                    ))
                  )}
                </Box>
              </>
            )}
          </Box>

          {selected && (
            <>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <Kick>Цены продаж за 3 дня</Kick>
                {pwLoading ? (
                  <Skeleton variant="rectangular" height={56} sx={{ bgcolor: tokens.bg2 }} />
                ) : pw && pw.count > 0 ? (
                  <StatusGrid
                    cols={3}
                    items={[
                      { k: 'Мин',    v: formatPrice(pw.min) },
                      { k: 'Медиана', v: formatPrice(pw.median != null ? Math.round(pw.median) : null), tone: 'gold' },
                      { k: 'Макс',   v: formatPrice(pw.max) },
                    ]}
                  />
                ) : (
                  <Box sx={{ p: '8px 10px', background: tokens.bg2, border: `1px solid ${tokens.border}`, borderRadius: '2px', color: tokens.text2, fontSize: fs.f12 }}>
                    За последние 3 дня продаж не найдено — задай порог по своему ориентиру.
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <Kick component="label">Порог ₽/шт</Kick>
                <TextField
                  type="number"
                  value={addPrice}
                  onChange={(e) => setAddPrice(e.target.value)}
                  size="small"
                  className="mono"
                  placeholder="цена, за которую готов купить"
                  slotProps={{ htmlInput: { min: 1, step: 1 }, input: { sx: { fontSize: '16px' }, endAdornment: <InputAdornment position="end">₽</InputAdornment> } }}
                />
              </Box>
            </>
          )}
        </Box>
      </BottomSheet>

      {/* Шит редактирования */}
      <BottomSheet
        open={!!editAlert}
        onClose={() => setEditAlert(null)}
        title="Изменить порог"
        footer={
          <Box sx={{ display: 'flex', gap: '8px', '& > *': { flex: 1 } }}>
            <Button variant="outlined" onClick={() => setEditAlert(null)} sx={{ minHeight: 44 }}>Отмена</Button>
            <Button variant="contained" onClick={handleEdit} sx={{ minHeight: 44 }}>Сохранить</Button>
          </Box>
        }
      >
        {editAlert && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {editError && <Alert severity="error" onClose={() => setEditError(null)}>{editError}</Alert>}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
              <ItemIcon src={iconUrl(editAlert.icon_path) ?? undefined} name={nameOf(editAlert)} quality={qualityKeyByValue(editAlert.quality_filter)} size={38} />
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: fs.f125, fontWeight: 600, color: tokens.text0 }}>{nameOf(editAlert)}</Typography>
                <Box component="span" className="mono" sx={{ fontSize: fs.f105, color: tokens.text2 }}>{editAlert.region}</Box>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <Kick component="label">Порог ₽/шт</Kick>
              <TextField
                type="number"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
                size="small"
                className="mono"
                slotProps={{ htmlInput: { min: 1, step: 1 }, input: { sx: { fontSize: '16px' }, endAdornment: <InputAdornment position="end">₽</InputAdornment> } }}
              />
            </Box>
          </Box>
        )}
      </BottomSheet>
    </Box>
  )
}
