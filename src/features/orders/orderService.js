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
import {
  aggregateStockRefundDeltas,
  buildStockMovementRecord,
  parseStockInteger,
  STOCK_MOVEMENT_TYPES,
} from '../stock/stockModels'

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

  const safeActorUid = actorUid || null
  const safeActorName = actorName || 'Staff device'
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
      actorUid: safeActorUid,
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

    const update = {
      // Legacy single field kept in sync with the derived overall status so
      // POS workload and subscribeFoodOrders keep working unchanged.
      foodStatus: overall,
      foodStatusUpdatedAt: serverTimestamp(),
      foodStatusUpdatedByUid: safeActorUid,
      foodStatusUpdatedByName: safeActorName,
      updatedAt: serverTimestamp(),
    }

    // For the per-station maps we use NESTED OBJECT MERGING instead of dot
    // notation. Firestore's dot-notation field paths only apply to
    // .update() / .transaction.update() — with .set({ merge: true }), a key
    // like "foodStatusByStation.burger" is treated as a literal top-level
    // field name containing a dot, so the write ends up in the wrong place
    // and the actual nested map is never touched. That looked exactly like
    // "the button spins and nothing happens" — silent no-op.
    //
    // { merge: true } recursively merges nested maps, so writing just
    // `{ [station]: nextStatus }` preserves sibling-station statuses.
    if (order.foodStatusByStation) {
      update.foodStatusByStation = { [station]: nextStatus }
      update.foodStatusUpdatedAtByStation = { [station]: serverTimestamp() }
      update.foodStatusUpdatedByByStation = { [station]: { uid: safeActorUid, name: safeActorName } }
    } else {
      // First materialization — write the full computed map for old orders
      // so the other stations get their initial statuses persisted too.
      update.foodStatusByStation = byStation
      update.foodStatusUpdatedAtByStation = { [station]: serverTimestamp() }
      update.foodStatusUpdatedByByStation = { [station]: { uid: safeActorUid, name: safeActorName } }
    }

    transaction.set(orderRef, update, { merge: true })
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

function buildStockItemRef(eventId, stockItemId) {
  return doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.stockItems, stockItemId))
}

function buildStockMovementRef(eventId) {
  return doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockMovements)))
}

async function readStockSnapshots(transaction, eventId, stockDeltas) {
  const pairs = await Promise.all(
    stockDeltas.map(async (delta) => {
      const ref = buildStockItemRef(eventId, delta.stockItemId)
      const snapshot = await transaction.get(ref)
      return [delta.stockItemId, { ref, snapshot }]
    }),
  )

  return new Map(pairs)
}

function mergeStockDelta(target, delta) {
  const current = target.get(delta.stockItemId) || {
    stockItemId: delta.stockItemId,
    stockItemName: delta.stockItemName || '',
    quantityDelta: 0,
    productRefs: [],
  }

  current.quantityDelta += delta.quantityDelta
  current.productRefs.push(...(delta.productRefs || []))
  target.set(delta.stockItemId, current)
}

function aggregateFullOrderRefundStockDeltas(lines) {
  const aggregate = new Map()

  ;(lines || []).forEach((line) => {
    const remainingQuantity = (line.quantity || 0) - (line.refundedQuantity || 0)
    aggregateStockRefundDeltas(line, remainingQuantity).forEach((delta) => {
      mergeStockDelta(aggregate, delta)
    })
  })

  return Array.from(aggregate.values()).filter((delta) => delta.quantityDelta !== 0)
}

function writeStockDeltas({
  transaction,
  eventId,
  stockDeltas,
  stockSnapshots,
  type,
  orderId,
  actorUid,
}) {
  stockDeltas.forEach((delta) => {
    const stockRead = stockSnapshots.get(delta.stockItemId)
    const stockExists = stockRead?.snapshot.exists()
    const stockItem = stockExists
      ? { id: stockRead.snapshot.id, ...stockRead.snapshot.data() }
      : { id: delta.stockItemId, name: delta.stockItemName, unit: 'piece', currentQuantity: null }
    const quantityBefore = stockExists ? parseStockInteger(stockItem.currentQuantity, 0) : null
    const quantityAfter = stockExists ? quantityBefore + delta.quantityDelta : null

    if (stockExists) {
      transaction.set(
        stockRead.ref,
        {
          currentQuantity: quantityAfter,
          updatedAt: serverTimestamp(),
          updatedBy: actorUid,
        },
        { merge: true },
      )
    }

    transaction.set(
      buildStockMovementRef(eventId),
      buildStockMovementRecord({
        stockItemId: delta.stockItemId,
        stockItemName: stockItem.name || delta.stockItemName,
        unit: stockItem.unit || 'piece',
        quantityDelta: delta.quantityDelta,
        quantityBefore,
        quantityAfter,
        type,
        reason: stockExists ? '' : 'Missing stock item during refund',
        orderId,
        lineId: delta.productRefs?.length === 1 ? delta.productRefs[0].lineId : null,
        productId: delta.productRefs?.length === 1 ? delta.productRefs[0].productId : null,
        productName: delta.productRefs?.length === 1 ? delta.productRefs[0].productName : null,
        actorUid,
      }),
    )
  })
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
    const refundStockDeltas = aggregateFullOrderRefundStockDeltas(order.lines)
    const refundStockSnapshots = await readStockSnapshots(transaction, eventId, refundStockDeltas)
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
    writeStockDeltas({
      transaction,
      eventId,
      stockDeltas: refundStockDeltas,
      stockSnapshots: refundStockSnapshots,
      type: STOCK_MOVEMENT_TYPES.refund,
      orderId,
      actorUid,
    })

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
