/**
 * 03-security-rules.js
 * Security rules correctness and performance tests using @firebase/rules-unit-testing.
 * Verifies that role-based access control is enforced correctly.
 *
 * Requires the emulator running at 127.0.0.1:8080.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { PROJECT_ID } from './config.js'
import { assert, section, printStats, printSummary } from './helpers.js'
import {
  deleteDoc, doc, getDoc, serverTimestamp, setDoc
} from 'firebase/firestore'

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)
const rulesContent = readFileSync(resolve(__dir, '../firestore.rules'), 'utf8')

console.log('\n══════════════════════════════════════════════════')
console.log('   SECURITY RULES TESTS')
console.log('══════════════════════════════════════════════════')

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    rules: rulesContent,
    host: '127.0.0.1',
    port: 8080,
  },
})

const TEST_EVENT_ID = 'rules-test-event'

// Seed data via admin bypass (no rules enforcement)
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore()
  const sets = [
    setDoc(doc(db, 'system/runtime'), { activeEventId: TEST_EVENT_ID }),
    setDoc(doc(db, 'accounts/admin-uid'), { uid: 'admin-uid', role: 'admin', status: 'active' }),
    setDoc(doc(db, 'accounts/staff-uid'), { uid: 'staff-uid', role: 'staff', status: 'active' }),
    setDoc(doc(db, 'accounts/head-pos-uid'), { uid: 'head-pos-uid', role: 'head_pos', status: 'active' }),
    setDoc(doc(db, 'accounts/user-uid'), { uid: 'user-uid', role: 'user', status: 'active' }),
    setDoc(doc(db, 'accounts/disabled-uid'), { uid: 'disabled-uid', role: 'staff', status: 'disabled' }),
    setDoc(doc(db, `accounts/user-uid/eventLinks/${TEST_EVENT_ID}`), { eventId: TEST_EVENT_ID, personId: 'person-uid' }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}`), { name: 'Rules Test Event', status: 'active' }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/people/person-uid`), {
      displayName: 'Test User', balance: 1000, recordStatus: 'active', createdAt: new Date(), updatedAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/people/other-person-uid`), {
      displayName: 'Other Person', balance: 500, recordStatus: 'active', createdAt: new Date(), updatedAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/products/beer-001`), {
      name: 'Sör', price: 500, category: 'beer', isActive: true, createdAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/baskets/person-uid`), {
      personId: 'person-uid', status: 'open', items: [],
      lockOwnerUid: 'staff-uid', lockSessionId: 'sess-1',
      openedAt: new Date(), updatedAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/orders/order-001`), {
      personId: 'person-uid', status: 'finalized', totalAmount: 1000, hasFood: false, hasDrs: false, createdAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/orders/order-002`), {
      personId: 'other-person-uid', status: 'finalized', totalAmount: 500, hasFood: false, hasDrs: false, createdAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/ledgerEntries/entry-001`), {
      personId: 'person-uid', type: 'topup', amount: 1000, createdAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/auditLogs/audit-001`), {
      type: 'topup', actorUid: 'admin-uid', createdAt: new Date(),
    }),
    setDoc(doc(db, `events/${TEST_EVENT_ID}/qrAssignments/1234`), {
      code: '1234', status: 'assigned', assignedPersonaId: 'person-uid',
    }),
  ]
  await Promise.all(sets)
})

// Cache Firestore instances once to avoid re-initialization errors
const adminDb = testEnv.authenticatedContext('admin-uid', { role: 'admin' }).firestore()
const staffDb = testEnv.authenticatedContext('staff-uid', { role: 'staff' }).firestore()
const headPosDb = testEnv.authenticatedContext('head-pos-uid', { role: 'head_pos' }).firestore()
const userDb = testEnv.authenticatedContext('user-uid', { role: 'user' }).firestore()
const disabledDb = testEnv.authenticatedContext('disabled-uid', { role: 'staff' }).firestore()
const unauthedDb = testEnv.unauthenticatedContext().firestore()

// ── 1. system/runtime ────────────────────────────────────────────────────────
section('Rules: system/runtime')

await assertSucceeds(getDoc(doc(adminDb, 'system/runtime')))
assert(true, 'Admin can read system/runtime')
await assertSucceeds(getDoc(doc(staffDb, 'system/runtime')))
assert(true, 'Staff can read system/runtime')
await assertSucceeds(getDoc(doc(userDb, 'system/runtime')))
assert(true, 'User can read system/runtime')
await assertFails(getDoc(doc(unauthedDb, 'system/runtime')))
assert(true, 'Unauthenticated cannot read system/runtime')
await assertSucceeds(setDoc(doc(adminDb, 'system/runtime'), { activeEventId: TEST_EVENT_ID }))
assert(true, 'Admin can write system/runtime')
await assertFails(setDoc(doc(staffDb, 'system/runtime'), { activeEventId: null }))
assert(true, 'Staff cannot write system/runtime')
await assertFails(setDoc(doc(headPosDb, 'system/runtime'), { activeEventId: null }))
assert(true, 'Főbüfé cannot write system/runtime')

// ── 2. accounts ──────────────────────────────────────────────────────────────
section('Rules: accounts')

await assertSucceeds(getDoc(doc(adminDb, 'accounts/staff-uid')))
assert(true, 'Admin can read any account')
await assertSucceeds(getDoc(doc(staffDb, 'accounts/staff-uid')))
assert(true, 'Staff can read any account')
await assertSucceeds(getDoc(doc(userDb, 'accounts/user-uid')))
assert(true, 'User can read own account')
await assertFails(getDoc(doc(userDb, 'accounts/admin-uid')))
assert(true, 'User cannot read other accounts')
await assertFails(setDoc(doc(staffDb, 'accounts/staff-uid'), { role: 'admin', status: 'active' }))
assert(true, 'Staff cannot modify accounts')

section('Rules: push tokens')
const ownPushToken = doc(userDb, 'accounts/user-uid/pushTokens/device-1')
await assertSucceeds(setDoc(ownPushToken, { token: 'test-fcm-token', origin: 'https://kasszaserzsi.hu', updatedAt: serverTimestamp() }))
assert(true, 'Participant can register a push token on their own account')
await assertSucceeds(getDoc(ownPushToken))
assert(true, 'Participant can read their own push token')
await assertFails(getDoc(doc(staffDb, 'accounts/user-uid/pushTokens/device-1')))
assert(true, 'Staff cannot read participant push tokens')
await assertFails(setDoc(doc(userDb, 'accounts/admin-uid/pushTokens/device-1'), { token: 'stolen', origin: 'https://kasszaserzsi.hu', updatedAt: serverTimestamp() }))
assert(true, 'Participant cannot register a token on another account')
await assertFails(setDoc(ownPushToken, { token: 'test-fcm-token', origin: 'https://kasszaserzsi.hu', role: 'admin', updatedAt: serverTimestamp() }))
assert(true, 'Push token documents reject unexpected fields')
await assertSucceeds(deleteDoc(ownPushToken))
assert(true, 'Participant can turn off push on their device')

// ── Participant catalog menu ────────────────────────────────────────────────
section('Rules: participant catalog menu')
await assertSucceeds(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/products/beer-001`)))
assert(true, 'Participant can read catalog products')
await assertFails(setDoc(doc(userDb, `events/${TEST_EVENT_ID}/products/beer-001`), { price: 1 }, { merge: true }))
assert(true, 'Participant cannot edit catalog products')

// ── 3. people ────────────────────────────────────────────────────────────────
section('Rules: people')

await assertSucceeds(getDoc(doc(adminDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Admin can read people')
await assertSucceeds(getDoc(doc(staffDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Staff can read people')
await assertSucceeds(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Linked user can read own person record')
await assertFails(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/people/other-person-uid`)))
assert(true, 'User cannot read another person\'s record')
await assertFails(getDoc(doc(unauthedDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Unauthenticated cannot read people')
await assertSucceeds(
  setDoc(doc(staffDb, `events/${TEST_EVENT_ID}/people/person-uid`), { balance: 999 }, { merge: true }),
)
assert(true, 'Staff can write people')
await assertFails(
  setDoc(doc(userDb, `events/${TEST_EVENT_ID}/people/person-uid`), { balance: 99999 }, { merge: true }),
)
assert(true, 'User cannot write people')

// ── 4. orders ────────────────────────────────────────────────────────────────
section('Rules: orders')

await assertSucceeds(getDoc(doc(adminDb, `events/${TEST_EVENT_ID}/orders/order-001`)))
assert(true, 'Admin can read any order')
await assertSucceeds(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/orders/order-001`)))
assert(true, 'Linked user can read own order')
await assertFails(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/orders/order-002`)))
assert(true, 'User cannot read another person\'s order')

// ── 5. baskets ───────────────────────────────────────────────────────────────
section('Rules: baskets')

await assertSucceeds(getDoc(doc(adminDb, `events/${TEST_EVENT_ID}/baskets/person-uid`)))
assert(true, 'Admin can read baskets')
await assertSucceeds(getDoc(doc(staffDb, `events/${TEST_EVENT_ID}/baskets/person-uid`)))
assert(true, 'Staff can read baskets')
await assertFails(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/baskets/person-uid`)))
assert(true, 'User cannot read baskets (POS staff only)')

// ── 6. QR assignments ────────────────────────────────────────────────────────
section('Rules: QR assignments')

await assertSucceeds(getDoc(doc(adminDb, `events/${TEST_EVENT_ID}/qrAssignments/1234`)))
assert(true, 'Admin can read QR assignments')
await assertFails(getDoc(doc(staffDb, `events/${TEST_EVENT_ID}/qrAssignments/1234`)))
assert(true, 'Staff CANNOT read QR assignments (admin-only in rules)')
await assertFails(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/qrAssignments/1234`)))
assert(true, 'Főbüfé cannot read QR assignments')
await assertFails(getDoc(doc(userDb, `events/${TEST_EVENT_ID}/qrAssignments/1234`)))
assert(true, 'User cannot read QR assignments')

// ── 7. audit logs ────────────────────────────────────────────────────────────
section('Rules: audit logs')

await assertSucceeds(getDoc(doc(adminDb, `events/${TEST_EVENT_ID}/auditLogs/audit-001`)))
assert(true, 'Admin can read audit logs')
await assertFails(getDoc(doc(staffDb, `events/${TEST_EVENT_ID}/auditLogs/audit-001`)))
assert(true, 'Staff cannot read audit logs')

// Főbüfé can sell, edit the catalog, and read statistics inputs without admin access.
section('Rules: Főbüfé access')
await assertSucceeds(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Főbüfé can read people for POS and statistics')
await assertSucceeds(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/orders/order-001`)))
assert(true, 'Főbüfé can read orders for statistics')
await assertSucceeds(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/ledgerEntries/entry-001`)))
assert(true, 'Főbüfé can read ledger entries for statistics')
await assertSucceeds(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/baskets/person-uid`)))
assert(true, 'Főbüfé can read POS baskets')
await assertSucceeds(setDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/products/beer-001`), { price: 600 }, { merge: true }))
assert(true, 'Főbüfé can update catalog products')
await assertFails(setDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/people/person-uid`), { displayName: 'Changed' }, { merge: true }))
assert(true, 'Főbüfé cannot manage people')
await assertFails(setDoc(doc(headPosDb, `events/${TEST_EVENT_ID}`), { isKitchenClosed: true, updatedBy: 'head-pos-uid', updatedAt: new Date() }, { merge: true }))
assert(true, 'Főbüfé cannot toggle kitchen status')
await assertFails(getDoc(doc(headPosDb, `events/${TEST_EVENT_ID}/auditLogs/audit-001`)))
assert(true, 'Főbüfé cannot read admin audit logs')

// ── 8. disabled account ──────────────────────────────────────────────────────
section('Rules: disabled account')

// token.role = 'staff' but accountStatus() = 'disabled' → isStaffLike() = false
await assertFails(getDoc(doc(disabledDb, `events/${TEST_EVENT_ID}/people/person-uid`)))
assert(true, 'Disabled staff account denied access to people')
await assertFails(
  setDoc(doc(disabledDb, `events/${TEST_EVENT_ID}/baskets/person-uid`), { status: 'open' }, { merge: true }),
)
assert(true, 'Disabled staff account denied write to baskets')

// ── 9. Security rules performance overhead ───────────────────────────────────
section('Rules: performance overhead of get() calls in rules')

const PERF_ITERATIONS = 40
const rulesLatencies = []
const bypassLatencies = []

// With rules: each read triggers get(accountPath()) in Firestore security rules
for (let i = 0; i < PERF_ITERATIONS; i++) {
  const t0 = performance.now()
  await getDoc(doc(staffDb, `events/${TEST_EVENT_ID}/people/person-uid`))
  rulesLatencies.push(performance.now() - t0)
}

// Without rules: admin SDK bypass, no extra reads
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const bypassDb = ctx.firestore()
  for (let i = 0; i < PERF_ITERATIONS; i++) {
    const t0 = performance.now()
    await getDoc(doc(bypassDb, `events/${TEST_EVENT_ID}/people/person-uid`))
    bypassLatencies.push(performance.now() - t0)
  }
})

const rulesStats = printStats(`With security rules (${PERF_ITERATIONS} reads, staff ctx)`, rulesLatencies.map(Math.round))
const bypassStats = printStats(`Without rules (${PERF_ITERATIONS} reads, bypassed)`, bypassLatencies.map(Math.round))
const overheadMs = rulesStats.mean - bypassStats.mean
console.log(`  Rules overhead (mean): +${overheadMs.toFixed(1)}ms per authenticated read`)
console.log(`  Note: rules call get(accountPath()) + exists(accountPath()) on EVERY read → 2 extra Firestore reads`)
assert(rulesStats.p99 < 3000, `Rules p99 latency < 3000ms (emulator) — got ${rulesStats.p99}ms`)

await testEnv.cleanup()
printSummary('═══ SECURITY RULES TESTS COMPLETE ═══')
