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
  setDoc,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { normalizeSearchText } from '../../lib/normalize'
import {
  buildStockItemPatch,
  buildStockItemRecord,
  buildStockMovementRecord,
  parseStockInteger,
  STOCK_MOVEMENT_TYPES,
} from './stockModels'

const MAX_STOCK_IMPORT_BATCH_SIZE = 200

export function subscribeToStockItems(eventId, onNext, onError) {
  if (!eventId) {
    onNext([])
    return () => {}
  }

  return onSnapshot(
    query(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)), orderBy('name', 'asc')),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export function subscribeToStockMovements(eventId, onNext, onError) {
  if (!eventId) {
    onNext([])
    return () => {}
  }

  return onSnapshot(
    query(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockMovements)), orderBy('createdAt', 'desc')),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export async function saveStockItem({
  eventId,
  stockItemId,
  name,
  unit,
  currentQuantity,
  lowThreshold,
  isActive,
  actorUid,
}) {
  const trimmedName = String(name || '').trim()

  if (!trimmedName) {
    throw new Error('A készletelem neve kötelező.')
  }

  const targetRef = stockItemId
    ? doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.stockItems, stockItemId))
    : doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))

  const payload = stockItemId
    ? buildStockItemPatch({ name, unit, currentQuantity, lowThreshold, isActive, actorUid })
    : buildStockItemRecord({ name, unit, currentQuantity, lowThreshold, isActive, actorUid })

  await setDoc(targetRef, payload, { merge: Boolean(stockItemId) })
  return targetRef.id
}

export async function applyManualStockMovement({
  eventId,
  stockItemId,
  type,
  amount,
  countedQuantity,
  reason,
  actorUid,
  actorName,
}) {
  const stockRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.stockItems, stockItemId))
  const movementRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockMovements)))

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(stockRef)

    if (!snapshot.exists()) {
      throw new Error('A készletelem nem található.')
    }

    const stockItem = { id: snapshot.id, ...snapshot.data() }
    const quantityBefore = parseStockInteger(stockItem.currentQuantity, 0)
    let quantityDelta = 0

    if (type === STOCK_MOVEMENT_TYPES.manualCorrection) {
      quantityDelta = parseStockInteger(countedQuantity, quantityBefore) - quantityBefore
    } else {
      quantityDelta = Math.abs(parseStockInteger(amount, 0))
    }

    if (quantityDelta === 0) {
      throw new Error('Adj meg nem nulla készletváltozást.')
    }

    const quantityAfter = quantityBefore + quantityDelta

    transaction.set(
      stockRef,
      {
        currentQuantity: quantityAfter,
        updatedAt: serverTimestamp(),
        updatedBy: actorUid,
      },
      { merge: true },
    )
    transaction.set(
      movementRef,
      buildStockMovementRecord({
        stockItemId,
        stockItemName: stockItem.name,
        unit: stockItem.unit,
        quantityDelta,
        quantityBefore,
        quantityAfter,
        type,
        reason,
        actorUid,
        actorName,
      }),
    )

    return quantityAfter
  })
}

export async function getStockItem(eventId, stockItemId) {
  const snapshot = await getDoc(doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.stockItems, stockItemId)))
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null
}

export async function importStockItems({
  eventId,
  rows,
  actorUid,
  actorName,
}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Nincs importálható készletsor.')
  }

  const stockSnapshot = await getDocs(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
  const existingByName = new Map()

  stockSnapshot.docs.forEach((item) => {
    const data = item.data()
    const normalizedName = normalizeSearchText(data.name || '')
    if (normalizedName) {
      existingByName.set(normalizedName, { ref: item.ref, id: item.id, data })
    }
  })

  const writes = []

  rows.forEach((row) => {
    const normalizedName = normalizeSearchText(row.name || '')
    const existing = existingByName.get(normalizedName)
    const quantityAfter = parseStockInteger(row.currentQuantity, 0)
    const quantityBefore = existing ? parseStockInteger(existing.data.currentQuantity, 0) : 0
    const quantityDelta = quantityAfter - quantityBefore
    const stockRef = existing?.ref || doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockItems)))
    const stockItemId = existing?.id || stockRef.id

    writes.push({
      type: 'stock',
      ref: stockRef,
      merge: Boolean(existing),
      data: existing
        ? buildStockItemPatch({
            name: row.name,
            unit: row.unit,
            currentQuantity: quantityAfter,
            lowThreshold: row.lowThreshold,
            isActive: row.isActive,
            actorUid,
          })
        : buildStockItemRecord({
            name: row.name,
            unit: row.unit,
            currentQuantity: quantityAfter,
            lowThreshold: row.lowThreshold,
            isActive: row.isActive,
            actorUid,
          }),
    })

    if (quantityDelta !== 0) {
      writes.push({
        type: 'movement',
        ref: doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.stockMovements))),
        data: buildStockMovementRecord({
          stockItemId,
          stockItemName: row.name,
          unit: row.unit,
          quantityDelta,
          quantityBefore,
          quantityAfter,
          type: STOCK_MOVEMENT_TYPES.manualCorrection,
          reason: 'Excel import',
          actorUid,
          actorName,
        }),
      })
    }

    existingByName.set(normalizedName, {
      ref: stockRef,
      id: stockItemId,
      data: {
        name: row.name,
        unit: row.unit,
        currentQuantity: quantityAfter,
        lowThreshold: row.lowThreshold,
        isActive: row.isActive,
      },
    })
  })

  for (let startIndex = 0; startIndex < writes.length; startIndex += MAX_STOCK_IMPORT_BATCH_SIZE) {
    const batch = writeBatch(db)
    const chunk = writes.slice(startIndex, startIndex + MAX_STOCK_IMPORT_BATCH_SIZE)

    chunk.forEach((write) => {
      if (write.merge) {
        batch.set(write.ref, write.data, { merge: true })
      } else {
        batch.set(write.ref, write.data)
      }
    })

    await batch.commit()
  }

  return {
    importedCount: rows.length,
    movementCount: writes.filter((write) => write.type === 'movement').length,
  }
}
