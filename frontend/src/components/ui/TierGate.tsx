import { ReactNode } from 'react'
import { Box, Button, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'
import Kick from './Kick'
import LockIcon from './LockIcon'

// .chart-wrap.gated + .gate — гейт поверх контента: blur(6px) детей + overlay +
// замок + «Доступно на тарифе N» + CTA .gbtn. Единственный вид locked-состояния
// блока (LOCK-01). base.css:288-296
export interface TierGateProps {
  children: ReactNode
  /** Название требуемого тарифа (подставляется в «Доступно на тарифе N»). */
  tierLabel: ReactNode
  /** Заблокировано ли (default true). Если false — рендерятся только дети. */
  gated?: boolean
  /** Киккер над крупным текстом. */
  kicker?: ReactNode
  /** Переопределение крупного текста (по умолчанию «Доступно на тарифе {tierLabel}»). */
  title?: ReactNode
  /** Подпись CTA (default «Сменить тариф»). */
  ctaLabel?: ReactNode
  /** Обработчик CTA. */
  onCta?: () => void
  /** Ссылка CTA (тогда кнопка — <a>). */
  ctaHref?: string
  sx?: SxProps<Theme>
}

export default function TierGate({
  children,
  tierLabel,
  gated = true,
  kicker,
  title,
  ctaLabel = 'Сменить тариф',
  onCta,
  ctaHref,
  sx,
}: TierGateProps) {
  if (!gated) return <>{children}</>

  const ctaProps = ctaHref
    ? ({ component: 'a', href: ctaHref } as const)
    : ({ onClick: onCta } as const)

  return (
    // Контент и оверлей — в одной ячейке grid, а не «оверлей absolute поверх».
    // Absolute-оверлей не участвует в расчёте высоты: на невысоком контенте
    // (панель фильтров ~46px) замок + CTA (~150px) вылезали за блок и наезжали
    // на соседей. В сетке высота ряда = max(контент, оверлей), вылезать нечему.
    <Box
      sx={[
        { position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box
        sx={{
          gridArea: '1 / 1',
          display: 'flex',
          flexDirection: 'column',
          // Контент тянется на всю ячейку: если оверлей выше, гейт остаётся
          // цельным блоком, а не полоской контента с пустотой под ней.
          '& > *': { flexGrow: 1 },
          filter: 'blur(6px)',
          opacity: 0.45,
          pointerEvents: 'none',
        }}
      >
        {children}
      </Box>
      <Box
        sx={{
          gridArea: '1 / 1',
          // position + z-index обязательны: blur делает контент stacking-контекстом,
          // и без них оверлей рисовался бы под ним.
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          background: tokens.overlay,
          textAlign: 'center',
          padding: '16px',
        }}
      >
        <LockIcon size={22} sx={{ color: tokens.gold }} />
        {kicker != null && <Kick sx={{ color: tokens.text1 }}>{kicker}</Kick>}
        <Box
          component="span"
          sx={{
            fontFamily: tokens.fontHead,
            fontWeight: 700,
            fontSize: fs.f16,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: tokens.goldAccent,
          }}
        >
          {title ?? <>Доступно на тарифе {tierLabel}</>}
        </Box>
        <Button
          variant="contained"
          color="primary"
          size="small"
          sx={{ marginTop: '4px' }}
          {...ctaProps}
        >
          {ctaLabel}
        </Button>
      </Box>
    </Box>
  )
}
