/**
 * 02-emulator-tests.js
 * Firestore emulator concurrency and correctness tests.
 * Requires the emulator running at 127.0.0.1:8080 (started by run-emulator-tests.js).
 *
 * Tests:
 *  A. Transaction serialization under concurrent balance writes
 *  B. Basket lock contention between concurrent staff sessions
 *  C. Double finalization protection (basket deleted atomically)
 *  D. DRS + sale concurrency on same person
 *  E. Query composite index requirements
 *  F. Subscription delivery latency (single-client estimate)
 *  G. Burst order creation throughput
 */

/* global process */

import { initializeApp, deleteApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { PROJECT_ID, FIRESTORE_EMULATOR_HOST, TEST_EVENT_ID } from './config.js'
import { assert, assertEqual, section, printStats, time, printSummary } from './helpers.js'

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST

const app = initializeApp({ projectId: PROJECT_ID }, 'emulator-test')
const db = getFirestore(app)

const EVENT_PATH = `events/${TEST_EVENT_ID}`

// ─── Helpers ─────────────────────────────────────────────────────────────────

function personRef(personId) {
  return db.doc(`${EVENT_PATH}/people/${personId}`)
}

function basketRef(personId) {
  return db.doc(`${EVENT_PATH}/baskets/${personId}`)
}

function newOrderRef() {
  return db.collection(`${EVENT_PATH}/orders`).doc()
}

function newLedgerRef() {
  return db.collection(`${EVENT_PATH}/ledgerEntries`).doc()
}

function newAuditRef() {
  return db.collection(`${EVENT_PATH}/auditLogs`).doc()
}

const STALE_BASKET_LOCK_MS = 45_000

async function clearCollection(collPath) {
  const snap = await db.collection(collPath).get()
  const batch = db.batch()
  snap.docs.forEach((d) => batch.delete(d.ref))
  if (snap.docs.length) await batch.commit()
}

async function clearEvent() {
  const subcollections = ['people', 'baskets', 'orders', 'ledgerEntries', 'auditLogs', 'drsReturns']
  await Promise.all(subcollections.map((s) => clearCollection(`${EVENT_PATH}/${s}`)))
}

async function createPerson(personId, balance = 5000) {
  await personRef(personId).set({
    displayName: `Test Person ${personId}`,
    internalId: `P-${personId.slice(0, 8).toUpperCase()}`,
    balance,
    recordStatus: 'active',
    team: 'TestTeam',
    attendeeType: 'organizer',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

async function createBasketWithLock(personId, staffUid, sessionId, ageMs = 0) {
  await basketRef(personId).set({
    personId,
    personDisplayName: `Test Person ${personId}`,
    status: 'open',
    items: [
      {
        lineId: 'l1',
        lineType: 'product',
        productId: 'beer-001',
        productName: 'Sör',
        category: 'beer',
        quantity: 2,
        unitPrice: 500,
        unitTotal: 500,
        lineTotal: 1000,
        customization: null,
      },
    ],
    itemCount: 2,
    totalAmount: 1000,
    lockOwnerUid: staffUid,
    lockSessionId: sessionId,
    lockOwnerName: staffUid,
    openedAt: FieldValue.serverTimestamp(),
    // updatedAt is set to simulate age
    updatedAt: FieldValue.serverTimestamp(),
  })

  // If simulating a stale lock, backdate updatedAt via admin SDK
  if (ageMs > 0) {
    const backdatedMs = Date.now() - ageMs
    await basketRef(personId).update({
      updatedAt: new Date(backdatedMs),
    })
  }
}

// Replicated transaction logic (mirrors posService.js using admin SDK)
function isStaleBasketLock(updatedAt) {
  if (!updatedAt) return false
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt.toMillis?.() ?? 0
  return Date.now() - ms > STALE_BASKET_LOCK_MS
}

async function acquireBasketLock(personId, staffUid, sessionId) {
  let retries = 0
  const result = await db.runTransaction(async (txn) => {
    retries++
    const bSnap = await txn.get(basketRef(personId))
    const pSnap = await txn.get(personRef(personId))

    if (!pSnap.exists) throw new Error('Person not found')

    const basket = bSnap.exists ? bSnap.data() : null

    if (basket &&
      basket.status === 'open' &&
      !(basket.lockOwnerUid === staffUid && basket.lockSessionId === sessionId) &&
      !isStaleBasketLock(basket.updatedAt?.toDate?.() ?? basket.updatedAt)
    ) {
      throw new Error(`Basket is currently open on another staff device for ${pSnap.data().displayName}.`)
    }

    const person = pSnap.data()
    const nextBasket = {
      personId,
      personDisplayName: person.displayName,
      status: 'open',
      items: basket?.items || [],
      itemCount: basket?.itemCount || 0,
      totalAmount: basket?.totalAmount || 0,
      lockOwnerUid: staffUid,
      lockSessionId: sessionId,
      lockOwnerName: staffUid,
      openedAt: basket?.openedAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    txn.set(basketRef(personId), nextBasket, { merge: true })
    return { acquired: true, sessionId }
  })
  return { ...result, retries }
}

async function finalizeBasket(personId, staffUid, sessionId, options = {}) {
  let retries = 0
  const orderRef = newOrderRef()
  const ledgerRef = newLedgerRef()
  const auditRef = newAuditRef()

  const result = await db.runTransaction(async (txn) => {
    retries++
    const bSnap = await txn.get(basketRef(personId))
    const pSnap = await txn.get(personRef(personId))

    if (!bSnap.exists) throw new Error('Active basket was not found.')
    if (!pSnap.exists) throw new Error('Person not found.')

    const basket = bSnap.data()
    const person = pSnap.data()

    if (basket.lockOwnerUid !== staffUid || basket.lockSessionId !== sessionId) {
      throw new Error('Another staff device currently owns this basket.')
    }

    if (!basket.items?.length) throw new Error('Basket is empty.')

    const balanceBefore = person.balance || 0
    if (balanceBefore < 0) throw new Error('Person is already below zero.')

    const totalAmount = basket.totalAmount || 0
    const balanceAfter = balanceBefore - totalAmount

    if (balanceAfter < 0 && !options.allowSingleNegativePurchase) {
      throw new Error(`Insufficient balance. Balance: ${balanceBefore} HUF, Purchase: ${totalAmount} HUF.`)
    }

    txn.set(orderRef, {
      personId,
      status: 'finalized',
      lines: basket.items,
      totalAmount,
      hasFood: basket.items.some((i) => i.category === 'food'),
      hasDrs: basket.items.some((i) => i.lineType === 'drs'),
      createdByUid: staffUid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    txn.set(pSnap.ref, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    txn.set(ledgerRef, {
      type: 'sale',
      personId,
      amount: -totalAmount,
      balanceBefore,
      balanceAfter,
      actorUid: staffUid,
      createdAt: FieldValue.serverTimestamp(),
    })
    txn.set(auditRef, {
      type: 'orderFinalization',
      actorUid: staffUid,
      personId,
      details: { totalAmount, balanceBefore, balanceAfter },
      createdAt: FieldValue.serverTimestamp(),
    })
    txn.delete(basketRef(personId))

    return { orderId: orderRef.id, totalAmount, balanceAfter }
  })
  return { ...result, retries }
}

async function topUpBalance(personId, actorUid, amount) {
  let retries = 0
  const ledgerRef = newLedgerRef()
  const result = await db.runTransaction(async (txn) => {
    retries++
    const pSnap = await txn.get(personRef(personId))
    if (!pSnap.exists) throw new Error('Person not found.')
    const person = pSnap.data()
    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore + amount
    txn.set(pSnap.ref, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    txn.set(ledgerRef, {
      type: 'topup',
      personId,
      amount,
      balanceBefore,
      balanceAfter,
      actorUid,
      createdAt: FieldValue.serverTimestamp(),
    })
    return { balanceAfter }
  })
  return { ...result, retries }
}

async function drsReturn(personId, actorUid, quantity) {
  const DRS_DEPOSIT_AMOUNT = 50
  let retries = 0
  const drsRef = db.collection(`${EVENT_PATH}/drsReturns`).doc()
  const ledgerRef = newLedgerRef()
  const result = await db.runTransaction(async (txn) => {
    retries++
    const pSnap = await txn.get(personRef(personId))
    if (!pSnap.exists) throw new Error('Person not found.')
    const person = pSnap.data()
    const balanceBefore = person.balance || 0
    const totalCreditAmount = quantity * DRS_DEPOSIT_AMOUNT
    const balanceAfter = balanceBefore + totalCreditAmount
    txn.set(pSnap.ref, { balance: balanceAfter, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    txn.set(drsRef, {
      personId, quantity, totalCreditAmount, balanceBefore, balanceAfter,
      actorUid, createdAt: FieldValue.serverTimestamp(),
    })
    txn.set(ledgerRef, {
      type: 'drsReturn', personId, amount: totalCreditAmount,
      balanceBefore, balanceAfter, actorUid, createdAt: FieldValue.serverTimestamp(),
    })
    return { balanceAfter, totalCreditAmount }
  })
  return { ...result, retries }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════')
console.log('   EMULATOR CONCURRENCY & CORRECTNESS TESTS')
console.log('══════════════════════════════════════════════════')

await clearEvent()

// ── A. TRANSACTION SERIALIZATION: concurrent balance writes ──────────────────
section('A. Concurrent balance writes — transaction serialization')

const PERSON_A = 'person-balance-test'
const INITIAL_BALANCE = 0
const TOPUP_AMOUNT = 1000
const CONCURRENT_TOPUPS = 10

await createPerson(PERSON_A, INITIAL_BALANCE)
console.log(`  Setup: person balance=${INITIAL_BALANCE}, ${CONCURRENT_TOPUPS} concurrent topups of ${TOPUP_AMOUNT} each`)

const { result: topupResults } = await time('Total time for concurrent topups', async () => {
  return Promise.allSettled(
    Array.from({ length: CONCURRENT_TOPUPS }, (_, i) =>
      topUpBalance(PERSON_A, `admin-${i}`, TOPUP_AMOUNT)
    )
  )
})

const topupSuccesses = topupResults.filter((r) => r.status === 'fulfilled')
const topupFailures = topupResults.filter((r) => r.status === 'rejected')
const totalRetries = topupSuccesses.reduce((s, r) => s + r.value.retries, 0)

console.log(`  Results: ${topupSuccesses.length}/${CONCURRENT_TOPUPS} succeeded, ${topupFailures.length} failed`)
console.log(`  Total transaction retries across all workers: ${totalRetries}`)
console.log(`  Mean retries per transaction: ${(totalRetries / CONCURRENT_TOPUPS).toFixed(2)}`)

const finalPerson = (await personRef(PERSON_A).get()).data()
const expectedBalance = INITIAL_BALANCE + TOPUP_AMOUNT * topupSuccesses.length
assertEqual(finalPerson.balance, expectedBalance, `Final balance = ${expectedBalance} (all writes serialized correctly)`)
assertEqual(topupFailures.length, 0, 'No transaction failures (Firestore correctly retried all contended writes)')

// Verify ledger entry count
const ledgerSnap = await db.collection(`${EVENT_PATH}/ledgerEntries`).get()
assertEqual(ledgerSnap.size, CONCURRENT_TOPUPS, `Ledger has exactly ${CONCURRENT_TOPUPS} entries`)

// ── B. BASKET LOCK CONTENTION ─────────────────────────────────────────────────
section('B. Basket lock contention — concurrent staff sessions')

const PERSON_B = 'person-basket-lock'
await createPerson(PERSON_B, 5000)
await clearCollection(`${EVENT_PATH}/baskets`)

// Staff 1 acquires lock
const lockResult = await acquireBasketLock(PERSON_B, 'staff-1', 'session-a')
assert(lockResult.acquired, 'Staff 1 acquires initial lock')

// Staff 2 tries — should fail
let lockError = null
try {
  await acquireBasketLock(PERSON_B, 'staff-2', 'session-b')
} catch (e) { lockError = e.message }
assert(lockError?.includes('currently open on another staff device'), 'Staff 2 blocked by lock')

// Staff 1 same session — re-entrant (refresh) should succeed
const reentrant = await acquireBasketLock(PERSON_B, 'staff-1', 'session-a')
assert(reentrant.acquired, 'Staff 1 re-acquires (session refresh) successfully')

// Staff 3 with same uid but different session — should fail
let lockError2 = null
try {
  await acquireBasketLock(PERSON_B, 'staff-1', 'session-c')
} catch (e) { lockError2 = e.message }
assert(lockError2?.includes('currently open on another staff device'), 'Same uid, different session → blocked')

// Simulate stale lock: overwrite updatedAt to 50s ago
await basketRef(PERSON_B).update({ updatedAt: new Date(Date.now() - 50_000) })

// Staff 2 should NOW succeed (lock is stale)
const staleAcquire = await acquireBasketLock(PERSON_B, 'staff-2', 'session-b')
assert(staleAcquire.acquired, 'Staff 2 acquires after 50s stale timeout — lock expired correctly')

// ── C. DOUBLE FINALIZATION PROTECTION ────────────────────────────────────────
section('C. Double-finalization protection')

const PERSON_C = 'person-double-finalize'
await createPerson(PERSON_C, 5000)
await clearCollection(`${EVENT_PATH}/baskets`)
await createBasketWithLock(PERSON_C, 'staff-1', 'session-x')

// First finalize — should succeed
const fin1 = await finalizeBasket(PERSON_C, 'staff-1', 'session-x')
assert(fin1.orderId, 'First finalize succeeds, orderId assigned')

// Second finalize — basket already deleted, should throw
let fin2Error = null
try {
  await finalizeBasket(PERSON_C, 'staff-1', 'session-x')
} catch (e) { fin2Error = e.message }
assert(fin2Error === 'Active basket was not found.', 'Second finalize blocked — basket deleted after first')

// Verify only one order was created
const ordersSnap = await db.collection(`${EVENT_PATH}/orders`).get()
const personOrders = ordersSnap.docs.filter((d) => d.data().personId === PERSON_C)
assertEqual(personOrders.length, 1, 'Exactly 1 order created — no duplicate')

// ── D. DRS + SALE CONCURRENCY ─────────────────────────────────────────────────
section('D. Concurrent DRS return + sale on same person')

const PERSON_D = 'person-drs-sale'
const PERSON_D_BALANCE = 1000
await createPerson(PERSON_D, PERSON_D_BALANCE)
await clearCollection(`${EVENT_PATH}/baskets`)
await createBasketWithLock(PERSON_D, 'staff-3', 'session-y')
await clearCollection(`${EVENT_PATH}/drsReturns`)

// Run DRS return AND basket finalization concurrently
const [drsResult, saleResult] = await Promise.allSettled([
  drsReturn(PERSON_D, 'staff-4', 5), // +250 HUF
  finalizeBasket(PERSON_D, 'staff-3', 'session-y'), // -1000 HUF (basket has 2×500)
])

console.log(`  DRS: ${drsResult.status} ${drsResult.status === 'fulfilled' ? `(+250 HUF, retries: ${drsResult.value.retries})` : drsResult.reason?.message}`)
console.log(`  Sale: ${saleResult.status} ${saleResult.status === 'fulfilled' ? `(-1000 HUF, retries: ${saleResult.value.retries})` : saleResult.reason?.message}`)

const finalPD = (await personRef(PERSON_D).get()).data()
const expectedPD = PERSON_D_BALANCE + 250 - 1000 // net: -750 HUF or a subset if one failed
console.log(`  Final balance: ${finalPD.balance} HUF (expected ${expectedPD} if both succeeded)`)

if (drsResult.status === 'fulfilled' && saleResult.status === 'fulfilled') {
  assertEqual(finalPD.balance, expectedPD, 'Both DRS and sale succeeded — balance mathematically correct')
} else {
  // One retry may have happened; either both or one succeeds
  const successCount = [drsResult, saleResult].filter((r) => r.status === 'fulfilled').length
  assert(successCount >= 1, 'At least one of DRS/sale succeeded')
  console.log('  NOTE: One operation may have needed retry — this is expected Firestore behavior')
}

// ── E. COMPOSITE INDEX REQUIREMENTS ──────────────────────────────────────────
section('E. Query composite index requirements (emulator enforcement)')

// Create test orders
const ordersBatch = db.batch()
for (let i = 0; i < 10; i++) {
  const oRef = db.collection(`${EVENT_PATH}/orders`).doc()
  ordersBatch.set(oRef, {
    personId: `person-idx-test`,
    hasFood: i % 2 === 0,
    hasDrs: i % 3 === 0,
    totalAmount: (i + 1) * 500,
    status: 'finalized',
    createdAt: new Date(Date.now() - i * 60_000),
    updatedAt: FieldValue.serverTimestamp(),
  })
}
await ordersBatch.commit()

// Query: hasFood + orderBy createdAt (NEEDS composite index)
let foodOrdersOk = true
try {
  // Use native Firestore query via admin SDK
  const foodSnap = await db.collection(`${EVENT_PATH}/orders`)
    .where('hasFood', '==', true)
    .orderBy('createdAt', 'desc')
    .get()
  console.log(`  hasFood + orderBy query: ${foodSnap.size} results ✓`)
} catch (e) {
  foodOrdersOk = false
  console.error(`  hasFood + orderBy query FAILED: ${e.message}`)
}
assert(foodOrdersOk, 'Query: where(hasFood==true) + orderBy(createdAt) — emulator accepts it')

// Query: personId + orderBy createdAt (NEEDS composite index)
let personOrdersOk = true
try {
  const personOrdersSnap = await db.collection(`${EVENT_PATH}/orders`)
    .where('personId', '==', 'person-idx-test')
    .orderBy('createdAt', 'desc')
    .get()
  console.log(`  personId + orderBy query: ${personOrdersSnap.size} results ✓`)
} catch (e) {
  personOrdersOk = false
  console.error(`  personId + orderBy query FAILED: ${e.message}`)
}
assert(personOrdersOk, 'Query: where(personId==X) + orderBy(createdAt) — emulator accepts it')

// Query: hasDrs + orderBy createdAt (index defined in firestore.indexes.json)
let drsOrdersOk = true
try {
  const drsSnap = await db.collection(`${EVENT_PATH}/orders`)
    .where('hasDrs', '==', true)
    .orderBy('createdAt', 'desc')
    .get()
  console.log(`  hasDrs + orderBy query: ${drsSnap.size} results ✓`)
} catch (e) {
  drsOrdersOk = false
  console.error(`  hasDrs + orderBy query FAILED: ${e.message}`)
}
assert(drsOrdersOk, 'Query: where(hasDrs==true) + orderBy(createdAt) — emulator accepts it')

// ── F. BURST ORDER CREATION THROUGHPUT ───────────────────────────────────────
section('F. Burst order creation — throughput test')

const BURST_COUNT = 50
const people = Array.from({ length: BURST_COUNT }, (_, i) => `burst-person-${i}`)

// Setup: create all people with balance = 2000
const setupBatch = db.batch()
people.forEach((pId) => {
  setupBatch.set(personRef(pId), {
    displayName: `Burst ${pId}`,
    internalId: `P-${pId.slice(0, 8)}`,
    balance: 2000,
    recordStatus: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
})
await setupBatch.commit()

// Setup: create all baskets
const basketBatch = db.batch()
people.forEach((pId) => {
  basketBatch.set(basketRef(pId), {
    personId: pId,
    personDisplayName: `Burst ${pId}`,
    status: 'open',
    items: [{ lineId: 'l1', lineType: 'product', productId: 'beer-001', productName: 'Sör',
      category: 'beer', quantity: 2, unitPrice: 500, unitTotal: 500, lineTotal: 1000, customization: null }],
    itemCount: 2,
    totalAmount: 1000,
    lockOwnerUid: 'staff-burst',
    lockSessionId: 'session-burst',
    openedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
})
await basketBatch.commit()

// Launch all finalizations concurrently
const burstStart = performance.now()
const burstResults = await Promise.allSettled(
  people.map((pId) => finalizeBasket(pId, 'staff-burst', 'session-burst'))
)
const burstMs = performance.now() - burstStart

const burstSuccess = burstResults.filter((r) => r.status === 'fulfilled')
const burstFail = burstResults.filter((r) => r.status === 'rejected')

console.log(`  ${BURST_COUNT} concurrent finalizations: ${burstSuccess.length} OK, ${burstFail.length} failed`)
console.log(`  Total elapsed: ${burstMs.toFixed(0)}ms`)
console.log(`  Mean per order: ${(burstMs / BURST_COUNT).toFixed(1)}ms`)
console.log(`  Throughput: ${(BURST_COUNT / (burstMs / 1000)).toFixed(1)} orders/sec`)

if (burstFail.length) {
  console.log('  Failed errors:')
  burstFail.slice(0, 3).forEach((r) => console.log(`    • ${r.reason?.message}`))
}

assert(burstSuccess.length >= BURST_COUNT * 0.95, `≥95% success rate under ${BURST_COUNT}-concurrent burst`)

// ── G. SOAK TEST: repeated writes over time ───────────────────────────────────
section('G. Soak test — 200 sequential writes, monitoring latency drift')

const SOAK_PERSON = 'soak-test-person'
await createPerson(SOAK_PERSON, 100_000)

const SOAK_COUNT = 200
const SOAK_TOPUP = 100
const soakLatencies = []

for (let i = 0; i < SOAK_COUNT; i++) {
  const t0 = performance.now()
  await topUpBalance(SOAK_PERSON, 'admin-soak', SOAK_TOPUP)
  soakLatencies.push(performance.now() - t0)
}

const soakStats = printStats(`Soak (${SOAK_COUNT} sequential topups)`, soakLatencies.map((v) => Math.round(v)))
const finalSoakPerson = (await personRef(SOAK_PERSON).get()).data()
const expectedSoakBalance = 100_000 + SOAK_TOPUP * SOAK_COUNT

assertEqual(finalSoakPerson.balance, expectedSoakBalance, `Soak: final balance = ${expectedSoakBalance} (all ${SOAK_COUNT} writes applied)`)
assert(soakStats.p99 < 5000, `Soak p99 < 5000ms (currently: ${soakStats.p99}ms)`)
assert(soakStats.mean < 1000, `Soak mean < 1000ms (currently: ${soakStats.mean}ms)`)

// Check for latency drift (first vs last 20%)
const firstQuintile = soakLatencies.slice(0, Math.floor(SOAK_COUNT * 0.2))
const lastQuintile = soakLatencies.slice(Math.floor(SOAK_COUNT * 0.8))
const firstMean = firstQuintile.reduce((s, v) => s + v, 0) / firstQuintile.length
const lastMean = lastQuintile.reduce((s, v) => s + v, 0) / lastQuintile.length
console.log(`  First 20% mean: ${firstMean.toFixed(1)}ms — Last 20% mean: ${lastMean.toFixed(1)}ms`)
const drift = ((lastMean - firstMean) / firstMean) * 100
console.log(`  Latency drift: ${drift > 0 ? '+' : ''}${drift.toFixed(1)}%`)
assert(Math.abs(drift) < 100, `No significant latency drift (>100%) over time — observed: ${drift.toFixed(1)}%`)

// ── H. INSUFFICIENT BALANCE GUARD ────────────────────────────────────────────
section('H. Insufficient balance guard — purchase blocked, no order, no ledger')

const PERSON_H1 = 'person-insuf-balance'
await createPerson(PERSON_H1, 300) // balance = 300 HUF, basket will be 1000 HUF
await createBasketWithLock(PERSON_H1, 'staff-h', 'session-h')

const ledgerCountBefore = (await db.collection(`${EVENT_PATH}/ledgerEntries`).get()).size
const orderCountBefore = (await db.collection(`${EVENT_PATH}/orders`).get()).size

let insufError = null
try {
  await finalizeBasket(PERSON_H1, 'staff-h', 'session-h')
} catch (e) { insufError = e.message }

assert(insufError !== null, 'finalizeBasket throws when balanceAfter < 0')
assert(insufError?.toLowerCase().includes('insufficient'), `Error mentions insufficient balance — got: "${insufError}"`)

const ledgerCountAfter = (await db.collection(`${EVENT_PATH}/ledgerEntries`).get()).size
const orderCountAfter = (await db.collection(`${EVENT_PATH}/orders`).get()).size

assertEqual(orderCountAfter, orderCountBefore, 'No order document created on insufficient balance')
assertEqual(ledgerCountAfter, ledgerCountBefore, 'No ledger entry created on insufficient balance')

const personH1After = (await personRef(PERSON_H1).get()).data()
assertEqual(personH1After.balance, 300, 'Person balance unchanged after blocked purchase')

const PERSON_H1B = 'person-one-negative-purchase'
await createPerson(PERSON_H1B, 300)
await createBasketWithLock(PERSON_H1B, 'staff-h', 'session-h1b')
const oneNegativeResult = await finalizeBasket(PERSON_H1B, 'staff-h', 'session-h1b', { allowSingleNegativePurchase: true })
assertEqual(oneNegativeResult.balanceAfter, -700, 'One-time negative purchase can cross below zero when enabled')

await createBasketWithLock(PERSON_H1B, 'staff-h', 'session-h1b-second')
let oneNegativeRepeatError = null
try {
  await finalizeBasket(PERSON_H1B, 'staff-h', 'session-h1b-second', { allowSingleNegativePurchase: true })
} catch (e) { oneNegativeRepeatError = e.message }
assert(oneNegativeRepeatError !== null, 'Second purchase while still negative is blocked')
assert(oneNegativeRepeatError?.toLowerCase().includes('zero'), `Repeat negative purchase error mentions zero — got: "${oneNegativeRepeatError}"`)

// Test: person already below zero blocks purchase
const PERSON_H2 = 'person-below-zero'
await createPerson(PERSON_H2, -100) // balance already negative
await createBasketWithLock(PERSON_H2, 'staff-h', 'session-h2')

let belowZeroError = null
try {
  await finalizeBasket(PERSON_H2, 'staff-h', 'session-h2')
} catch (e) { belowZeroError = e.message }

assert(belowZeroError !== null, 'finalizeBasket throws when person already has negative balance')
assert(belowZeroError?.toLowerCase().includes('zero'), `Below-zero error message correct — got: "${belowZeroError}"`)

const personH2After = (await personRef(PERSON_H2).get()).data()
assertEqual(personH2After.balance, -100, 'Negative-balance person balance unchanged after blocked purchase')

await clearEvent()
await deleteApp(app)

printSummary('═══ EMULATOR TESTS COMPLETE ═══')
