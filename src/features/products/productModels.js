import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText } from '../../lib/normalize'

export const PRODUCT_CATEGORIES = [
  'Sör',
  'Bor',
  'Hosszúital',
  'Üditő',
  'Nasi',
  'Kaja',
]

const LEGACY_PRODUCT_CATEGORY_MAP = {
  beer: 'Sör',
  wines: 'Bor',
  softdrinks: 'Üditő',
  snacks: 'Nasi',
  food: 'Kaja',
  Egyebek: 'Egyéb',
  egyebek: 'Egyéb',
  egyéb: 'Egyéb',
  sör: 'Sör',
  bor: 'Bor',
  hosszúital: 'Hosszúital',
  üditő: 'Üditő',
  üdítő: 'Üditő',
  nasi: 'Nasi',
  kaja: 'Kaja',
}

export function normalizeProductCategory(category) {
  const trimmedCategory = String(category || '').trim()
  const lowerCategory = trimmedCategory.toLowerCase()

  return LEGACY_PRODUCT_CATEGORY_MAP[trimmedCategory]
    || LEGACY_PRODUCT_CATEGORY_MAP[lowerCategory]
    || trimmedCategory
}

export function isFoodCategory(category) {
  return normalizeProductCategory(category) === 'Kaja'
}

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
    category: normalizeProductCategory(category),
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
    category: normalizeProductCategory(category),
    price,
    isActive,
    isTemporarilyUnavailable,
    modifierTemplateId: modifierTemplateId || null,
    isDRS: isDRS || false,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  }
}
