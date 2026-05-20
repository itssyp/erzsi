import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { parseHufInteger } from '../../lib/money'
import { buildProductPatch, buildProductRecord } from './productModels'
import { sanitizeProductBarcodes } from './productBarcodes'

const MAX_IMPORT_BATCH_SIZE = 200

function getProductBarcodeRef(eventId, barcode) {
  return doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.productBarcodes, barcode))
}

function buildBarcodeIndexRecord({ barcode, productId, productName, actorUid }) {
  return {
    barcode,
    productId,
    productName: productName.trim(),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}

async function assertBarcodesAvailable({ eventId, barcodes, productId = null }) {
  const barcodeSnapshots = await Promise.all(
    barcodes.map((barcode) => getDoc(getProductBarcodeRef(eventId, barcode))),
  )

  barcodeSnapshots.forEach((snapshot, index) => {
    if (!snapshot.exists()) return
    const existing = snapshot.data()
    if (existing.productId !== productId) {
      throw new Error(`A(z) ${barcodes[index]} vonalkod mar masik termekhez tartozik.`)
    }
  })
}

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
  barcodes = [],
}) {
  const parsedPrice = parseHufInteger(price)
  const normalizedBarcodes = sanitizeProductBarcodes(barcodes)

  if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
    throw new Error('Price must be a non-negative integer HUF value.')
  }

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
    barcodes: normalizedBarcodes,
    actorUid,
  }

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
      barcodes: normalizedBarcodes,
    },
  })

  await runTransaction(db, async (transaction) => {
    const existingProductSnapshot = productId ? await transaction.get(targetRef) : null
    const existingBarcodes = existingProductSnapshot?.exists()
      ? sanitizeProductBarcodes(existingProductSnapshot.data().barcodes || [])
      : []
    const barcodeSnapshots = await Promise.all(
      normalizedBarcodes.map((barcode) => transaction.get(getProductBarcodeRef(eventId, barcode))),
    )

    barcodeSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) return
      const existing = snapshot.data()
      if (existing.productId !== targetRef.id) {
        throw new Error(`A(z) ${normalizedBarcodes[index]} vonalkod mar masik termekhez tartozik.`)
      }
    })

    transaction.set(
      targetRef,
      productId ? buildProductPatch(payload) : buildProductRecord(payload),
      { merge: Boolean(productId) },
    )

    existingBarcodes
      .filter((barcode) => !normalizedBarcodes.includes(barcode))
      .forEach((barcode) => {
        transaction.delete(getProductBarcodeRef(eventId, barcode))
      })

    normalizedBarcodes.forEach((barcode) => {
      transaction.set(getProductBarcodeRef(eventId, barcode), buildBarcodeIndexRecord({
        barcode,
        productId: targetRef.id,
        productName: name,
        actorUid,
      }))
    })

    transaction.set(auditLogWrite.ref, auditLogWrite.data)
  })
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
    product.barcodes = sanitizeProductBarcodes(product.barcodes || [])

    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      throw new Error(`Invalid product price for "${product.name}".`)
    }
  }

  const importedBarcodeOwners = new Map()
  products.forEach((product) => {
    ;(product.barcodes || []).forEach((barcode) => {
      if (importedBarcodeOwners.has(barcode)) {
        throw new Error(`A(z) ${barcode} vonalkod tobbszor szerepel az importban.`)
      }
      importedBarcodeOwners.set(barcode, product.name)
    })
  })

  await assertBarcodesAvailable({
    eventId,
    barcodes: [...importedBarcodeOwners.keys()],
  })

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
        barcodes: product.barcodes || [],
        actorUid,
      }))
      ;(product.barcodes || []).forEach((barcode) => {
        batch.set(getProductBarcodeRef(eventId, barcode), buildBarcodeIndexRecord({
          barcode,
          productId: targetRef.id,
          productName: product.name,
          actorUid,
        }))
      })
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
  const barcodeSnapshot = await getDocs(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.productBarcodes)))

  if (!snapshot.size && !barcodeSnapshot.size) {
    return 0
  }

  const docsToDelete = [...snapshot.docs, ...barcodeSnapshot.docs]

  for (let startIndex = 0; startIndex < docsToDelete.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = docsToDelete.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

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
  const productSnapshot = await getDoc(targetRef)
  const existingBarcodes = productSnapshot.exists()
    ? sanitizeProductBarcodes(productSnapshot.data().barcodes || [])
    : []

  batch.delete(targetRef)
  existingBarcodes.forEach((barcode) => {
    batch.delete(getProductBarcodeRef(eventId, barcode))
  })

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
