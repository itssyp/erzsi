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
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}
