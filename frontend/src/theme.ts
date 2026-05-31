import { createTheme, alpha } from '@mui/material/styles'

// ─── SC TRADING Design System ─────────────────────────────────────────────────
// Post-apocalyptic fintech dashboard — STALCRAFT / STALKER universe aesthetic

const P  = '#6F2BFF'   // Primary Purple
const PB = '#8A4DFF'   // Bright Purple
const PS = '#B38CFF'   // Soft Purple
const PD = '#3D1A7A'   // Dark Purple

const BG0 = '#0B0812'  // Primary Background
const BG1 = '#120A1E'  // Secondary Background
const BG2 = '#171022'  // Elevated Surface
const BG3 = '#1B1328'  // Card Surface

const T0  = '#F2F2F5'  // Primary Text
const T1  = '#B6B2C7'  // Secondary Text
const T2  = '#7D7695'  // Muted Text

const SUCCESS = '#2EEA8B'
const WARNING = '#FFB84D'
const DANGER  = '#FF5C72'
const INFO    = '#53B7FF'

const BORDER  = 'rgba(255,255,255,0.06)'
const GLOW    = `rgba(138,77,255,0.15)`

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: P,       light: PB,      dark: PD,    contrastText: '#fff' },
    secondary: { main: SUCCESS, light: '#5af7ae',dark: '#1ab867' },
    error:     { main: DANGER  },
    warning:   { main: WARNING },
    info:      { main: INFO    },
    background: { default: BG0, paper: BG3 },
    divider: BORDER,
    text: { primary: T0, secondary: T1, disabled: T2 },
  },

  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',

    h1: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '3.5rem',
      letterSpacing: '0.04em',
      lineHeight: 1.1,
    },
    h2: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '2.625rem',
      letterSpacing: '0.04em',
    },
    h3: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '2rem',
      letterSpacing: '0.04em',
    },
    h4: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '1.5rem',
      letterSpacing: '0.03em',
    },
    h5: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 600,
      fontSize: '1.25rem',
      letterSpacing: '0.03em',
    },
    h6: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 600,
      fontSize: '1.1rem',
      letterSpacing: '0.03em',
    },
    subtitle1: { fontWeight: 600, color: T0 },
    subtitle2: { fontWeight: 500, color: T1, fontSize: '0.8rem', letterSpacing: '0.06em' },
    body1:     { color: T1, lineHeight: 1.6 },
    body2:     { color: T1, fontSize: '0.875rem' },
    caption:   { color: T2, fontSize: '0.8125rem' },
    button:    { fontWeight: 600, letterSpacing: '0.04em' },
  },

  shape: { borderRadius: 12 },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { background: BG0, minHeight: '100vh' },
      },
    },

    // ─── AppBar ────────────────────────────────────────────────────────────────
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: alpha(BG1, 0.88),
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderBottom: `1px solid ${BORDER}`,
          boxShadow: `0 1px 0 ${BORDER}`,
        },
      },
    },

    // ─── Card ──────────────────────────────────────────────────────────────────
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: BG3,
          border: `1px solid ${BORDER}`,
          borderRadius: 18,
          boxShadow: `0 4px 32px rgba(0,0,0,0.5), inset 0 0 0 1px ${BORDER}`,
          transition: 'border-color 0.3s, box-shadow 0.3s',
          '&:hover': {
            borderColor: alpha(P, 0.35),
            boxShadow: `0 8px 40px rgba(0,0,0,0.6), 0 0 32px ${GLOW}, inset 0 0 0 1px ${alpha(P, 0.2)}`,
          },
        },
      },
    },

    MuiCardContent: {
      styleOverrides: {
        root: { '&:last-child': { paddingBottom: 20 } },
      },
    },

    // ─── Button ────────────────────────────────────────────────────────────────
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          height: 44,
          borderRadius: 18,
          fontSize: '0.875rem',
          transition: 'all 0.2s',
        },
        sizeSmall: { height: 32, borderRadius: 12, fontSize: '0.8rem', px: 1.5 },
        sizeLarge: { height: 52, borderRadius: 18, fontSize: '1rem' },
        containedPrimary: {
          background: `linear-gradient(135deg, ${PB} 0%, ${P} 60%, ${PD} 100%)`,
          boxShadow: `0 4px 16px ${alpha(P, 0.45)}`,
          '&:hover': {
            background: `linear-gradient(135deg, ${PS} 0%, ${PB} 60%, ${P} 100%)`,
            boxShadow: `0 6px 24px ${alpha(P, 0.6)}`,
            transform: 'translateY(-1px)',
          },
          '&:active': { transform: 'translateY(0)' },
        },
        outlinedPrimary: {
          borderColor: alpha(P, 0.4),
          color: PS,
          background: alpha(P, 0.04),
          '&:hover': {
            borderColor: PB,
            background: alpha(P, 0.1),
            boxShadow: `0 0 16px ${alpha(P, 0.2)}`,
          },
        },
        text: {
          color: PS,
          '&:hover': {
            background: alpha(P, 0.08),
            boxShadow: `0 0 12px ${alpha(P, 0.15)}`,
          },
        },
      },
    },

    // ─── Chip ──────────────────────────────────────────────────────────────────
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: 8,
          fontSize: '0.75rem',
          letterSpacing: '0.03em',
        },
        colorDefault: {
          background: alpha('#fff', 0.05),
          border: `1px solid ${BORDER}`,
          color: T1,
        },
        colorPrimary: {
          background: alpha(P, 0.15),
          border: `1px solid ${alpha(P, 0.35)}`,
          color: PS,
        },
        colorSuccess: {
          background: alpha(SUCCESS, 0.12),
          border: `1px solid ${alpha(SUCCESS, 0.3)}`,
          color: SUCCESS,
        },
        colorWarning: {
          background: alpha(WARNING, 0.12),
          border: `1px solid ${alpha(WARNING, 0.3)}`,
          color: WARNING,
        },
        colorError: {
          background: alpha(DANGER, 0.12),
          border: `1px solid ${alpha(DANGER, 0.3)}`,
          color: DANGER,
        },
        colorInfo: {
          background: alpha(INFO, 0.12),
          border: `1px solid ${alpha(INFO, 0.3)}`,
          color: INFO,
        },
      },
    },

    // ─── Table ─────────────────────────────────────────────────────────────────
    MuiTableCell: {
      styleOverrides: {
        head: {
          background: BG2,
          color: T2,
          fontWeight: 600,
          fontSize: '0.7rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          borderBottom: `1px solid ${BORDER}`,
        },
        body: {
          color: T1,
          borderBottom: `1px solid ${BORDER}`,
          fontSize: '0.875rem',
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover td': { background: alpha(P, 0.04) },
          '&:last-child td': { borderBottom: 'none' },
        },
      },
    },

    // ─── TextField ─────────────────────────────────────────────────────────────
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 12,
            background: alpha('#fff', 0.025),
            '& fieldset': { borderColor: BORDER },
            '&:hover fieldset': { borderColor: alpha(P, 0.5) },
            '&.Mui-focused fieldset': {
              borderColor: PB,
              boxShadow: `0 0 0 3px ${alpha(P, 0.15)}`,
            },
          },
          '& .MuiInputLabel-root': { color: T2 },
          '& .MuiInputLabel-root.Mui-focused': { color: PS },
          '& .MuiInputBase-input': { color: T0 },
        },
      },
    },

    // ─── Select ────────────────────────────────────────────────────────────────
    MuiSelect: {
      styleOverrides: {
        outlined: { borderRadius: 12 },
      },
    },

    MuiMenu: {
      styleOverrides: {
        paper: {
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          boxShadow: `0 16px 48px rgba(0,0,0,0.6), 0 0 32px ${GLOW}`,
        },
      },
    },

    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: T1,
          fontSize: '0.875rem',
          '&:hover': { background: alpha(P, 0.08) },
          '&.Mui-selected': { background: alpha(P, 0.15), color: PS },
        },
      },
    },

    // ─── Divider ───────────────────────────────────────────────────────────────
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: BORDER },
      },
    },

    // ─── Paper ─────────────────────────────────────────────────────────────────
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
        },
      },
    },

    // ─── Dialog ────────────────────────────────────────────────────────────────
    MuiDialog: {
      styleOverrides: {
        paper: {
          background: BG2,
          border: `1px solid ${alpha(P, 0.2)}`,
          borderRadius: 24,
          boxShadow: `0 24px 80px rgba(0,0,0,0.7), 0 0 48px ${GLOW}`,
        },
      },
    },

    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 700,
          letterSpacing: '0.04em',
          fontSize: '1.3rem',
          color: T0,
        },
      },
    },

    // ─── Alert ─────────────────────────────────────────────────────────────────
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 12, border: `1px solid` },
        standardSuccess: {
          background: alpha(SUCCESS, 0.1),
          borderColor: alpha(SUCCESS, 0.3),
          color: SUCCESS,
        },
        standardError: {
          background: alpha(DANGER, 0.1),
          borderColor: alpha(DANGER, 0.3),
          color: DANGER,
        },
        standardWarning: {
          background: alpha(WARNING, 0.1),
          borderColor: alpha(WARNING, 0.3),
          color: WARNING,
        },
        standardInfo: {
          background: alpha(INFO, 0.1),
          borderColor: alpha(INFO, 0.3),
          color: INFO,
        },
      },
    },

    // ─── ToggleButton ──────────────────────────────────────────────────────────
    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderColor: BORDER,
          color: T2,
          borderRadius: '8px !important',
          fontSize: '0.78rem',
          fontWeight: 500,
          '&.Mui-selected': {
            color: PS,
            borderColor: alpha(P, 0.5),
            background: alpha(P, 0.15),
          },
          '&:hover': { background: alpha(P, 0.06) },
        },
      },
    },

    // ─── Switch ────────────────────────────────────────────────────────────────
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: PB,
            '& + .MuiSwitch-track': { backgroundColor: P, opacity: 0.7 },
          },
        },
        track: { backgroundColor: alpha('#fff', 0.1) },
      },
    },

    // ─── Avatar ────────────────────────────────────────────────────────────────
    MuiAvatar: {
      styleOverrides: {
        root: {
          background: alpha(P, 0.2),
          color: PS,
          border: `1px solid ${alpha(P, 0.3)}`,
        },
      },
    },

    // ─── Tooltip ───────────────────────────────────────────────────────────────
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          background: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: 8,
          color: T1,
          fontSize: '0.78rem',
          boxShadow: `0 8px 24px rgba(0,0,0,0.5)`,
        },
      },
    },
  },
})

export default theme

// Export design tokens for direct use in components
export const tokens = {
  purple: P, purpleBright: PB, purpleSoft: PS, purpleDark: PD,
  bg0: BG0, bg1: BG1, bg2: BG2, bg3: BG3,
  text0: T0, text1: T1, text2: T2,
  success: SUCCESS, warning: WARNING, danger: DANGER, info: INFO,
  border: BORDER, glow: GLOW,
}
