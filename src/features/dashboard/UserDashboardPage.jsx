import { useCallback, useEffect, useState } from 'react'
import { StatusCard } from '../../components/StatusCard'
import { LoadingScreen } from '../../components/LoadingScreen'
import { formatHuf } from '../../lib/money'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { QrCodeCard } from '../user/QrCodeCard'
import { useUserDashboardData } from '../user/useUserDashboardData'
import { joinEventByShibboleth } from '../user/userService'
import { TabShell } from '../../components/TabShell'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { isFoodCategory } from '../products/productModels'
import { getPersonDisplayId } from '../people/personModels'
import { QrSelfAssignOverlay } from '../qr/QrSelfAssignOverlay'

const FOOD_STATUS_STEPS = [
  FOOD_ORDER_STATUSES.new,
  FOOD_ORDER_STATUSES.preparing,
  FOOD_ORDER_STATUSES.ready,
  FOOD_ORDER_STATUSES.delivered,
]

const STATUS_LABELS = {
  [FOOD_ORDER_STATUSES.new]: 'Fogadva',
  [FOOD_ORDER_STATUSES.preparing]: 'Készül',
  [FOOD_ORDER_STATUSES.ready]: 'Átvehető',
  [FOOD_ORDER_STATUSES.delivered]: 'Átadva',
}

function FoodOrderTracker({ status }) {
  const currentIndex = FOOD_STATUS_STEPS.indexOf(status)

  return (
    <div className="order-status-track">
      <div className="order-status-rail">
        <div className="order-status-line-layer" aria-hidden="true">
          {FOOD_STATUS_STEPS.slice(0, -1).map((step, i) => (
            <div
              key={`${step}-line`}
              className={`order-status-line${i < currentIndex ? ' done' : ''}`}
            />
          ))}
        </div>
        <div className="order-status-steps">
          {FOOD_STATUS_STEPS.map((step, i) => {
            const isDone = i < currentIndex
            const isCurrent = i === currentIndex
            return (
              <div key={step} className="order-status-step">
              <div className={`order-status-dot${isDone ? ' done' : isCurrent ? ' current' : ''}`} />
              <span className={`order-status-label${isDone || isCurrent ? ' done' : ''}`}>
                {STATUS_LABELS[step]}
              </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatOrderTimestamp(value) {
  if (!value?.toDate) return 'Függőben...'
  return value.toDate().toLocaleString('hu-HU')
}

function getJoinErrorMessage(error) {
  switch (error?.code) {
    case 'functions/not-found':
    case 'functions/failed-precondition':
    case 'functions/invalid-argument':
      return error.message || 'Nem sikerült csatlakozni az eseményhez. Keress egy szervezőt.'
    case 'functions/unauthenticated':
      return 'Jelentkezz be újra a csatlakozáshoz.'
    default:
      return error?.message || 'Nem sikerült csatlakozni az eseményhez. Keress egy szervezőt.'
  }
}

export function UserDashboardPage() {
  const { account, user } = useAuth()
  const { activeEvent, activeEventId } = useActiveEvent()
  const [joinShibboleth, setJoinShibboleth] = useState('')
  const [joinPending, setJoinPending] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [joinStatus, setJoinStatus] = useState('')
  const [showQrAssign, setShowQrAssign] = useState(false)

  const handleQrAssignClose = useCallback(() => setShowQrAssign(false), [])
  const { loading, person, orders, activeFoodOrder, hasLinkedPerson, error } = useUserDashboardData({
    uid: user?.uid,
    eventId: activeEventId,
  })

  useEffect(() => {
    setJoinShibboleth(account?.shibboleth || '')
  }, [account?.shibboleth])

  async function handleJoinEvent(event) {
    event.preventDefault()
    setJoinPending(true)
    setJoinError('')
    setJoinStatus('')

    try {
      await joinEventByShibboleth({
        eventId: activeEventId,
        shibboleth: joinShibboleth,
      })
      setJoinStatus('Sikeres csatlakozás. A profilod betöltése folyamatban van.')
    } catch (joinError) {
      setJoinError(getJoinErrorMessage(joinError))
    } finally {
      setJoinPending(false)
    }
  }

  if (loading) {
    return <LoadingScreen label="Eseményprofil betöltése" />
  }

  const historyTotalSpent = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0)

  const tabs = hasLinkedPerson ? [
    {
      id: 'overview',
      label: 'Áttekintés',
      component: (
        <div className="two-column-grid user-dashboard-grid">
          <section className="panel user-flat-section user-balance-section">
            <div className="balance-label">Jelenlegi egyenleg</div>
            <div className="balance-value">{formatHuf(person.balance || 0)}</div>
            <div style={{ height: '1px', background: 'var(--border)', margin: '16px 0' }} />
            <ul className="detail-list">
              <li><strong>Név</strong> <span>{person.displayName}</span></li>
              <li><strong>Csapat</strong> <span>{person.team || '-'}</span></li>
              <li><strong>Típus</strong> <span style={{ textTransform: 'capitalize' }}>{person.attendeeType}</span></li>
              <li><strong>Shibboleth</strong> <span>{person.shibboleth || '-'}</span></li>
              <li><strong>Esemény</strong> <span>{activeEvent?.name || activeEventId}</span></li>
            </ul>
          </section>

          <div className="user-qr-slot">
            {(person.assignedQrLink || person.qrCodeId) ? (
              <QrCodeCard value={person.assignedQrLink || person.qrCodeId} label="Saját QR-kód" />
            ) : (
              <section className="panel qr-panel user-qr-unassigned">
                <h3 className="card-title">Saját QR-kód</h3>
                <div className="user-qr-empty">
                  <svg className="user-qr-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="3" height="3" rx="0.5" />
                    <rect x="19" y="14" width="2" height="2" rx="0.5" />
                    <rect x="14" y="19" width="2" height="2" rx="0.5" />
                    <rect x="18" y="18" width="3" height="3" rx="0.5" />
                  </svg>
                  <p className="helper-text">Még nincs QR-kód hozzárendelve.</p>
                  <button
                    type="button"
                    className="primary-button user-qr-claim-btn"
                    onClick={() => setShowQrAssign(true)}
                  >
                    QR-kód igénylése
                  </button>
                </div>
              </section>
            )}
          </div>

          <section className="panel user-flat-section">
            <h3 className="card-title">Fiók</h3>
            <ul className="detail-list">
              <li><strong>Megjelenített név</strong> <span>{account?.displayName || user?.displayName || '-'}</span></li>
              <li><strong>E-mail</strong> <span style={{ fontSize: '0.82rem' }}>{account?.email || user?.email || '-'}</span></li>
              <li><strong>Azonosító</strong> <span>{getPersonDisplayId(person)}</span></li>
            </ul>
          </section>
        </div>
      ),
    },
    {
      id: 'active',
      label: 'Aktív rendelés',
      component: (
        <section className="panel user-flat-section user-active-order-section">
          <h3 className="card-title">Aktív ételrendelés</h3>
          {activeFoodOrder ? (
            <div className="user-active-order-content">
              <FoodOrderTracker status={activeFoodOrder.foodStatus || FOOD_ORDER_STATUSES.new} />
              <p className="helper-text" style={{ marginTop: '16px', marginBottom: '12px' }}>
                Rendelés ideje: {formatOrderTimestamp(activeFoodOrder.createdAt)}
              </p>
              <ul className="detail-list">
                {activeFoodOrder.lines
                  .filter((line) => isFoodCategory(line.category))
                  .map((line) => (
                    <li key={line.lineId}>
                      <strong>{line.quantity} x {line.productName}</strong>
                      <span>{formatHuf(line.lineTotal)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <p className="helper-text user-active-order-empty">Jelenleg nincs aktív ételrendelés.</p>
          )}
        </section>
      ),
    },
    {
      id: 'history',
      label: 'Előzmények',
      component: (
        <section className="panel user-flat-section">
          <div className="split-header user-history-summary">
            <h3 className="card-title">Korábbi rendelések</h3>
            <div className="user-history-total">
              <span>Összes költés</span>
              <strong>{formatHuf(historyTotalSpent)}</strong>
            </div>
          </div>
          <div className="user-history-list">
            {orders.map((order) => (
              <article key={order.id} className="receipt-container user-history-receipt">
                <div className="receipt-header user-history-receipt-header">
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '2px' }}>
                    {formatOrderTimestamp(order.createdAt)}
                  </div>
                  {order.hasFood ? (
                    <div className="user-history-meta">{order.foodStatus || 'étel'}</div>
                  ) : null}
                  {order.refundedTotal > 0 ? (
                    <div className="user-history-refund">
                      Visszatérítve: {formatHuf(order.refundedTotal)}
                    </div>
                  ) : null}
                </div>
                <div className="receipt-body">
                  {order.lines.map((line) => (
                    <div key={line.lineId} className="receipt-line">
                      <span className="receipt-item-name">{line.quantity} x {line.productName}</span>
                      <span className="receipt-dots" />
                      <span className="receipt-line-price">{formatHuf(line.lineTotal)}</span>
                    </div>
                  ))}
                </div>
                <div className="receipt-footer">
                  <div className="receipt-subtotal">
                    <span>Tételek</span>
                    <span className="receipt-dots" />
                    <span>{order.lines.reduce((sum, line) => sum + line.quantity, 0)}</span>
                  </div>
                  <div className="receipt-total">
                    <span>TOTAL</span>
                    <span className="receipt-dots" />
                    <span>{formatHuf(order.totalAmount)}</span>
                  </div>
                </div>
              </article>
            ))}
            {orders.length === 0 ? (
              <p className="helper-text">Még nincs lezárt rendelés.</p>
            ) : null}
          </div>
        </section>
      ),
    },
  ] : []

  return (
    <div className="user-dashboard-page">
      {error ? <div className="error-banner" style={{ marginBottom: '16px' }}>{error.message}</div> : null}

      {!hasLinkedPerson ? (
        <StatusCard
          title="Csatlakozás az eseményhez"
          tone="warning"
          body="A fiókod még nincs összekapcsolva résztvevői profillal az aktív eseményben. Add meg a shibboleth azonosítódat, és ha találunk egyező profilt, automatikusan csatlakozhatsz."
        >
          {joinError ? <div className="error-banner" style={{ marginTop: '12px' }}>{joinError}</div> : null}
          {joinStatus ? <div className="status-inline" style={{ marginTop: '12px' }}>{joinStatus}</div> : null}
          <form className="form-grid" onSubmit={handleJoinEvent} style={{ marginTop: '12px' }}>
            <div className="field">
              <label htmlFor="joinShibboleth">Shibboleth</label>
              <input
                id="joinShibboleth"
                value={joinShibboleth}
                onChange={(event) => setJoinShibboleth(event.target.value)}
                placeholder="Shibboleth azonosító"
                autoComplete="off"
                required
              />
            </div>
            <button
              type="submit"
              className="primary-button"
              disabled={joinPending || !activeEventId || !joinShibboleth.trim()}
            >
              {joinPending ? 'Csatlakozás...' : 'Csatlakozás'}
            </button>
          </form>
          <p className="helper-text" style={{ marginTop: '12px' }}>
            Ha nincs egyező shibboleth az aktív eseményben, vagy a profil már másik fiókhoz tartozik, keress egy szervezőt.
          </p>
          <ul className="detail-list" style={{ marginTop: '12px' }}>
            <li><strong>Bejelentkezve mint</strong> <span>{account?.email || user?.email || '-'}</span></li>
            <li><strong>Fiók shibboleth</strong> <span>{account?.shibboleth || '-'}</span></li>
            <li><strong>Aktív esemény</strong> <span>{activeEvent?.name || activeEventId || 'Nincs aktív esemény'}</span></li>
          </ul>
        </StatusCard>
      ) : (
        <div className="panel user-dashboard-shell" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <TabShell tabs={tabs} className="user-tab-shell" />
        </div>
      )}

      {showQrAssign && hasLinkedPerson ? (
        <QrSelfAssignOverlay
          eventId={activeEventId}
          onClose={handleQrAssignClose}
        />
      ) : null}
    </div>
  )
}
