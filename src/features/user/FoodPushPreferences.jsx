import { useEffect, useState } from 'react'
import {
  disableFoodPush,
  enableFoodPush,
  getFoodPushAvailability,
  isFoodPushEnabled,
} from './foodPushService'

export function FoodPushPreferences({ uid }) {
  const [supported, setSupported] = useState(null)
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const available = await getFoodPushAvailability()
        if (!available) {
          if (!cancelled) setSupported(false)
          return
        }
        const previouslyEnabled = await isFoodPushEnabled(uid)
        if (previouslyEnabled && Notification.permission === 'granted') {
          await enableFoodPush(uid, { requestPermission: false }) // refresh rotated tokens
        }
        if (!cancelled) {
          setSupported(true)
          setEnabled(previouslyEnabled && Notification.permission === 'granted')
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Az értesítési beállítás nem tölthető be.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [uid])

  async function toggle() {
    setPending(true)
    setError('')
    try {
      if (enabled) {
        await disableFoodPush(uid)
        setEnabled(false)
      } else {
        // Permission must be requested directly from the button gesture.
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') throw new Error('Az értesítési engedély nem lett megadva.')
        await enableFoodPush(uid, { requestPermission: false })
        setEnabled(true)
      }
    } catch (changeError) {
      setError(changeError.message || 'Az értesítési beállítás nem módosítható.')
    } finally {
      setPending(false)
    }
  }

  if (supported === false) return null

  return (
    <div className="user-food-push-preferences">
      <div>
        <strong>Értesítés, ha elkészült a rendelésed</strong>
        <p className="helper-text">Engedélyezés után ezen az eszközön akkor is értesítünk, ha az alkalmazás nincs megnyitva.</p>
        {error ? <p className="helper-text" role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      </div>
      <button type="button" className="secondary-button" onClick={toggle} disabled={pending || supported === null}>
        {pending ? 'Folyamatban…' : enabled ? 'Értesítések kikapcsolása' : 'Értesítések bekapcsolása'}
      </button>
    </div>
  )
}
