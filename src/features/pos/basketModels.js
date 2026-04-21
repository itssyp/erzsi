import { serverTimestamp } from 'firebase/firestore'

export const BASKET_STATUSES = {
  open: 'open',
}

export function computeLineUnitTotal(item) {
  const extrasUnitTotal = (item.customization?.extras || []).reduce(
    (sum, extra) => sum + extra.price * extra.quantity,
    0,
  )

  return item.unitPrice + extrasUnitTotal
}

export function normalizeBasketItems(items) {
  return items.map((item) => {
    const unitTotal = computeLineUnitTotal(item)

    return {
      ...item,
      unitTotal,
      lineTotal: unitTotal * item.quantity,
    }
  })
}

export function summarizeBasketItems(items) {
  const normalizedItems = normalizeBasketItems(items)

  return {
    items: normalizedItems,
    itemCount: normalizedItems.reduce((sum, item) => sum + item.quantity, 0),
    totalAmount: normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0),
  }
}

export function buildOpenBasketRecord({
  person,
  items,
  staffUid,
  sessionId,
  staffName,
  existingBasket = null,
}) {
  const summary = summarizeBasketItems(items)

  return {
    personId: person.id,
    personDisplayName: person.displayName,
    personInternalId: person.internalId,
    status: BASKET_STATUSES.open,
    items: summary.items,
    itemCount: summary.itemCount,
    totalAmount: summary.totalAmount,
    lockOwnerUid: staffUid,
    lockSessionId: sessionId,
    lockOwnerName: staffName,
    openedAt: existingBasket?.openedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

export function buildBasketLine({
  product,
  customization,
}) {
  const normalizedCustomization = customization
    ? {
        includedIngredients: customization.includedIngredients || [],
        removedIngredients: customization.removedIngredients || [],
        extras: customization.extras || [],
      }
    : null

  const unitPrice = product.price
  const extrasUnitTotal = (normalizedCustomization?.extras || []).reduce(
    (sum, extra) => sum + extra.price * extra.quantity,
    0,
  )

  return {
    lineId: crypto.randomUUID(),
    productId: product.id,
    productName: product.name,
    category: product.category,
    quantity: 1,
    unitPrice,
    unitTotal: unitPrice + extrasUnitTotal,
    lineTotal: unitPrice + extrasUnitTotal,
    modifierTemplateId: product.modifierTemplateId || null,
    customization: normalizedCustomization,
  }
}
