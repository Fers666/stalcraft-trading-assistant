import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { keyframes } from '@mui/system'
import { tokens, fs } from '../../theme'

// .toast-stack + .toast — единственный канал «успех/инфо»: правый нижний угол,
// bg3, граница goldLine, mono fs.f12. Заменяет Alert/Snackbar. z-index toast(70).
// base.css:318-325, app.js:210-223
interface ToastItem {
  id: number
  message: ReactNode
}

export interface ToastContextValue {
  /** Показать тост (успех/инфо), автоскрытие через 3.2 с. */
  showToast: (message: ReactNode) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const toastIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
`

const TOAST_TTL = 3200

export interface ToastProviderProps {
  children: ReactNode
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const showToast = useCallback((message: ReactNode) => {
    const id = nextId.current++
    setItems((prev) => [...prev, { id, message }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), TOAST_TTL)
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <Box
        sx={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          zIndex: tokens.z.toast,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '8px',
          pointerEvents: 'none',
        }}
      >
        {items.map((t) => (
          <Box
            key={t.id}
            role="status"
            className="mono"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              background: tokens.bg3,
              border: `1px solid ${tokens.goldLine}`,
              borderRadius: 1,
              fontSize: fs.f12,
              color: tokens.text0,
              animation: `${toastIn} ${tokens.motion.mid}ms ${tokens.motion.ease}`,
            }}
          >
            {t.message}
          </Box>
        ))}
      </Box>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast должен использоваться внутри <ToastProvider>')
  return ctx
}
