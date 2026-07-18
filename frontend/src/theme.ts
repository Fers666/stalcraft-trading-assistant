import { createTheme, alpha } from '@mui/material/styles'

// ─── SC TRADING Design System · v5 «ТЕРМИНАЛ» ─────────────────────────────────
// ANOMALY → DATA → PROFIT
// Единственный источник цветовой/размерной правды (design/v5/assets/tokens.css).
// Правило ревью: хекс/rgba вне этого файла = дефект.

// Gold palette
const G1 = '#B78A2A'   // gold-1  · тёмное золото (градиенты баров, скроллбар)
const G2 = '#D9AF37'   // gold    · базовое золото (медиана, лого, активный таб)
const G3 = '#F2C94C'   // gold-2  · светлое золото (активный текст, средняя линия)
const G4 = '#FFB800'   // gold-hi · пик (медиана-цена, подчёркивание активного, глоу)

// Surfaces
const BG0 = '#080808'  // s0 · страница
const BG1 = '#0D1014'  // s1 · панель
const BG2 = '#12161C'  // s2 · приподнятая ячейка, thead, инпут
const BG3 = '#1A1F26'  // s3 · карточка / hover / тултип / тост

// Text
const T0  = '#F2F4F6'  // основной
const T1  = '#B6BDC4'  // вторичный (≥4.5:1 на s3)
const T2  = '#8A939C'  // лейблы/киккеры/оси (≥4.5:1 на s3)

// Status
const SUCCESS = '#3ED598'
const WARNING = '#F5B74F'
const DANGER  = '#FF5A5A'
const INFO    = '#53B7FF'  // только MUI Alert severity="info" / quality.stalker

// Lines
const BORDER    = 'rgba(255,255,255,0.08)'
const BORDER_HI = 'rgba(255,255,255,0.15)'
const GRID      = 'rgba(255,255,255,0.06)'
const TICK      = 'rgba(255,255,255,0.2)'

// Gold rgba
const GOLD_DIM       = 'rgba(217,175,55,0.12)'
const GOLD_LINE      = 'rgba(217,175,55,0.4)'
const GOLD_LINE_SOFT = 'rgba(217,175,55,0.3)'
const GOLD_GLOW      = 'rgba(255,184,0,0.22)'

// Status rgba (dim = подложка, line = граница)
const SUCCESS_DIM  = 'rgba(62,213,152,0.12)'
const SUCCESS_LINE = 'rgba(62,213,152,0.35)'
const DANGER_DIM   = 'rgba(255,90,90,0.12)'
const DANGER_LINE  = 'rgba(255,90,90,0.4)'
const WARNING_DIM  = 'rgba(245,183,79,0.12)'
const WARNING_LINE = 'rgba(245,183,79,0.4)'

// Overlays
const OVERLAY    = 'rgba(8,8,8,0.55)'   // гейт поверх графика
const OVERLAY_HI = 'rgba(8,8,8,0.78)'   // подложка модалки

// Fonts
const FONT_HEAD = '"Rajdhani", system-ui, sans-serif'
const FONT_MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace'
const FONT_UI   = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

// Geometry / motion
const R    = 2    // базовый радиус
const R_LG = 4    // максимум; скругления >4px запрещены
const EASE = 'cubic-bezier(.19,1,.22,1)'
const FAST = 150  // ms
const MID  = 220  // ms
// spacing: MUI база остаётся 8 (см. ТЗ §2.5); в новых компонентах — точные px из 4-шкалы

// Типографская шкала (px). Пол: киккеры ≥10, вспомогательное ≥10.5 (mono), текст ≥12
export const fs = {
  f10:  '10px',    // киккеры Rajdhani (только display)
  f105: '10.5px',  // микро-моно: sysbar, заголовки таблиц
  f11:  '11px',    // лейблы, чипы, оси графиков
  f115: '11.5px',  // строки гистограмм, gbtn
  f12:  '12px',    // вторичный текст, тултипы
  f125: '12.5px',  // данные таблиц, инпуты, навссылки
  f13:  '13px',    // body
  f14:  '14px',    // значения статус-строки, заголовок модалки
  f15:  '15px',    // бренд
  f16:  '16px',    // заголовок гейта
  f26:  '26px',    // h1 карточки предмета
  f28:  '28px',    // медиана-цена (пик иерархии)
} as const

// Единая шкала качества предметов — ключ = поле `color` из БД (COL-01)
export const QUALITY_COLORS: Record<string, string> = {
  default: '#9BA3AB', // серый    · Обычный
  newbie:  '#3ED598', // зелёный  · Новичок
  stalker: '#53B7FF', // синий    · Сталкер
  veteran: '#B57BFF', // фиолет.  · Ветеран
  master:  '#FF5A5A', // красный  · Мастер
  legend:  '#FFB800', // золотой  · Легенда
}

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: G2, light: G3, dark: G1, contrastText: '#F5F5F5' },
    secondary: { main: SUCCESS, light: '#6affc0', dark: '#1ab867' },
    error:     { main: DANGER  },
    warning:   { main: WARNING },
    info:      { main: INFO    },
    background: { default: BG0, paper: BG1 },
    divider: BORDER,
    text: { primary: T0, secondary: T1, disabled: T2 },
  },

  typography: {
    fontFamily: FONT_UI,

    h1: {
      fontFamily: FONT_HEAD,
      fontWeight: 700,
      fontSize: '3.5rem',
      letterSpacing: '0.08em',
      lineHeight: 1.1,
    },
    h2: {
      fontFamily: FONT_HEAD,
      fontWeight: 700,
      fontSize: '2.625rem',
      letterSpacing: '0.08em',
    },
    h3: {
      fontFamily: FONT_HEAD,
      fontWeight: 700,
      fontSize: '2rem',
      letterSpacing: '0.08em',
    },
    h4: {
      fontFamily: FONT_HEAD,
      fontWeight: 700,
      fontSize: '1.5rem',
      letterSpacing: '0.06em',
    },
    h5: {
      fontFamily: FONT_HEAD,
      fontWeight: 600,
      fontSize: '1.25rem',
      letterSpacing: '0.06em',
    },
    h6: {
      fontFamily: FONT_HEAD,
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

  shape: { borderRadius: R },

  transitions: {
    duration: { shorter: FAST, standard: MID },
    easing: { easeOut: EASE },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { background: BG0, minHeight: '100vh' },

        // все цифры и данные (цены, количества, время, id, регионы)
        '.mono': {
          fontFamily: FONT_MONO,
          fontVariantNumeric: 'tabular-nums',
        },

        // A11Y-01 — одно золотое кольцо фокуса на все интерактивы
        ':focus-visible': {
          outline: `2px solid ${G2}`,
          outlineOffset: 1,
        },

        // MOT-01 — гашение анимаций
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },

    // ─── Card ──────────────────────────────────────────────────────────────────
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: BG1,
          border: `1px solid ${BORDER}`,
          borderRadius: R,
          boxShadow: 'none',
        },
      },
    },

    MuiCardContent: {
      styleOverrides: {
        root: { '&:last-child': { paddingBottom: 20 } },
      },
    },

    // ─── Paper ─────────────────────────────────────────────────────────────────
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: BG1,
          border: `1px solid ${BORDER}`,
          borderRadius: R,
          boxShadow: 'none',
        },
      },
    },

    // ─── Button ────────────────────────────────────────────────────────────────
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          height: 44,
          borderRadius: R,
          fontSize: '0.875rem',
          letterSpacing: '0.04em',
          boxShadow: 'none',
          transition: `color ${FAST}ms ${EASE}, background-color ${FAST}ms ${EASE}, border-color ${FAST}ms ${EASE}`,
          '&:hover': { boxShadow: 'none' },
        },
        sizeSmall: { height: 32, fontSize: '0.8rem' },
        sizeLarge: { height: 48, fontSize: '1rem' },
        // .gbtn — золотая primary (гейты, CTA)
        containedPrimary: {
          background: GOLD_DIM,
          border: `1px solid ${GOLD_LINE}`,
          color: G3,
          fontFamily: FONT_HEAD,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          '&:hover': { background: G2, color: BG0 },
        },
        // .qbtn — нейтральная ghost-вторичная
        outlined: {
          background: BG2,
          borderColor: BORDER,
          color: T1,
          '&:hover': { background: BG2, borderColor: BORDER_HI, color: T0 },
        },
        outlinedPrimary: {
          background: BG2,
          borderColor: BORDER,
          color: T1,
          '&:hover': { background: BG2, borderColor: BORDER_HI, color: T0 },
        },
        text: {
          color: T0,
          '&:hover': { color: G3, background: 'transparent' },
        },
      },
    },

    // ─── IconButton ────────────────────────────────────────────────────────────
    MuiIconButton: {
      styleOverrides: {
        root: {
          width: 30,
          height: 30,
          borderRadius: R,
          color: T2,
          border: '1px solid transparent',
          transition: `color ${FAST}ms ${EASE}, background-color ${FAST}ms ${EASE}, border-color ${FAST}ms ${EASE}`,
          '&:hover': { color: G3, background: BG2, borderColor: BORDER_HI },
        },
      },
    },

    // ─── Chip ──────────────────────────────────────────────────────────────────
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: R,
          fontSize: fs.f11,
          letterSpacing: '0.03em',
          border: `1px solid ${BORDER_HI}`,
        },
        colorDefault: {
          background: BG2,
          border: `1px solid ${BORDER_HI}`,
          color: T1,
        },
        colorPrimary: {
          background: GOLD_DIM,
          border: `1px solid ${GOLD_LINE}`,
          color: G3,
        },
        colorSuccess: {
          background: SUCCESS_DIM,
          border: `1px solid ${SUCCESS_LINE}`,
          color: SUCCESS,
        },
        colorWarning: {
          background: WARNING_DIM,
          border: `1px solid ${WARNING_LINE}`,
          color: WARNING,
        },
        colorError: {
          background: DANGER_DIM,
          border: `1px solid ${DANGER_LINE}`,
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
          fontFamily: FONT_HEAD,
          fontWeight: 600,
          fontSize: fs.f105,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          borderBottom: `1px solid ${BORDER_HI}`,
        },
        body: {
          color: T0,
          borderBottom: `1px solid ${BORDER}`,
          fontFamily: FONT_MONO,
          fontVariantNumeric: 'tabular-nums',
          fontSize: fs.f125,
          textAlign: 'right',
          padding: '6px 10px',
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          transition: `background-color ${FAST}ms ${EASE}`,
          '&:hover td': { background: BG2 },
          '&:active td': { background: BG3 },
          '&.Mui-selected td': {
            background: GOLD_DIM,
            color: G3,
          },
          '&.Mui-selected': { boxShadow: `inset 2px 0 0 ${G4}` },
          '&:last-child td': { borderBottom: 'none' },
        },
      },
    },

    // ─── TextField / Select ──────────────────────────────────────────────────────
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: R,
            background: BG2,
            '& fieldset': { borderColor: BORDER },
            '&:hover fieldset': { borderColor: BORDER_HI },
            '&.Mui-focused fieldset': { borderColor: G2, borderWidth: '1px' },
          },
          '& .MuiOutlinedInput-root:not(.MuiInputBase-sizeSmall)': { height: 40 },
          '& .MuiInputLabel-root': { color: T2 },
          '& .MuiInputLabel-root.Mui-focused': { color: G3 },
          '& .MuiInputBase-input': { color: T0 },
        },
      },
    },

    MuiSelect: {
      styleOverrides: {
        outlined: { borderRadius: R },
      },
    },

    MuiMenu: {
      styleOverrides: {
        paper: {
          background: BG3,
          border: `1px solid ${BORDER_HI}`,
          borderRadius: R,
          boxShadow: 'none',
        },
      },
    },

    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: T1,
          fontSize: '0.875rem',
          '&:hover': { background: BG2 },
          '&.Mui-selected': { background: GOLD_DIM, color: G3 },
          '&.Mui-selected:hover': { background: GOLD_DIM },
        },
      },
    },

    // ─── Divider ───────────────────────────────────────────────────────────────
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: BORDER },
      },
    },

    // ─── Dialog ────────────────────────────────────────────────────────────────
    MuiDialog: {
      styleOverrides: {
        paper: {
          background: BG1,
          border: `1px solid ${BORDER_HI}`,
          borderTop: `2px solid ${G2}`,
          borderRadius: R,
          boxShadow: 'none',
        },
      },
    },

    MuiBackdrop: {
      styleOverrides: {
        root: { backgroundColor: OVERLAY_HI },
      },
    },

    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontFamily: FONT_HEAD,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          fontSize: fs.f14,
          color: T0,
        },
      },
    },

    // ─── Alert ─────────────────────────────────────────────────────────────────
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: R, border: '1px solid' },
        standardSuccess: {
          background: SUCCESS_DIM,
          borderColor: SUCCESS_LINE,
          color: SUCCESS,
        },
        standardError: {
          background: DANGER_DIM,
          borderColor: DANGER_LINE,
          color: DANGER,
        },
        standardWarning: {
          background: WARNING_DIM,
          borderColor: WARNING_LINE,
          color: WARNING,
        },
        standardInfo: {
          background: alpha(INFO, 0.12),
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
          borderRadius: `${R}px`,
          fontFamily: FONT_HEAD,
          fontSize: fs.f11,
          fontWeight: 600,
          letterSpacing: '0.1em',
          transition: `color ${FAST}ms ${EASE}, background-color ${FAST}ms ${EASE}`,
          '&.Mui-selected': {
            color: BG0,
            borderColor: G2,
            background: G2,
            fontWeight: 700,
            '&:hover': { background: G2 },
          },
          '&:hover': { color: T1, background: BG2 },
        },
      },
    },

    // ─── Switch ────────────────────────────────────────────────────────────────
    // Прямоугольный трек по контракту .switch; финальная геометрия 30×16 —
    // в ui/-компоненте Фазы 5, здесь базовый рестайл цвета/радиуса.
    MuiSwitch: {
      styleOverrides: {
        track: {
          backgroundColor: BG2,
          border: `1px solid ${BORDER_HI}`,
          borderRadius: R,
          opacity: 1,
        },
        switchBase: {
          color: T2,
          '&.Mui-checked': {
            color: G3,
            '& + .MuiSwitch-track': {
              backgroundColor: GOLD_DIM,
              borderColor: GOLD_LINE,
              opacity: 1,
            },
          },
        },
      },
    },

    // ─── Avatar ────────────────────────────────────────────────────────────────
    MuiAvatar: {
      styleOverrides: {
        root: {
          background: GOLD_DIM,
          color: G3,
          border: `1px solid ${GOLD_LINE}`,
        },
      },
    },

    // ─── Tooltip ───────────────────────────────────────────────────────────────
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          background: BG3,
          border: `1px solid ${BORDER_HI}`,
          borderRadius: R,
          color: T0,
          fontFamily: FONT_UI,
          fontSize: fs.f12,
          boxShadow: 'none',
        },
      },
    },

    // ─── Skeleton ──────────────────────────────────────────────────────────────
    MuiSkeleton: {
      styleOverrides: {
        root: {
          backgroundColor: BG2,
          borderRadius: R,
        },
      },
    },
  },
})

export default theme

// ─── Design tokens for direct use in components (sx/styled) ──────────────────
export const tokens = {
  // Gold palette
  gold: G2, goldAccent: G3, goldHighlight: G4, goldSoft: G1,
  goldDim: GOLD_DIM, goldLine: GOLD_LINE, goldLineSoft: GOLD_LINE_SOFT, goldGlow: GOLD_GLOW,
  // Surfaces
  bg0: BG0, bg1: BG1, bg2: BG2, bg3: BG3,
  // Text
  text0: T0, text1: T1, text2: T2,
  // Lines
  border: BORDER, borderHi: BORDER_HI, grid: GRID, tick: TICK,
  // Status
  success: SUCCESS, successDim: SUCCESS_DIM, successLine: SUCCESS_LINE,
  warning: WARNING, warningDim: WARNING_DIM, warningLine: WARNING_LINE,
  danger: DANGER, dangerDim: DANGER_DIM, dangerLine: DANGER_LINE,
  info: INFO,
  // Overlays
  overlay: OVERLAY, overlayHi: OVERLAY_HI,
  // Fonts
  fontHead: FONT_HEAD, fontMono: FONT_MONO, fontUi: FONT_UI,
  // Geometry
  navH: 48, radiusLg: R_LG,
  // Motion
  motion: { fast: FAST, mid: MID, ease: EASE },
  // z-index scale (Z-01)
  z: { nav: 40, tooltip: 50, modal: 60, toast: 70 },
}
