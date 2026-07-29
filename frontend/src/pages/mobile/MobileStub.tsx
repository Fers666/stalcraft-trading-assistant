import { Box } from '@mui/material'
import { tokens, fs } from '../../theme'

// Временная заглушка мобильной страницы (Фаза 1). Проверяет оболочку и
// навигацию; реальные экраны — Фазы 2–5. Контракт .pg-h (mobile.css).
export default function MobileStub({ title }: { title: string }) {
  return (
    <Box sx={{ pt: '18px' }}>
      <Box
        sx={{
          fontFamily: tokens.fontHead,
          fontWeight: 600,
          fontSize: fs.f10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: tokens.text2,
        }}
      >
        Мобильная версия
      </Box>
      <Box
        component="h1"
        sx={{
          m: 0,
          mt: '3px',
          fontFamily: tokens.fontHead,
          fontWeight: 700,
          fontSize: fs.f26,
          letterSpacing: '0.03em',
          lineHeight: 1.05,
          color: tokens.text0,
        }}
      >
        {title}
      </Box>
      <Box sx={{ mt: '5px', fontSize: fs.f12, color: tokens.text2, lineHeight: 1.5 }}>
        Раздел в разработке — экран появится в следующих фазах мобильной версии.
      </Box>
    </Box>
  )
}
