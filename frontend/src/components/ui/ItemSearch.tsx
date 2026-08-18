/**
 * Поиск предмета по каталогу — общий инпут фильтров «Ленты»
 * (десктоп + мобильный шит).
 *
 * Набор ленты расширен со 103 артефактов до 382 предметов
 * (docs/tasks/feed-gear-expansion.md), и выпадающий список стал непригоден:
 * пролистать 382 позиции глазами нельзя. Предмет выбирается поиском — тем же
 * способом, что на странице «Лоты» (GET /items?search=…, LotsPage.tsx).
 *
 * Ищем по ВСЕМУ каталогу, а не по items из /feed/filters: пользователь ищет то,
 * что помнит по названию, и «по этому предмету выгодных лотов сейчас нет» —
 * честный ответ, а молчащие подсказки читались бы как поломка поиска. Сколько
 * у предмета выгодных лотов, видно в подсказке до выбора (lotsCount).
 */
import { useEffect, useRef, useState } from 'react'
import {
  Box, TextField, Paper, List, ListItem, ListItemButton, ListItemText,
  Typography, InputAdornment, IconButton, ClickAwayListener, SxProps, Theme,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import CloseIcon from '@mui/icons-material/Close'

import api from '../../api/client'
import { tokens, fs } from '../../theme'
import { iconUrl, translateCategory } from '../../utils/i18n'
import ItemIcon from './ItemIcon'

export interface SearchItem {
  item_id: string
  name_ru: string | null
  name_en: string | null
  category: string | null
  icon_path: string | null
}

export interface ItemSearchProps {
  /** Выбранный предмет или null («любой предмет»). */
  value: SearchItem | null
  onChange: (item: SearchItem | null) => void
  /** Сколько выгодных лотов у предмета сейчас (из /feed/filters). */
  lotsCount?: (itemId: string) => number | undefined
  placeholder?: string
  fullWidth?: boolean
  sx?: SxProps<Theme>
}

const MIN_CHARS = 2
/** Пауза перед запросом: поиск дёргается на каждую букву, а /items — сеть. */
const DEBOUNCE_MS = 250

const itemName = (it: SearchItem): string => it.name_ru ?? it.name_en ?? it.item_id

export default function ItemSearch({
  value, onChange, lotsCount, placeholder = 'Найти предмет — от 2 символов…',
  fullWidth, sx,
}: ItemSearchProps) {
  const [query, setQuery] = useState(value ? itemName(value) : '')
  const [suggestions, setSuggestions] = useState<SearchItem[]>([])
  const [open, setOpen] = useState(false)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Счётчик запросов: ответы приходят вразнобой, и без него подсказки могли бы
  // залипнуть от предыдущей, более медленной буквы.
  const reqRef = useRef(0)
  // Последнее значение, которое отправили НАВЕРХ мы сами. Без него синхронизация
  // с value стирала бы набранный текст: правка снимает выбор (onChange(null)),
  // и эффект тут же затирал бы поле.
  const emittedRef = useRef<SearchItem | null>(value)

  // Внешний сброс (выбор группы, чип «Все») обязан очищать и текст: иначе в
  // поле остаётся имя предмета, который уже не фильтрует.
  useEffect(() => {
    if (value === emittedRef.current) return
    emittedRef.current = value
    setSuggestions([])
    setQuery(value ? itemName(value) : '')
  }, [value])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const runSearch = (text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (text.trim().length < MIN_CHARS) { setSuggestions([]); return }
    const seq = ++reqRef.current
    timerRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get('/items', {
          params: { search: text.trim(), page_size: 8 },
        })
        if (seq === reqRef.current) { setSuggestions(data.items ?? []); setOpen(true) }
      } catch {
        if (seq === reqRef.current) setSuggestions([])
      }
    }, DEBOUNCE_MS)
  }

  const emit = (next: SearchItem | null) => {
    emittedRef.current = next
    onChange(next)
  }

  const onType = (text: string) => {
    setQuery(text)
    // Правка текста снимает выбор: показанные строки обязаны соответствовать
    // тому, что написано в поле.
    if (value !== null) emit(null)
    runSearch(text)
  }

  const select = (item: SearchItem) => {
    setSuggestions([])
    setOpen(false)
    setQuery(itemName(item))
    emit(item)
  }

  const clear = () => {
    setSuggestions([])
    setOpen(false)
    setQuery('')
    emit(null)
  }

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={[{ position: 'relative', minWidth: 0 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>
        <TextField
          size="small"
          fullWidth={fullWidth}
          value={query}
          placeholder={placeholder}
          onChange={e => onType(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'Escape') { setOpen(false); return }
            if (e.key === 'Enter' && open && suggestions.length > 0) select(suggestions[0])
          }}
          slotProps={{
            htmlInput: { 'aria-label': 'Поиск предмета в ленте' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 15, color: tokens.text2 }} />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small" onClick={clear} aria-label="Сбросить предмет"
                    sx={{ color: tokens.text2, '&:hover': { color: tokens.gold, bgcolor: 'transparent' } }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{
            '& .MuiInputBase-root': { bgcolor: tokens.bg2, fontSize: fs.f12 },
            '& .MuiOutlinedInput-notchedOutline': { borderColor: tokens.border },
          }}
        />
        {open && suggestions.length > 0 && (
          <Paper sx={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            zIndex: tokens.z.tooltip,
            background: tokens.bg3, border: `1px solid ${tokens.borderHi}`,
          }}>
            <List dense disablePadding>
              {suggestions.map(item => {
                const count = lotsCount?.(item.item_id)
                return (
                  <ListItem key={item.item_id} disablePadding>
                    <ListItemButton onClick={() => select(item)} sx={{ gap: '9px' }}>
                      <ItemIcon src={iconUrl(item.icon_path) ?? undefined} name={itemName(item)} size={22} />
                      <ListItemText
                        primary={
                          <Typography sx={{ fontSize: fs.f125, color: tokens.text0 }} noWrap>
                            {itemName(item)}
                          </Typography>
                        }
                        secondary={
                          <Typography
                            className="mono" noWrap
                            sx={{ fontSize: fs.f105, color: count ? tokens.success : tokens.text2 }}
                          >
                            {translateCategory(item.category)}
                            {count ? ` · ${count} выгодных лотов` : ' · выгодных лотов нет'}
                          </Typography>
                        }
                      />
                    </ListItemButton>
                  </ListItem>
                )
              })}
            </List>
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  )
}
