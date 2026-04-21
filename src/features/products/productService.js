import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { parseHufInteger } from '../../lib/money'
import { buildProductPatch, buildProductRecord } from './productModels'

export function subscribeToProducts(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.products)),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export { PRODUCT_CATEGORIES } from './productModels'

export async function saveProduct({
  eventId,
  actorUid,
  productId,
  name,
  category,
  price,
  isActive,
  isTemporarilyUnavailable,
  modifierTemplateId,
}) {
  const parsedPrice = parseHufInteger(price)

  if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
    throw new Error('Price must be a non-negative integer HUF value.')
  }

  const batch = writeBatch(db)
  const targetRef = productId
    ? doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.products, productId))
    : doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.products)))

  const payload = {
    name,
    category,
    price: parsedPrice,
    isActive,
    isTemporarilyUnavailable,
    modifierTemplateId,
    actorUid,
  }

  batch.set(
    targetRef,
    productId ? buildProductPatch(payload) : buildProductRecord(payload),
    { merge: Boolean(productId) },
  )

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.productChange,
    actorUid,
    summary: `${productId ? 'Updated' : 'Created'} product ${name}`,
    targetType: 'product',
    targetId: targetRef.id,
    details: {
      category,
      price: parsedPrice,
      isActive,
      isTemporarilyUnavailable,
      modifierTemplateId: modifierTemplateId || null,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}
