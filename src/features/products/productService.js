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
import { normalizeSearchText } from '../../lib/normalize'
import { buildProductPatch, buildProductRecord } from './productModels'
import { sanitizeProductBarcodes } from './productBarcodes'
import { buildStockItemRecord, parseStockInteger, STOCK_UNITS } from '../stock/stockModels'

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

function normalizeImportedStockName(name) {
  return normalizeSearchText(name)
}

function createRecipeComponentFromStockItem(stockItemRef, component) {
  return {
    id: crypto.randomUUID(),
    stockItemId: stockItemRef.id,
    stockItemName: component.stockItemName,
    quantityPerUnit: parseStockInteger(component.quantityPerUnit, 0),
  }
}

function createRecipeFromImport(product, ensureStockItem) {
  const stockImport = product.stockImport

  if (!stockImport || stockImport.mode === 'none') {
    return product.stockRecipe
  }

  if (stockImport.mode === 'self') {
    const stockItemRef = ensureStockItem({
      name: product.name,
      unit: stockImport.unit || STOCK_UNITS.piece,
      currentQuantity: stockImport.quantity,
      lowThreshold: stockImport.lowThreshold,
      applyQuantity: true,
    })

    return {
      enabled: true,
      components: [
        {
          id: crypto.randomUUID(),
          stockItemId: stockItemRef.id,
          stockItemName: product.name,
          quantityPerUnit: 1,
        },
      ],
      choiceGroups: [],
    }
  }

  const components = (stockImport.components || []).map((component) => {
    const stockItemRef = ensureStockItem({
      name: component.stockItemName,
      unit: component.unit || STOCK_UNITS.ml,
      currentQuantity: 0,
      lowThreshold: 0,
      applyQuantity: false,
    })
    return createRecipeComponentFromStockItem(stockItemRef, component)
  })

  const choiceGroups = (stockImport.choiceGroups || []).map((group) => ({
    id: crypto.randomUUID(),
    label: group.label,
    options: (group.options || []).map((option) => ({
      id: crypto.randomUUID(),
      label: option.label,
      components: (option.components || []).map((component) => {
        const stockItemRef = ensureStockItem({
          name: component.stockItemName,
          unit: component.unit || STOCK_UNITS.ml,
          currentQuantity: 0,
          lowThreshold: 0,
          applyQuantity: false,
        })
        return createRecipeComponentFromStockItem(stockItemRef, component)
      }),
    })),
  }))

  return {
    enabled: components.length > 0 || choiceGroups.length > 0,
    components,
    choiceGroups,
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

async function prepareImportedStockRecipe({
  eventId,
  actorUid,
  product,
}) {
  if (!product.stockImport || product.stockImport.mode === 'none') {
    return product.stockRecipe
  }

  const stockItemSnapshot = await getDocs(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
  const stockItemRefsByName = new Map()
  const stockItemWrites = new Map()

  stockItemSnapshot.docs.forEach((item) => {
    const stockItem = item.data()
    const normalizedName = normalizeImportedStockName(stockItem.name)
    if (normalizedName) {
      stockItemRefsByName.set(normalizedName, {
        ref: item.ref,
        data: stockItem,
      })
    }
  })

  function ensureStockItem({
    name,
    unit = STOCK_UNITS.piece,
    currentQuantity = 0,
    lowThreshold = 0,
    applyQuantity = false,
  }) {
    const trimmedName = String(name || '').trim()
    const normalizedName = normalizeImportedStockName(trimmedName)
    const existing = stockItemRefsByName.get(normalizedName)

    if (existing) {
      if (applyQuantity) {
        stockItemWrites.set(existing.ref.path, {
          ref: existing.ref,
          data: {
            name: existing.data.name || trimmedName,
            normalizedName,
            unit: unit || existing.data.unit || STOCK_UNITS.piece,
            currentQuantity: parseStockInteger(currentQuantity, 0),
            lowThreshold: Math.max(0, parseStockInteger(lowThreshold, 0)),
            isActive: existing.data.isActive !== false,
            updatedAt: serverTimestamp(),
            updatedBy: actorUid,
          },
          merge: true,
        })
      }
      return existing.ref
    }

    const ref = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
    stockItemRefsByName.set(normalizedName, {
      ref,
      data: {
        name: trimmedName,
        unit,
      },
    })
    stockItemWrites.set(ref.path, {
      ref,
      data: buildStockItemRecord({
        name: trimmedName,
        unit,
        currentQuantity: applyQuantity ? currentQuantity : 0,
        lowThreshold: applyQuantity ? lowThreshold : 0,
        isActive: true,
        actorUid,
      }),
      merge: false,
    })
    return ref
  }

  const stockRecipe = createRecipeFromImport(product, ensureStockItem)
  const stockWrites = Array.from(stockItemWrites.values())

  for (let startIndex = 0; startIndex < stockWrites.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = stockWrites.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

    chunk.forEach((write) => {
      if (write.merge) {
        batch.set(write.ref, write.data, { merge: true })
      } else {
        batch.set(write.ref, write.data)
      }
    })

    await batch.commit()
  }

  return stockRecipe
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
  stockRecipe,
  stockImport,
}) {
  const parsedPrice = parseHufInteger(price)
  const normalizedBarcodes = sanitizeProductBarcodes(barcodes)

  if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
    throw new Error('Price must be a non-negative integer HUF value.')
  }

  const preparedStockRecipe = await prepareImportedStockRecipe({
    eventId,
    actorUid,
    product: {
      name,
      stockRecipe,
      stockImport,
    },
  })

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
    stockRecipe: preparedStockRecipe,
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
      stockRecipe: preparedStockRecipe,
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

  const stockItemSnapshot = await getDocs(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
  const stockItemRefsByName = new Map()
  const stockItemWrites = new Map()

  stockItemSnapshot.docs.forEach((item) => {
    const stockItem = item.data()
    const normalizedName = normalizeImportedStockName(stockItem.name)
    if (normalizedName) {
      stockItemRefsByName.set(normalizedName, {
        ref: item.ref,
        data: stockItem,
      })
    }
  })

  function ensureStockItem({
    name,
    unit = STOCK_UNITS.piece,
    currentQuantity = 0,
    lowThreshold = 0,
    applyQuantity = false,
  }) {
    const trimmedName = String(name || '').trim()
    const normalizedName = normalizeImportedStockName(trimmedName)
    const existing = stockItemRefsByName.get(normalizedName)

    if (existing) {
      if (applyQuantity) {
        stockItemWrites.set(existing.ref.path, {
          ref: existing.ref,
          data: {
            name: existing.data.name || trimmedName,
            normalizedName,
            unit: unit || existing.data.unit || STOCK_UNITS.piece,
            currentQuantity: parseStockInteger(currentQuantity, 0),
            lowThreshold: Math.max(0, parseStockInteger(lowThreshold, 0)),
            isActive: existing.data.isActive !== false,
            updatedAt: serverTimestamp(),
            updatedBy: actorUid,
          },
          merge: true,
        })
      }
      return existing.ref
    }

    const ref = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
    stockItemRefsByName.set(normalizedName, {
      ref,
      data: {
        name: trimmedName,
        unit,
      },
    })
    stockItemWrites.set(ref.path, {
      ref,
      data: buildStockItemRecord({
        name: trimmedName,
        unit,
        currentQuantity: applyQuantity ? currentQuantity : 0,
        lowThreshold: applyQuantity ? lowThreshold : 0,
        isActive: true,
        actorUid,
      }),
      merge: false,
    })
    return ref
  }

  const preparedProducts = products.map((product) => ({
    ...product,
    stockRecipe: createRecipeFromImport(product, ensureStockItem),
  }))

  const stockWrites = Array.from(stockItemWrites.values())

  for (let startIndex = 0; startIndex < stockWrites.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = stockWrites.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

    chunk.forEach((write) => {
      if (write.merge) {
        batch.set(write.ref, write.data, { merge: true })
      } else {
        batch.set(write.ref, write.data)
      }
    })

    await batch.commit()
  }

  for (let startIndex = 0; startIndex < preparedProducts.length; startIndex += MAX_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = preparedProducts.slice(startIndex, startIndex + MAX_IMPORT_BATCH_SIZE)

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
        stockRecipe: product.stockRecipe,
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
      importedStockItemCount: stockWrites.length,
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

export async function updateProductTemporaryAvailability({
  eventId,
  actorUid,
  productId,
  productName,
  isTemporarilyUnavailable,
}) {
  const batch = writeBatch(db)
  const targetRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.products, productId))
  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.productChange,
    actorUid,
    summary: `${isTemporarilyUnavailable ? 'Marked unavailable' : 'Marked available'} product ${productName}`,
    targetType: 'product',
    targetId: productId,
    details: {
      isTemporarilyUnavailable,
      source: 'posLongPress',
    },
  })

  batch.set(
    targetRef,
    {
      isTemporarilyUnavailable,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    },
    { merge: true },
  )
  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}
