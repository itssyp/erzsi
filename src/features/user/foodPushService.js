import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db, firebaseApp, firebaseConfig } from '../../lib/firebase'
import { waitForActiveServiceWorker } from './waitForActiveServiceWorker'

const DEVICE_ID_KEY = 'erzsi-food-push-device-id'
const PUSH_SCOPE = '/firebase-cloud-messaging-push-scope/'
const vapidKey = import.meta.env.VITE_FCM_VAPID_KEY

function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY)
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
  }
  return deviceId
}

function pushTokenRef(uid) {
  return doc(db, 'accounts', uid, 'pushTokens', getDeviceId())
}

async function getPushRegistration() {
  const params = new URLSearchParams({
    apiKey: firebaseConfig.apiKey,
    authDomain: firebaseConfig.authDomain,
    projectId: firebaseConfig.projectId,
    messagingSenderId: firebaseConfig.messagingSenderId,
    appId: firebaseConfig.appId,
  })
  const registration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${params}`, { scope: PUSH_SCOPE })
  return waitForActiveServiceWorker(registration)
}

export async function getFoodPushAvailability() {
  if (!vapidKey || !('serviceWorker' in navigator) || !('Notification' in window)) return false
  const { isSupported } = await import('firebase/messaging')
  return isSupported()
}

export async function isFoodPushEnabled(uid) {
  if (!uid || !localStorage.getItem(DEVICE_ID_KEY)) return false
  const snapshot = await getDoc(pushTokenRef(uid))
  return snapshot.exists()
}

export async function enableFoodPush(uid, { requestPermission = true } = {}) {
  if (!await getFoodPushAvailability()) throw new Error('Az eszközön az értesítések nem érhetők el.')
  const permission = requestPermission ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') throw new Error('Az értesítési engedély nem lett megadva.')

  const registration = await getPushRegistration()
  const { getMessaging, getToken } = await import('firebase/messaging')
  const messaging = getMessaging(firebaseApp)
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration })
  if (!token) throw new Error('Nem sikerült létrehozni az értesítési tokent.')
  await setDoc(pushTokenRef(uid), { token, origin: window.location.origin, updatedAt: serverTimestamp() })
  return registration
}

export async function disableFoodPush(uid) {
  if (!uid || !localStorage.getItem(DEVICE_ID_KEY)) return
  const results = await Promise.allSettled([
    deleteDoc(pushTokenRef(uid)),
    import('firebase/messaging').then(async ({ deleteToken, getMessaging, isSupported }) =>
      (await isSupported()) ? deleteToken(getMessaging(firebaseApp)) : undefined),
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

export async function listenForFoodPush(onReady) {
  if (!await getFoodPushAvailability()) return () => {}
  const { getMessaging, onMessage } = await import('firebase/messaging')
  return onMessage(getMessaging(firebaseApp), async (payload) => {
    if (payload.data?.type !== 'food-order-ready') return
    const registration = await getPushRegistration()
    await registration.showNotification(payload.notification?.title || 'Rendelésed elkészült', {
      body: payload.notification?.body || 'Átveheted a pultnál.',
      icon: new URL('/notification-burger.png', window.location.origin).href,
      tag: `food-order-ready-${payload.data.orderId}`,
      data: { url: '/app' },
    })
    onReady?.()
  })
}
