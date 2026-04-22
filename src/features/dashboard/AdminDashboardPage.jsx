import { AccountManagementPanel } from '../admin/AccountManagementPanel'
import { AuditLogPanel } from '../admin/AuditLogPanel'
import { EventArchivePanel } from '../admin/EventArchivePanel'
import { EventManagementPanel } from '../admin/EventManagementPanel'
import { PeopleManagementPanel } from '../admin/PeopleManagementPanel'
import { DrsSummaryPanel } from '../drs/DrsSummaryPanel'
import { StatusCard } from '../../components/StatusCard'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { TabShell } from '../../components/TabShell'

export function AdminDashboardPage() {
  const { account, user } = useAuth()
  const { activeEvent, activeEventId, hasActiveEvent, runtime } = useActiveEvent()

  const tabs = [
    {
      id: 'overview',
      label: 'Áttekintés',
      component: (
        <div className="dashboard-grid">
          <section className="panel">
            <h3 className="card-title">Aktív esemény</h3>
            <ul className="detail-list">
              <li><strong>Név</strong> <span>{activeEvent?.name || '-'}</span></li>
              <li><strong>Azonosító</strong> <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{activeEventId || '-'}</span></li>
              <li><strong>Állapot</strong> <span style={{ textTransform: 'capitalize' }}>{activeEvent?.status || '-'}</span></li>
              <li><strong>Kezdet</strong> <span>{activeEvent?.startsOn || '-'}</span></li>
            </ul>
          </section>

          <section className="panel">
            <h3 className="card-title">Admin fiók</h3>
            <ul className="detail-list">
              <li><strong>Név</strong> <span>{account?.displayName || user?.displayName || '-'}</span></li>
              <li><strong>E-mail</strong> <span style={{ fontSize: '0.82rem' }}>{account?.email || user?.email || '-'}</span></li>
              <li><strong>Szerepkör</strong> <span>Admin</span></li>
            </ul>
          </section>

          <section className="panel">
            <h3 className="card-title">Gyors műveletek</h3>
            <p className="helper-text" style={{ marginBottom: '12px' }}>A fenti fülekkel kezelheted az eseményt és az adatait.</p>
            <ul className="detail-list">
              <li><strong>Események fül</strong> <span>Események létrehozása és aktiválása</span></li>
              <li><strong>Személyek fül</strong> <span>Perszónák importálása, fiókok kapcsolása és QR-azonosítók kezelése</span></li>
              <li><strong>Katalógus oldal</strong> <span>Termékek és módosítók kezelése a közös staff/admin útvonalon</span></li>
              <li><strong>Fiókok fül</strong> <span>Staff és admin fiókok kezelése</span></li>
              <li><strong>Napló fül</strong> <span>Teljes tevékenységi napló</span></li>
            </ul>
          </section>
        </div>
      ),
    },
    {
      id: 'events',
      label: 'Események',
      component: (
        <div className="stack-block">
          <EventManagementPanel activeEventId={activeEventId} actorUid={user?.uid} />
          <EventArchivePanel activeEventId={activeEventId} />
        </div>
      ),
    },
    {
      id: 'people',
      label: 'Személyek és pénzügyek',
      component: activeEventId ? (
        <PeopleManagementPanel eventId={activeEventId} actorUid={user?.uid} />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt." />
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
      component: activeEventId ? (
        <AuditLogPanel eventId={activeEventId} />
      ) : (
        <StatusCard title="Nincs aktív esemény" tone="warning" body="Először válassz vagy hozz létre egy eseményt." />
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
              <strong>Jelenlegi runtime dokumentum:</strong> {runtime ? JSON.stringify(runtime) : 'Hiányzik vagy üres'}
            </li>
            <li>
              <strong>Kezdeti admin fiók:</strong> {account?.displayName || user?.email}
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
