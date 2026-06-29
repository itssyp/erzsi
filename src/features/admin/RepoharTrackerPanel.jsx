import { useEffect, useMemo, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { subscribeOrdersForEvent } from '../orders/orderService'
import { REUSABLE_CUP_RETURN_AMOUNT } from '../pos/basketModels'

// Repohár sells are regular catalog products named "Repohár" (or similar) — there
// is no dedicated lineType for them, only a productName convention. Matches any
// product whose name contains "repohár" / "repohar" (case + diacritic tolerant).
const REPOHAR_NAME_PATTERN = /repoh[áa]r/i

function classifyLine(line) {
  if (line.lineType === 'reusableCupReturn') return 'return'
  if (line.lineType === 'product' && REPOHAR_NAME_PATTERN.test(line.productName || '')) {
    return 'sell'
  }
  return null
}

function effectiveQuantity(line) {
  // Refunded quantities should not count toward bought / returned totals.
  return Math.max(0, (line.quantity || 0) - (line.refundedQuantity || 0))
}

export function RepoharTrackerPanel({ eventId }) {
  const [orders, setOrders] = useState([])
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!eventId) return undefined
    return subscribeOrdersForEvent(eventId, setOrders, (error) => setErrorMessage(error.message))
  }, [eventId])

  const stats = useMemo(() => {
    const byPerson = new Map()
    let totalBought = 0
    let totalReturned = 0

    orders.forEach((order) => {
      const personId = order.personId
      if (!personId) return

      if (!byPerson.has(personId)) {
        byPerson.set(personId, {
          personId,
          displayName: order.personDisplayName || '—',
          displayId: order.personDisplayId || order.personInternalId || '',
          bought: 0,
          returned: 0,
        })
      }
      const personRow = byPerson.get(personId)

      ;(order.lines || []).forEach((line) => {
        const kind = classifyLine(line)
        if (!kind) return
        const qty = effectiveQuantity(line)
        if (qty <= 0) return
        if (kind === 'sell') {
          personRow.bought += qty
          totalBought += qty
        } else {
          personRow.returned += qty
          totalReturned += qty
        }
      })
    })

    const rows = Array.from(byPerson.values())
      .filter((r) => r.bought > 0 || r.returned > 0)
      .map((r) => ({ ...r, net: r.bought - r.returned }))
      .sort((a, b) => {
        // Largest outstanding first; ties broken alphabetically (Hungarian).
        if (b.net !== a.net) return b.net - a.net
        return a.displayName.localeCompare(b.displayName, 'hu')
      })

    return {
      rows,
      totalBought,
      totalReturned,
      totalOutstanding: totalBought - totalReturned,
    }
  }, [orders])

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Repohár</span>
        <h3>Repohár kiadás és visszaváltás</h3>
        <p className="muted">
          Élő összesítő arról, hogy ki vett és hozott vissza repohárt az aktív eseményben
          {' '}({formatHuf(REUSABLE_CUP_RETURN_AMOUNT)} / pohár).
        </p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="catalog-summary-grid">
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Kiadott repoharak</span>
          <strong style={{ fontSize: '1.5rem' }}>{stats.totalBought}</strong>
          <p className="helper-text">{formatHuf(stats.totalBought * REUSABLE_CUP_RETURN_AMOUNT)} kiszámlázva</p>
        </div>
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Visszahozott repoharak</span>
          <strong style={{ fontSize: '1.5rem' }}>{stats.totalReturned}</strong>
          <p className="helper-text">{formatHuf(stats.totalReturned * REUSABLE_CUP_RETURN_AMOUNT)} visszatérítve</p>
        </div>
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Forgalomban</span>
          <strong style={{ fontSize: '1.5rem', color: stats.totalOutstanding > 0 ? 'var(--primary)' : undefined }}>
            {stats.totalOutstanding}
          </strong>
          <p className="helper-text">{formatHuf(stats.totalOutstanding * REUSABLE_CUP_RETURN_AMOUNT)} fennáll</p>
        </div>
      </div>

      {stats.rows.length > 0 ? (
        <section className="panel" style={{ marginTop: '16px' }}>
          <h4 className="card-title" style={{ marginBottom: '12px' }}>Személyenkénti összesítés</h4>
          <div className="record-list stacked">
            {stats.rows.map((row) => (
              <div key={row.personId} className="record-row" style={{ cursor: 'default' }}>
                <span>
                  <strong>{row.displayName}</strong>
                  {row.displayId ? <small>#{row.displayId}</small> : null}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    gap: '22px',
                    alignItems: 'baseline',
                    textAlign: 'right',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ minWidth: '52px' }}>
                    <strong>{row.bought}</strong>
                    <small style={{ display: 'block' }}>vett</small>
                  </span>
                  <span style={{ minWidth: '64px' }}>
                    <strong>{row.returned}</strong>
                    <small style={{ display: 'block' }}>visszahozott</small>
                  </span>
                  <span style={{ minWidth: '64px' }}>
                    <strong
                      style={{
                        color: row.net > 0
                          ? 'var(--primary)'
                          : row.net < 0
                            ? 'var(--danger)'
                            : undefined,
                      }}
                    >
                      {row.net > 0 ? `+${row.net}` : row.net}
                    </strong>
                    <small style={{ display: 'block' }}>fennáll</small>
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <p className="helper-text" style={{ marginTop: '16px' }}>
          Még nem történt repohár tranzakció ebben az eseményben.
        </p>
      )}
    </div>
  )
}
