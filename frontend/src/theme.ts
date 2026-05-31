import { createTheme, alpha } from '@mui/material/styles'

const VIOLET  = '#7c3aed'   // основной фиолетовый
const V_LIGHT = '#a78bfa'   // светлый фиолетовый для текста
const V_DARK  = '#5b21b6'   // тёмный фиолетовый
const GREEN   = '#10b981'   // зелёный — прибыль
const BG      = '#080b18'   // тёмно-синий фон
const CARD    = '#0d1129'   // карточки — чуть светлее фона
const CARD2   = '#111638'   // вложенные карточки
const BORDER  = '#1e2445'   // разделители с синеватым оттенком

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: VIOLET, light: V_LIGHT, dark: V_DARK },
    secondary: { main: GREEN, light: '#34d399', dark: '#059669' },
    error:     { main: '#ef4444' },
    warning:   { main: '#f59e0b' },
    background: { default: BG, paper: CARD },
    divider: BORDER,
    text: {
      primary:   '#e2e8f0',
      secondary: '#94a3b8',
      disabled:  '#334155',
    },
  },

  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',
    h3: { fontWeight: 800, letterSpacing: '-0.03em' },
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700 },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 500, color: '#94a3b8' },
    caption:   { color: '#64748b' },
    body2:     { color: '#cbd5e1' },
  },

  shape: { borderRadius: 12 },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          background: BG,
          scrollbarWidth: 'thin',
          scrollbarColor: `${BORDER} transparent`,
        },
      },
    },

    MuiAppBar: {
      styleOverrides: {
        root: {
          background: alpha(BG, 0.85),
          backdropFilter: 'blur(20px)',
          borderBottom: `1px solid ${BORDER}`,
          boxShadow: 'none',
        },
      },
    },

    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: CARD,
          border: `1px solid ${BORDER}`,
          boxShadow: `0 4px 24px ${alpha('#000', 0.4)}`,
          transition: 'border-color 0.25s, box-shadow 0.25s',
          '&:hover': {
            borderColor: alpha(VIOLET, 0.5),
            boxShadow: `0 4px 32px ${alpha(VIOLET, 0.12)}`,
          },
        },
      },
    },

    MuiCardContent: {
      styleOverrides: {
        root: {
          '&:last-child': { paddingBottom: 16 },
        },
      },
    },

    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          borderRadius: 8,
        },
        containedPrimary: {
          background: `linear-gradient(135deg, ${VIOLET} 0%, ${V_DARK} 100%)`,
          boxShadow: `0 4px 14px ${alpha(VIOLET, 0.4)}`,
          '&:hover': {
            background: `linear-gradient(135deg, ${V_LIGHT} 0%, ${VIOLET} 100%)`,
            boxShadow: `0 6px 20px ${alpha(VIOLET, 0.5)}`,
          },
        },
        outlinedPrimary: {
          borderColor: alpha(VIOLET, 0.5),
          color: V_LIGHT,
          '&:hover': {
            borderColor: VIOLET,
            background: alpha(VIOLET, 0.08),
          },
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500, borderRadius: 6 },
        colorPrimary: {
          background: alpha(VIOLET, 0.15),
          color: V_LIGHT,
          border: `1px solid ${alpha(VIOLET, 0.3)}`,
        },
        colorSuccess: {
          background: alpha(GREEN, 0.12),
          color: '#34d399',
          border: `1px solid ${alpha(GREEN, 0.3)}`,
        },
        colorWarning: {
          background: alpha('#f59e0b', 0.12),
          color: '#fbbf24',
          border: `1px solid ${alpha('#f59e0b', 0.3)}`,
        },
        colorError: {
          background: alpha('#ef4444', 0.12),
          color: '#f87171',
          border: `1px solid ${alpha('#ef4444', 0.3)}`,
        },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        head: {
          color: '#475569',
          fontWeight: 600,
          fontSize: '0.7rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          borderBottom: `1px solid ${BORDER}`,
          background: CARD,
        },
        body: {
          borderBottom: `1px solid ${BORDER}`,
          color: '#cbd5e1',
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover td': {
            background: alpha(VIOLET, 0.04),
          },
        },
      },
    },

    MuiDivider: {
      styleOverrides: {
        root: { borderColor: BORDER },
      },
    },

    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 8,
            background: alpha('#fff', 0.02),
            '& fieldset': { borderColor: BORDER },
            '&:hover fieldset': { borderColor: alpha(VIOLET, 0.5) },
            '&.Mui-focused fieldset': { borderColor: VIOLET },
          },
          '& .MuiInputLabel-root.Mui-focused': { color: V_LIGHT },
        },
      },
    },

    MuiSelect: {
      styleOverrides: {
        outlined: {
          borderRadius: 8,
        },
      },
    },

    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderColor: BORDER,
          color: '#475569',
          borderRadius: '6px !important',
          '&.Mui-selected': {
            color: V_LIGHT,
            borderColor: alpha(VIOLET, 0.6),
            background: alpha(VIOLET, 0.15),
          },
        },
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 8 },
      },
    },

    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: CARD2,
          border: `1px solid ${BORDER}`,
        },
      },
    },

    MuiDialog: {
      styleOverrides: {
        paper: {
          background: CARD,
          border: `1px solid ${BORDER}`,
        },
      },
    },

    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: V_LIGHT,
            '& + .MuiSwitch-track': {
              backgroundColor: VIOLET,
            },
          },
        },
      },
    },
  },
})

export default theme
