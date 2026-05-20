import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

function requireFirebaseAdmin(moduleName) {
  try {
    return require(moduleName)
  } catch {
    return require(`../functions/node_modules/${moduleName}`)
  }
}

const { applicationDefault, initializeApp } = requireFirebaseAdmin('firebase-admin/app')
const { FieldValue, getFirestore } = requireFirebaseAdmin('firebase-admin/firestore')

function resolveProjectId(aliasOrProjectId) {
  const requested = aliasOrProjectId || 'staging'

  try {
    const firebaseRc = JSON.parse(readFileSync(resolve('.firebaserc'), 'utf8'))
    return firebaseRc.projects?.[requested] || requested
  } catch {
    return requested
  }
}

function normalizeSearchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizeShibboleth(value) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, '')
}

const aliasOrProjectId = process.argv[2] || 'staging'
const projectId = resolveProjectId(aliasOrProjectId)
const publicBaseUrl = process.env.STAGING_PUBLIC_BASE_URL || 'https://staging.kasszaserzsi.hu'
const actorUid = process.env.STAGING_SEED_ACTOR_UID || 'staging-seed'
const eventId = 'staging-demo'
const now = FieldValue.serverTimestamp()

initializeApp({
  credential: applicationDefault(),
  projectId,
})

const db = getFirestore()

const products = [
  { id: 'soproni-05', name: 'Soproni 0.5', category: 'Sör', price: 900, isDRS: true, barcodes: ['5999880010011'] },
  { id: 'froccs-kicsi', name: 'Kisfröccs', category: 'Bor', price: 700, isDRS: false, barcodes: ['5999880010028'] },
  { id: 'burger-demo', name: 'Hamburger demo', category: 'Kaja', price: 2400, isDRS: false, modifierTemplateId: 'burger-template', barcodes: ['5999880010035'] },
]

const people = [
  { id: 'anna-demo', internalId: 'S001', displayName: 'Teszt Anna', team: 'Staging', attendeeType: 'organizer', shibboleth: 'anna-demo', balance: 5000, qr: '1001' },
  { id: 'bela-demo', internalId: 'S002', displayName: 'Teszt Béla', team: 'Staging', attendeeType: 'freshman', shibboleth: 'bela-demo', balance: 2500, qr: '1002' },
  { id: 'csilla-demo', internalId: 'S003', displayName: 'Teszt Csilla', team: 'Staging', attendeeType: 'freshman', shibboleth: 'csilla-demo', balance: 0, qr: '1003' },
]

const qrCodes = ['1001', '1002', '1003', '1004', '1005', '1006']

const batch = db.batch()

batch.set(db.doc(`events/${eventId}`), {
  name: 'Staging Demo Event',
  code: 'staging-demo',
  normalizedName: normalizeSearchText('Staging Demo Event'),
  status: 'active',
  startsOn: new Date().toISOString().slice(0, 10),
  createdBy: actorUid,
  createdAt: now,
  updatedAt: now,
  updatedBy: actorUid,
  activatedAt: now,
  closedAt: null,
  allowSingleNegativePurchase: true,
  isKitchenClosed: false,
})

batch.set(db.doc('system/runtime'), {
  activeEventId: eventId,
  updatedBy: actorUid,
  updatedAt: now,
})

batch.set(db.doc(`events/${eventId}/modifierTemplates/burger-template`), {
  name: 'Hamburger demo',
  normalizedName: normalizeSearchText('Hamburger demo'),
  defaultIncludedIngredients: [
    { id: 'patty', label: 'hús' },
    { id: 'lettuce', label: 'saláta' },
    { id: 'tomato', label: 'paradicsom' },
    { id: 'cheese', label: 'sajt' },
  ],
  optionalExtras: [
    { id: 'extra-patty', label: 'extra hús', price: 400, maxQuantity: 3 },
    { id: 'extra-cheese', label: 'extra sajt', price: 250, maxQuantity: 3 },
  ],
  createdAt: now,
  updatedAt: now,
  updatedBy: actorUid,
})

products.forEach((product) => {
  batch.set(db.doc(`events/${eventId}/products/${product.id}`), {
    name: product.name,
    normalizedName: normalizeSearchText(product.name),
    category: product.category,
    price: product.price,
    isActive: true,
    isTemporarilyUnavailable: false,
    modifierTemplateId: product.modifierTemplateId || null,
    isDRS: product.isDRS,
    barcodes: product.barcodes,
    createdAt: now,
    updatedAt: now,
    updatedBy: actorUid,
  })

  product.barcodes.forEach((barcode) => {
    batch.set(db.doc(`events/${eventId}/productBarcodes/${barcode}`), {
      barcode,
      productId: product.id,
      productName: product.name,
      updatedAt: now,
      updatedBy: actorUid,
    })
  })
})

people.forEach((person) => {
  const qrLink = `${publicBaseUrl}/qr/${person.qr}`
  batch.set(db.doc(`events/${eventId}/people/${person.id}`), {
    internalId: person.internalId,
    displayName: person.displayName,
    normalizedName: normalizeSearchText(person.displayName),
    team: person.team,
    attendeeType: person.attendeeType,
    shibboleth: person.shibboleth,
    normalizedShibboleth: normalizeShibboleth(person.shibboleth),
    linkedAuthUid: null,
    linkedAccountId: null,
    qrCodeId: person.qr,
    assignedQrId: person.qr,
    assignedQrLink: qrLink,
    balance: person.balance,
    recordStatus: 'active',
    createdAt: now,
    updatedAt: now,
  })
})

qrCodes.forEach((code) => {
  const assignedPerson = people.find((person) => person.qr === code)
  batch.set(db.doc(`events/${eventId}/qrAssignments/${code}`), {
    qrId: code,
    code,
    link: `${publicBaseUrl}/qr/${code}`,
    status: assignedPerson ? 'assigned' : 'unassigned',
    assignedPersonaId: assignedPerson?.id || null,
    personId: assignedPerson?.id || null,
    assignedAccountId: null,
    linkedAuthUid: null,
    createdBy: actorUid,
    assignedBy: assignedPerson ? actorUid : null,
    createdAt: now,
    updatedAt: now,
    assignedAt: assignedPerson ? now : null,
    revokedAt: null,
    revokedBy: null,
  })
})

batch.set(db.doc(`events/${eventId}/auditLogs/staging-seed`), {
  type: 'eventChange',
  actorUid,
  summary: 'Seeded staging demo data',
  targetType: 'event',
  targetId: eventId,
  details: {
    products: products.length,
    people: people.length,
    qrCredentials: qrCodes.length,
  },
  createdAt: now,
})

await batch.commit()

console.log(`Seeded staging demo data into project "${projectId}" event "${eventId}".`)
