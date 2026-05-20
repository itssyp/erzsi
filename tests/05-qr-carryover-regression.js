/**
 * QR scanning, top-up selection, and carryover regression tests.
 *
 * Requires Firestore emulator at 127.0.0.1:8080.
 */

/* global process */

import { deleteApp, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { PROJECT_ID, FIRESTORE_EMULATOR_HOST } from './config.js'
import { assert, assertEqual, assertThrows, printSummary, section } from './helpers.js'
import { QR_CODE_LENGTH, buildQrCredentialLink, normalizeQrInput } from '../src/features/qr/qrLinks.js'

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST

const app = initializeApp({ projectId: PROJECT_ID }, 'qr-carryover-regression')
const db = getFirestore(app)

const EVENT_ID = 'qr-carryover-regression-event'
const EVENT_PATH = `events/${EVENT_ID}`
const QR_PUBLIC_BASE_URL = 'https://kasszaserzsi.hu'

function eventRef() {
  return db.doc(EVENT_PATH)
}

function personRef(personId) {
  return db.doc(`${EVENT_PATH}/people/${personId}`)
}

function qrRef(code) {
  return db.doc(`${EVENT_PATH}/qrAssignments/${code}`)
}

function carryoverRef(normalizedShibboleth) {
  return db.doc(`carryoverBalances/${normalizedShibboleth}`)
}

function ledgerCollection() {
  return db.collection(`${EVENT_PATH}/ledgerEntries`)
}

function auditCollection() {
  return db.collection(`${EVENT_PATH}/auditLogs`)
}

async function clearCollection(path) {
  const snapshot = await db.collection(path).get()
  const batch = db.batch()
  snapshot.docs.forEach((docSnapshot) => batch.delete(docSnapshot.ref))
  if (snapshot.size) await batch.commit()
}

async function clearRegressionData() {
  await Promise.all([
    clearCollection(`${EVENT_PATH}/people`),
    clearCollection(`${EVENT_PATH}/qrAssignments`),
    clearCollection(`${EVENT_PATH}/ledgerEntries`),
    clearCollection(`${EVENT_PATH}/auditLogs`),
  ])
  await Promise.all([
    eventRef().delete().catch(() => {}),
    db.doc('system/runtime').delete().catch(() => {}),
    carryoverRef('alice').delete().catch(() => {}),
    carryoverRef('bob').delete().catch(() => {}),
    carryoverRef('charlie').delete().catch(() => {}),
    carryoverRef('dupe').delete().catch(() => {}),
    carryoverRef('missing').delete().catch(() => {}),
  ])
}

function normalizeShibboleth(value) {
  return String(value || '').trim().toLowerCase()
}

async function assertRejects(fn, expectedMsg, label) {
  try {
    await fn()
    assert(false, `${label} (expected rejection)`)
  } catch (error) {
    const message = error?.message || String(error)
    assert(message.includes(expectedMsg), `${label} (threw: ${message})`)
  }
}

async function createPerson(personId, overrides = {}) {
  const displayName = overrides.displayName || `Person ${personId}`
  const shibboleth = overrides.shibboleth || personId
  const normalizedShibboleth = overrides.normalizedShibboleth || normalizeShibboleth(shibboleth)
  await personRef(personId).set({
    displayName,
    internalId: `P-${personId}`,
    shibboleth,
    normalizedShibboleth,
    team: 'Regression',
    attendeeType: 'organizer',
    balance: 0,
    recordStatus: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...overrides,
  })
}

async function createQrCredential(code, overrides = {}) {
  await qrRef(code).set({
    id: code,
    code,
    qrId: code,
    link: buildQrCredentialLink(code),
    status: 'unassigned',
    assignedPersonaId: null,
    assignedPersonId: null,
    assignedAt: null,
    assignedBy: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...overrides,
  })
}

async function assignQrToPerson({ personId, rawQrInput, actorUid = 'admin-regression' }) {
  const qrCode = normalizeQrInput(rawQrInput)
  await db.runTransaction(async (transaction) => {
    const pRef = personRef(personId)
    const qRef = qrRef(qrCode)
    const auditRef = auditCollection().doc()
    const [personSnapshot, qrSnapshot] = await Promise.all([
      transaction.get(pRef),
      transaction.get(qRef),
    ])

    if (!personSnapshot.exists) throw new Error('Persona was not found.')
    if (!qrSnapshot.exists) throw new Error('QR credential was not found.')

    const person = personSnapshot.data()
    const credential = qrSnapshot.data()
    const currentQrCode = person.assignedQrId || person.qrCodeId || null

    if (person.recordStatus === 'deleted') throw new Error('Deleted personas cannot receive QR credentials.')
    if (credential.status === 'revoked') throw new Error('This QR credential has already been revoked.')
    if (credential.status === 'assigned' && credential.assignedPersonaId !== personId) {
      throw new Error('This QR credential is already assigned to another persona.')
    }

    if (currentQrCode && currentQrCode !== qrCode) {
      const previousRef = qrRef(currentQrCode)
      const previousSnapshot = await transaction.get(previousRef)
      if (previousSnapshot.exists) {
        transaction.set(previousRef, {
          status: 'revoked',
          revokedAt: FieldValue.serverTimestamp(),
          revokedBy: actorUid,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
      }
    }

    const nextLink = buildQrCredentialLink(qrCode)
    transaction.set(qRef, {
      code: qrCode,
      qrId: qrCode,
      link: nextLink,
      status: 'assigned',
      assignedPersonaId: personId,
      assignedPersonId: personId,
      assignedAt: credential.assignedAt || FieldValue.serverTimestamp(),
      assignedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    transaction.set(pRef, {
      assignedQrId: qrCode,
      qrCodeId: qrCode,
      assignedQrLink: nextLink,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    transaction.set(auditRef, {
      type: 'qrAssignment',
      actorUid,
      personId,
      details: { qrCode, replacedQrCode: currentQrCode && currentQrCode !== qrCode ? currentQrCode : null },
      createdAt: FieldValue.serverTimestamp(),
    })
  })

  return qrCode
}

async function resolveAssignedQr(rawQrInput) {
  const qrCode = normalizeQrInput(rawQrInput)
  const credentialSnapshot = await qrRef(qrCode).get()
  if (!credentialSnapshot.exists) throw new Error('QR credential was not found in the active event.')

  const credential = credentialSnapshot.data()
  if (credential.status === 'revoked') throw new Error('This QR credential has been revoked.')
  if (credential.status !== 'assigned' || !credential.assignedPersonaId) {
    throw new Error('This QR credential is not assigned to a persona yet.')
  }

  const personSnapshot = await personRef(credential.assignedPersonaId).get()
  if (!personSnapshot.exists) throw new Error('The persona linked to this QR credential was not found.')
  const person = { id: personSnapshot.id, ...personSnapshot.data() }
  if (person.recordStatus === 'deleted') throw new Error('Deleted personas cannot be resolved from QR.')
  return { credential, person }
}

async function selfAssignQr({ uid, personId, rawQrInput }) {
  const qrCode = normalizeQrInput(rawQrInput)
  await db.doc(`accounts/${uid}/eventLinks/${EVENT_ID}`).set({
    eventId: EVENT_ID,
    personId,
    linkedAuthUid: uid,
    updatedAt: FieldValue.serverTimestamp(),
  })
  await personRef(personId).set({ linkedAuthUid: uid }, { merge: true })

  await db.runTransaction(async (transaction) => {
    const pRef = personRef(personId)
    const qRef = qrRef(qrCode)
    const [personSnapshot, qrSnapshot] = await Promise.all([
      transaction.get(pRef),
      transaction.get(qRef),
    ])
    if (!personSnapshot.exists) throw new Error('Persona was not found.')
    if (!qrSnapshot.exists) throw new Error('QR code not found. Check the code and try again.')
    const person = personSnapshot.data()
    const credential = qrSnapshot.data()
    if (person.linkedAuthUid !== uid) throw new Error('This persona is not linked to your account.')
    if (person.assignedQrId || person.qrCodeId) throw new Error('Your profile already has a QR code.')
    if (credential.status === 'revoked') throw new Error('This QR code has been revoked and cannot be claimed.')
    if (credential.status === 'assigned') throw new Error('This QR code is already in use.')

    const link = buildQrCredentialLink(qrCode)
    transaction.set(qRef, {
      code: qrCode,
      qrId: qrCode,
      link,
      status: 'assigned',
      assignedPersonaId: personId,
      assignedPersonId: personId,
      assignedLinkedAccountId: uid,
      assignedBy: uid,
      assignedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    transaction.set(pRef, {
      assignedQrId: qrCode,
      qrCodeId: qrCode,
      assignedQrLink: link,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  })

  return qrCode
}

function createScannerBuffer({ onResolved, isTextEntryElement = () => false }) {
  let buffer = ''
  let lastKeyAt = 0
  const maxGapMs = 45

  function flush() {
    const value = buffer
    buffer = ''
    if (value.length >= QR_CODE_LENGTH) onResolved(value)
  }

  return {
    key(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || isTextEntryElement(event.activeElement)) return false
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (buffer) {
          flush()
          return true
        }
        lastKeyAt = 0
        return false
      }
      if (event.key.length !== 1) return false
      if (event.now - lastKeyAt > maxGapMs) buffer = ''
      lastKeyAt = event.now
      buffer += event.key
      return buffer.length >= 2
    },
    flush,
  }
}

async function closeEventAndCarryBalances({ eventId, actorUid = 'admin-regression' }) {
  const localEventRef = db.doc(`events/${eventId}`)
  let summary = { carriedCount: 0, totalBalance: 0 }

  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(localEventRef)
    if (!eventSnapshot.exists) throw new Error('Event was not found.')
    if (eventSnapshot.data().status !== 'active') throw new Error('Only the active event can be closed.')

    const peopleSnapshot = await transaction.get(db.collection(`events/${eventId}/people`))
    const activePeople = peopleSnapshot.docs
      .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
      .filter((person) => person.recordStatus !== 'deleted')
    const uniqueShibboleths = [...new Set(
      activePeople
        .map((person) => person.normalizedShibboleth || normalizeShibboleth(person.shibboleth))
        .filter(Boolean),
    )]
    const existingCarryoverSnaps = await Promise.all(
      uniqueShibboleths.map((shibboleth) => transaction.get(carryoverRef(shibboleth))),
    )
    const existingCarryoverByShib = new Map()
    uniqueShibboleths.forEach((shibboleth, index) => {
      if (existingCarryoverSnaps[index].exists) existingCarryoverByShib.set(shibboleth, existingCarryoverSnaps[index].data())
    })

    const missingShibboleth = []
    const peopleByShibboleth = new Map()
    activePeople.forEach((person) => {
      const balance = Number.isFinite(person.balance) ? person.balance : 0
      const normalizedShibboleth = person.normalizedShibboleth || normalizeShibboleth(person.shibboleth)
      if (!normalizedShibboleth) {
        if (balance !== 0) missingShibboleth.push({ personId: person.id, balance })
        return
      }
      const existing = peopleByShibboleth.get(normalizedShibboleth) || []
      existing.push({ personId: person.id, displayName: person.displayName || '' })
      peopleByShibboleth.set(normalizedShibboleth, existing)
    })
    const duplicateShibboleths = [...peopleByShibboleth.entries()].filter(([, people]) => people.length > 1)
    if (missingShibboleth.length || duplicateShibboleths.length) throw new Error('Event cannot be closed until shibboleth problems are fixed.')

    let carriedCount = 0
    let totalBalance = 0
    activePeople.forEach((person) => {
      const normalizedShibboleth = person.normalizedShibboleth || normalizeShibboleth(person.shibboleth)
      if (!normalizedShibboleth) return
      const personBalance = Number.isFinite(person.balance) ? person.balance : 0
      const existingCarryover = existingCarryoverByShib.get(normalizedShibboleth)
      const unappliedCarryover =
        existingCarryover &&
        existingCarryover.sourceEventId !== eventId &&
        person.carryoverAppliedFromEventId !== existingCarryover.sourceEventId
          ? (Number.isFinite(existingCarryover.balance) ? existingCarryover.balance : 0)
          : 0
      const balance = personBalance + unappliedCarryover
      carriedCount += 1
      totalBalance += balance
      transaction.set(carryoverRef(normalizedShibboleth), {
        shibboleth: person.shibboleth || '',
        normalizedShibboleth,
        balance,
        currency: 'HUF',
        sourceEventId: eventId,
        sourcePersonId: person.id,
        updatedBy: actorUid,
        updatedAt: FieldValue.serverTimestamp(),
        lastClosedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    })

    transaction.set(localEventRef, {
      status: 'closed',
      updatedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
      closedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    transaction.set(db.doc('system/runtime'), {
      activeEventId: null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    }, { merge: true })
    summary = { carriedCount, totalBalance }
  })

  return summary
}

async function applyCarryoverOnLink({ personId, normalizedShibboleth, uid = 'user-regression' }) {
  await db.runTransaction(async (transaction) => {
    const pRef = personRef(personId)
    const cRef = carryoverRef(normalizedShibboleth)
    const [personSnapshot, carryoverSnapshot] = await Promise.all([
      transaction.get(pRef),
      transaction.get(cRef),
    ])
    if (!personSnapshot.exists) throw new Error('Persona was not found.')
    const person = personSnapshot.data()
    const carryover = carryoverSnapshot.exists ? carryoverSnapshot.data() : null
    const carryoverBalance = Number.isFinite(carryover?.balance) ? carryover.balance : 0
    const carryoverAlreadyApplied = Boolean(carryover && person.carryoverAppliedFromEventId === carryover.sourceEventId)
    const shouldApplyCarryover = carryoverBalance !== 0 && carryover && !carryoverAlreadyApplied
    const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
    const patch = {
      linkedAuthUid: uid,
      linkedAccountId: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (shouldApplyCarryover) {
      patch.balance = balanceBefore + carryoverBalance
      patch.carryoverAppliedFromEventId = carryover.sourceEventId
    }
    transaction.set(pRef, patch, { merge: true })
    if (shouldApplyCarryover) {
      transaction.set(ledgerCollection().doc(), {
        type: 'carryoverIn',
        actorUid: uid,
        personId,
        amount: carryoverBalance,
        balanceBefore,
        balanceAfter: balanceBefore + carryoverBalance,
        currency: 'HUF',
        reason: `Carry-over from event ${carryover.sourceEventId || 'unknown'} (applied on link)`,
        createdAt: FieldValue.serverTimestamp(),
      })
    }
  })
}

console.log('\n============================================================')
console.log('   QR + CARRYOVER REGRESSION TESTS')
console.log('============================================================')

await clearRegressionData()
await eventRef().set({
  status: 'active',
  name: 'QR regression event',
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
})

section('QR link generation and normalization')
assertEqual(QR_CODE_LENGTH, 4, 'QR_CODE_LENGTH is 4')
assertEqual(buildQrCredentialLink('1234'), `${QR_PUBLIC_BASE_URL}/qr/1234`, 'QR links always use kasszaserzsi.hu')
assertEqual(normalizeQrInput('1234'), '1234', 'Plain 4-digit QR normalizes')
assertEqual(normalizeQrInput('https://kasszaserzsi.hu/qr/9876'), '9876', 'Production QR URL normalizes')
assertEqual(normalizeQrInput('http://localhost:3000/qr/8442'), '8442', 'Legacy localhost scan input still normalizes')
assertEqual(normalizeQrInput('xxx/qr/5566?source=scanner'), '5566', 'Scanner prefix noise with /qr path normalizes')
assertThrows(() => normalizeQrInput('12345'), '4-digit', '5-digit QR code is rejected')
assertThrows(() => normalizeQrInput('https://kasszaserzsi.hu/qr/12345'), '4-digit', '5-digit QR URL is rejected')

section('Keyboard-scanner buffering for POS and top-up screens')
const posResolved = []
const posScanner = createScannerBuffer({ onResolved: (value) => posResolved.push(normalizeQrInput(value)) })
;'8442'.split('').forEach((key, index) => posScanner.key({ key, now: 1000 + index * 8 }))
posScanner.flush()
assertEqual(posResolved.length, 1, 'POS global scanner resolves without searchbar focus')
assertEqual(posResolved[0], '8442', 'POS global scanner resolves 4-digit code')

const barcodeLikeResolved = []
const barcodeLikeScanner = createScannerBuffer({ onResolved: (value) => barcodeLikeResolved.push(value) })
;'8442612345678'.split('').forEach((key, index) => barcodeLikeScanner.key({ key, now: 1200 + index * 6 }))
barcodeLikeScanner.key({ key: 'Enter', now: 1300 })
assertEqual(barcodeLikeResolved.length, 1, 'Scanner waits for the complete product barcode before resolving')
assertEqual(barcodeLikeResolved[0], '8442612345678', 'Product barcode is not truncated to the first 4 QR digits')

const topupResolved = []
const topupScanner = createScannerBuffer({ onResolved: (value) => topupResolved.push(normalizeQrInput(value)) })
;'5566'.split('').forEach((key, index) => topupScanner.key({ key, now: 2000 + index * 7 }))
topupScanner.key({ key: 'Enter', now: 2032 })
assertEqual(topupResolved.length, 1, 'Top-up persona scanner resolves without searchbar focus')
assertEqual(topupResolved[0], '5566', 'Top-up persona scanner resolves 4-digit code')

const ignoredResolved = []
const ignoredScanner = createScannerBuffer({
  onResolved: (value) => ignoredResolved.push(value),
  isTextEntryElement: (element) => element?.tagName === 'INPUT',
})
;'1234'.split('').forEach((key, index) => ignoredScanner.key({ key, now: 3000 + index * 6, activeElement: { tagName: 'INPUT' } }))
ignoredScanner.flush()
assertEqual(ignoredResolved.length, 0, 'Scanner does not steal normal input typing')

const interruptedResolved = []
const interruptedScanner = createScannerBuffer({ onResolved: (value) => interruptedResolved.push(value) })
interruptedScanner.key({ key: '1', now: 4000 })
interruptedScanner.key({ key: '2', now: 4010 })
interruptedScanner.key({ key: '3', now: 4100 })
interruptedScanner.key({ key: '4', now: 4110 })
interruptedScanner.flush()
assertEqual(interruptedResolved.length, 0, 'Slow human typing is not treated as a scanner code')

section('QR assignment, POS resolve, top-up resolve, and revocation')
await createPerson('alice', { displayName: 'Alice', shibboleth: 'alice', balance: 1000 })
await createPerson('bob', { displayName: 'Bob', shibboleth: 'bob', balance: 500 })
await createQrCredential('8442')
await createQrCredential('5566')
await assignQrToPerson({ personId: 'alice', rawQrInput: 'https://localhost:3000/qr/8442' })
const aliceAfterQr = (await personRef('alice').get()).data()
const qr8442 = (await qrRef('8442').get()).data()
assertEqual(aliceAfterQr.assignedQrId, '8442', 'Assigned QR is stored on persona')
assertEqual(aliceAfterQr.assignedQrLink, `${QR_PUBLIC_BASE_URL}/qr/8442`, 'Assigned persona QR link uses production domain')
assertEqual(qr8442.status, 'assigned', 'QR credential status becomes assigned')
assertEqual(qr8442.link, `${QR_PUBLIC_BASE_URL}/qr/8442`, 'QR credential link uses production domain')

const posResolvedPerson = await resolveAssignedQr('/qr/8442')
assertEqual(posResolvedPerson.person.id, 'alice', 'POS QR resolve finds assigned persona')
const topupResolvedPerson = await resolveAssignedQr('https://kasszaserzsi.hu/qr/8442')
assertEqual(topupResolvedPerson.person.id, 'alice', 'Top-up QR resolve finds same assigned persona')

await assignQrToPerson({ personId: 'alice', rawQrInput: '5566' })
const oldQr = (await qrRef('8442').get()).data()
const newQr = (await qrRef('5566').get()).data()
assertEqual(oldQr.status, 'revoked', 'Replacing persona QR revokes previous credential')
assertEqual(newQr.status, 'assigned', 'Replacement QR is assigned')
assertEqual(newQr.assignedPersonaId, 'alice', 'Replacement QR points to the persona')
await assertRejects(() => resolveAssignedQr('8442'), 'revoked', 'Revoked QR cannot resolve')

await createQrCredential('7788')
await selfAssignQr({ uid: 'bob-user', personId: 'bob', rawQrInput: 'https://kasszaserzsi.hu/qr/7788' })
const bobAfterSelfAssign = (await personRef('bob').get()).data()
assertEqual(bobAfterSelfAssign.assignedQrId, '7788', 'Self-assign stores QR on linked persona')
await assertRejects(
  () => selfAssignQr({ uid: 'bob-user', personId: 'bob', rawQrInput: '5566' }),
  'already has a QR',
  'Self-assign blocks double QR on one persona',
)

section('Top-up transaction after QR selection')
const balanceBeforeTopup = (await personRef('alice').get()).data().balance
await db.runTransaction(async (transaction) => {
  const selected = await resolveAssignedQr('5566')
  const pRef = personRef(selected.person.id)
  const personSnapshot = await transaction.get(pRef)
  const balanceBefore = personSnapshot.data().balance
  const amount = 2500
  transaction.set(pRef, {
    balance: balanceBefore + amount,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  transaction.set(ledgerCollection().doc(), {
    type: 'topup',
    personId: selected.person.id,
    amount,
    balanceBefore,
    balanceAfter: balanceBefore + amount,
    actorUid: 'admin-regression',
    createdAt: FieldValue.serverTimestamp(),
  })
})
const aliceAfterTopup = (await personRef('alice').get()).data()
assertEqual(aliceAfterTopup.balance, balanceBeforeTopup + 2500, 'Top-up after QR selection updates the correct persona balance exactly once')
const topupEntries = await ledgerCollection().where('type', '==', 'topup').where('personId', '==', 'alice').get()
assertEqual(topupEntries.size, 1, 'Top-up after QR selection creates exactly one ledger entry')

section('Carryover close, rescue, and no double-apply')
const carryEventId = 'qr-carryover-close-event'
await db.doc(`events/${carryEventId}`).set({ status: 'active', createdAt: FieldValue.serverTimestamp() })
await db.doc(`events/${carryEventId}/people/alice`).set({
  displayName: 'Alice Carry',
  shibboleth: 'alice',
  normalizedShibboleth: 'alice',
  balance: 4000,
  recordStatus: 'active',
})
await db.doc(`events/${carryEventId}/people/bob`).set({
  displayName: 'Bob Carry',
  shibboleth: 'bob',
  normalizedShibboleth: 'bob',
  balance: -500,
  recordStatus: 'active',
})
await carryoverRef('alice').set({
  normalizedShibboleth: 'alice',
  balance: 1500,
  sourceEventId: 'previous-event',
})
const carrySummary = await closeEventAndCarryBalances({ eventId: carryEventId })
assertEqual(carrySummary.carriedCount, 2, 'Close carries every active persona with shibboleth')
assertEqual(carrySummary.totalBalance, 5000, 'Close total includes unapplied previous carryover and negative balances')
assertEqual((await carryoverRef('alice').get()).data().balance, 5500, 'Close rescues unapplied previous carryover instead of overwriting it')
assertEqual((await carryoverRef('bob').get()).data().balance, -500, 'Close carries negative balances')
assertEqual((await db.doc(`events/${carryEventId}`).get()).data().status, 'closed', 'Close marks event closed')
assertEqual((await db.doc('system/runtime').get()).data().activeEventId, null, 'Close clears active event id')

await createPerson('charlie', { displayName: 'Charlie', shibboleth: 'charlie', normalizedShibboleth: 'charlie', balance: 100 })
await carryoverRef('charlie').set({
  normalizedShibboleth: 'charlie',
  balance: 700,
  sourceEventId: 'carry-source',
})
await applyCarryoverOnLink({ personId: 'charlie', normalizedShibboleth: 'charlie' })
const charlieAfterFirstApply = (await personRef('charlie').get()).data()
assertEqual(charlieAfterFirstApply.balance, 800, 'Carryover apply adds balance once on link/import')
assertEqual(charlieAfterFirstApply.carryoverAppliedFromEventId, 'carry-source', 'Carryover apply stamps source event')
await applyCarryoverOnLink({ personId: 'charlie', normalizedShibboleth: 'charlie' })
const charlieAfterSecondApply = (await personRef('charlie').get()).data()
assertEqual(charlieAfterSecondApply.balance, 800, 'Carryover apply is idempotent and does not double-credit')
const charlieCarryLedgers = await ledgerCollection().where('type', '==', 'carryoverIn').where('personId', '==', 'charlie').get()
assertEqual(charlieCarryLedgers.size, 1, 'Carryover apply creates one ledger entry only')

const badEventId = 'qr-carryover-bad-event'
await db.doc(`events/${badEventId}`).set({ status: 'active', createdAt: FieldValue.serverTimestamp() })
await db.doc(`events/${badEventId}/people/missing`).set({
  displayName: 'Missing Shib',
  balance: 1000,
  recordStatus: 'active',
})
await assertRejects(
  () => closeEventAndCarryBalances({ eventId: badEventId }),
  'shibboleth problems',
  'Close blocks non-zero balance without shibboleth',
)
assertEqual((await db.doc(`events/${badEventId}`).get()).data().status, 'active', 'Failed close leaves event active')

const summary = printSummary('QR + carryover regression summary')
await clearRegressionData()
await deleteApp(app)

if (summary.failCount > 0) {
  process.exit(1)
}
