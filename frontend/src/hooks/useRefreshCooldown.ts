import { useState, useEffect, useRef } from 'react'

/**
 * Хук для кнопки "Обновить" с таймером обратного отсчёта.
 * Показывает "Обновить через 1:43" вместо заблокированной кнопки.
 *
 * @param cooldownSeconds - длительность кулдауна в секундах (по умолчанию 120)
 */
export function useRefreshCooldown(cooldownSeconds = 120) {
  const [secondsLeft, setSecondsLeft] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = () => {
    setSecondsLeft(cooldownSeconds)
  }

  useEffect(() => {
    if (secondsLeft <= 0) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [secondsLeft])

  const isCoolingDown = secondsLeft > 0

  const label = isCoolingDown
    ? `Обновить через ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
    : 'Обновить'

  return { isCoolingDown, label, startCooldown }
}
