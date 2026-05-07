import {
  collection,
  doc,
  getDocs,
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

const MAX_IMPORT_BATCH_SIZE = 400

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
  isDRS = false,
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
    isDRS,
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
      isDRS,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

export async function importProducts({
  eventId,
  actorUid,
  products,
}) {
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('No valid products were provided for import.')
  }

  for (const product of products) {
    const parsedPrice = parseHufInteger(product.price)

    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      throw new Error(`Invalid product price for "${product.name}".`)
    }
  }

  for (let startIndex = 0; startIndex < products.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = products.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

    chunk.forEach((product) => {
      const targetRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.products)))
      batch.set(targetRef, buildProductRecord({
        name: product.name,
        category: product.category,
        price: parseHufInteger(product.price),
        isActive: true,
        isTemporarilyUnavailable: false,
        modifierTemplateId: '',
        isDRS: product.isDRS,
        actorUid,
      }))
    })

    await batch.commit()
  }

  const auditBatch = writeBatch(db)
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.import,
    actorUid,
    summary: `Imported ${products.length} products`,
    targetType: 'productImport',
    targetId: null,
    details: {
      importedCount: products.length,
      categories: [...new Set(products.map((product) => product.category))].sort(),
    },
  })

  auditBatch.set(auditLogWrite.ref, auditLogWrite.data)
  await auditBatch.commit()
}

export async function clearProducts({
  eventId,
  actorUid,
}) {
  const snapshot = await getDocs(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.products)))

  if (!snapshot.size) {
    return 0
  }

  for (let startIndex = 0; startIndex < snapshot.docs.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = snapshot.docs.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

    chunk.forEach((item) => {
      batch.delete(item.ref)
    })

    await batch.commit()
  }

  const auditBatch = writeBatch(db)
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.productChange,
    actorUid,
    summary: `Cleared ${snapshot.size} products`,
    targetType: 'productCollection',
    targetId: null,
    details: {
      clearedCount: snapshot.size,
    },
  })

  auditBatch.set(auditLogWrite.ref, auditLogWrite.data)
  await auditBatch.commit()

  return snapshot.size
}

export async function deleteProduct({
  eventId,
  actorUid,
  productId,
  name,
}) {
  const batch = writeBatch(db)
  const targetRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.products, productId))

  batch.delete(targetRef)

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.productChange,
    actorUid,
    summary: `Deleted product ${name}`,
    targetType: 'product',
    targetId: productId,
    details: {
      deletedAt: new Date().toISOString(),
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}
