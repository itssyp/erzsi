export const ACCOUNTS_COLLECTION = 'accounts'
export const CARRYOVER_BALANCES_COLLECTION = 'carryoverBalances'
export const EVENTS_COLLECTION = 'events'
export const SYSTEM_COLLECTION = 'system'
export const SYSTEM_RUNTIME_DOCUMENT = 'runtime'
export const ACCOUNT_SUBCOLLECTIONS = {
  eventLinks: 'eventLinks',
}
export const EVENT_SUBCOLLECTIONS = {
  people: 'people',
  products: 'products',
  modifierTemplates: 'modifierTemplates',
  baskets: 'baskets',
  orders: 'orders',
  ledgerEntries: 'ledgerEntries',
  auditLogs: 'auditLogs',
  qrAssignments: 'qrAssignments',
  drsReturns: 'drsReturns',
  productBarcodes: 'productBarcodes',
  stockItems: 'stockItems',
  stockMovements: 'stockMovements',
}

export function getAccountPath(uid) {
  return `${ACCOUNTS_COLLECTION}/${uid}`
}

export function getAccountEventLinkPath(uid, eventId) {
  return `${getAccountPath(uid)}/${ACCOUNT_SUBCOLLECTIONS.eventLinks}/${eventId}`
}

export function getCarryoverBalancePath(normalizedShibboleth) {
  return `${CARRYOVER_BALANCES_COLLECTION}/${normalizedShibboleth}`
}

export function getSystemRuntimePath() {
  return `${SYSTEM_COLLECTION}/${SYSTEM_RUNTIME_DOCUMENT}`
}

export function getEventPath(eventId) {
  return `${EVENTS_COLLECTION}/${eventId}`
}

export function getEventCollectionPath(eventId, collectionName) {
  return `${getEventPath(eventId)}/${collectionName}`
}

export function getEventScopedPath(eventId, collectionName, docId) {
  const basePath = getEventCollectionPath(eventId, collectionName)

  return docId ? `${basePath}/${docId}` : basePath
}
