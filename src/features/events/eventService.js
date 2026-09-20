import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import {
  EVENTS_COLLECTION,
  EVENT_SUBCOLLECTIONS,
  getEventPath,
  getEventCollectionPath,
  getEventScopedPath,
  getSystemRuntimePath,
} from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { buildModifierTemplateRecord } from '../modifiers/modifierTemplateModels'
import { buildProductRecord } from '../products/productModels'
import { sanitizeProductBarcodes } from '../products/productBarcodes'
import { buildStockItemRecord } from '../stock/stockModels'
import {
  EVENT_STATUSES,
  buildEventActivationPatch,
  buildEventRecord,
  buildKitchenStatusPatch,
  buildRuntimeRecord,
  buildSingleNegativePurchasePatch,
  deriveEventCode,
} from './eventModels'

const closeEventAndCarryBalancesCallable = httpsCallable(functions, 'closeEventAndCarryBalances')

export function subscribeToRuntime(onNext, onError) {
  return onSnapshot(
    doc(db, getSystemRuntimePath()),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}

export function subscribeToEventsList(onNext, onError) {
  return onSnapshot(
    collection(db, EVENTS_COLLECTION),
    (snapshot) => {
      const events = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .sort((left, right) => {
          const rightTime = right.createdAt?.toMillis?.() || right.updatedAt?.toMillis?.() || 0
          const leftTime = left.createdAt?.toMillis?.() || left.updatedAt?.toMillis?.() || 0

          return rightTime - leftTime
        })

      onNext(events)
    },
    onError,
  )
}

async function cloneCatalogFromSourceEvent({
  sourceEventId,
  targetEventId,
  actorUid,
}) {
  const [templateSnapshot, productSnapshot, stockItemSnapshot] = await Promise.all([
    getDocs(collection(db, getEventCollectionPath(sourceEventId, EVENT_SUBCOLLECTIONS.modifierTemplates))),
    getDocs(collection(db, getEventCollectionPath(sourceEventId, EVENT_SUBCOLLECTIONS.products))),
    getDocs(collection(db, getEventCollectionPath(sourceEventId, EVENT_SUBCOLLECTIONS.stockItems))),
  ])

  const batch = writeBatch(db)

  templateSnapshot.docs.forEach((item) => {
    const template = item.data()

    batch.set(
      doc(db, getEventScopedPath(targetEventId, EVENT_SUBCOLLECTIONS.modifierTemplates, item.id)),
      buildModifierTemplateRecord({
        name: template.name,
        defaultIncludedIngredients: template.defaultIncludedIngredients || [],
        optionalExtras: template.optionalExtras || [],
        actorUid,
      }),
    )
  })

  productSnapshot.docs.forEach((item) => {
    const product = item.data()
    const barcodes = sanitizeProductBarcodes(product.barcodes || [])

    batch.set(
      doc(db, getEventScopedPath(targetEventId, EVENT_SUBCOLLECTIONS.products, item.id)),
      buildProductRecord({
        name: product.name,
        category: product.category,
        price: product.price,
        isActive: Boolean(product.isActive),
        isTemporarilyUnavailable: Boolean(product.isTemporarilyUnavailable),
        modifierTemplateId: product.modifierTemplateId || null,
        isDRS: Boolean(product.isDRS),
        barcodes,
        stockRecipe: product.stockRecipe,
        actorUid,
      }),
    )

    barcodes.forEach((barcode) => {
      batch.set(
        doc(db, getEventScopedPath(targetEventId, EVENT_SUBCOLLECTIONS.productBarcodes, barcode)),
        {
          barcode,
          productId: item.id,
          productName: product.name,
          updatedAt: serverTimestamp(),
          updatedBy: actorUid,
        },
      )
    })
  })

  stockItemSnapshot.docs.forEach((item) => {
    const stockItem = item.data()

    batch.set(
      doc(db, getEventScopedPath(targetEventId, EVENT_SUBCOLLECTIONS.stockItems, item.id)),
      buildStockItemRecord({
        name: stockItem.name,
        unit: stockItem.unit,
        currentQuantity: 0,
        lowThreshold: stockItem.lowThreshold || 0,
        isActive: Boolean(stockItem.isActive),
        actorUid,
      }),
    )
  })

  const auditLogWrite = createAuditLogWrite({
    eventId: targetEventId,
    type: AUDIT_TYPES.eventChange,
    actorUid,
    summary: `Cloned catalog from event ${sourceEventId}`,
    targetType: 'event',
    targetId: targetEventId,
    details: {
      sourceEventId,
      clonedModifierTemplateCount: templateSnapshot.size,
      clonedProductCount: productSnapshot.size,
      clonedStockItemCount: stockItemSnapshot.size,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

export async function createEvent({
  name,
  code,
  startsOn,
  activateNow,
  cloneProductsFromEventId,
  actorUid,
  currentActiveEventId,
}) {
  if (activateNow && currentActiveEventId) {
    throw new Error('Close the active event before creating and activating a new event.')
  }

  const eventRef = doc(collection(db, EVENTS_COLLECTION))
  const batch = writeBatch(db)
  const eventRecord = buildEventRecord({
    name,
    code,
    startsOn,
    createdBy: actorUid,
    activateNow,
  })

  batch.set(eventRef, eventRecord)

  if (activateNow) {
    batch.set(
      doc(db, getSystemRuntimePath()),
      buildRuntimeRecord({ activeEventId: eventRef.id, actorUid }),
      { merge: true },
    )
  }

  const auditLogWrite = createAuditLogWrite({
    eventId: eventRef.id,
    type: AUDIT_TYPES.eventChange,
    actorUid,
    summary: `${activateNow ? 'Created and activated' : 'Created'} event ${name.trim()}`,
    targetType: 'event',
    targetId: eventRef.id,
    details: {
      code: deriveEventCode(name, code),
      startsOn: startsOn || null,
      activateNow,
      cloneProductsFromEventId: cloneProductsFromEventId || null,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()

  if (cloneProductsFromEventId) {
    await cloneCatalogFromSourceEvent({
      sourceEventId: cloneProductsFromEventId,
      targetEventId: eventRef.id,
      actorUid,
    })
  }

  return eventRef.id
}

export async function activateEvent({ eventId, actorUid, currentActiveEventId }) {
  if (currentActiveEventId && currentActiveEventId !== eventId) {
    throw new Error('Close the active event before activating another event.')
  }

  const batch = writeBatch(db)

  batch.set(
    doc(db, getEventPath(eventId)),
    buildEventActivationPatch({ actorUid }),
    { merge: true },
  )
  batch.set(
    doc(db, getSystemRuntimePath()),
    buildRuntimeRecord({ activeEventId: eventId, actorUid }),
    { merge: true },
  )

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.eventChange,
    actorUid,
    summary: `Activated event ${eventId}`,
    targetType: 'event',
    targetId: eventId,
    details: {
      previousActiveEventId: currentActiveEventId || null,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

export async function closeEventAndCarryBalances({ eventId }) {
  const result = await closeEventAndCarryBalancesCallable({ eventId })

  return result.data
}

/**
 * Ensure the system/runtime document exists and is consistent with the
 * events collection. Self-heals the common desync where runtime.activeEventId
 * is null but an event in the collection has status='active' (which happens
 * when the runtime doc was wiped, when a deploy/seed step ran out of order,
 * or when an atomic batch was partially synced from an offline client).
 *
 * Only auto-recovers when there is exactly ONE unambiguously active event —
 * if multiple events have status='active', the admin must resolve manually.
 */
export async function ensureRuntimeDocument(actorUid) {
  const runtimeRef = doc(db, getSystemRuntimePath())
  const runtimeSnapshot = await getDoc(runtimeRef)
  const runtimeData = runtimeSnapshot.exists() ? runtimeSnapshot.data() : null

  // Runtime already points to an event — trust it (existing happy path).
  if (runtimeData?.activeEventId) {
    return runtimeData
  }

  // Runtime says "no active event". Verify by scanning events for one
  // that is still flagged active. If exactly one exists, re-link the runtime.
  const activeEventsSnapshot = await getDocs(
    query(collection(db, EVENTS_COLLECTION), where('status', '==', EVENT_STATUSES.active)),
  )
  const activeEvents = activeEventsSnapshot.docs.filter((d) => !d.data().closedAt)

  if (activeEvents.length === 1) {
    const recoveredEventId = activeEvents[0].id
    await setDoc(
      runtimeRef,
      buildRuntimeRecord({ activeEventId: recoveredEventId, actorUid }),
      { merge: true },
    )
    return { ...(runtimeData || {}), activeEventId: recoveredEventId }
  }

  // No active event, or ambiguous (multiple) — make sure the doc exists
  // so subsequent code paths don't blow up, but leave activeEventId null.
  if (!runtimeData) {
    await setDoc(
      runtimeRef,
      buildRuntimeRecord({ activeEventId: null, actorUid }),
      { merge: true },
    )
  }

  return runtimeData || { activeEventId: null }
}

export function subscribeToActiveEvent(eventId, onNext, onError) {
  return onSnapshot(
    doc(db, getEventPath(eventId)),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}
export async function setKitchenClosedStatus({ eventId, isClosed, actorUid }) {
  const eventRef = doc(db, getEventPath(eventId))
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.eventChange,
    actorUid,
    summary: isClosed ? 'Closed the kitchen' : 'Opened the kitchen',
    targetType: 'event',
    targetId: eventId,
    details: { isKitchenClosed: isClosed },
  })

  const batch = writeBatch(db)
  batch.set(eventRef, buildKitchenStatusPatch({ isClosed, actorUid }), { merge: true })
  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

export async function setSingleNegativePurchaseStatus({ eventId, isEnabled, actorUid }) {
  const eventRef = doc(db, getEventPath(eventId))
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.eventChange,
    actorUid,
    summary: isEnabled ? 'Enabled one-time negative balance purchases' : 'Disabled one-time negative balance purchases',
    targetType: 'event',
    targetId: eventId,
    details: { allowSingleNegativePurchase: Boolean(isEnabled) },
  })

  const batch = writeBatch(db)
  batch.set(eventRef, buildSingleNegativePurchasePatch({ isEnabled, actorUid }), { merge: true })
  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}
