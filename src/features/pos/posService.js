import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { buildLedgerEntryRecord, LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'
import { buildOrderRecord } from '../orders/orderModels'
import { PERSON_RECORD_STATUSES, getPersonDisplayId } from '../people/personModels'
import { buildDrsReturnRecord, DRS_DEPOSIT_AMOUNT } from '../drs/drsModels'
import {
  BASKET_STATUSES,
  buildOpenBasketRecord,
  summarizeBasketItems,
} from './basketModels'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventPath, getEventScopedPath } from '../../lib/firestorePaths'
import { resolveAssignedQrToPerson } from '../qr/qrService'

const STALE_BASKET_LOCK_MS = 45 * 1000

function basketBelongsToSession(basket, staffUid, sessionId) {
  return basket?.lockOwnerUid === staffUid && basket?.lockSessionId === sessionId
}

function isStaleBasketLock(basket) {
  if (!basket?.updatedAt?.toMillis) {
    return false
  }

  return Date.now() - basket.updatedAt.toMillis() > STALE_BASKET_LOCK_MS
}

function shouldDiscardBasketContents(basket) {
  return basket?.status === BASKET_STATUSES.open && isStaleBasketLock(basket)
}

function assertPersonOperational(person) {
  if (!person) {
    throw new Error('Person record was not found.')
  }

  if (person.recordStatus === PERSON_RECORD_STATUSES.deleted) {
    throw new Error('Deleted person records cannot be used in POS.')
  }
}

function buildLookupError(kind) {
  if (kind === 'qr') {
    return new Error('QR code was not found in the active event.')
  }

  return new Error('Person record was not found.')
}

export async function findPersonByQr(eventId, qrId) {
  const result = await resolveAssignedQrToPerson({
    eventId,
    qrInput: qrId,
  })
  const person = result.person

  assertPersonOperational(person)

  return person
}

export async function acquireBasketLock({
  eventId,
  person,
  staffUid,
  sessionId,
  staffName,
}) {
  const basketRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.baskets, person.id))
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, person.id))

  return runTransaction(db, async (transaction) => {
    const personSnapshot = await transaction.get(personRef)
    const basketSnapshot = await transaction.get(basketRef)

    if (!personSnapshot.exists()) {
      throw buildLookupError('person')
    }

    const personData = { id: personSnapshot.id, ...personSnapshot.data() }
    assertPersonOperational(personData)

    const existingBasket = basketSnapshot.exists() ? basketSnapshot.data() : null

    if (
      existingBasket &&
      existingBasket.status === BASKET_STATUSES.open &&
      !basketBelongsToSession(existingBasket, staffUid, sessionId) &&
      !isStaleBasketLock(existingBasket)
    ) {
      throw new Error(`Basket is currently open on another staff device for ${personData.displayName}.`)
    }

    const nextBasket = buildOpenBasketRecord({
      person: personData,
      items: shouldDiscardBasketContents(existingBasket) ? [] : existingBasket?.items || [],
      staffUid,
      sessionId,
      staffName,
      existingBasket,
    })

    transaction.set(basketRef, nextBasket, { merge: true })

    return {
      id: person.id,
      ...nextBasket,
    }
  })
}

export async function refreshBasketLock({
  eventId,
  personId,
  staffUid,
  sessionId,
  staffName,
}) {
  const basketRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.baskets, personId))
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))

  return runTransaction(db, async (transaction) => {
    const basketSnapshot = await transaction.get(basketRef)
    const personSnapshot = await transaction.get(personRef)

    if (!basketSnapshot.exists() || !personSnapshot.exists()) {
      throw new Error('Active basket was not found.')
    }

    const basket = basketSnapshot.data()
    const person = { id: personSnapshot.id, ...personSnapshot.data() }

    assertPersonOperational(person)

    if (!basketBelongsToSession(basket, staffUid, sessionId) && !isStaleBasketLock(basket)) {
      throw new Error('Another staff device currently owns this basket.')
    }

    transaction.set(
      basketRef,
      buildOpenBasketRecord({
        person,
        items: basket.items || [],
        staffUid,
        sessionId,
        staffName,
        existingBasket: basket,
      }),
      { merge: true },
    )
  })
}

export async function saveBasketItems({
  eventId,
  personId,
  items,
  staffUid,
  sessionId,
  staffName,
}) {
  const basketRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.baskets, personId))
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))

  return runTransaction(db, async (transaction) => {
    const basketSnapshot = await transaction.get(basketRef)
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists()) {
      throw buildLookupError('person')
    }

    const person = { id: personSnapshot.id, ...personSnapshot.data() }
    assertPersonOperational(person)

    if (!basketSnapshot.exists()) {
      throw new Error('Active basket was not found.')
    }

    const basket = basketSnapshot.data()

    if (!basketBelongsToSession(basket, staffUid, sessionId) && !isStaleBasketLock(basket)) {
      throw new Error('Another staff device currently owns this basket.')
    }

    transaction.set(
      basketRef,
      buildOpenBasketRecord({
        person,
        items,
        staffUid,
        sessionId,
        staffName,
        existingBasket: basket,
      }),
      { merge: true },
    )
  })
}

export async function cancelBasket({
  eventId,
  personId,
  staffUid,
  sessionId,
}) {
  const basketRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.baskets, personId))

  await runTransaction(db, async (transaction) => {
    const basketSnapshot = await transaction.get(basketRef)

    if (!basketSnapshot.exists()) {
      return
    }

    const basket = basketSnapshot.data()

    if (!basketBelongsToSession(basket, staffUid, sessionId) && !isStaleBasketLock(basket)) {
      throw new Error('Another staff device currently owns this basket.')
    }

    transaction.delete(basketRef)
  })
}

export async function finalizeBasket({
  eventId,
  personId,
  staffUid,
  sessionId,
  staffName,
}) {
  const basketRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.baskets, personId))
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const eventRef = doc(db, getEventPath(eventId))
  const orderRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.orders)))
  const ledgerRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)))
  const drsReturnRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.drsReturns)))
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.orderFinalization,
    actorUid: staffUid,
    summary: `Finalized POS order for person ${personId}`,
    targetType: 'order',
    targetId: orderRef.id,
    personId,
    details: {},
  })

  return runTransaction(db, async (transaction) => {
    const basketSnapshot = await transaction.get(basketRef)
    const personSnapshot = await transaction.get(personRef)
    const eventSnapshot = await transaction.get(eventRef)

    if (!basketSnapshot.exists()) {
      throw new Error('Active basket was not found.')
    }

    if (!personSnapshot.exists()) {
      throw buildLookupError('person')
    }

    const basket = basketSnapshot.data()
    const person = { id: personSnapshot.id, ...personSnapshot.data() }
    const event = eventSnapshot.exists() ? eventSnapshot.data() : null

    assertPersonOperational(person)

    if (!basketBelongsToSession(basket, staffUid, sessionId) && !isStaleBasketLock(basket)) {
      throw new Error('Another staff device currently owns this basket.')
    }

    if (!basket.items?.length) {
      throw new Error('Basket is empty.')
    }

    const basketSummary = summarizeBasketItems(basket.items)
    const totalAmount = basket.totalAmount ?? basketSummary.totalAmount
    const finalizedBasket = {
      ...basket,
      items: basketSummary.items,
      itemCount: basketSummary.itemCount,
      totalAmount,
    }
    const drsReturnQuantity = basketSummary.items
      .filter((item) => item.lineType === 'drsReturn')
      .reduce((sum, item) => sum + item.quantity, 0)
    const drsReturnCreditAmount = drsReturnQuantity * DRS_DEPOSIT_AMOUNT
    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore - totalAmount
    const allowSingleNegativePurchase = Boolean(event?.allowSingleNegativePurchase)

    if (totalAmount > 0 && balanceBefore < 0) {
      throw new Error(`${person.displayName} is already below zero and cannot purchase again yet.`)
    }

    if (totalAmount > 0 && balanceAfter < 0 && !allowSingleNegativePurchase) {
      throw new Error(
        `${person.displayName} has insufficient balance. ` +
        `Balance: ${balanceBefore} HUF, Purchase: ${totalAmount} HUF.`,
      )
    }

    transaction.set(
      orderRef,
      buildOrderRecord({
        basket: finalizedBasket,
        person,
        actorUid: staffUid,
        actorName: staffName,
      }),
    )
    transaction.set(
      personRef,
      {
        balance: balanceAfter,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: totalAmount < 0 ? LEDGER_ENTRY_TYPES.drsReturn : LEDGER_ENTRY_TYPES.sale,
        actorUid: staffUid,
        personId,
        amount: -totalAmount,
        balanceBefore,
        balanceAfter,
        reason: orderRef.id,
      }),
    )
    if (drsReturnQuantity > 0) {
      transaction.set(
        drsReturnRef,
        buildDrsReturnRecord({
          personId,
          personDisplayName: person.displayName,
          personInternalId: person.internalId,
          personDisplayId: getPersonDisplayId(person),
          quantity: drsReturnQuantity,
          balanceBefore,
          balanceAfter,
          actorUid: staffUid,
          actorName: staffName,
        }),
      )
    }
    transaction.set(
      auditLogWrite.ref,
      {
        ...auditLogWrite.data,
        details: {
          totalAmount,
          drsReturnQuantity,
          drsReturnCreditAmount,
          balanceBefore,
          balanceAfter,
          allowSingleNegativePurchase,
          usedSingleNegativePurchase: totalAmount > 0 && balanceBefore >= 0 && balanceAfter < 0 && allowSingleNegativePurchase,
        },
      },
    )
    transaction.delete(basketRef)

    return {
      orderId: orderRef.id,
      totalAmount,
      balanceAfter,
    }
  })
}

export async function refundOrderLineQuantity({
  eventId,
  orderId,
  lineId,
  quantity,
  actorUid,
  actorName,
}) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Refund quantity must be a positive integer.')
  }

  const orderRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.orders, orderId))
  const ledgerRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)))

  return runTransaction(db, async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef)

    if (!orderSnapshot.exists()) {
      throw new Error('Order was not found.')
    }

    const order = { id: orderSnapshot.id, ...orderSnapshot.data() }
    const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, order.personId))
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists()) {
      throw buildLookupError('person')
    }

    const person = { id: personSnapshot.id, ...personSnapshot.data() }
    const lineIndex = order.lines.findIndex((line) => line.lineId === lineId)

    if (lineIndex === -1) {
      throw new Error('Order line was not found.')
    }

    const targetLine = order.lines[lineIndex]
    const refundableQuantity = targetLine.quantity - (targetLine.refundedQuantity || 0)

    if (quantity > refundableQuantity) {
      throw new Error('Refund quantity exceeds the remaining refundable quantity.')
    }

    const refundAmount = targetLine.unitTotal * quantity
    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore + refundAmount
    const updatedLines = order.lines.map((line, index) =>
      index === lineIndex
        ? {
            ...line,
            refundedQuantity: (line.refundedQuantity || 0) + quantity,
          }
        : line,
    )
    const refundRecord = {
      refundId: crypto.randomUUID(),
      lineId,
      quantity,
      amount: refundAmount,
      actorUid,
      actorName,
      createdAtMs: Date.now(),
    }
    const refundHistory = [...(order.refundHistory || []), refundRecord]
    const refundedTotal = (order.refundedTotal || 0) + refundAmount
    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.refund,
      actorUid,
      summary: `Refunded ${quantity} x ${targetLine.productName}`,
      targetType: 'order',
      targetId: orderId,
      personId: order.personId,
      details: {
        lineId,
        quantity,
        refundAmount,
      },
    })

    transaction.set(
      orderRef,
      {
        lines: updatedLines,
        refundHistory,
        refundedTotal,
        netAmount: order.totalAmount - refundedTotal,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(
      personRef,
      {
        balance: balanceAfter,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: LEDGER_ENTRY_TYPES.refund,
        actorUid,
        personId: order.personId,
        amount: refundAmount,
        balanceBefore,
        balanceAfter,
        reason: `${orderId}:${lineId}`,
      }),
    )
    transaction.set(auditLogWrite.ref, auditLogWrite.data)

    return {
      refundAmount,
      balanceAfter,
    }
  })
}
