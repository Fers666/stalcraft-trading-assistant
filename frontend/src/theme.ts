import { createTheme } from '@mui/material/styles'

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: '#e8a020' },   // янтарный — цвет золота/монет
    secondary: { main: '#4caf84' },   // зелёный — прибыль
    error:     { main: '#f44336' },
    background: {
      default: '#0f1117',
      paper:   '#1a1d27',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", sans-serif',
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiCard: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500 },
      },
    },
  },
})

export default theme
