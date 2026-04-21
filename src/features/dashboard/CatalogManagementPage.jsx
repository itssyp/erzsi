import { StatusCard } from '../../components/StatusCard'
import { useAuth } from '../auth/useAuth'
import { useActiveEvent } from '../events/useActiveEvent'
import { ProductManagementPanel } from '../admin/ProductManagementPanel'

export function CatalogManagementPage() {
  const { user } = useAuth()
  const { activeEvent, activeEventId } = useActiveEvent()

  return (
    <>
      {activeEventId ? (
        <ProductManagementPanel eventId={activeEventId} actorUid={user?.uid} />
      ) : (
        <StatusCard
          title="Nincs aktív esemény"
          tone="warning"
          body={`A katalógus szerkesztése előtt hozz létre vagy aktiválj egy eseményt${activeEvent?.name ? ` ehhez: ${activeEvent.name}` : ''}.`}
        />
      )}
    </>
  )
}
