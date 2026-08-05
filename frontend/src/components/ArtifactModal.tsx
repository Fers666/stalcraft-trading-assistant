/**
 * Карточка артефакта из «Ленты» — read-only обозреватель варианта
 * «предмет × качество × заточка».
 *
 * Содержимое переиспользует карточку «Избранного» (LotStatCard / мобильный
 * MobileLotStatCard): оба уже развязаны от watchlist-записи и принимают
 * itemId/region/qualityFilter/enchantFilter. Предмет из ленты у пользователя
 * не отслеживается, поэтому «выгодные лоты» питаются из /feed/lots
 * (signalsSource='feed') — watchlist-сигналы для него всегда пусты.
 *
 * Модалка допущена дизайн-контрактом по исключению для read-only
 * карточки-обозревателя (design/v5/DIRECTION.md §4): ничего не меняет,
 * то же содержимое доступно на странице предмета, закрывается по ESC и
 * клику вне, возвращает фокус на строку-источник.
 */
import { Dialog, IconButton, Box } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'

import { tokens, fs } from '../theme'
import { useLayoutMode } from '../hooks/useLayoutMode'
import type { FeedLot } from '../api/feed'
import LotStatCard from './LotStatCard'
import MobileLotStatCard from './mobile/MobileLotStatCard'
import BottomSheet from './mobile/BottomSheet'

export interface ArtifactModalProps {
  open: boolean
  lot: FeedLot
  onClose: () => void
  onViewLots?: () => void
}

export default function ArtifactModal({ open, lot, onClose, onViewLots }: ArtifactModalProps) {
  const { mode } = useLayoutMode()
  const itemName = lot.name_ru ?? lot.name_en ?? lot.item_id

  const shared = {
    itemId: lot.item_id,
    region: lot.region,
    qualityFilter: lot.qlt,
    enchantFilter: lot.ptn,
    itemName,
    // Сырой путь: iconUrl применяют сами карточки, повторное применение сломало бы URL.
    iconPath: lot.icon_path,
  }

  if (mode === 'mobile') {
    return (
      <BottomSheet open={open} onClose={onClose} title={itemName}>
        {/* Кикер — тот же, что в десктопной модалке: источник карточки
            («Лента», а не «Избранное») должен читаться и в шите. */}
        <MobileLotStatCard {...shared} kicker={`Лента · ${lot.region}`} signalsSource="feed" />
      </BottomSheet>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      scroll="body"
      aria-label={`Карточка артефакта ${itemName}`}
      PaperProps={{
        sx: {
          bgcolor: tokens.bg1,
          border: `1px solid ${tokens.borderHi}`,
          borderTop: `2px solid ${tokens.gold}`,
          borderRadius: `${tokens.radiusLg}px`,
          backgroundImage: 'none',
        },
      }}
    >
      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        p: '10px 14px', borderBottom: `1px solid ${tokens.border}`,
      }}>
        <Box sx={{
          fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f14,
          letterSpacing: '.1em', textTransform: 'uppercase', color: tokens.text0,
        }}>
          Карточка артефакта
        </Box>
        <IconButton
          size="small" onClick={onClose} aria-label="Закрыть карточку"
          sx={{ color: tokens.text2, '&:hover': { color: tokens.text0, bgcolor: 'transparent' } }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      <Box sx={{ p: '14px' }}>
        <LotStatCard
          {...shared}
          fullWidth
          signalsSource="feed"
          kicker={`Лента · ${lot.region}`}
          onViewLots={onViewLots}
        />
      </Box>
    </Dialog>
  )
}
