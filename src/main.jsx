import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

if (import.meta.env.VITE_APP_ENV === 'staging' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations
      .filter((registration) => !registration.scope.endsWith('/firebase-cloud-messaging-push-scope/'))
      .map((registration) => registration.unregister())))
    .catch(() => {})
}

if (import.meta.env.PROD && import.meta.env.VITE_APP_ENV !== 'staging') {
  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateServiceWorker(true)
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return

      window.setInterval(() => {
        registration.update()
      }, 30 * 60 * 1000)

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update()
        }
      })
    },
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
