import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
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
import {
  buildEventActivationPatch,
  buildEventRecord,
  buildKitchenStatusPatch,
  buildRuntimeRecord,
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
    query(collection(db, EVENTS_COLLECTION), orderBy('createdAt', 'desc')),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

async function cloneCatalogFromSourceEvent({
  sourceEventId,
  targetEventId,
  actorUid,
}) {
  const [templateSnapshot, productSnapshot] = await Promise.all([
    getDocs(collection(db, getEventCollectionPath(sourceEventId, EVENT_SUBCOLLECTIONS.modifierTemplates))),
    getDocs(collection(db, getEventCollectionPath(sourceEventId, EVENT_SUBCOLLECTIONS.products))),
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

    batch.set(
      doc(db, getEventScopedPath(targetEventId, EVENT_SUBCOLLECTIONS.products, item.id)),
      buildProductRecord({
        name: product.name,
        category: product.category,
        price: product.price,
        isActive: Boolean(product.isActive),
        isTemporarilyUnavailable: Boolean(product.isTemporarilyUnavailable),
        modifierTemplateId: product.modifierTemplateId || null,
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

export async function ensureRuntimeDocument(actorUid) {
  const runtimeRef = doc(db, getSystemRuntimePath())
  const runtimeSnapshot = await getDoc(runtimeRef)

  if (runtimeSnapshot.exists()) {
    return runtimeSnapshot.data()
  }

  await setDoc(
    runtimeRef,
    buildRuntimeRecord({ activeEventId: null, actorUid }),
    { merge: true },
  )
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
