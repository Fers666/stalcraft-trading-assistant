import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Box } from '@mui/material'
import { tokens } from '../../theme'
import MobileTopBar from './MobileTopBar'
import MobileSignals from './MobileSignals'
import MobileTabBar from './MobileTabBar'
import MoreSheet from './MoreSheet'
import MobileSysBar from './MobileSysBar'

// Мобильная оболочка — контракт mshell.js: fixed-минибар + лента сигналов +
// одноколоночный контент (<Outlet/>) + fixed таб-бар + шит «Ещё» + sysbar.
// Геометрия/safe-area из mobile.css, значения через tokens/sx (без css-файла).
const MTOP_H = 52 // --mtop-h
const MTAB_H = 58 // --mtab-h

export default function MobileLayout() {
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: tokens.bg0,
        overflowX: 'hidden',
        // Отступы под fixed-бары + safe-area (аналог body padding в mobile.css).
        paddingTop: `calc(${MTOP_H}px + env(safe-area-inset-top))`,
        paddingBottom: `calc(${MTAB_H}px + env(safe-area-inset-bottom))`,
      }}
    >
      <MobileTopBar />

      {/* Лента сигналов — полноширинная, скроллится с контентом */}
      <MobileSignals />

      {/* .mmain — одна колонка, боковые поля 12px, центр на планшете */}
      <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: '12px', pb: '20px' }}>
        <Outlet />
        <MobileSysBar />
      </Box>

      <MobileTabBar onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </Box>
  )
}
