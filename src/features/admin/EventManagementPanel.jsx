import { useEffect, useState } from 'react'
import { StatusCard } from '../../components/StatusCard'
import {
  activateEvent,
  closeEventAndCarryBalances,
  createEvent,
  ensureRuntimeDocument,
  subscribeToEventsList,
} from '../events/eventService'
import { formatHuf } from '../../lib/money'

const initialFormState = {
  name: '',
  code: '',
  startsOn: '',
  activateNow: true,
  cloneProductsFromEventId: '',
}

function formatDate(value) {
  if (!value) return 'Nincs dátum megadva'

  return value
}

export function EventManagementPanel({ activeEventId, actorUid }) {
  const [events, setEvents] = useState([])
  const [formState, setFormState] = useState(initialFormState)
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    if (!actorUid) return () => {}

    ensureRuntimeDocument(actorUid).catch(() => {})

    return subscribeToEventsList(
      (nextEvents) => {
        setEvents(nextEvents)
        setLoadingEvents(false)
      },
      (error) => {
        setErrorMessage(error.message)
        setLoadingEvents(false)
      },
    )
  }, [actorUid])

  function updateField(event) {
    const { name, value, type, checked } = event.target

    setFormState((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  async function handleCreateEvent(event) {
    event.preventDefault()
    setSubmitting(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await createEvent({
        ...formState,
        actorUid,
        currentActiveEventId: activeEventId,
      })
      setFormState(initialFormState)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleActivateEvent(eventId) {
    setSubmitting(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await activateEvent({
        eventId,
        actorUid,
        currentActiveEventId: activeEventId,
      })
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  function formatCloseError(error) {
    const details = error?.details
    if (!details?.missingShibboleth?.length && !details?.duplicateShibboleths?.length) {
      return error?.message || 'Az esemény lezárása sikertelen volt.'
    }

    const missing = details.missingShibboleth?.length
      ? `Hiányzó shibboleth nem nulla egyenleggel: ${details.missingShibboleth.map((item) => item.displayName || item.personId).join(', ')}.`
      : ''
    const duplicates = details.duplicateShibboleths?.length
      ? `Duplikált shibboleth: ${details.duplicateShibboleths.map((item) => item.normalizedShibboleth).join(', ')}.`
      : ''

    return [error.message, missing, duplicates].filter(Boolean).join(' ')
  }

  async function handleCloseEvent() {
    if (!activeEventId) return

    const confirmed = window.confirm(
      'Biztosan lezárod az aktív eseményt? A résztvevők aktuális egyenlege shibboleth alapján átkerül a következő eseményhez használható globális carry-over tárolóba, és nem lesz aktív esemény.',
    )

    if (!confirmed) return

    setSubmitting(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const result = await closeEventAndCarryBalances({ eventId: activeEventId })
      setStatusMessage(`Esemény lezárva. Átvitt egyenlegek: ${result.carriedCount}; összesen: ${formatHuf(result.totalBalance || 0)}.`)
    } catch (error) {
      setErrorMessage(formatCloseError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="two-column-grid">
      <section className="panel">
        <h3 className="card-title">Esemény létrehozása vagy indítása</h3>
        <p className="helper-text">
          Az új események alapból üresen indulnak. Ha a következő tábor újrahasználná az előző katalógust, létrehozás közben másold át a termékeket és módosítókat egy korábbi eseményből.
        </p>
        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
        {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}
        {activeEventId ? (
          <div className="button-row" style={{ marginBottom: '12px' }}>
            <button type="button" className="danger-button" onClick={handleCloseEvent} disabled={submitting}>
              {submitting ? 'Lezárás...' : 'Aktív esemény lezárása'}
            </button>
          </div>
        ) : null}
        <form className="form-grid" onSubmit={handleCreateEvent}>
          <div className="field">
            <label htmlFor="eventName">Esemény neve</label>
            <input
              id="eventName"
              name="name"
              value={formState.name}
              onChange={updateField}
              placeholder="Egyetemi tábor 2026"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="eventCode">Kód</label>
            <input
              id="eventCode"
              name="code"
              value={formState.code}
              onChange={updateField}
              placeholder="camp-2026"
            />
          </div>
          <div className="field">
            <label htmlFor="startsOn">Kezdő dátum</label>
            <input
              id="startsOn"
              name="startsOn"
              type="date"
              value={formState.startsOn}
              onChange={updateField}
            />
          </div>
          <div className="field">
            <label htmlFor="cloneProductsFromEventId">Katalógus másolása korábbi eseményből</label>
            <select
              id="cloneProductsFromEventId"
              name="cloneProductsFromEventId"
              value={formState.cloneProductsFromEventId}
              onChange={updateField}
            >
              <option value="">Indulás üresen</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name} ({event.code})
                </option>
              ))}
            </select>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="activateNow"
              checked={formState.activateNow}
              onChange={updateField}
            />
            <span>Az esemény azonnali létrehozása és aktiválása</span>
          </label>
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={submitting}>
              {submitting ? 'Mentés...' : 'Esemény létrehozása'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h3 className="card-title">Eseménytörténet</h3>
        <p className="helper-text">
          Az aktív eseményt a `system/runtime.activeEventId` irányítja. Az eseménydokumentumok megmaradnak a történetben, új esemény indításakor sem törlődnek.
        </p>
        {loadingEvents ? <p className="helper-text">Események betöltése...</p> : null}
        {!loadingEvents && events.length === 0 ? (
          <StatusCard
            title="Még nincs esemény"
            tone="warning"
            body="Hozd létre az első eseményt a felhasználói és staff szekciók megnyitásához."
          />
        ) : null}
        <div className="event-list">
          {events.map((event) => (
            <article key={event.id} className="event-card">
              <div className="event-card-header">
                <div>
                  <h4 className="card-title">{event.name}</h4>
                  <p className="helper-text">{event.code}</p>
                </div>
                <div className="pill-row">
                  <span className="event-pill">{event.status}</span>
                  {activeEventId === event.id ? <span className="event-pill">aktív mutató</span> : null}
                </div>
              </div>
              <ul className="detail-list">
                <li>
                  <strong>Kezdő dátum</strong>
                  {formatDate(event.startsOn)}
                </li>
                <li>
                  <strong>Létrehozta</strong>
                  {event.createdBy}
                </li>
                <li>
                  <strong>Állapot</strong>
                  {activeEventId === event.id ? 'Jelenleg aktív esemény' : 'Elérhető a történetben és archívumban'}
                </li>
              </ul>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={submitting || Boolean(activeEventId)}
                  onClick={() => handleActivateEvent(event.id)}
                >
                  {activeEventId === event.id ? 'Jelenleg aktív' : activeEventId ? 'Előbb zárd le az aktív eseményt' : 'Aktívvá tesz'}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
