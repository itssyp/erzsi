import { useEffect, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { subscribeDrsOrders } from '../orders/orderService'
import { subscribeDrsReturns } from './drsService'
import { DRS_DEPOSIT_AMOUNT } from './drsModels'

export function DrsSummaryPanel({ eventId }) {
  const [drsOrders, setDrsOrders] = useState([])
  const [drsReturns, setDrsReturns] = useState([])
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    return subscribeDrsOrders(eventId, setDrsOrders, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeDrsReturns(eventId, setDrsReturns, (error) => setErrorMessage(error.message))
  }, [eventId])

  const bottlesSold = drsOrders.reduce((sum, order) => sum + (order.drsBottleCount || 0), 0)
  const bottlesReturned = drsReturns.reduce((sum, r) => sum + (r.quantity || 0), 0)
  const bottlesOutstanding = bottlesSold - bottlesReturned
  const depositCollected = bottlesSold * DRS_DEPOSIT_AMOUNT
  const depositRefunded = bottlesReturned * DRS_DEPOSIT_AMOUNT
  const depositHeld = depositCollected - depositRefunded

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Betétdíj</span>
        <h3>DRS palackkövetés</h3>
        <p className="muted">
          Valós idejű összesítő a kiadott és visszavett betétdíjas palackokról ({DRS_DEPOSIT_AMOUNT} Ft/palack).
        </p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="catalog-summary-grid">
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Kiadott palackok</span>
          <strong style={{ fontSize: '1.5rem' }}>{bottlesSold}</strong>
          <p className="helper-text">{formatHuf(depositCollected)} betétdíj kiszámlázva</p>
        </div>
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Visszavett palackok</span>
          <strong style={{ fontSize: '1.5rem' }}>{bottlesReturned}</strong>
          <p className="helper-text">{formatHuf(depositRefunded)} visszatérítve</p>
        </div>
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Forgalomban lévő palackok</span>
          <strong style={{ fontSize: '1.5rem', color: bottlesOutstanding > 0 ? 'var(--primary)' : undefined }}>
            {bottlesOutstanding}
          </strong>
          <p className="helper-text">{formatHuf(depositHeld)} betétdíj fennáll</p>
        </div>
      </div>

      {drsReturns.length > 0 && (
        <section className="panel" style={{ marginTop: '16px' }}>
          <h4 className="card-title" style={{ marginBottom: '12px' }}>Visszaváltási előzmények</h4>
          <div className="record-list stacked">
            {drsReturns.map((entry) => (
              <div key={entry.id} className="record-row" style={{ cursor: 'default' }}>
                <span>
                  <strong>{entry.personDisplayName}</strong>
                  <small>#{entry.personDisplayId || entry.personInternalId} · {entry.actorName}</small>
                </span>
                <span style={{ textAlign: 'right', flexShrink: 0 }}>
                  <strong>{entry.quantity} palack</strong>
                  <small>{formatHuf(entry.totalCreditAmount)}</small>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {drsReturns.length === 0 && (
        <p className="helper-text" style={{ marginTop: '16px' }}>Még nem történt visszaváltás.</p>
      )}
    </div>
  )
}
