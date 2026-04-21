import { initializeApp } from 'firebase/app'
import { getAuth, browserLocalPersistence, setPersistence } from 'firebase/auth'
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
setPersistence(auth, browserLocalPersistence).catch(() => {})

export const db = getFirestore(app)
enableIndexedDbPersistence(db).catch(() => {})

export const functions = getFunctions(app, 'europe-west1')
