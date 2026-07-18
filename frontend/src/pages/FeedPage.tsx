import { Box, Typography, Button } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import ConstructionIcon from '@mui/icons-material/Construction'

export default function FeedPage() {
  const navigate = useNavigate()
  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', textAlign: 'center', gap: 1.5,
    }}>
      <ConstructionIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
      <Typography variant="h6" fontWeight={700} color="text.secondary">
        Лента возможностей в разработке
      </Typography>
      <Typography variant="body2" color="text.disabled" sx={{ maxWidth: 420 }}>
        Прежний подход к оценке выгоды оказался ненадёжным — переделываем метрику
        на более честную основу. Скоро вернёмся с обновлённой версией.
      </Typography>
      <Button variant="contained" onClick={() => navigate('/app/monitoring')} sx={{ mt: 1 }}>
        Пока смотри Избранное
      </Button>
    </Box>
  )
}
