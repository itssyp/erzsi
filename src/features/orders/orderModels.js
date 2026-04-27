import { serverTimestamp } from 'firebase/firestore'

export const ORDER_STATUSES = {
  finalized: 'finalized',
}

export const FOOD_ORDER_STATUSES = {
  new: 'new',
  preparing: 'preparing',
  ready: 'ready',
  delivered: 'delivered',
}

export function buildOrderRecord({
  basket,
  person,
  actorUid,
  actorName,
}) {
  const hasFood = basket.items.some((item) => item.category === 'food')
  const hasDrs = basket.items.some((item) => item.lineType === 'drs')
  const drsBottleCount = basket.items
    .filter((item) => item.lineType === 'drs')
    .reduce((sum, item) => sum + item.quantity, 0)
  const drsReturnedCount = basket.items
    .filter((item) => item.lineType === 'drsReturn')
    .reduce((sum, item) => sum + item.quantity, 0)

  return {
    personId: person.id,
    personDisplayName: person.displayName,
    personInternalId: person.internalId,
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
    createdByUid: actorUid,
    createdByName: actorName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}
