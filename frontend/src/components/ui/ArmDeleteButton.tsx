import { ReactNode, useEffect, useRef, useState } from 'react'
import { ButtonBase, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .dbtn + SC_APP.armConfirm — двухшаговое удаление: клик 1 → armed «Точно?»
// (red-dim) на N мс, клик 2 → onConfirm. confirm() запрещён (DEL-01).
// base.css:217-224, app.js:150-167
export interface ArmDeleteButtonProps {
  /** Вызывается на втором (подтверждающем) клике. */
  onConfirm: () => void
  /** Обычная подпись (default «Удалить»). */
  label?: ReactNode
  /** Подпись во взведённом состоянии (default «Точно?»). */
  armedLabel?: ReactNode
  /** Время удержания armed до сброса, мс (default 3000). */
  timeout?: number
  /** aria-label для иконочного варианта. */
  'aria-label'?: string
  sx?: SxProps<Theme>
}

export default function ArmDeleteButton({
  onConfirm,
  label = 'Удалить',
  armedLabel = 'Точно?',
  timeout = 3000,
  sx,
  ...rest
}: ArmDeleteButtonProps) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clear, [])

  const handleClick = () => {
    if (armed) {
      clear()
      setArmed(false)
      onConfirm()
      return
    }
    setArmed(true)
    clear()
    timer.current = setTimeout(() => setArmed(false), timeout)
  }

  return (
    <ButtonBase
      type="button"
      onClick={handleClick}
      disableRipple
      sx={[
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          height: 28,
          padding: '0 8px',
          borderRadius: 1,
          border: `1px solid ${armed ? tokens.dangerLine : tokens.border}`,
          background: armed ? tokens.dangerDim : tokens.bg2,
          color: armed ? tokens.danger : tokens.text2,
          fontFamily: tokens.fontHead,
          fontWeight: 600,
          fontSize: fs.f11,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
          '&:hover': { color: tokens.danger, borderColor: tokens.dangerLine },
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
      {...rest}
    >
      {armed ? armedLabel : label}
    </ButtonBase>
  )
}
