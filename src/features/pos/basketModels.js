import { serverTimestamp } from 'firebase/firestore'
import { DRS_DEPOSIT_AMOUNT } from '../drs/drsModels'
import { normalizeProductCategory } from '../products/productModels'
import { getPersonDisplayId } from '../people/personModels'

export const BASKET_STATUSES = {
  open: 'open',
}

export const DRS_RETURN_PRODUCT_ID = '__drs_return__'
export const REUSABLE_CUP_RETURN_PRODUCT_ID = '__reusable_cup_return__'
export const REUSABLE_CUP_RETURN_AMOUNT = 1000
// Repohár sells are normal catalog products — no dedicated lineType. Single
// source of truth for matching them by productName (case + diacritic tolerant).
// Used by the POS to cap returns and by RepoharTrackerPanel / Statisztika.
export const REUSABLE_CUP_NAME_PATTERN = /repoh[áa]r/i

/**
 * Count how many Repohár cups a person currently owes back, given an array
 * of finalized orders for that person. Subtracts refunded units. Returns 0
 * (never negative) so callers can use it as a strict upper bound.
 */
export function countReusableCupsOutstanding(orders) {
  let bought = 0
  let returned = 0
  for (const order of orders || []) {
    for (const line of order.lines || []) {
      const netQty = (line.quantity || 0) - (line.refundedQuantity || 0)
      if (netQty <= 0) continue
      if (line.lineType === 'product' && REUSABLE_CUP_NAME_PATTERN.test(line.productName || '')) {
        bought += netQty
      } else if (line.lineType === 'reusableCupReturn') {
        returned += netQty
      }
    }
  }
  return Math.max(0, bought - returned)
}

/** Sum of Repohár BUY quantities currently in an open basket. */
export function countReusableCupsInBasket(basketItems) {
  let bought = 0
  for (const item of basketItems || []) {
    if (item.lineType === 'product' && REUSABLE_CUP_NAME_PATTERN.test(item.productName || '')) {
      bought += item.quantity || 0
    }
  }
  return bought
}

export function computeLineUnitTotal(item) {
  const extrasUnitTotal = (item.customization?.extras || []).reduce(
    (sum, extra) => sum + extra.price * extra.quantity,
    0,
  )

  return item.unitPrice + extrasUnitTotal
}

export function buildBasketLineMergeKey(productId, customization) {
  if (!customization) {
    return `${productId}::default`
  }

  const includedIngredients = (customization.includedIngredients || [])
    .map((item) => item.id)
    .join(',')
  const removedIngredients = (customization.removedIngredients || [])
    .map((item) => item.id)
    .join(',')
  const extras = (customization.extras || [])
    .map((item) => `${item.id}:${item.quantity}`)
    .join(',')

  return `${productId}::${includedIngredients}::${removedIngredients}::${extras}`
}

export function normalizeBasketItems(items) {
  return items.map((item) => {
    const unitTotal = computeLineUnitTotal(item)

    return {
      ...item,
      mergeKey: item.mergeKey || buildBasketLineMergeKey(item.productId, item.customization),
      unitTotal,
      lineTotal: unitTotal * item.quantity,
    }
  })
}

export function summarizeBasketItems(items) {
  const normalizedItems = normalizeBasketItems(items)

  return {
    items: normalizedItems,
    itemCount: normalizedItems.reduce((sum, item) => sum + (item.lineType === 'drs' ? 0 : item.quantity), 0),
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
    personDisplayId: getPersonDisplayId(person),
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
    lineType: 'product',
    parentLineId: null,
    mergeKey: buildBasketLineMergeKey(product.id, normalizedCustomization),
    productId: product.id,
    productName: product.name,
    category: normalizeProductCategory(product.category),
    quantity: 1,
    unitPrice,
    unitTotal: unitPrice + extrasUnitTotal,
    lineTotal: unitPrice + extrasUnitTotal,
    modifierTemplateId: product.modifierTemplateId || null,
    customization: normalizedCustomization,
  }
}

export function buildDrsLine({ parentLineId }) {
  return {
    lineId: crypto.randomUUID(),
    lineType: 'drs',
    parentLineId,
    productId: null,
    productName: `Betétdíj`,
    category: 'drs',
    quantity: 1,
    unitPrice: DRS_DEPOSIT_AMOUNT,
    unitTotal: DRS_DEPOSIT_AMOUNT,
    lineTotal: DRS_DEPOSIT_AMOUNT,
    modifierTemplateId: null,
    customization: null,
  }
}

export function buildDrsReturnLine() {
  return {
    lineId: crypto.randomUUID(),
    lineType: 'drsReturn',
    parentLineId: null,
    mergeKey: `${DRS_RETURN_PRODUCT_ID}::default`,
    productId: DRS_RETURN_PRODUCT_ID,
    productName: 'Palack visszaváltás',
    category: 'Egyéb',
    quantity: 1,
    unitPrice: -DRS_DEPOSIT_AMOUNT,
    unitTotal: -DRS_DEPOSIT_AMOUNT,
    lineTotal: -DRS_DEPOSIT_AMOUNT,
    modifierTemplateId: null,
    customization: null,
  }
}

export function buildReusableCupReturnLine() {
  return {
    lineId: crypto.randomUUID(),
    lineType: 'reusableCupReturn',
    parentLineId: null,
    mergeKey: `${REUSABLE_CUP_RETURN_PRODUCT_ID}::default`,
    productId: REUSABLE_CUP_RETURN_PRODUCT_ID,
    productName: 'Repohár visszaváltás',
    category: 'Egyéb',
    quantity: 1,
    unitPrice: -REUSABLE_CUP_RETURN_AMOUNT,
    unitTotal: -REUSABLE_CUP_RETURN_AMOUNT,
    lineTotal: -REUSABLE_CUP_RETURN_AMOUNT,
    modifierTemplateId: null,
    customization: null,
  }
}
