import { AccountManagementPanel } from '../admin/AccountManagementPanel'
import { AuditLogPanel } from '../admin/AuditLogPanel'
import { EventManagementPanel } from '../admin/EventManagementPanel'
import { PeopleManagementPanel } from '../admin/PeopleManagementPanel'
import { RegisteredUsersPanel } from '../admin/RegisteredUsersPanel'
import { DrsSummaryPanel } from '../drs/DrsSummaryPanel'
import { StatusCard } from '../../components/StatusCard'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { TabShell } from '../../components/TabShell'

function getStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'aktív'
    case 'draft':
      return 'vázlat'
    case 'closed':
      return 'lezárva'
    default:
      return status || '-'
  }
}

function OverviewTab({ activeEvent, activeEventId, account, user, runtime }) {
  return (
    <div className="dashboard-grid">
      <section className="panel admin-overview-event">
        <div className="admin-overview-event-header">
          <div>
            <span className="eyebrow">Aktív esemény</span>
            <h3>{activeEvent?.name || '—'}</h3>
          </div>
          {activeEvent ? (
            <span className="event-pill status-active">aktív</span>
          ) : (
            <span className="event-pill">nincs</span>
          )}
        </div>
        <ul className="detail-list">
          <li><strong>Kód</strong><span style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{activeEvent?.code || '-'}</span></li>
          <li><strong>ID</strong><span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{activeEventId || '-'}</span></li>
          <li><strong>Állapot</strong><span style={{ textTransform: 'capitalize' }}>{getStatusLabel(activeEvent?.status)}</span></li>
          <li><strong>Kezdés</strong><span>{activeEvent?.startsOn || '-'}</span></li>
        </ul>
        {!activeEvent ? (
          <p className="helper-text" style={{ marginTop: '8px' }}>
            Az <strong>Események</strong> fülön hozhatsz létre vagy aktiválhatsz eseményt.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <span className="eyebrow">Admin fiók</span>
        <h3 style={{ marginTop: '2px', marginBottom: '12px', fontSize: '1.1rem' }}>
          {account?.displayName || user?.displayName || '—'}
        </h3>
        <ul className="detail-list">
          <li><strong>E-mail</strong><span style={{ fontSize: '0.82rem' }}>{account?.email || user?.email || '-'}</span></li>
          <li><strong>Szerepkör</strong><span>Admin</span></li>
        </ul>
      </section>

      <section className="panel">
        <span className="eyebrow">Futási állapot</span>
        <h3 style={{ marginTop: '2px', marginBottom: '12px', fontSize: '1.1rem' }}>Rendszerállapot</h3>
        <ul className="detail-list">
          <li>
            <strong>Runtime dokumentum</strong>
            <span style={{ fontFamily: 'monospace', fontSize: '0.76rem', wordBreak: 'break-all' }}>
              {runtime ? (activeEventId ? `→ ${activeEventId}` : 'létezik, nincs aktív esemény') : 'hiányzik vagy üres'}
            </span>
          </li>
          <li>
            <strong>Staff nézetek</strong>
            <span>{activeEventId ? 'nyitva' : 'zárolva - nincs aktív esemény'}</span>
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
        <PeopleManagementPanel eventId={activeEventId} actorUid={user?.uid} view="personas" />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt az Események fülön." />
      ),
    },
    {
      id: 'qrpool',
      label: 'QR Pool',
      component: activeEventId ? (
        <PeopleManagementPanel eventId={activeEventId} actorUid={user?.uid} view="qrpool" />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt az Események fülön." />
      ),
    },
    {
      id: 'accounts',
      label: 'Staff fiókok',
      component: <AccountManagementPanel actorUid={user?.uid} />,
    },
    {
      id: 'registered-users',
      label: 'Felhasználók',
      component: <RegisteredUsersPanel eventId={activeEventId} />,
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
          actorUid={user?.uid}
          showEventSelector
        />
      ),
    },
  ]

  return (
    <>
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
