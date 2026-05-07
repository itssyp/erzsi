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

export async function updateFoodOrderStatus({
  eventId,
  orderId,
  nextStatus,
  actorUid,
  actorName,
}) {
  if (!Object.values(FOOD_ORDER_STATUSES).includes(nextStatus)) {
    throw new Error('Invalid food order status.')
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

    const currentStatus = order.foodStatus || FOOD_ORDER_STATUSES.new

    if (currentStatus === nextStatus) {
      return
    }

    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.kitchenStatusChange,
      actorUid,
      summary: `Kitchen status changed from ${currentStatus} to ${nextStatus}`,
      targetType: 'order',
      targetId: orderId,
      personId: order.personId,
      details: {
        previousStatus: currentStatus,
        nextStatus,
      },
    })

    transaction.set(
      orderRef,
      {
        foodStatus: nextStatus,
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
