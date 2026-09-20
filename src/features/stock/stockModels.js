import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText } from '../../lib/normalize'

export const STOCK_UNITS = {
  piece: 'piece',
  ml: 'ml',
}

export const STOCK_UNIT_LABELS = {
  [STOCK_UNITS.piece]: 'db',
  [STOCK_UNITS.ml]: 'ml',
}

export const STOCK_MOVEMENT_TYPES = {
  manualAdd: 'manualAdd',
  manualCorrection: 'manualCorrection',
  sale: 'sale',
  refund: 'refund',
}

export function normalizeStockUnit(unit) {
  return unit === STOCK_UNITS.ml ? STOCK_UNITS.ml : STOCK_UNITS.piece
}

export function parseStockInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').replace(/\s+/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeRecipeComponent(component) {
  const stockItemId = String(component?.stockItemId || '').trim()
  const quantityPerUnit = parseStockInteger(component?.quantityPerUnit, 0)

  if (!stockItemId || quantityPerUnit <= 0) {
    return null
  }

  return {
    id: component.id || crypto.randomUUID(),
    stockItemId,
    stockItemName: String(component.stockItemName || '').trim(),
    quantityPerUnit,
  }
}

function sanitizeRecipeOption(option) {
  const components = (option?.components || [])
    .map(sanitizeRecipeComponent)
    .filter(Boolean)

  if (!components.length) {
    return null
  }

  return {
    id: option.id || crypto.randomUUID(),
    label: String(option.label || '').trim() || components[0].stockItemName,
    components,
  }
}

export function sanitizeStockRecipe(recipe) {
  if (!recipe?.enabled) {
    return {
      enabled: false,
      components: [],
      choiceGroups: [],
    }
  }

  return {
    enabled: true,
    components: (recipe.components || [])
      .map(sanitizeRecipeComponent)
      .filter(Boolean),
    choiceGroups: (recipe.choiceGroups || [])
      .map((group) => {
        const options = (group.options || [])
          .map(sanitizeRecipeOption)
          .filter(Boolean)

        if (!options.length) {
          return null
        }

        return {
          id: group.id || crypto.randomUUID(),
          label: String(group.label || '').trim() || 'Választás',
          options,
        }
      })
      .filter(Boolean),
  }
}

export function buildStockItemRecord({
  name,
  unit,
  currentQuantity = 0,
  lowThreshold = 0,
  isActive = true,
  actorUid,
}) {
  const trimmedName = String(name || '').trim()

  return {
    name: trimmedName,
    normalizedName: normalizeSearchText(trimmedName),
    unit: normalizeStockUnit(unit),
    currentQuantity: parseStockInteger(currentQuantity, 0),
    lowThreshold: Math.max(0, parseStockInteger(lowThreshold, 0)),
    isActive: Boolean(isActive),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}

export function buildStockItemPatch({
  name,
  unit,
  currentQuantity,
  lowThreshold,
  isActive,
  actorUid,
}) {
  const trimmedName = String(name || '').trim()

  return {
    name: trimmedName,
    normalizedName: normalizeSearchText(trimmedName),
    unit: normalizeStockUnit(unit),
    currentQuantity: parseStockInteger(currentQuantity, 0),
    lowThreshold: Math.max(0, parseStockInteger(lowThreshold, 0)),
    isActive: Boolean(isActive),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}

export function buildStockMovementRecord({
  stockItemId,
  stockItemName,
  unit,
  quantityDelta,
  quantityBefore,
  quantityAfter,
  type,
  reason = '',
  orderId = null,
  lineId = null,
  productId = null,
  productName = null,
  actorUid,
  actorName = '',
}) {
  return {
    stockItemId,
    stockItemName: stockItemName || '',
    unit: normalizeStockUnit(unit),
    quantityDelta,
    quantityBefore,
    quantityAfter,
    type,
    reason: reason || '',
    orderId,
    lineId,
    productId,
    productName,
    actorUid,
    actorName: actorName || '',
    createdAt: serverTimestamp(),
  }
}

export function buildStockSelectionsFromChoiceGroups(choiceGroups, selectedOptionIds) {
  return (choiceGroups || [])
    .map((group) => {
      const optionId = selectedOptionIds?.[group.id]
      const option = (group.options || []).find((candidate) => candidate.id === optionId)

      if (!option) {
        return null
      }

      return {
        groupId: group.id,
        groupLabel: group.label,
        optionId: option.id,
        optionLabel: option.label,
        components: option.components || [],
      }
    })
    .filter(Boolean)
}

export function buildStockConsumptionForProduct(product, stockSelections = []) {
  const recipe = sanitizeStockRecipe(product?.stockRecipe)

  if (!recipe.enabled) {
    return []
  }

  const selectedComponents = (stockSelections || []).flatMap((selection) => selection.components || [])
  const components = [...recipe.components, ...selectedComponents]

  return components
    .map(sanitizeRecipeComponent)
    .filter(Boolean)
    .map((component) => ({
      stockItemId: component.stockItemId,
      stockItemName: component.stockItemName,
      quantityPerUnit: component.quantityPerUnit,
    }))
}

export function aggregateStockLineDeltas(lines, quantityMultiplier = 1) {
  const aggregate = new Map()

  ;(lines || []).forEach((line) => {
    if (line.lineType !== 'product') {
      return
    }

    const lineQuantity = (line.quantity || 0) * quantityMultiplier

    ;(line.stockConsumption || []).forEach((component) => {
      const stockItemId = String(component.stockItemId || '').trim()
      const quantityPerUnit = parseStockInteger(component.quantityPerUnit, 0)

      if (!stockItemId || quantityPerUnit <= 0 || lineQuantity <= 0) {
        return
      }

      const previous = aggregate.get(stockItemId) || {
        stockItemId,
        stockItemName: component.stockItemName || '',
        quantityDelta: 0,
        productRefs: [],
      }

      previous.quantityDelta -= quantityPerUnit * lineQuantity
      previous.productRefs.push({
        lineId: line.lineId,
        productId: line.productId,
        productName: line.productName,
        quantityDelta: -(quantityPerUnit * lineQuantity),
      })
      aggregate.set(stockItemId, previous)
    })
  })

  return Array.from(aggregate.values())
}

export function aggregateStockRefundDeltas(line, quantity) {
  const aggregate = new Map()
  const refundQuantity = parseStockInteger(quantity, 0)

  if (!line || refundQuantity <= 0) {
    return []
  }

  ;(line.stockConsumption || []).forEach((component) => {
    const stockItemId = String(component.stockItemId || '').trim()
    const quantityPerUnit = parseStockInteger(component.quantityPerUnit, 0)

    if (!stockItemId || quantityPerUnit <= 0) {
      return
    }

    const previous = aggregate.get(stockItemId) || {
      stockItemId,
      stockItemName: component.stockItemName || '',
      quantityDelta: 0,
      productRefs: [],
    }
    const quantityDelta = quantityPerUnit * refundQuantity

    previous.quantityDelta += quantityDelta
    previous.productRefs.push({
      lineId: line.lineId,
      productId: line.productId,
      productName: line.productName,
      quantityDelta,
    })
    aggregate.set(stockItemId, previous)
  })

  return Array.from(aggregate.values())
}
