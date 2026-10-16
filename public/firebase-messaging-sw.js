// This worker has its own scope so it can coexist with the PWA's /sw.js.
// Firebase's public web config is supplied in the registration URL.
self.addEventListener('notificationclick', (event) => {
  event.stopImmediatePropagation()
  event.notification.close()
  const url = new URL('/app', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin))
    if (existing) {
      await existing.navigate(url)
      return existing.focus()
    }
    return self.clients.openWindow(url)
  }))
})

importScripts('https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js')

const params = new URL(self.location.href).searchParams
firebase.initializeApp({
  apiKey: params.get('apiKey'),
  authDomain: params.get('authDomain'),
  projectId: params.get('projectId'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId'),
})
firebase.messaging()
