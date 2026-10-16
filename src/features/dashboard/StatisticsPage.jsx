import { EventAnalyticsPanel } from '../admin/EventAnalyticsPanel'
import { useActiveEvent } from '../events/useActiveEvent'

export function StatisticsPage() {
  const { activeEventId } = useActiveEvent()

  return <EventAnalyticsPanel activeEventId={activeEventId} />
}
