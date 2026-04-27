# Erzsi 2.0 — Performance & Stability Test Report

**Date:** 2026-04-22  
**Tester:** Claude (automated)  
**Environment:** Local developer machine (Windows 11), Firebase Emulator Suite 14.17.0  
**Node.js:** v22.14.0

---

## Executive Summary

The app is **conditionally safe for launch** under the expected event load (~500 attendees, 5–10 concurrent staff). The Firestore architecture is sound: transactions serialize correctly, the basket lock works, and double-finalization is protected. However, **two critical defects must be fixed before go-live**, and **three medium risks need mitigation** either before or shortly after launch.

**Go / No-go: CONDITIONAL GO** — fix the two critical items below, then deploy.

---

## Architecture & Bottleneck Map

```
Browser (React 19 + Firebase Client SDK)
    │
    ├── onSnapshot listeners (Firestore realtime)
    │     • subscribeToPeople — ALL 500 people, no limit
    │     • subscribeOrdersForEvent — ALL orders, grows during event
    │     • subscribeFoodOrders — kitchen queue (needs composite index)
    │     • subscribeDrsOrders — DRS queue (has index)
    │
    ├── runTransaction (Firestore) — CRITICAL PATH
    │     • acquireBasketLock: reads person + basket
    │     • finalizeBasket: reads basket + person → creates order + ledger
    │     • topUpBalance / DRS return: reads person → updates balance
    │
    └── onCall (Cloud Functions, max 10 instances)
          • resolveAssignedQrCredential — every QR scan
          • generateQrCredentials — admin batch (up to 250)
          • assignQrCredentialToPersona — admin operation

Firestore Security Rules
    • isStaffLike() / isAdmin() → calls get(accountPath()) on EVERY request
    • Adds ~1 extra Firestore read per authenticated operation
```

---

## What Was Tested

### Phase 1: Unit Tests (01-unit-tests.js)
**No Firebase required. Ran immediately.**

Tests covered:
- Basket lock session ownership logic
- Stale lock detection (45-second threshold)
- Basket content discard on stale lock
- Balance insufficient-funds edge case
- Basket item summarization and totals
- Extras pricing and line total calculation
- Merge key generation for deduplication
- Kitchen workload level mapping
- Kitchen wait-time estimation
- QR code input normalization
- Double-submit protection simulation
- Concurrent lock acquisition simulation

**Result: 55/55 PASSED**

### Phase 2: Emulator Concurrency Tests (02-emulator-tests.js)
**Firebase Emulator on localhost:8080.**

Tests covered:
- Transaction serialization under concurrent balance writes
- Basket lock contention between concurrent staff sessions
- Double-finalization protection
- Concurrent DRS return + sale on same person
- Composite index query acceptance
- Burst order creation throughput (50 concurrent)
- Soak test (200 sequential writes)

**Result: 20/20 PASSED**

### Phase 3: Security Rules Tests (03-security-rules.js)
**Firebase Emulator on localhost:8080, with rules loaded.**

Tests covered:
- system/runtime read/write by role
- Account read/write by role
- People read/write by role (including linked-user access)
- Order read isolation (user can only see own orders)
- Basket access (staff-only)
- QR assignment access (admin-only)
- Audit log access (admin-only)
- Disabled account enforcement
- Security rules performance overhead measurement

**Result: 32/32 PASSED**

**Total: 107/107 assertions passed**

---

## Measured Results

### A. Concurrent Balance Writes — Transaction Serialization

| Scenario | Workers | Success | Failures | Total Retries | Mean Retries | Wall Time |
|---|---|---|---|---|---|---|
| Concurrent topups (same person) | 10 | 10/10 | 0 | 24–33 | 2.4–3.3× | 8–13s |
| Concurrent finalizations (different people) | 50 | 50/50 | 0 | 0 | 1.0× | 564–885ms |

**Interpretation:**
- Concurrent writes to the **same** person document are correctly serialized by Firestore. No data corruption. Final balance is always exactly correct. However, each additional contending writer adds exponential retry delay: 10 concurrent topups on the same person took 8–13 seconds total.
- Concurrent writes to **different** people have zero contention. 50 orders processed in under 900ms.

**Real-world implication:** 10 admins simultaneously topping up the same person is an unlikely scenario. Normal operations (different staff serving different people) have zero contention.

### B. Basket Lock Contention

| Action | Expected | Actual |
|---|---|---|
| Staff 1 acquires fresh lock | ✓ Succeeds | ✓ |
| Staff 2 tries to steal lock | ✗ Blocked | ✗ Blocked |
| Staff 1 refreshes same session | ✓ Re-entrant | ✓ |
| Staff 1 different session | ✗ Blocked | ✗ Blocked |
| Staff 2 after 50s stale timeout | ✓ Takes over | ✓ |

**The 45-second stale basket lock works correctly.** If a staff device crashes, another staff member can take over after 45 seconds. Items already in the basket are preserved (not discarded) unless the basket is stale when the new session opens it.

### C. Double Finalization Protection

- First `finalizeBasket` → succeeds, creates order, deletes basket atomically
- Second `finalizeBasket` → fails with "Active basket was not found."
- Exactly 1 order document in Firestore after two attempts
- **Protected: no double-charging possible**

### D. DRS Return + Sale Concurrency

- DRS return (+250 HUF) and basket finalization (-1000 HUF) on same person ran simultaneously
- Both succeeded after 1 retry each (Firestore serialized them internally)
- Final balance: correct (1000 + 250 − 1000 = 250 HUF)
- **No data inconsistency observed**

### E. Query Composite Index Requirements

| Query | Index Status | Result |
|---|---|---|
| `orders where(hasDrs==true) + orderBy(createdAt)` | In indexes.json | ✓ Works |
| `orders where(hasFood==true) + orderBy(createdAt)` | **MISSING** | Accepted by emulator* |
| `orders where(personId==X) + orderBy(createdAt)` | **MISSING** | Accepted by emulator* |
| `drsReturns where(personId==X) + orderBy(createdAt)` | In indexes.json | ✓ Works |

*The Firestore emulator does not enforce composite index requirements. These queries will **fail in production** if the indexes are not deployed.

**Fix applied:** Two missing indexes added to `firestore.indexes.json` (see below).

### F. Burst Order Creation Throughput

| Metric | Value |
|---|---|
| Concurrent workers | 50 |
| Success rate | 100% (50/50) |
| Total elapsed | 564–885ms |
| Mean per order | 11–18ms |
| Throughput | **56–88 orders/sec** |

This far exceeds expected real-world peak (roughly 2–5 orders/minute per staff member × 10 staff = ~0.5–0.8 orders/sec). The system has massive headroom for concurrent order creation when different people are served.

### G. Soak Test — 200 Sequential Writes

| Metric | Value |
|---|---|
| Operations | 200 balance topups |
| min | 13ms |
| p50 | 32–33ms |
| p95 | 46–48ms |
| p99 | 53–57ms |
| max | 55–63ms |
| mean | 33–34ms |
| Latency drift (first 20% vs last 20%) | −1.5% to −24.8% (slight improvement over time) |

**No latency degradation observed over 200 operations.** The slight improvement at the end is likely JVM warmup in the Firestore emulator. In production, latency will be higher due to EU network round-trip (add 20–50ms for europe-west1).

### H. Security Rules Performance Overhead

| Context | min | p50 | p95 | p99 | mean |
|---|---|---|---|---|---|
| With rules (staff JWT) | 14ms | 31ms | 148ms | 196ms | 39ms |
| Without rules (admin bypass) | 5ms | 15ms | 26ms | 63ms | 14ms |
| **Overhead** | +9ms | +16ms | +122ms | +133ms | **+26ms** |

**Root cause:** `isStaffLike()` and `isAdmin()` in the rules call `accountStatus()` which calls `get(accountPath())` — an extra Firestore document read on **every** authenticated request. This adds one additional Firestore round-trip per rule evaluation.

In production (EU network), this overhead will be 40–100ms per authenticated read, significantly impacting perceived responsiveness.

---

## Breaking Points & Failure Modes

### 1. Balance Goes Negative on Single Purchase (**CRITICAL** — CONFIRMED BY UNIT TEST)

**File:** `src/features/pos/posService.js:281`

```js
// Current code — only checks BEFORE balance, not AFTER
const balanceBefore = person.balance || 0
if (balanceBefore < 0) {
  throw new Error(`${person.displayName} is already below zero and cannot purchase again yet.`)
}
const totalAmount = basket.totalAmount || 0
const balanceAfter = balanceBefore - totalAmount  // ← can go negative, no check
```

**Scenario:** Person has 300 HUF. Staff adds 500 HUF item to basket. `finalizeBasket` runs. `balanceBefore = 300 ≥ 0` → check passes. `balanceAfter = −200`. Order created. Person now owes 200 HUF they never paid.

**Impact:** Person can accidentally be served more than their loaded balance. In a cash-only event, this is a real loss.

**Proposed fix:**
```js
if (balanceAfter < 0) {
  throw new Error(
    `${person.displayName} has insufficient balance (${balanceBefore} HUF) for this purchase (${totalAmount} HUF).`
  )
}
```

### 2. Missing Composite Indexes — Kitchen and Per-Person Queries (**CRITICAL** — CONFIRMED BY CODE ANALYSIS)

`subscribeFoodOrders` and `subscribeOrdersForPerson` use composite queries (`where` + `orderBy` on different fields) that require composite indexes. These indexes were **not** present in `firestore.indexes.json`.

**Impact:** Without the indexes:
- `subscribeFoodOrders` → kitchen display shows nothing → kitchen staff miss food orders
- `subscribeOrdersForPerson` → user's order history fails to load

**Fix applied:** Both indexes added to `firestore.indexes.json`. Deploy with `firebase deploy --only firestore:indexes` before launch.

### 3. Security Rules Add 1 Extra Firestore Read Per Request (**MEDIUM** — MEASURED)

`accountStatus()` in `firestore.rules` calls `get(accountPath())` even when the user's role is already available from the JWT token. This doubles read costs for all authenticated requests.

**Impact:** ~26ms overhead per read on localhost. In production: estimated 40–100ms additional latency per Firestore read. For a page that loads 3–5 collections simultaneously, this adds 120–500ms to page load.

**Proposed fix:** Cache account status in the JWT token as a custom claim, or use `request.auth.token` exclusively for all checks. Example:

```
// Optimized — no extra Firestore reads
function isStaffLike() {
  return request.auth != null
    && (request.auth.token.role == 'staff' || request.auth.token.role == 'admin')
    && request.auth.token.status != 'disabled'
}
```

This requires setting `status` in custom claims when disabling accounts (call `adminAuth.setCustomUserClaims(uid, { role: ..., status: 'disabled' })`).

### 4. subscribeToPeople Loads All 500 Records Without Limit (**MEDIUM** — CODE ANALYSIS)

`subscribeToPeople` in `personService.js` subscribes to ALL people ordered by `createdAt` with no `limit()`. For 500 attendees, every connected staff client holds 500 documents in memory, and every person update re-delivers the full changed document to every listener.

**Impact:** ~50–100KB initial load per staff client. Every person update triggers re-render across all staff clients. Under rapid import or update bursts, this could cause perceptible UI lag.

**Proposed fix:** Add client-side pagination (limit to 200), or filter by `recordStatus == 'active'` (with appropriate composite index).

### 5. subscribeOrdersForEvent Has No Limit (**MEDIUM** — CODE ANALYSIS)

`subscribeOrdersForEvent` grows throughout the event. With 500 attendees each buying multiple times, by end of event there could be 1000–2000 order documents delivered to every subscribed client on every new order.

**Proposed fix:** Add `limitCount: 200` to all calls to `subscribeOrdersForEvent` in admin/staff views. The app already supports this via `options.limitCount`.

### 6. Cloud Functions Max 10 Instances (**LOW-MEDIUM** — CODE ANALYSIS, NOT TESTED)

`maxInstances: 10` is hardcoded in `functions/index.js`. Every QR scan calls `resolveAssignedQrCredential` (a Cloud Function). If >10 concurrent scans happen simultaneously, requests queue in Google's infrastructure.

**Expected real-world load:** 5–8 concurrent staff, each scanning once every 10–30 seconds → 0.2–0.8 concurrent function calls. Well under the limit.

**Risk scenario:** Admin runs `generateQrCredentials(250)` while staff are actively scanning. This uses several function instances simultaneously.

**Proposed fix for robustness:** Increase to `maxInstances: 20` or implement QR resolution via a direct Firestore read (staff has read access to `qrAssignments` collection after appropriate rules adjustment).

Actually, current rules: `qrAssignments` is admin-read only. The Cloud Function call is necessary for staff to resolve QR codes without admin privileges. Consider adding a dedicated read path for staff.

### 7. Basket Lock 45-Second Dead Zone (**LOW** — CODE ANALYSIS, CONFIRMED BY UNIT TEST)

If a staff device crashes with an open basket, that person's basket is locked for up to 45 seconds. During this time, no other staff can open it.

**Impact:** In a fast-paced event with long queues, 45 seconds is acceptable but noticeable. Attendee must wait.

**Proposed improvement:** Add a manual "force-take" option in the admin panel to immediately clear a stuck basket lock.

### 8. Kitchen Wait Time Model Is Extremely Conservative (**LOW** — CODE ANALYSIS)

`ITEMS_PER_MINUTE = 0.25` means the model assumes the kitchen processes 1 food item every 4 minutes. At KRITIKUS level (21 items), the estimated wait is **84 minutes**. This is likely wrong and will alarm kitchen staff with inaccurate estimates.

**Impact:** Display only. No operational impact.

**Proposed fix:** Increase `ITEMS_PER_MINUTE` to 2–4 (depending on kitchen throughput) or make it configurable per event.

---

## Risk Register

| # | Issue | Severity | Likelihood | Impact | Status |
|---|---|---|---|---|---|
| 1 | `finalizeBasket` allows negative balance | HIGH | MEDIUM | Person overcharged, unrecoverable without manual refund | **Not fixed — fix before launch** |
| 2 | Missing composite indexes for `subscribeFoodOrders` and `subscribeOrdersForPerson` | HIGH | CERTAIN (if not deployed) | Kitchen display shows nothing; user order history fails | **Fixed in `firestore.indexes.json` — deploy indexes** |
| 3 | Security rules add 1 extra Firestore read per request | MEDIUM | CERTAIN | 40–100ms latency overhead per authenticated read in production | Open — optimization |
| 4 | `subscribeToPeople` unbounded — all 500 records | MEDIUM | MEDIUM | UI lag under rapid updates; memory growth on long sessions | Open — add limit |
| 5 | `subscribeOrdersForEvent` grows unboundedly | MEDIUM | MEDIUM | Memory growth during event; re-render on every order | Open — use limitCount |
| 6 | Cloud Functions max 10 instances | LOW | LOW (under normal load) | Queue buildup under burst admin + staff concurrent use | Acceptable for current scale |
| 7 | Basket lock 45s dead zone on device crash | LOW | LOW | 45s wait for attendee before another staff can serve | Acceptable |
| 8 | Kitchen wait time model grossly inaccurate | LOW | CERTAIN | Kitchen staff will see incorrect estimates (display only) | Acceptable |
| 9 | Audit logs unbounded, no cleanup | LOW | CERTAIN over time | Slow audit log queries after many events | Post-launch maintenance |

---

## Confirmed Correct Behaviors (Do Not Change)

- ✓ Firestore transactions correctly serialize concurrent balance writes — no data corruption
- ✓ Double-finalization protected atomically (basket deleted in same transaction as order)
- ✓ Basket lock correctly blocks other staff sessions
- ✓ Stale lock (45s) allows session recovery from crashed devices
- ✓ Concurrent DRS + sale on same person: both succeed, final balance mathematically correct
- ✓ Security rules correctly enforce all role boundaries
- ✓ Disabled accounts are blocked despite having a valid role claim
- ✓ Users can only access their own person record and their own orders
- ✓ QR code normalization handles 5-digit codes and URL formats correctly
- ✓ DRS lineType excluded from `itemCount` (correct — betétdíj is not a purchased item)
- ✓ Burst throughput: 56–88 orders/sec for different people (massively exceeds real-world load)
- ✓ No latency degradation in soak test over 200 sequential writes

---

## Recommended Fixes — Priority Order

### Before Launch (Blockers)

**Fix 1 — Add insufficient-balance guard to `finalizeBasket`**

In `src/features/pos/posService.js`, after computing `balanceAfter`:
```js
const balanceAfter = balanceBefore - totalAmount

if (balanceAfter < 0) {
  throw new Error(
    `${person.displayName} has insufficient balance. ` +
    `Balance: ${balanceBefore} HUF, Purchase: ${totalAmount} HUF.`
  )
}
```

**Fix 2 — Deploy missing Firestore indexes**

```bash
firebase deploy --only firestore:indexes
```

The two missing indexes have already been added to `firestore.indexes.json`:
- `orders: (hasFood ASC, createdAt DESC)` ← for kitchen food queue
- `orders: (personId ASC, createdAt DESC)` ← for per-person order history

**Note:** Index creation in production takes 2–10 minutes. Deploy indexes BEFORE the event, not during.

### Before or Shortly After Launch (Important)

**Fix 3 — Add `limitCount` to subscribeOrdersForEvent calls**

Audit all usages of `subscribeOrdersForEvent` in admin/staff views and ensure `options.limitCount` is set (suggest 200). The function already supports this — just not used.

**Fix 4 — Eliminate get(accountPath()) from security rules**

Set `status` as a custom claim when disabling/enabling accounts, and simplify the rules to:
```
function isStaffLike() {
  return request.auth != null
    && (request.auth.token.role == 'staff' || request.auth.token.role == 'admin')
    && request.auth.token.status != 'disabled'
}
```

Add `disablePrivilegedAccount` Cloud Function to also call:
```js
await adminAuth.setCustomUserClaims(targetUid, { role: existingClaims.role, status: 'disabled' })
```

### Post-Launch (Backlog)

**Fix 5 — Increase Cloud Functions max instances**

In `functions/index.js`:
```js
setGlobalOptions({ region: 'europe-west1', maxInstances: 30, cors: true })
```

**Fix 6 — Add people list pagination or active-only filter**

**Fix 7 — Fix kitchen wait time model** (adjust `ITEMS_PER_MINUTE`)

**Fix 8 — Add audit log cleanup/archival mechanism**

---

## Production Hardening Checklist

- [ ] Apply Fix 1 (insufficient balance guard) — **REQUIRED**
- [ ] Deploy updated `firestore.indexes.json` — **REQUIRED**
- [ ] Verify `firebase deploy --only firestore:indexes` completes before event
- [ ] Test `subscribeFoodOrders` live with a test order to confirm kitchen display works
- [ ] Confirm custom claims include `role` for all staff/admin accounts
- [ ] Set `limitCount: 200` on `subscribeOrdersForEvent` in admin dashboard
- [ ] Test device crash recovery: crash a staff device with open basket, confirm another staff can take over after 45s
- [ ] Run manual load test with 2–3 concurrent staff sessions during pre-event setup
- [ ] Monitor Firebase usage console during event for function invocation count and Firestore read volume
- [ ] Add error boundary / retry UI for `onError` callbacks in `subscribeFoodOrders` and `subscribeOrdersForPerson`
- [ ] Confirm BOOTSTRAP_ADMIN_EMAILS env var is set in Cloud Functions config
- [ ] Confirm Firebase App Check is not blocking legitimate PWA requests
- [ ] Confirm PWA is installable on both iOS (Safari) and Android (Chrome) staff devices

---

## Tests That Should Be Re-run in Staging

The following cannot be meaningfully tested in the local emulator because they require real network latency, real Firebase Auth, or actual browser clients:

1. **Real network latency baseline** — Run 200 sequential Firestore writes against the real `erzsi-2` project. Expected p50: 80–120ms, p99: 200–400ms (EU network).

2. **Cloud Functions concurrent invocation** — Invoke `resolveAssignedQrCredential` 10+ times concurrently to validate the 10-instance ceiling in practice.

3. **Browser PWA performance** — Use Chrome DevTools Performance tab to measure:
   - Time to interactive on first load
   - Re-render time when an order arrives on kitchen display
   - Memory growth during a 2-hour simulated event

4. **Real auth session churn** — Log in and out with 5 accounts rapidly to confirm custom claims are properly refreshed (Firebase auth token cache is 1 hour by default — role changes may not take effect immediately).

5. **Full event simulation** — Run with 500 people imported, 5 staff accounts, process 100 orders across 30 minutes, verify ledger totals match at end.

---

## How to Re-run the Tests

```bash
# Unit tests (no Firebase required — runs in seconds)
cd tests
node 01-unit-tests.js

# Full emulator test suite (starts emulator automatically)
node run-emulator-tests.js

# Shortcut to run all
node run-all.js
```

All test dependencies are in `tests/node_modules`. No `.env` setup required for emulator tests.
