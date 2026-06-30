import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { FOOD_ORDER_STATUSES } from './orderModels'
import { buildLedgerEntryRecord, LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'

export function subscribeOrdersForPerson(eventId, personId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.orders)),
      where('personId', '==', personId),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export function subscribeOrdersForEvent(eventId, onNext, onError, options = {}) {
  const constraints = [orderBy('createdAt', 'desc')]

  if (options.limitCount) {
    constraints.push(limit(options.limitCount))
  }

  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.orders)),
      ...constraints,
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export function subscribeDrsOrders(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.orders)),
      where('hasDrs', '==', true),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export function subscribeFoodOrders(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.orders)),
      where('hasFood', '==', true),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export function subscribeOrder(eventId, orderId, onNext, onError) {
  return onSnapshot(
    doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.orders, orderId)),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}

/**
 * Advance a kitchen ticket's status.
 *
 * `station` is required. The transaction updates the per-station status map
 * and recomputes the legacy single `foodStatus` field (least-advanced across
 * all stations the order touched) so consumers that haven't been split-aware
 * yet — useKitchenWorkload, the POS workload mini-widget, subscribeFoodOrders
 * — keep working.
 *
 * For orders that pre-date the split feature and don't have foodStatusByStation
 * yet, the transaction synthesizes the map from the order's current foodStatus
 * (every station present in the order shares the same starting status) so the
 * first per-station write doesn't lose track of the others.
 */
export async function updateFoodOrderStatus({
  eventId,
  orderId,
  station,
  nextStatus,
  actorUid,
  actorName,
}) {
  if (!Object.values(FOOD_ORDER_STATUSES).includes(nextStatus)) {
    throw new Error('Invalid food order status.')
  }
  if (!station || typeof station !== 'string') {
    throw new Error('Station is required for kitchen status updates.')
  }

  const orderRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.orders, orderId))

  await runTransaction(db, async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef)

    if (!orderSnapshot.exists()) {
      throw new Error('Order was not found.')
    }

    const order = orderSnapshot.data()

    if (!order.hasFood) {
      throw new Error('Only food orders can be updated in the kitchen queue.')
    }

    // Lazy fallback: synthesize the per-station map for orders created before
    // the split feature shipped. We iterate lines client-side and classify
    // each — same logic as kitchenStations.classifyKitchenStation, inlined
    // here to avoid pulling kitchen into the order-service module graph.
    let byStation = order.foodStatusByStation ? { ...order.foodStatusByStation } : null
    if (!byStation) {
      byStation = {}
      const fallbackStatus = order.foodStatus || FOOD_ORDER_STATUSES.new
      for (const line of order.lines || []) {
        if (!_isFoodCategoryName(line.category)) continue
        const s = _classifyLineStation(line)
        if (!s || byStation[s]) continue
        byStation[s] = fallbackStatus
      }
    }

    const currentStationStatus = byStation[station] || FOOD_ORDER_STATUSES.new

    if (currentStationStatus === nextStatus && order.foodStatusByStation) {
      // No-op if nothing changed AND the map already exists (lazy materialization
      // still needs to write through on the first call).
      return
    }

    byStation[station] = nextStatus
    const overall = _deriveOverallFoodStatus(byStation)

    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.kitchenStatusChange,
      actorUid,
      summary: `Kitchen ${station} ${currentStationStatus} → ${nextStatus}`,
      targetType: 'order',
      targetId: orderId,
      personId: order.personId,
      details: {
        station,
        previousStatus: currentStationStatus,
        nextStatus,
        overallStatus: overall,
      },
    })

    transaction.set(
      orderRef,
      {
        // Per-station maps. Using dot notation for the individual key keeps
        // sibling keys (other stations) intact when merge:true is set.
        [`foodStatusByStation.${station}`]: nextStatus,
        [`foodStatusUpdatedAtByStation.${station}`]: serverTimestamp(),
        [`foodStatusUpdatedByByStation.${station}`]: { uid: actorUid, name: actorName },
        // If we just materialized the map for an old order, write the whole
        // map so the other stations get persisted alongside.
        ...(!order.foodStatusByStation ? { foodStatusByStation: byStation } : {}),
        // Legacy single field kept in sync with the derived overall status so
        // POS workload and subscribeFoodOrders keep working unchanged.
        foodStatus: overall,
        foodStatusUpdatedAt: serverTimestamp(),
        foodStatusUpdatedByUid: actorUid,
        foodStatusUpdatedByName: actorName,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(auditLogWrite.ref, auditLogWrite.data)
  })
}

// ── Internal helpers (kept inline to avoid circular imports) ────────────────

// Mirrors productModels.isFoodCategory, intentionally inlined.
function _isFoodCategoryName(category) {
  const normalized = String(category || '').trim().toLowerCase()
  return normalized === 'kaja' || normalized === 'food'
}

const _STATION_PATTERNS = [
  { kind: 'burger', re: /\b(?:ham)?burger\b/i },
  { kind: 'gyros',  re: /\bgyros\b/i },
  { kind: 'pizza',  re: /\bpizza\b/i },
]
function _classifyLineStation(line) {
  const haystack = `${line.productName || ''} ${line.modifierTemplateId || ''}`
  for (const { kind, re } of _STATION_PATTERNS) if (re.test(haystack)) return kind
  return 'other'
}

function _deriveOverallFoodStatus(byStation) {
  const values = Object.values(byStation || {}).filter(Boolean)
  if (!values.length) return null
  const order = [
    FOOD_ORDER_STATUSES.new,
    FOOD_ORDER_STATUSES.preparing,
    FOOD_ORDER_STATUSES.ready,
    FOOD_ORDER_STATUSES.delivered,
  ]
  if (values.every((v) => v === FOOD_ORDER_STATUSES.delivered)) return FOOD_ORDER_STATUSES.delivered
  let minIdx = Infinity
  for (const v of values) {
    const i = order.indexOf(v)
    const safeI = i === -1 ? 0 : i
    if (safeI < minIdx) minIdx = safeI
  }
  return order[minIdx] || FOOD_ORDER_STATUSES.new
}

export async function refundOrder({ eventId, orderId, actorUid }) {
  const orderRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.orders, orderId))
  const personRef = (personId) => doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const ledgerRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)))

  await runTransaction(db, async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef)

    if (!orderSnapshot.exists()) {
      throw new Error('Order not found.')
    }

    const order = orderSnapshot.data()
    const refundableAmount = (order.totalAmount || 0) - (order.refundedTotal || 0)

    if (refundableAmount <= 0) {
      throw new Error('This order has already been fully refunded.')
    }

    const personSnapshot = await transaction.get(personRef(order.personId))

    if (!personSnapshot.exists()) {
      throw new Error('Persona not found.')
    }

    const person = personSnapshot.data()
    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore + refundableAmount

    const refundedLines = (order.lines || []).map((line) => ({
      ...line,
      refundedQuantity: line.quantity,
    }))

    const refundEntry = {
      refundedAt: serverTimestamp(),
      refundedByUid: actorUid,
      amount: refundableAmount,
    }

    transaction.set(
      orderRef,
      {
        refundedTotal: order.totalAmount,
        netAmount: 0,
        lines: refundedLines,
        refundHistory: [...(order.refundHistory || []), refundEntry],
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )

    transaction.set(
      personRef(order.personId),
      { balance: balanceAfter, updatedAt: serverTimestamp() },
      { merge: true },
    )

    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: LEDGER_ENTRY_TYPES.refund,
        actorUid,
        personId: order.personId,
        amount: refundableAmount,
        balanceBefore,
        balanceAfter,
        reason: `Refund for order ${orderId}`,
      }),
    )

    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.refund,
      actorUid,
      summary: `Order refunded for ${order.personDisplayName || order.personId}: +${refundableAmount} Ft`,
      targetType: 'order',
      targetId: orderId,
      personId: order.personId,
      details: { refundableAmount, balanceBefore, balanceAfter, orderId },
    })

    transaction.set(auditLogWrite.ref, auditLogWrite.data)
  })
}
