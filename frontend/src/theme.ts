import { createTheme, alpha } from '@mui/material/styles'

// ─── SC TRADING Design System ─────────────────────────────────────────────────
// ANOMALY → DATA → PROFIT
// Bloomberg Terminal built for the Zone — luxury fintech + tactical military UI

// Gold Palette
const G1 = '#B78A2A'   // Soft Gold
const G2 = '#D9AF37'   // Primary Gold
const G3 = '#F2C94C'   // Accent Gold
const G4 = '#FFB800'   // Highlight Gold

// Backgrounds
const BG0 = '#080808'  // Primary Background
const BG1 = '#11151A'  // Secondary Background
const BG2 = '#1A1F26'  // Card Surface
const BG3 = '#202633'  // Elevated Surface

// Text
const T0  = '#F5F5F5'  // Primary Text
const T1  = '#B8B8B8'  // Secondary Text
const T2  = '#7C7C7C'  // Muted Text

// Status
const SUCCESS = '#3ED598'
const WARNING = '#F5B74F'
const DANGER  = '#FF5A5A'
const INFO    = '#53B7FF'

const BORDER  = 'rgba(255,255,255,0.08)'
const GLOW    = 'rgba(217,175,55,0.10)'

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: G2, light: G3, dark: G1, contrastText: '#080808' },
    secondary: { main: SUCCESS, light: '#6affc0', dark: '#1ab867' },
    error:     { main: DANGER  },
    warning:   { main: WARNING },
    info:      { main: INFO    },
    background: { default: BG0, paper: BG2 },
    divider: BORDER,
    text: { primary: T0, secondary: T1, disabled: T2 },
  },

  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',

    h1: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '3.5rem',
      letterSpacing: '0.08em',
      lineHeight: 1.1,
    },
    h2: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '2.625rem',
      letterSpacing: '0.08em',
    },
    h3: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '2rem',
      letterSpacing: '0.08em',
    },
    h4: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 700,
      fontSize: '1.5rem',
      letterSpacing: '0.06em',
    },
    h5: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 600,
      fontSize: '1.25rem',
      letterSpacing: '0.06em',
    },
    h6: {
      fontFamily: '"Rajdhani", "Inter", sans-serif',
      fontWeight: 600,
      fontSize: '1.1rem',
      letterSpacing: '0.06em',
    },
    subtitle1: { fontWeight: 600, color: T0 },
    subtitle2: { fontWeight: 500, color: T1, fontSize: '0.8rem', letterSpacing: '0.08em' },
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
          background: alpha(BG1, 0.92),
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderBottom: `1px solid ${BORDER}`,
          boxShadow: `0 1px 0 ${BORDER}`,
          // Fix: primary.contrastText is #080808 (dark) — prevent it from
          // cascading into nav items as invisible black text on dark bg
          color: T0,
        },
      },
    },

    // ─── Card ──────────────────────────────────────────────────────────────────
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: BG2,
          border: `1px solid ${BORDER}`,
          borderRadius: 18,
          boxShadow: `0 4px 24px rgba(0,0,0,0.4)`,
          transition: 'border-color 0.3s',
          '&:hover': {
            borderColor: alpha(G2, 0.25),
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
          borderRadius: 12,
          fontSize: '0.875rem',
          transition: 'all 0.2s',
          letterSpacing: '0.04em',
        },
        sizeSmall: { height: 32, borderRadius: 8, fontSize: '0.8rem' },
        sizeLarge: { height: 48, borderRadius: 12, fontSize: '1rem' },
        containedPrimary: {
          background: `linear-gradient(90deg, ${G1} 0%, ${G2} 50%, ${G3} 100%)`,
          color: '#080808',
          boxShadow: 'none',
          '&:hover': {
            filter: 'brightness(1.1)',
            boxShadow: 'none',
            transform: 'translateY(-1px)',
          },
          '&:active': { transform: 'translateY(0)' },
        },
        outlinedPrimary: {
          borderColor: alpha(G2, 0.4),
          color: G3,
          background: 'transparent',
          '&:hover': {
            borderColor: G2,
            background: alpha(G2, 0.08),
          },
        },
        text: {
          color: T0,
          '&:hover': {
            color: G3,
            background: 'transparent',
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
          background: alpha('#fff', 0.04),
          border: `1px solid ${BORDER}`,
          color: T1,
        },
        colorPrimary: {
          background: alpha(G2, 0.12),
          border: `1px solid ${alpha(G2, 0.3)}`,
          color: G3,
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
          background: BG1,
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
          '&:hover td': { background: alpha(G2, 0.04) },
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
            background: BG1,
            '& fieldset': { borderColor: BORDER },
            '&:hover fieldset': { borderColor: alpha(G2, 0.4) },
            '&.Mui-focused fieldset': {
              borderColor: G2,
              borderWidth: '1px',
            },
          },
          // Standard size — 48px height
          '& .MuiOutlinedInput-root:not(.MuiInputBase-sizeSmall)': {
            height: 48,
          },
          '& .MuiInputLabel-root': { color: T2 },
          '& .MuiInputLabel-root.Mui-focused': { color: G3 },
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
          boxShadow: `0 16px 48px rgba(0,0,0,0.6)`,
        },
      },
    },

    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: T1,
          fontSize: '0.875rem',
          '&:hover': { background: alpha(G2, 0.06) },
          '&.Mui-selected': { background: alpha(G2, 0.12), color: G3 },
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
          border: `1px solid ${alpha(G2, 0.2)}`,
          borderRadius: 24,
          boxShadow: `0 24px 80px rgba(0,0,0,0.7)`,
        },
      },
    },

    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 700,
          letterSpacing: '0.08em',
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
            color: G3,
            borderColor: alpha(G2, 0.5),
            background: alpha(G2, 0.12),
          },
          '&:hover': { background: alpha(G2, 0.05) },
        },
      },
    },

    // ─── Switch ────────────────────────────────────────────────────────────────
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: G3,
            '& + .MuiSwitch-track': { backgroundColor: G2, opacity: 0.7 },
          },
        },
        track: { backgroundColor: alpha('#fff', 0.1) },
      },
    },

    // ─── Avatar ────────────────────────────────────────────────────────────────
    MuiAvatar: {
      styleOverrides: {
        root: {
          background: alpha(G2, 0.15),
          color: G3,
          border: `1px solid ${alpha(G2, 0.3)}`,
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
  // Gold palette (primary brand colors)
  gold: G2, goldAccent: G3, goldHighlight: G4, goldSoft: G1,
  // Legacy aliases — kept for backward compat with existing page components
  purple: G2, purpleBright: G3, purpleSoft: G3, purpleDark: G1,
  // Backgrounds
  bg0: BG0, bg1: BG1, bg2: BG2, bg3: BG3,
  // Text
  text0: T0, text1: T1, text2: T2,
  // Status
  success: SUCCESS, warning: WARNING, danger: DANGER, info: INFO,
  // Misc
  border: BORDER, glow: GLOW,
}
