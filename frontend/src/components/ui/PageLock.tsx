import { ReactNode } from 'react'
import { Box, Button, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'
import LockIcon from './LockIcon'

// .pagelock — полностраничный гейт (Лоты без auction_access, Радар без аддона):
// тот же словарь замка + CTA. base.css:567-575
export interface PageLockProps {
  /** Крупный заголовок. По умолчанию «Доступно на тарифе {tierLabel}». */
  title?: ReactNode
  /** Пояснение под заголовком (.note). */
  description?: ReactNode
  /** Название требуемого тарифа/аддона для дефолтного заголовка. */
  tierLabel?: ReactNode
  /** Подпись CTA (default «Сменить тариф»). */
  ctaLabel?: ReactNode
  /** Обработчик CTA. */
  onCta?: () => void
  /** Ссылка CTA (тогда кнопка — <a>). */
  ctaHref?: string
  sx?: SxProps<Theme>
}

export default function PageLock({
  title,
  description,
  tierLabel,
  ctaLabel = 'Сменить тариф',
  onCta,
  ctaHref,
  sx,
}: PageLockProps) {
  const ctaProps = ctaHref
    ? ({ component: 'a', href: ctaHref } as const)
    : ({ onClick: onCta } as const)

  return (
    <Box
      sx={[
        {
          minHeight: 440,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          textAlign: 'center',
          padding: '40px',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <LockIcon size={34} sx={{ color: tokens.gold }} />
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
      {description != null && (
        <Box component="p" sx={{ margin: 0, fontSize: fs.f12, color: tokens.text1, maxWidth: '56ch' }}>
          {description}
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
        <Button variant="contained" color="primary" size="small" {...ctaProps}>
          {ctaLabel}
        </Button>
      </Box>
    </Box>
  )
}
