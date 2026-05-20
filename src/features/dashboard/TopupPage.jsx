import { StatusCard } from '../../components/StatusCard'
import { PeopleManagementPanel } from '../admin/PeopleManagementPanel'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { ROLES } from '../../lib/roles'

export function TopupPage() {
  const { role, user } = useAuth()
  const { activeEventId } = useActiveEvent()

  if (!activeEventId) {
    return (
      <StatusCard
        title="Nincs aktív esemény"
        tone="warning"
        body="Feltöltéshez először aktív eseményre van szükség."
      />
    )
  }

  return (
    <PeopleManagementPanel
      eventId={activeEventId}
      actorUid={user?.uid}
      view="topup"
      allowManualAdjustment={role === ROLES.admin}
    />
  )
}
