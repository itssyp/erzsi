import { useEffect, useMemo, useState } from 'react'
import { StatusCard } from '../../components/StatusCard'
import { formatHuf } from '../../lib/money'
import { subscribeToEventsList } from '../events/eventService'
import { normalizeProductCategory } from '../products/productModels'
import { EventStatisticsPanel } from './EventStatisticsPanel'
import { useEventArchiveData } from './useEventArchiveData'

function formatTimestamp(value, fallback = 'Várakozó időbélyeg') {
  if (!value?.toDate) {
    return fallback
  }

  return value.toDate().toLocaleString('hu-HU')
}

function formatLedgerAmount(entry) {
  const prefix = entry.amount > 0 ? '+' : ''

  return `${prefix}${formatHuf(entry.amount)}`
}

export function EventArchivePanel({ activeEventId }) {
  const [events, setEvents] = useState([])
  const [selectedEventId, setSelectedEventId] = useState(activeEventId || '')
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [eventError, setEventError] = useState('')
  const {
    loading,
    products,
    modifierTemplates,
    orders,
    ledgerEntries,
    auditLogs,
    error,
    stats,
  } = useEventArchiveData(selectedEventId)

  useEffect(() => {
    return subscribeToEventsList(
      (nextEvents) => {
        setEvents(nextEvents)
        setLoadingEvents(false)
      },
      (nextError) => {
        setEventError(nextError.message)
        setLoadingEvents(false)
      },
    )
  }, [])

  useEffect(() => {
    if (!events.length) {
      setSelectedEventId('')
      return
    }

    if (selectedEventId && events.some((event) => event.id === selectedEventId)) {
      return
    }

    setSelectedEventId(activeEventId || events[0].id)
  }, [activeEventId, events, selectedEventId])

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) || null,
    [events, selectedEventId],
  )

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Archívum</span>
        <h3>Eseménytörténet és admin riportok</h3>
        <p className="muted">
          Bármely eseményt megvizsgálhatsz az élő katalógusállapottól függetlenül. A rendelések a mentett pillanatképből jelennek meg akkor is, ha a termékek később változtak.
        </p>
      </section>

      {eventError ? <div className="error-banner">{eventError}</div> : null}
      {error ? <div className="error-banner">{error.message}</div> : null}

      {loadingEvents && !events.length ? <p className="helper-text">Eseményarchívum betöltése...</p> : null}

      {!loadingEvents && events.length === 0 ? (
        <StatusCard
          title="Még nincs eseménytörténet"
          tone="warning"
          body="Hozz létre legalább egy eseményt, mielőtt az archívum és riport nézetek használhatók lennének."
        />
      ) : null}

      {events.length > 0 ? (
        <div className="stack-block">
          <div className="two-column-grid">
            <section className="panel">
              <div className="split-header">
                <div>
                  <h3 className="card-title">Esemény kiválasztása</h3>
                  <p className="helper-text">
                    Az archívum megtekintése működik az aktív és bármely lezárt eseményre is.
                  </p>
                </div>
                {activeEventId ? <span className="event-pill">Aktív mutató: {activeEventId}</span> : null}
              </div>

              <div className="field">
                <label htmlFor="archiveEventId">Esemény</label>
                <select
                  id="archiveEventId"
                  value={selectedEventId}
                  onChange={(event) => setSelectedEventId(event.target.value)}
                >
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name} ({event.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="record-list stacked">
                {events.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={`record-row${selectedEventId === event.id ? ' selected' : ''}`}
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <span>
                      <strong>{event.name}</strong>
                      <small>{event.code}</small>
                    </span>
                    <span>
                      <strong>{event.status}</strong>
                      <small>{event.startsOn || 'Nincs dátum'}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <EventStatisticsPanel event={selectedEvent} loading={loading} stats={stats} />
          </div>

          <div className="three-column-grid">
            <section className="panel">
              <h3 className="card-title">Termékek és módosítók</h3>
              <p className="helper-text">
                {products.length} termék | {modifierTemplates.length} módosítósablon
              </p>
              <div className="record-list stacked">
                {products.map((product) => (
                  <div key={product.id} className="record-row">
                    <span>
                      <strong>{product.name}</strong>
                      <small>
                        {normalizeProductCategory(product.category)} | {formatHuf(product.price)}
                      </small>
                    </span>
                    <span>
                      <strong>{product.isActive ? 'Aktív' : 'Inaktív'}</strong>
                      <small>{product.isTemporarilyUnavailable ? 'Nem elérhető' : 'Elérhető'}</small>
                    </span>
                  </div>
                ))}
                {products.length === 0 && !loading ? <p className="helper-text">Ebben az eseményben nincs termék.</p> : null}
              </div>
            </section>

            <section className="panel">
              <h3 className="card-title">Rendeléstörténet</h3>
              <p className="helper-text">A kiválasztott esemény legutóbbi 20 lezárt rendelése látszik.</p>
              <div className="record-list stacked">
                {orders.slice(0, 20).map((order) => (
                  <article key={order.id} className="order-card">
                    <div className="split-header">
                      <div>
                        <strong>{order.personDisplayName}</strong>
                        <p className="helper-text">
                          {order.personInternalId} | {formatTimestamp(order.createdAt)}
                        </p>
                      </div>
                      <div className="pill-row">
                        {order.hasFood ? <span className="event-pill">{order.foodStatus}</span> : null}
                        <span className="event-pill">{formatHuf(order.totalAmount)}</span>
                      </div>
                    </div>
                    <ul className="detail-list">
                      {order.lines.map((line) => (
                        <li key={line.lineId}>
                          <strong>{line.quantity} x {line.productName}</strong>
                          <span>
                            {formatHuf(line.lineTotal)}
                            {line.refundedQuantity ? ` | Visszatérítve: ${line.refundedQuantity}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
                {orders.length === 0 && !loading ? <p className="helper-text">Ebben az eseményben nincs rendelés.</p> : null}
              </div>
            </section>

            <section className="panel">
              <h3 className="card-title">Pénzügyi előzmények</h3>
              <p className="helper-text">A kiválasztott esemény legutóbbi 25 ledger bejegyzése látszik.</p>
              <div className="record-list stacked">
                {ledgerEntries.slice(0, 25).map((entry) => (
                  <div key={entry.id} className="record-row">
                    <span>
                      <strong>{entry.type}</strong>
                      <small>
                        Személy: {entry.personId} | {formatTimestamp(entry.createdAt)}
                      </small>
                    </span>
                    <span>
                      <strong>{formatLedgerAmount(entry)}</strong>
                      <small>
                        {formatHuf(entry.balanceBefore)} {'->'} {formatHuf(entry.balanceAfter)}
                      </small>
                    </span>
                  </div>
                ))}
                {ledgerEntries.length === 0 && !loading ? <p className="helper-text">Még nincs ledger bejegyzés.</p> : null}
              </div>
            </section>
          </div>

          <section className="panel">
            <h3 className="card-title">Naplóelőzmények</h3>
            <p className="helper-text">A kiválasztott esemény legutóbbi 25 naplóbejegyzése látszik.</p>
            <div className="record-list stacked">
              {auditLogs.slice(0, 25).map((entry) => (
                <div key={entry.id} className="audit-row">
                  <div className="split-header">
                    <strong>{entry.type}</strong>
                    <span className="helper-text">{formatTimestamp(entry.createdAt)}</span>
                  </div>
                  <p className="helper-text">{entry.summary}</p>
                </div>
              ))}
              {auditLogs.length === 0 && !loading ? <p className="helper-text">Még nincs naplóbejegyzés.</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
