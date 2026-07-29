import { Drawer, Box } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { tokens, fs } from '../../theme'

// Переиспользуемая мобильная модалка — обёртка над MUI Drawer anchor="bottom".
// Контракт .msheet (mobile.css): borderTop 2px gold, скругление только верхних
// углов, max-height 88vh, sticky-шапка, «грабилка», safe-area снизу.
// Из коробки: focus-trap, портал, backdrop (OVERLAY_HI), ESC/бэкдроп, lock scroll.
export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
}

export default function BottomSheet({ open, onClose, title, children, footer }: BottomSheetProps) {
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      // Ниже toast (70), выше fixed-баров (40/41).
      sx={{ zIndex: tokens.z.modal }}
      PaperProps={{
        sx: {
          background: tokens.bg1,
          borderTop: `2px solid ${tokens.gold}`,
          borderTopLeftRadius: `${tokens.radiusLg}px`,
          borderTopRightRadius: `${tokens.radiusLg}px`,
          maxHeight: '88vh',
          overflowY: 'auto',
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
        },
      }}
    >
      {/* .msheet-grab */}
      <Box aria-hidden sx={{ width: 36, height: 4, background: tokens.borderHi, borderRadius: '2px', margin: '8px auto 0' }} />

      {/* .msheet-h (sticky) */}
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '14px 16px 12px',
          background: tokens.bg1,
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        <Box
          component="h3"
          sx={{
            flex: 1,
            m: 0,
            fontFamily: tokens.fontHead,
            fontWeight: 700,
            fontSize: fs.f14,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: tokens.text0,
          }}
        >
          {title}
        </Box>
        <Box
          component="button"
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          sx={{
            width: 44,
            height: 44,
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            color: tokens.text2,
            border: '1px solid transparent',
            borderRadius: '2px',
            transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
            '&:hover, &:active': { color: tokens.goldAccent, background: tokens.bg2, borderColor: tokens.borderHi },
          }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </Box>
      </Box>

      {/* .msheet-b */}
      <Box sx={{ padding: '14px 16px' }}>{children}</Box>

      {footer && <Box sx={{ padding: '4px 16px 14px' }}>{footer}</Box>}
    </Drawer>
  )
}
