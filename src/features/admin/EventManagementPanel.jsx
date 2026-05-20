import { useEffect, useMemo, useState } from 'react'
import { StatusCard } from '../../components/StatusCard'
import { formatHuf } from '../../lib/money'
import { normalizeShibboleth } from '../../lib/normalize'
import { EventStatisticsPanel } from './EventStatisticsPanel'
import { useEventArchiveData } from './useEventArchiveData'
import { PERSON_RECORD_STATUSES } from '../people/personModels'
import {
  activateEvent,
  closeEventAndCarryBalances,
  createEvent,
  ensureRuntimeDocument,
  setSingleNegativePurchaseStatus,
  subscribeToEventsList,
} from '../events/eventService'

const initialFormState = {
  name: '',
  code: '',
  startsOn: '',
  activateNow: true,
  cloneProductsFromEventId: '',
}

function formatDate(value, fallback = 'Nincs dátum') {
  if (!value) return fallback
  if (value?.toDate) return value.toDate().toLocaleDateString('hu-HU')
  return value
}

function formatTimestamp(value, fallback = '-') {
  if (!value?.toDate) return fallback
  return value.toDate().toLocaleString('hu-HU')
}

function getEventStatus(event, activeEventId) {
  if (!event) return 'Nincs kiválasztott esemény'
  if (activeEventId === event.id) return 'active'
  return event.status || 'draft'
}

function getStatusClass(status) {
  return `${status}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function getStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'aktív'
    case 'draft':
      return 'vázlat'
    case 'closed':
      return 'lezárva'
    default:
      return status
  }
}

function getNormalizedShibboleth(person) {
  return person.normalizedShibboleth || normalizeShibboleth(person.shibboleth || '')
}

function buildEventHealth(people) {
  const activePeople = people.filter((person) => person.recordStatus !== PERSON_RECORD_STATUSES.deleted)
  const duplicateMap = new Map()
  const missingShibboleth = []
  const missingShibbolethWithBalance = []

  activePeople.forEach((person) => {
    const normalizedShibboleth = getNormalizedShibboleth(person)
    const balance = person.balance || 0

    if (!normalizedShibboleth) {
      missingShibboleth.push(person)
      if (balance !== 0) missingShibbolethWithBalance.push(person)
      return
    }

    const existing = duplicateMap.get(normalizedShibboleth) || []
    existing.push(person)
    duplicateMap.set(normalizedShibboleth, existing)
  })

  const duplicateShibboleths = Array.from(duplicateMap.entries())
    .filter(([, group]) => group.length > 1)
    .map(([normalizedShibboleth, group]) => ({ normalizedShibboleth, group }))

  return {
    totalPeople: people.length,
    activePeople,
    deletedCount: people.length - activePeople.length,
    totalBalance: activePeople.reduce((sum, person) => sum + (person.balance || 0), 0),
    carryableCount: activePeople.filter((person) => getNormalizedShibboleth(person)).length,
    linkedCount: activePeople.filter((person) => person.linkedAccountId || person.linkedAuthUid).length,
    missingShibboleth,
    missingShibbolethWithBalance,
    duplicateShibboleths,
  }
}

function formatCloseError(error) {
  const details = error?.details
  if (!details?.missingShibboleth?.length && !details?.duplicateShibboleths?.length) {
    return error?.message || 'Az esemény lezárása sikertelen.'
  }

  const missing = details.missingShibboleth?.length
    ? `Hiányzó shibboleth nem nulla egyenleggel: ${details.missingShibboleth.map((item) => item.displayName || item.personId).join(', ')}.`
    : ''
  const duplicates = details.duplicateShibboleths?.length
    ? `Duplikált shibboleth: ${details.duplicateShibboleths.map((item) => item.normalizedShibboleth).join(', ')}.`
    : ''

  return [error.message, missing, duplicates].filter(Boolean).join(' ')
}

function MetricTile({ label, value, tone = '' }) {
  return (
    <article className={`event-metric-tile${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function CloseEventDialog({ event, health, pending, onCancel, onConfirm }) {
  const blockers = health.missingShibbolethWithBalance.length + health.duplicateShibboleths.length

  return (
    <div className="nav-guard-overlay" role="presentation">
      <section className="event-close-dialog floating-overlay" role="dialog" aria-modal="true" aria-labelledby="closeEventTitle">
        <div className="split-header">
          <div>
            <h3 id="closeEventTitle">Aktív esemény lezárása</h3>
            <p className="helper-text">
              Az egyenlegek shibboleth alapján mentésre kerülnek, az aktív esemény pedig törlődik a runtime állapotból.
            </p>
          </div>
          <span className="event-pill">{event?.name || 'Aktív esemény'}</span>
        </div>

        <div className="event-metric-grid compact">
          <MetricTile label="Ellenőrzött personák" value={String(health.activePeople.length)} />
          <MetricTile label="Áthozható rekordok" value={String(health.carryableCount)} />
          <MetricTile label="Teljes egyenleg" value={formatHuf(health.totalBalance)} />
          <MetricTile label="Blokkolók" value={String(blockers)} tone={blockers ? 'warning' : 'success'} />
        </div>

        {blockers ? (
          <div className="event-validation-list">
            {health.missingShibbolethWithBalance.length ? (
              <section>
                <h4>Hiányzó shibboleth nem nulla egyenleggel</h4>
                <ul>
                  {health.missingShibbolethWithBalance.map((person) => (
                    <li key={person.id}>
                      {person.displayName || person.id} ({formatHuf(person.balance || 0)})
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {health.duplicateShibboleths.length ? (
              <section>
                <h4>Duplikált shibboleth-ek</h4>
                <ul>
                  {health.duplicateShibboleths.map((duplicate) => (
                    <li key={duplicate.normalizedShibboleth}>
                      {duplicate.normalizedShibboleth}: {duplicate.group.map((person) => person.displayName || person.id).join(', ')}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <StatusCard
            title="Lezárható"
            tone="success"
            body="Nincs duplikált shibboleth, és nincs shibboleth nélküli nem nulla egyenleg."
          />
        )}

        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={pending}>
            Mégse
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={pending || Boolean(blockers)}>
            {pending ? 'Lezárás...' : 'Esemény lezárása és egyenlegek áthozása'}
          </button>
        </div>
      </section>
    </div>
  )
}

export function EventManagementPanel({ activeEventId, actorUid }) {
  const [events, setEvents] = useState([])
  const [selectedEventId, setSelectedEventId] = useState(activeEventId || '')
  const [formState, setFormState] = useState(initialFormState)
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const {
    loading: selectedEventLoading,
    people,
    products,
    modifierTemplates,
    orders,
    ledgerEntries,
    error: selectedEventError,
    stats,
  } = useEventArchiveData(selectedEventId)

  useEffect(() => {
    if (!actorUid) return () => {}

    ensureRuntimeDocument(actorUid).catch(() => {})

    return subscribeToEventsList(
      (nextEvents) => {
        setEvents(nextEvents)
        setLoadingEvents(false)
      },
      (error) => {
        setErrorMessage(`Eseménylista betöltése sikertelen: ${error.message}`)
        setLoadingEvents(false)
      },
    )
  }, [actorUid])

  useEffect(() => {
    if (!events.length) {
      setSelectedEventId('')
      return
    }

    if (selectedEventId && events.some((event) => event.id === selectedEventId)) return

    setSelectedEventId(activeEventId || events[0].id)
  }, [activeEventId, events, selectedEventId])

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) || null,
    [events, selectedEventId],
  )

  const health = useMemo(() => buildEventHealth(people), [people])
  const selectedEventStatus = getEventStatus(selectedEvent, activeEventId)
  const canCloseSelectedEvent = Boolean(selectedEventId && activeEventId === selectedEventId)
  const blockers = health.missingShibbolethWithBalance.length + health.duplicateShibboleths.length

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
      const nextEventId = await createEvent({
        ...formState,
        actorUid,
        currentActiveEventId: activeEventId,
      })
      setSelectedEventId(nextEventId)
      setFormState(initialFormState)
      setShowCreateForm(false)
      setStatusMessage('Esemény létrehozva.')
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
      await activateEvent({ eventId, actorUid, currentActiveEventId: activeEventId })
      setSelectedEventId(eventId)
      setStatusMessage('Esemény aktiválva.')
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirmCloseEvent() {
    if (!canCloseSelectedEvent) return

    setSubmitting(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const result = await closeEventAndCarryBalances({ eventId: selectedEventId })
      setCloseDialogOpen(false)
      setStatusMessage(`Esemény lezárva. ${result.carriedCount} áthozott egyenleg mentve, összesen ${formatHuf(result.totalBalance || 0)}.`)
    } catch (error) {
      setErrorMessage(formatCloseError(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggleSingleNegativePurchase(event) {
    if (!selectedEventId) return
    const isEnabled = event.target.checked
    setSubmitting(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await setSingleNegativePurchaseStatus({ eventId: selectedEventId, isEnabled, actorUid })
      setStatusMessage(isEnabled
        ? 'Egyszeri negatív vásárlás engedélyezve.'
        : 'Egyszeri negatív vásárlás kikapcsolva.')
    } catch (error) {
      setErrorMessage(error.message || 'A beállítás mentése sikertelen.')
    } finally {
      setSubmitting(false)
    }
  }

  function openCreateForm() {
    setShowCreateForm(true)
    setSelectedEventId('')
  }

  function selectEvent(eventId) {
    setSelectedEventId(eventId)
    setShowCreateForm(false)
  }

  return (
    <div className="admin-section event-workspace">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {selectedEventError ? <div className="error-banner">{selectedEventError.message}</div> : null}
      {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}

      <div className="event-workspace-grid">

        {/* ── Left pane: event list ── */}
        <aside className="event-list-pane">
          <div className="event-list-header">
            <span className="helper-text">
              {loadingEvents ? 'Betöltés...' : `${events.length} esemény`}
            </span>
            <button
              type="button"
              className={`secondary-button btn-sm${showCreateForm ? ' active-outline' : ''}`}
              onClick={showCreateForm ? () => setShowCreateForm(false) : openCreateForm}
            >
              {showCreateForm ? 'Mégse' : '+ Új esemény'}
            </button>
          </div>

          <div className="event-list">
            {events.map((event) => {
              const status = getEventStatus(event, activeEventId)
              const isSelected = selectedEventId === event.id && !showCreateForm
              return (
                <button
                  key={event.id}
                  type="button"
                  className={`event-list-item${isSelected ? ' selected' : ''}`}
                  onClick={() => selectEvent(event.id)}
                >
                  <span className="event-list-item-main">
                    <strong>{event.name}</strong>
                    <small>{[event.code, formatDate(event.startsOn, null)].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className={`event-pill status-${getStatusClass(status)}`}>{getStatusLabel(status)}</span>
                </button>
              )
            })}
            {!loadingEvents && events.length === 0 ? (
              <p className="helper-text">Még nincs esemény. Hozd létre az elsőt.</p>
            ) : null}
          </div>
        </aside>

        {/* ── Right pane: create form or event detail ── */}
        <div className="event-detail-pane">

          {showCreateForm ? (
            <section className="panel">
              <h3 className="card-title">Esemény létrehozása</h3>
              <p className="helper-text" style={{ marginBottom: '12px' }}>
                Az új események üres katalógussal indulnak, hacsak nem klónozol katalógust. Ha van aktív esemény, előbb zárd le az új aktiválása előtt.
              </p>
              <form className="form-grid" onSubmit={handleCreateEvent}>
                <div className="field">
                  <label htmlFor="eventName">Esemény neve</label>
                  <input
                    id="eventName"
                    name="name"
                    value={formState.name}
                    onChange={updateField}
                    placeholder="Tábor 2026"
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
                  <label htmlFor="startsOn">Kezdés dátuma</label>
                  <input
                    id="startsOn"
                    name="startsOn"
                    type="date"
                    value={formState.startsOn}
                    onChange={updateField}
                  />
                </div>
                <div className="field">
                  <label htmlFor="cloneProductsFromEventId">Katalógus klónozása eseményből</label>
                  <select
                    id="cloneProductsFromEventId"
                    name="cloneProductsFromEventId"
                    value={formState.cloneProductsFromEventId}
                    onChange={updateField}
                  >
                    <option value="">Indítás üres katalógussal</option>
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
                  <span>Létrehozás és azonnali aktiválás</span>
                </label>
                <div className="button-row">
                  <button type="button" className="secondary-button" onClick={() => setShowCreateForm(false)}>
                    Mégse
                  </button>
                  <button type="submit" className="primary-button" disabled={submitting}>
                    {submitting ? 'Mentés...' : 'Esemény létrehozása'}
                  </button>
                </div>
              </form>
            </section>

          ) : selectedEvent ? (
            <>
              {/* Event details */}
              <section className="panel event-status-panel">
                <div className="event-status-main">
                  <div>
                    <span className="eyebrow">Esemény munkaterület</span>
                    <h3>{selectedEvent.name}</h3>
                    <p className="helper-text">
                      {[selectedEvent.code, formatDate(selectedEvent.startsOn, null)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="pill-row">
                    <span className={`event-pill status-${getStatusClass(selectedEventStatus)}`}>{getStatusLabel(selectedEventStatus)}</span>
                  </div>
                </div>

                <div className="event-metric-grid">
                  <MetricTile label="Personák" value={selectedEventLoading ? '...' : String(health.activePeople.length)} />
                  <MetricTile label="Esemény egyenlege" value={selectedEventLoading ? '...' : formatHuf(health.totalBalance)} />
                  <MetricTile
                    label="Hiányzó shibboleth"
                    value={selectedEventLoading ? '...' : String(health.missingShibboleth.length)}
                    tone={health.missingShibboleth.length ? 'warning' : ''}
                  />
                  <MetricTile
                    label="Duplikált shibboleth"
                    value={selectedEventLoading ? '...' : String(health.duplicateShibboleths.length)}
                    tone={health.duplicateShibboleths.length ? 'warning' : ''}
                  />
                  <MetricTile
                    label="Hozzárendelt fiókok"
                    value={selectedEventLoading ? '...' : `${health.linkedCount}/${health.activePeople.length}`}
                  />
                </div>

                <ul className="detail-list">
                  <li><strong>Aktiválva</strong><span>{formatTimestamp(selectedEvent.activatedAt)}</span></li>
                  <li><strong>Lezárva</strong><span>{formatTimestamp(selectedEvent.closedAt)}</span></li>
                  <li><strong>Katalógus</strong><span>{products.length} termék, {modifierTemplates.length} módosítósablon</span></li>
                  <li><strong>Rendelések</strong><span>{orders.length}</span></li>
                  <li><strong>Ledger bejegyzések</strong><span>{ledgerEntries.length}</span></li>
                </ul>

                <div className="event-action-row">
                  {activeEventId && selectedEventId !== activeEventId ? (
                    <button type="button" className="secondary-button" onClick={() => selectEvent(activeEventId)}>
                      Aktív esemény megnyitása
                    </button>
                  ) : null}
                  {selectedEventId !== activeEventId ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={Boolean(activeEventId) || submitting}
                      title={activeEventId ? 'Előbb zárd le az aktív eseményt' : ''}
                      onClick={() => handleActivateEvent(selectedEventId)}
                    >
                      {activeEventId ? 'Előbb zárd le az aktívat' : 'Esemény aktiválása'}
                    </button>
                  ) : null}
                  {canCloseSelectedEvent ? (
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => setCloseDialogOpen(true)}
                      disabled={submitting || selectedEventLoading}
                    >
                      Aktív esemény lezárása
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="panel">
                <h3 className="card-title">POS egyenleg szabály</h3>
                <p className="helper-text" style={{ marginBottom: '12px' }}>
                  Ha be van kapcsolva, egy nem negatív egyenlegű persona még egyszer vásárolhat akkor is, ha ezzel mínuszba kerül. Amíg mínuszban van, újabb vásárlás nem zárható le feltöltés nélkül.
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedEvent.allowSingleNegativePurchase)}
                    onChange={handleToggleSingleNegativePurchase}
                    disabled={submitting || selectedEventLoading}
                  />
                  <span>Egyszeri negatív vásárlás engedélyezése</span>
                </label>
              </section>

              {/* Carry-over readiness */}
              <section className="panel">
                <h3 className="card-title">Áthozási ellenőrzés</h3>
                <p className="helper-text" style={{ marginBottom: '12px' }}>
                  Lezáráskor minden aktív persona egyenlege normalizált shibboleth alapján kerül az áthozási tárba.
                </p>
                <div className="event-metric-grid compact">
                  <MetricTile label="Áthozható" value={selectedEventLoading ? '...' : String(health.carryableCount)} />
                  <MetricTile label="Teljes egyenleg" value={selectedEventLoading ? '...' : formatHuf(health.totalBalance)} />
                  <MetricTile
                    label="Hiányzó pénzzel"
                    value={selectedEventLoading ? '...' : String(health.missingShibbolethWithBalance.length)}
                    tone={health.missingShibbolethWithBalance.length ? 'warning' : 'success'}
                  />
                  <MetricTile
                    label="Duplikációk"
                    value={selectedEventLoading ? '...' : String(health.duplicateShibboleths.length)}
                    tone={health.duplicateShibboleths.length ? 'warning' : 'success'}
                  />
                </div>

                {!selectedEventLoading ? (
                  blockers ? (
                    <div className="event-validation-list" style={{ marginTop: '12px' }}>
                      {health.missingShibbolethWithBalance.length ? (
                        <section>
                          <h4>Hiányzó shibboleth nem nulla egyenleggel</h4>
                          <ul>
                            {health.missingShibbolethWithBalance.map((person) => (
                              <li key={person.id}>{person.displayName || person.id} ({formatHuf(person.balance || 0)})</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                      {health.duplicateShibboleths.length ? (
                        <section>
                          <h4>Duplikált shibboleth-ek</h4>
                          <ul>
                            {health.duplicateShibboleths.map((duplicate) => (
                              <li key={duplicate.normalizedShibboleth}>
                                {duplicate.normalizedShibboleth}: {duplicate.group.map((person) => person.displayName || person.id).join(', ')}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  ) : (
                    <StatusCard
                      title="Nincs blokkoló"
                      tone="success"
                      body="Ez az esemény lezárható, ha aktív eseményként van kijelölve."
                    />
                  )
                ) : null}
              </section>

              {/* Statistics */}
              <EventStatisticsPanel event={selectedEvent} loading={selectedEventLoading} stats={stats} />
            </>

          ) : (
            <StatusCard
              title="Nincs kiválasztott esemény"
              tone="warning"
              body="Válassz eseményt a listából, vagy hozz létre újat a fenti gombbal."
            />
          )}
        </div>
      </div>

      {closeDialogOpen ? (
        <CloseEventDialog
          event={selectedEvent}
          health={health}
          pending={submitting}
          onCancel={() => setCloseDialogOpen(false)}
          onConfirm={handleConfirmCloseEvent}
        />
      ) : null}
    </div>
  )
}
