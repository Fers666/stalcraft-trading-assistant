/* Service Worker — только Web Push (без offline-кэша).
 * Получает push от браузерного push-сервиса и показывает уведомление;
 * по клику открывает/фокусирует приложение на нужном маршруте.
 * Payload от push_service: { title, body, url, tag }. */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'SC Trading', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'SC Trading'
  const options = {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/favicon.svg',
    tag: data.tag || undefined,
    data: { url: data.url || '/app' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/app'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
    })
  )
})
