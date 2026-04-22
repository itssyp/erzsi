import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText } from '../../lib/normalize'

export const PRODUCT_CATEGORIES = [
  'beer',
  'softdrinks',
  'food',
  'snacks',
  'wines',
]

export function buildProductRecord({
  name,
  category,
  price,
  isActive,
  isTemporarilyUnavailable,
  modifierTemplateId,
  isDRS,
  actorUid,
}) {
  return {
    name: name.trim(),
    normalizedName: normalizeSearchText(name),
    category,
    price,
    isActive,
    isTemporarilyUnavailable,
    modifierTemplateId: modifierTemplateId || null,
    isDRS: isDRS || false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}

export function buildProductPatch({
  name,
  category,
  price,
  isActive,
  isTemporarilyUnavailable,
  modifierTemplateId,
  isDRS,
  actorUid,
}) {
  return {
    name: name.trim(),
    normalizedName: normalizeSearchText(name),
    category,
    price,
    isActive,
    isTemporarilyUnavailable,
    modifierTemplateId: modifierTemplateId || null,
    isDRS: isDRS || false,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}
