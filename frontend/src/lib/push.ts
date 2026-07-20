/* Web Push: подписка/отписка устройства. Вызывается из тумблера «Browser Push»
 * в настройках. Регистрирует Service Worker (/sw.js), запрашивает разрешение,
 * подписывается через pushManager с VAPID-ключом и отправляет подписку на бэк. */
import api from '../api/client'

export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

/** PWA запущено с домашнего экрана (на iOS push доступен только так). */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari
    (navigator as any).standalone === true
  )
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/sw.js')
  if (existing) return existing
  return navigator.serviceWorker.register('/sw.js')
}

/** Включает push: SW + разрешение + подписка + отправка на бэк.
 *  Бросает Error с человекочитаемым сообщением при отказе/ошибке. */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error('Ваш браузер не поддерживает web push.')

  await registerServiceWorker()

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Разрешение на уведомления не выдано в браузере.')
  }

  const { data } = await api.get<{ public_key: string }>('/push/vapid-public-key')
  if (!data.public_key) throw new Error('Web push не сконфигурирован на сервере.')

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // cast: Uint8Array<ArrayBufferLike> не сужается до BufferSource в новых
      // TS (возможный SharedArrayBuffer). Рантайм не меняется — ключ всегда
      // поверх обычного ArrayBuffer.
      applicationServerKey: urlBase64ToUint8Array(data.public_key) as BufferSource,
    })
  }

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  await api.post('/push/subscribe', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  })
}

/** Отключает push: отписка в браузере + удаление на бэке. Ошибки не критичны. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  try {
    await sub.unsubscribe()
  } finally {
    await api.post('/push/unsubscribe', { endpoint })
  }
}
