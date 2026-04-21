import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText } from '../../lib/normalize'

function buildIngredientItem(label) {
  return {
    id: crypto.randomUUID(),
    label: label.trim(),
  }
}

function buildExtraItem({ label, price, maxQuantity }) {
  return {
    id: crypto.randomUUID(),
    label: label.trim(),
    price,
    maxQuantity,
  }
}

export function parseDefaultIngredientsText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => buildIngredientItem(label))
}

export function parseOptionalExtrasText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label = '', priceRaw = '0', maxQuantityRaw = '1'] = line.split('|').map((item) => item.trim())
      const price = Number.parseInt(priceRaw || '0', 10)
      const maxQuantity = Number.parseInt(maxQuantityRaw || '1', 10)

      return buildExtraItem({
        label,
        price: Number.isInteger(price) ? price : 0,
        maxQuantity: Number.isInteger(maxQuantity) && maxQuantity > 0 ? maxQuantity : 1,
      })
    })
}

export function buildModifierTemplateRecord({
  name,
  defaultIncludedIngredients,
  optionalExtras,
  actorUid,
}) {
  return {
    name: name.trim(),
    normalizedName: normalizeSearchText(name),
    defaultIncludedIngredients,
    optionalExtras,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}

export function buildModifierTemplatePatch({
  name,
  defaultIncludedIngredients,
  optionalExtras,
  actorUid,
}) {
  return {
    name: name.trim(),
    normalizedName: normalizeSearchText(name),
    defaultIncludedIngredients,
    optionalExtras,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}
