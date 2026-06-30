import { serverTimestamp } from 'firebase/firestore'
import { isFoodCategory } from '../products/productModels'
import { getPersonDisplayId } from '../people/personModels'

export const ORDER_STATUSES = {
  finalized: 'finalized',
}

export const FOOD_ORDER_STATUSES = {
  new: 'new',
  preparing: 'preparing',
  ready: 'ready',
  delivered: 'delivered',
}

// Defining this locally to avoid pulling kitchenStations into the order model
// circular-import path. Kept in sync with kitchenStations.classifyKitchenStation —
// the helper there is the canonical implementation; this lives here only so
// buildOrderRecord can seed foodStatusByStation at finalization time.
const _ORDER_STATION_PATTERNS = [
  { kind: 'burger', re: /\b(?:ham)?burger\b/i },
  { kind: 'gyros',  re: /\bgyros\b/i },
  { kind: 'pizza',  re: /\bpizza\b/i },
]
function classifyLineStationLocal(line) {
  if (!line || !isFoodCategory(line.category)) return null
  const haystack = `${line.productName || ''} ${line.modifierTemplateId || ''}`
  for (const { kind, re } of _ORDER_STATION_PATTERNS) if (re.test(haystack)) return kind
  return 'other'
}

export function buildOrderRecord({
  basket,
  person,
  actorUid,
  actorName,
}) {
  const hasFood = basket.items.some((item) => isFoodCategory(item.category))
  const hasDrs = basket.items.some((item) => item.lineType === 'drs')
  const drsBottleCount = basket.items
    .filter((item) => item.lineType === 'drs')
    .reduce((sum, item) => sum + item.quantity, 0)
  const drsReturnedCount = basket.items
    .filter((item) => item.lineType === 'drsReturn')
    .reduce((sum, item) => sum + item.quantity, 0)

  // Per-station status map: every station with at least one food line on this
  // order starts at 'new'. Other stations are omitted so the kitchen UI can
  // tell which ones to render and which to skip. See kitchenStations.js for
  // the canonical classifier.
  const foodStatusByStation = {}
  const foodStatusUpdatedAtByStation = {}
  const foodStatusUpdatedByByStation = {}
  if (hasFood) {
    const initiator = { uid: actorUid, name: actorName }
    for (const item of basket.items) {
      const station = classifyLineStationLocal(item)
      if (!station || foodStatusByStation[station]) continue
      foodStatusByStation[station] = FOOD_ORDER_STATUSES.new
      foodStatusUpdatedAtByStation[station] = serverTimestamp()
      foodStatusUpdatedByByStation[station] = initiator
    }
  }

  return {
    personId: person.id,
    personDisplayName: person.displayName,
    personInternalId: person.internalId,
    personDisplayId: getPersonDisplayId(person),
    status: ORDER_STATUSES.finalized,
    lines: basket.items.map((item) => ({
      ...item,
      refundedQuantity: 0,
    })),
    totalAmount: basket.totalAmount,
    refundedTotal: 0,
    netAmount: basket.totalAmount,
    refundHistory: [],
    currency: 'HUF',
    hasFood,
    hasDrs,
    drsBottleCount,
    drsReturnedCount,
    foodStatus: hasFood ? FOOD_ORDER_STATUSES.new : null,
    foodStatusUpdatedAt: hasFood ? serverTimestamp() : null,
    foodStatusUpdatedByUid: hasFood ? actorUid : null,
    foodStatusUpdatedByName: hasFood ? actorName : null,
    foodStatusByStation: hasFood ? foodStatusByStation : null,
    foodStatusUpdatedAtByStation: hasFood ? foodStatusUpdatedAtByStation : null,
    foodStatusUpdatedByByStation: hasFood ? foodStatusUpdatedByByStation : null,
    createdByUid: actorUid,
    createdByName: actorName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}
