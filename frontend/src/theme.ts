import { createTheme, alpha } from '@mui/material/styles'

const GOLD   = '#c9922a'   // насыщенное золото как на референсе
const GREEN  = '#3d9e6e'   // приглушённый зелёный для прибыли
const BLACK  = '#000000'   // чистый чёрный фон
const CARD   = '#0d0d0d'   // карточки — почти чёрные
const BORDER = '#1e1e1e'   // едва заметные разделители

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: GOLD,  light: '#e8b84b', dark: '#a0731a' },
    secondary: { main: GREEN, light: '#5abf8a', dark: '#2d7a52' },
    error:     { main: '#c0392b' },
    background: {
      default: BLACK,
      paper:   CARD,
    },
    divider: BORDER,
    text: {
      primary:   '#f0f0f0',
      secondary: '#888888',
      disabled:  '#444444',
    },
  },

  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',
    h3: { fontWeight: 800, letterSpacing: '-0.02em' },
    h4: { fontWeight: 700 },
    h5: { fontWeight: 700 },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600, color: '#888888' },
    caption:   { color: '#666666' },
  },

  shape: { borderRadius: 4 },  // менее скруглённые углы — лаконичнее

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          background: BLACK,
          scrollbarWidth: 'thin',
          scrollbarColor: `${BORDER} transparent`,
        },
      },
    },

    MuiAppBar: {
      styleOverrides: {
        root: {
          background: 'rgba(0,0,0,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: `1px solid ${BORDER}`,
        },
      },
    },

    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: CARD,
          border: `1px solid ${BORDER}`,
          boxShadow: 'none',
          transition: 'border-color 0.2s',
          '&:hover': {
            borderColor: alpha(GOLD, 0.3),
          },
        },
      },
    },

    MuiButton: {
      styleOverrides: {
        containedPrimary: {
          background: `linear-gradient(135deg, ${GOLD} 0%, #a0731a 100%)`,
          color: '#000',
          fontWeight: 700,
          letterSpacing: '0.05em',
          '&:hover': {
            background: `linear-gradient(135deg, #e8b84b 0%, ${GOLD} 100%)`,
          },
        },
        outlinedPrimary: {
          borderColor: alpha(GOLD, 0.5),
          color: GOLD,
          '&:hover': {
            borderColor: GOLD,
            background: alpha(GOLD, 0.08),
          },
        },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        head: {
          color: '#555555',
          fontWeight: 600,
          fontSize: '0.7rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          borderBottom: `1px solid ${BORDER}`,
        },
        body: {
          borderBottom: `1px solid ${BORDER}`,
        },
      },
    },

    MuiDivider: {
      styleOverrides: {
        root: { borderColor: BORDER },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500, borderRadius: 4 },
      },
    },

    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            '& fieldset': { borderColor: BORDER },
            '&:hover fieldset': { borderColor: alpha(GOLD, 0.4) },
            '&.Mui-focused fieldset': { borderColor: GOLD },
          },
        },
      },
    },

    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderColor: BORDER,
          color: '#555',
          '&.Mui-selected': {
            color: GOLD,
            borderColor: alpha(GOLD, 0.5),
            background: alpha(GOLD, 0.08),
          },
        },
      },
    },
  },
})

export default theme
