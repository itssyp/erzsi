import { StaffPosPanel } from '../pos/StaffPosPanel'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { KitchenQueuePanel } from '../kitchen/KitchenQueuePanel'

export function StaffDashboardPage({ mode = 'sell' }) {
  const { user, account } = useAuth()
  const { activeEventId } = useActiveEvent()
  const actorName = account?.displayName || user?.displayName || user?.email || 'Staff device'

  if (mode === 'kitchen') {
    return (
      <KitchenQueuePanel
        eventId={activeEventId}
        actorUid={user?.uid}
        actorName={actorName}
      />
    )
  }

  return <StaffPosPanel eventId={activeEventId} />
}
