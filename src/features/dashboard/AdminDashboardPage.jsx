import { AccountManagementPanel } from '../admin/AccountManagementPanel'
import { AuditLogPanel } from '../admin/AuditLogPanel'
import { EventManagementPanel } from '../admin/EventManagementPanel'
import { PeopleManagementPanel } from '../admin/PeopleManagementPanel'
import { DrsSummaryPanel } from '../drs/DrsSummaryPanel'
import { StatusCard } from '../../components/StatusCard'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { TabShell } from '../../components/TabShell'

function OverviewTab({ activeEvent, activeEventId, account, user, runtime }) {
  return (
    <div className="dashboard-grid">
      <section className="panel admin-overview-event">
        <div className="admin-overview-event-header">
          <div>
            <span className="eyebrow">Active event</span>
            <h3>{activeEvent?.name || '—'}</h3>
          </div>
          {activeEvent ? (
            <span className="event-pill status-active">active</span>
          ) : (
            <span className="event-pill">none</span>
          )}
        </div>
        <ul className="detail-list">
          <li><strong>Code</strong><span style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{activeEvent?.code || '-'}</span></li>
          <li><strong>ID</strong><span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{activeEventId || '-'}</span></li>
          <li><strong>Status</strong><span style={{ textTransform: 'capitalize' }}>{activeEvent?.status || '-'}</span></li>
          <li><strong>Starts</strong><span>{activeEvent?.startsOn || '-'}</span></li>
        </ul>
        {!activeEvent ? (
          <p className="helper-text" style={{ marginTop: '8px' }}>
            Go to <strong>Események</strong> to create or activate an event.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <span className="eyebrow">Admin account</span>
        <h3 style={{ marginTop: '2px', marginBottom: '12px', fontSize: '1.1rem' }}>
          {account?.displayName || user?.displayName || '—'}
        </h3>
        <ul className="detail-list">
          <li><strong>E-mail</strong><span style={{ fontSize: '0.82rem' }}>{account?.email || user?.email || '-'}</span></li>
          <li><strong>Role</strong><span>Admin</span></li>
        </ul>
      </section>

      <section className="panel">
        <span className="eyebrow">Runtime</span>
        <h3 style={{ marginTop: '2px', marginBottom: '12px', fontSize: '1.1rem' }}>System state</h3>
        <ul className="detail-list">
          <li>
            <strong>Runtime doc</strong>
            <span style={{ fontFamily: 'monospace', fontSize: '0.76rem', wordBreak: 'break-all' }}>
              {runtime ? (activeEventId ? `→ ${activeEventId}` : 'present, no active event') : 'missing or empty'}
            </span>
          </li>
          <li>
            <strong>Staff views</strong>
            <span>{activeEventId ? 'open' : 'locked — no active event'}</span>
          </li>
        </ul>
      </section>
    </div>
  )
}

export function AdminDashboardPage() {
  const { account, user } = useAuth()
  const { activeEvent, activeEventId, hasActiveEvent, runtime } = useActiveEvent()

  const tabs = [
    {
      id: 'overview',
      label: 'Áttekintés',
      component: (
        <OverviewTab
          activeEvent={activeEvent}
          activeEventId={activeEventId}
          account={account}
          user={user}
          runtime={runtime}
        />
      ),
    },
    {
      id: 'events',
      label: 'Események',
      component: <EventManagementPanel activeEventId={activeEventId} actorUid={user?.uid} />,
    },
    {
      id: 'people',
      label: 'Személyek',
      component: activeEventId ? (
        <PeopleManagementPanel eventId={activeEventId} actorUid={user?.uid} />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt az Események fülön." />
      ),
    },
    {
      id: 'accounts',
      label: 'Fiókok',
      component: <AccountManagementPanel actorUid={user?.uid} />,
    },
    {
      id: 'drs',
      label: 'DRS',
      component: activeEventId ? (
        <DrsSummaryPanel eventId={activeEventId} />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt." />
      ),
    },
    {
      id: 'audit',
      label: 'Napló',
      component: (
        <AuditLogPanel
          eventId={activeEventId}
          activeEventId={activeEventId}
          showEventSelector
        />
      ),
    },
  ]

  return (
    <>
      <section className="page-heading">
        <span className="eyebrow">Admin</span>
        <h2>Tábori operációs központ</h2>
        <p className="muted">
          Az admin felületről kezelhető az aktív esemény életciklusa, az előkészítés, az archívum és az esemény utáni riportolás.
        </p>
      </section>

      {!hasActiveEvent ? (
        <StatusCard
          title="Még nincs aktív esemény"
          tone="warning"
          body="Innen akkor is létrehozhatsz új eseményt. A staff és felhasználói nézetek addig zárva maradnak, amíg nincs egy aktívra jelölt esemény."
        >
          <ul className="detail-list">
            <li>
              <strong>Runtime dokumentum:</strong> {runtime ? JSON.stringify(runtime) : 'Hiányzik vagy üres'}
            </li>
            <li>
              <strong>Admin fiók:</strong> {account?.displayName || user?.email}
            </li>
          </ul>
        </StatusCard>
      ) : null}

      <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '600px' }}>
        <TabShell tabs={tabs} />
      </div>
    </>
  )
}
