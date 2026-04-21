import { StatusCard } from '../../components/StatusCard'
import { LoadingScreen } from '../../components/LoadingScreen'
import { formatHuf } from '../../lib/money'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { QrCodeCard } from '../user/QrCodeCard'
import { useUserDashboardData } from '../user/useUserDashboardData'
import { TabShell } from '../../components/TabShell'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'

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
      {FOOD_STATUS_STEPS.map((step, i) => {
        const isDone = i < currentIndex
        const isCurrent = i === currentIndex
        return (
          <div key={step} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
              <div className={`order-status-dot${isDone ? ' done' : isCurrent ? ' current' : ''}`} />
              <span className={`order-status-label${isDone || isCurrent ? ' done' : ''}`}>
                {STATUS_LABELS[step]}
              </span>
            </div>
            {i < FOOD_STATUS_STEPS.length - 1 && (
              <div className={`order-status-line${isDone ? ' done' : ''}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatOrderTimestamp(value) {
  if (!value?.toDate) return 'Függőben...'
  return value.toDate().toLocaleString('hu-HU')
}

export function UserDashboardPage() {
  const { account, user } = useAuth()
  const { activeEvent, activeEventId } = useActiveEvent()
  const { loading, person, orders, activeFoodOrder, hasLinkedPerson, error } = useUserDashboardData({
    uid: user?.uid,
    eventId: activeEventId,
  })

  if (loading) {
    return <LoadingScreen label="Eseményprofil betöltése" />
  }

  const tabs = hasLinkedPerson ? [
    {
      id: 'overview',
      label: 'Áttekintés',
      component: (
        <div className="two-column-grid">
          <section className="panel">
            <div className="balance-label">Jelenlegi egyenleg</div>
            <div className="balance-value">{formatHuf(person.balance || 0)}</div>
            <div style={{ height: '1px', background: 'var(--border)', margin: '16px 0' }} />
            <ul className="detail-list">
              <li><strong>Név</strong> <span>{person.displayName}</span></li>
              <li><strong>Csapat</strong> <span>{person.team || '-'}</span></li>
              <li><strong>Típus</strong> <span style={{ textTransform: 'capitalize' }}>{person.attendeeType}</span></li>
              <li><strong>Esemény</strong> <span>{activeEvent?.name || activeEventId}</span></li>
            </ul>
          </section>

          <QrCodeCard value={person.assignedQrLink || person.qrCodeId} label="Saját QR-kód" />

          <section className="panel">
            <h3 className="card-title">Fiók</h3>
            <ul className="detail-list">
              <li><strong>Megjelenített név</strong> <span>{account?.displayName || user?.displayName || '-'}</span></li>
              <li><strong>E-mail</strong> <span style={{ fontSize: '0.82rem' }}>{account?.email || user?.email || '-'}</span></li>
              <li><strong>Belső azonosító</strong> <span>{person.internalId}</span></li>
              <li><strong>QR-azonosító</strong> <span>{person.assignedQrId || person.qrCodeId || 'Nincs hozzárendelve'}</span></li>
            </ul>
          </section>
        </div>
      ),
    },
    {
      id: 'active',
      label: 'Aktív rendelés',
      component: (
        <section className="panel">
          <h3 className="card-title">Aktív ételrendelés</h3>
          {activeFoodOrder ? (
            <div>
              <FoodOrderTracker status={activeFoodOrder.foodStatus || FOOD_ORDER_STATUSES.new} />
              <p className="helper-text" style={{ marginTop: '16px', marginBottom: '12px' }}>
                Rendelés ideje: {formatOrderTimestamp(activeFoodOrder.createdAt)}
              </p>
              <ul className="detail-list">
                {activeFoodOrder.lines
                  .filter((line) => line.category === 'food')
                  .map((line) => (
                    <li key={line.lineId}>
                      <strong>{line.quantity} x {line.productName}</strong>
                      <span>{formatHuf(line.lineTotal)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <p className="helper-text">Jelenleg nincs aktív ételrendelés.</p>
          )}
        </section>
      ),
    },
    {
      id: 'history',
      label: 'Előzmények',
      component: (
        <section className="panel">
          <h3 className="card-title">Korábbi rendelések</h3>
          <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {orders.map((order) => (
              <article
                key={order.id}
                style={{
                  padding: '14px 16px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg)',
                }}
              >
                <div className="split-header" style={{ marginBottom: '10px' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '1rem' }}>{formatHuf(order.totalAmount)}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '2px' }}>
                      {formatOrderTimestamp(order.createdAt)}
                    </div>
                  </div>
                  <div className="pill-row">
                    {order.hasFood ? (
                      <span className="event-pill">{order.foodStatus || 'étel'}</span>
                    ) : null}
                    {order.refundedTotal > 0 ? (
                      <span className="event-pill" style={{ background: 'var(--success-soft)', borderColor: '#86efac', color: 'var(--success)' }}>
                        Visszatérítve: {formatHuf(order.refundedTotal)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <ul className="detail-list">
                  {order.lines.map((line) => (
                    <li key={line.lineId}>
                      <span>{line.quantity} x {line.productName}</span>
                      <span style={{ fontWeight: 700 }}>{formatHuf(line.lineTotal)}</span>
                    </li>
                  ))}
                </ul>
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
    <>
      <section className="page-heading">
        <span className="eyebrow">Résztvevő</span>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Saját tábori irányítópult</h2>
        <p className="muted" style={{ marginTop: '4px' }}>
          Egyenleg, QR-kód és rendelési előzmények.
        </p>
      </section>

      {error ? <div className="error-banner" style={{ marginBottom: '16px' }}>{error.message}</div> : null}

      {!hasLinkedPerson ? (
        <StatusCard
          title="Admin összekapcsolásra vár"
          tone="warning"
          body="A fiókod már létezik, de még nincs összekapcsolva egy résztvevői profillal az aktív eseményben. Kérj meg egy staff tagot vagy szervezőt a kapcsolás elvégzésére."
        >
          <ul className="detail-list" style={{ marginTop: '12px' }}>
            <li><strong>Bejelentkezve mint</strong> <span>{account?.email || user?.email || '-'}</span></li>
            <li><strong>Aktív esemény</strong> <span>{activeEvent?.name || activeEventId || 'Nincs aktív esemény'}</span></li>
          </ul>
        </StatusCard>
      ) : (
        <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <TabShell tabs={tabs} />
        </div>
      )}
    </>
  )
}
