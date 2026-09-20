# Architectural Assessment

This document intentionally separates criticism from the neutral system description. Severity reflects plausible impact in this product, not generic best practice.

## Priority summary

| Severity | Issue | Confidence |
| --- | --- | --- |
| High | Linked guests can read every food order | Confirmed |
| High | POS/staff clients can forge core accounting documents | Confirmed |
| High | Event close cannot scale to realistic upper bounds | Confirmed |
| High | People import can exceed batch limits and is not chunked | Confirmed |
| Medium | Bulk-adjustment idempotency is race-prone and partial | Confirmed |
| Medium | Unbounded listeners/browser analytics grow with event history | Confirmed |
| Medium | Silent 500-person cap creates incomplete admin/POS views | Confirmed |
| Medium | Large, tightly coupled UI/service modules impede safe change | Confirmed |
| Medium | Multi-stage imports/cloning can leave partial state | Confirmed |
| Medium | Duplicate business rules can drift | Confirmed |
| Medium | Auth claims/account records can diverge | Confirmed |
| Medium | No coherent observability/backup/retention strategy | Confirmed |
| Medium | Tests copy logic and current full verification is unhealthy | Confirmed |
| Medium | Large single frontend bundle | Confirmed |
| Low–Medium | Kitchen/product behavior relies on naming conventions | Confirmed |

## Security and authorization

### 1. Cross-participant food-order disclosure

**Problem.** Any linked participant can read every food order, not only its own.

**Evidence.** `useUserDashboardData.js` subscribes to `subscribeFoodOrders` to calculate orders ahead. `firestore.rules` permits a linked user to read when either `resource.data.personId` matches or `resource.data.hasFood == true`. Orders contain participant display identifiers and complete line/customization data.

**Impact.** Authenticated guests can observe other guests' names/identifiers and purchase details. This is a concrete privacy/confidentiality failure.

**Severity:** High. **Confidence:** Confirmed.

**Recommended direction.** Do not expose raw queue orders to guests. Maintain an aggregate queue counter/rank document via trusted server logic, or return a minimal queue position from a callable endpoint. Restrict order Rules to own `personId` only.

### 2. Broad client authority over financial records

**Problem.** POS-capable roles have unrestricted write access to orders, baskets, ledger entries, audit logs, and DRS returns. Staff additionally has unrestricted person updates through `canManagePeople`.

**Evidence.** `firestore.rules` uses `allow write: if canUsePos()` on those collections and `allow update: if canManagePeople()` on people. Rules do not validate order totals against products, ledger amount against balance delta, refund limits, state transitions, or append-only semantics.

**Impact.** A stolen staff token or malicious/custom client can fabricate sales/refunds/audit records, change balances, delete orders, or create inconsistent accounting while satisfying role checks. UI transactions are not a security boundary.

**Severity:** High. **Confidence:** Confirmed.

**Recommended direction.** Move checkout, refunds, DRS credit, kitchen transitions, and manual balance/stock changes behind callable Functions or rigorously constrain Rules with immutable fields and `getAfter()` cross-document invariants. Make ledger/audit append-only from trusted server code.

### 3. Disabled-state enforcement differs between Rules and Functions

**Problem.** Rules read account status, while Function role helpers only inspect token claims.

**Evidence.** `isAdmin`/role predicates in Rules require `accountStatus() != 'disabled'`; `ensureAdmin`, `ensureStaffLike`, and `ensureTopupLike` in `functions/index.js` do not query account status. Disable updates Auth and Firestore but does not explicitly revoke refresh tokens or replace claims with a disabled marker.

**Impact.** Exact immediate revocation behavior for already issued tokens is uncertain; a disabled user may retain callable authority for a window if Auth accepts the token.

**Severity:** Medium. **Confidence:** Strongly supported (the code difference is confirmed; token behavior should be validated).

**Recommended direction.** Revoke refresh tokens on disable and/or check account status in privileged callables. Add a regression test using a token minted before disable.

### 4. No App Check evidence

**Problem.** The repository does not initialize Firebase App Check or configure callable enforcement.

**Evidence.** No App Check dependency/bootstrap/config is present.

**Impact.** Authenticated abuse must be controlled only by Rules, claims, quotas, and platform protections; scripted clients are easy to construct.

**Severity:** Low–Medium. **Confidence:** Strongly supported; console-side settings remain uncertain.

**Recommended direction.** Evaluate App Check for public web clients after fixing Rules. Do not use it as a substitute for authorization.

## Consistency and concurrency

### 5. Event close exceeds Firestore transaction limits

**Problem.** Closing reads the entire people subcollection, reads each unique carryover, and writes one carryover per person plus event/runtime/audit in one transaction.

**Evidence.** `closeEventAndCarryBalances` in `functions/index.js` performs unbounded transaction collection/query reads and per-person writes. Firestore transactions have finite document/write/time limits.

**Impact.** Event closure will fail once the event is large enough; it is exactly the operation needed to preserve balances. The UI supports hundreds/thousands of people and bulk operations up to 5,000, making this credible.

**Severity:** High. **Confidence:** Confirmed design limit; exact failure threshold depends on Firestore platform limits/data size.

**Recommended direction.** Implement a resumable server-side close job with event `closing` state, deterministic per-person carryover writes, progress/checkpoints, duplicate prevention, and final runtime switch only after validation/completion. Alternatively enforce a hard supported attendee cap well below limits.

### 6. People import uses one oversized batch

**Problem.** All accepted person records, possible carryover ledger entries, and one audit record are committed in a single write batch.

**Evidence.** `importPeopleRows` creates one `writeBatch` and commits after iterating all rows. Catalog/stock imports chunk at 200, highlighting the inconsistency.

**Impact.** Imports with roughly 500 people—or fewer when carryovers add ledger writes—can exceed the batch limit and fail entirely. The people listener itself anticipates 500.

**Severity:** High. **Confidence:** Confirmed.

**Recommended direction.** Chunk imports with a job/import ID, prevalidate duplicates and total limits, commit deterministic records, and produce a completion summary. Document partial-failure recovery.

### 7. Bulk balance idempotency is non-atomic

**Problem.** The Function queries for a summary, processes multiple transactions, then adds the summary. Concurrent calls with the same ID can both start; failed chunks are not marked for targeted safe retry.

**Evidence.** `bulkAdjustPersonBalance` performs the existence query before its loop and writes summary after all chunks. Correlation ID is not reserved with create/precondition.

**Impact.** Double application is possible under simultaneous retry/double-click race; partial runs may be reported as already processed even though some chunks failed.

**Severity:** Medium (potentially High for large monetary changes). **Confidence:** Confirmed.

**Recommended direction.** Create an operation document atomically (`create`) before processing, track per-chunk deterministic IDs/status, make each person entry idempotent, and only mark complete after all intended chunks resolve.

### 8. Active-event uniqueness is conventional

**Problem.** Event status and runtime pointer can diverge; multiple events may be active.

**Evidence.** Client checks `currentActiveEventId`, but Rules permit admin writes and no server transaction asserts global uniqueness. `ensureRuntimeDocument` explicitly handles the possibility of multiple active events by refusing automatic repair.

**Impact.** Different screens/data may disagree on operational event; staff can transact against an unintended event if IDs are stale.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Move create/activate/close lifecycle behind one server command using the runtime singleton as the serialized decision point; validate allowed state transitions.

### 9. Multi-stage catalog operations are only partially atomic

**Problem.** Cloning and product/stock imports execute several batches/transactions with no operation state or compensation.

**Evidence.** `cloneCatalogFromSourceEvent`, `prepareImportedStockRecipe`, `importProducts`, `importStockItems`, and `clearProducts` commit chunks sequentially and audit later.

**Impact.** Network/permission/quota failure can leave stock without products, incomplete catalog/barcode mappings, or data changes without the summary audit.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Add import job records and deterministic/upsertable IDs; validate first, checkpoint chunks, expose status/retry, and reconcile barcode/product indexes.

### 10. Stored totals can trust stale/tampered basket total

**Problem.** Checkout recalculates a basket summary but uses `basket.totalAmount` when it is not null instead of always taking the recalculated total.

**Evidence.** `posService.js` sets `const totalAmount = basket.totalAmount ?? basketSummary.totalAmount`.

**Impact.** With broad basket write permission, a POS client can alter the stored total independently of lines. Even accidental schema drift can charge an inconsistent amount.

**Severity:** Medium; composes with finding 2. **Confidence:** Confirmed.

**Recommended direction.** Always calculate price/totals from server-trusted catalog or signed snapshots in a server-side checkout; at minimum prefer calculated summary and validate every line.

## Performance and scale

### 11. Growing unbounded real-time subscriptions

**Problem.** Orders, ledger, audit, stock movements, food orders, DRS returns, and QR lists are commonly subscribed without pagination/limits. Analytics attaches several simultaneously.

**Evidence.** subscription services only optionally limit a few queries; major call sites omit the option. `useEventStatistics`, `useEventArchiveData`, Repohár, kitchen, and user queue consume entire collections.

**Impact.** Increasing read cost, initial latency, browser memory/CPU, and rerender/aggregation work throughout an event. Kitchen and every participant listening to all food orders amplify reads.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Use active-ticket queries, time windows, pagination, summary/materialized metric documents, and server-derived participant queue positions. Archive closed-event analytics separately if required.

### 12. Silent 500-person truncation

**Problem.** `subscribeToPeople` limits to 500 newest records and every consumer treats the result as complete.

**Evidence.** `personService.js` has `orderBy(createdAt, desc), limit(500)`; POS, admin, audit, linking, analytics, and event health reuse it.

**Impact.** Older participants disappear from POS/admin lookup and analytics after 500, while server close still processes all. This creates dangerous disagreement rather than graceful scaling.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Declare/enforce a hard event cap or implement paged/search-specific queries. Do not use one capped subscription for complete health/statistics.

### 13. Large monolithic client bundle

**Problem.** Routes/panels and heavy libraries are eagerly bundled.

**Evidence.** Production build generated a ~2.06-MB minified main JS chunk (~588 KB gzip) and Vite warned above 500 KB. Routes use static imports; SheetJS, Recharts, scanners, large admin/POS modules are in the graph.

**Impact.** Slower first load/parse on event mobile devices and larger update downloads.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Lazy-load role routes and admin analytics/import libraries; split POS/kitchen/admin chunks; measure on target phones.

### 14. Rules require account document lookups

**Problem.** Most privileged Rules evaluate `exists/get(accounts/{uid})` for status and sometimes role fallback.

**Evidence.** `accountStatus()` and `effectiveRole()` call account helpers. Historical tests measured additional local overhead, though those measurements are not current-production evidence.

**Impact.** Additional Rules document accesses, latency, and billing on high-frequency real-time traffic.

**Severity:** Low–Medium. **Confidence:** Confirmed design; production magnitude uncertain.

**Recommended direction.** Measure first. Consider a carefully managed status claim plus explicit token revocation, or retain account lookup for immediate disable if security value outweighs cost.

## Maintainability and correctness

### 15. Oversized components and centralized Function module

**Problem.** `StaffPosPanel.jsx` (~2,900 lines), `ProductManagementPanel.jsx` (~2,700), `PeopleManagementPanel.jsx` (~2,600), and `functions/index.js` (~1,800) combine many responsibilities.

**Evidence.** Files contain parsing, persistence orchestration, scanner protocols, calculations, state machines, and extensive rendering.

**Impact.** High change coupling, difficult focused tests/review, merge conflicts, and regressions in unrelated modes.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Extract tested domain/application modules first—not cosmetic component splitting. Separate callable modules by account/QR/balance/event; extract scanner, import, basket, and customization state machines.

### 16. Duplicated rules and representations

**Problem.** Roles, QR parsing/record builders, Shibboleth normalization, station classification, ledger/audit types, and carryover logic exist in multiple client/server/service/test locations.

**Evidence.** `functions/index.js` duplicates client models; order station logic is copied into `orderModels.js` and `orderService.js`; tests reimplement production algorithms.

**Impact.** A change can pass one test/path while another drifts. Compatibility fields already show this evolution pressure.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Extract environment-neutral shared domain modules consumable by browser, Functions, and tests. Keep Rules parity tests for values that cannot literally share code.

### 17. Naming-based business behavior

**Problem.** Reusable cups and kitchen stations are detected with product-name/template regexes.

**Evidence.** `REUSABLE_CUP_NAME_PATTERN` and burger/gyros/pizza trigger patterns control returns, tracking, customizers, and station routing.

**Impact.** Renaming/localization or unexpected spelling silently changes financial/operational behavior.

**Severity:** Low–Medium. **Confidence:** Confirmed.

**Recommended direction.** Add explicit product type and kitchen station fields; migrate legacy records with regex fallback only during transition.

### 18. Event lifecycle transitions are not enforced

**Problem.** Closed events can technically be reactivated and kitchen status can jump/reverse.

**Evidence.** activation patch unconditionally sets active; kitchen service validates membership in status enum only; Rules allow broad writes.

**Impact.** Historical data may become operational again or ticket state may regress unexpectedly.

**Severity:** Medium. **Confidence:** Confirmed technical possibility.

**Recommended direction.** Centralize commands and validate current→next transition server-side; record explicit reopen/override action if required.

## Testing and operations

### 19. Test suite is bespoke and partially detached from production code

**Problem.** Several tests duplicate functions, orchestration depends on PATH/global Firebase CLI, and there are no component/browser tests.

**Evidence.** `tests/01-unit-tests.js` and `05-qr-carryover-regression.js` contain local copies/helpers; scripts are not wired into root `package.json`; current emulator runner failed when child PATH lacked executables; ESLint is failing.

**Impact.** Passing calculations may not cover the code shipped. UI, Functions authorization, imports, PWA, and end-to-end role workflows depend heavily on manual testing.

**Severity:** Medium. **Confidence:** Confirmed.

**Recommended direction.** Add Vitest for importable domain modules, Firebase Rules unit tests in the normal runner, Function tests against exported handlers/emulator, and Playwright smoke tests for each role. Make root CI run lint/build/tests on a clean checkout.

### 20. Limited observability and data protection

**Problem.** There is no structured monitoring, health check, alerting, backup/restore, or retention configuration.

**Evidence.** Only console/platform logs and business audit collections are present; no CI/monitoring/IaC files or cleanup jobs exist.

**Impact.** Failures may be noticed by users; forensic correlation and recovery are manual. Audit and operational collections grow indefinitely.

**Severity:** Medium. **Confidence:** Confirmed for repository; external console setup is unknown.

**Recommended direction.** Define SLOs and alerts for callable errors/latency and Firestore usage, structured log fields, daily export/backup and restore drills, retention policy, and a minimal operational dashboard/runbook.

## Strengths worth preserving

- Checkout/refund/DRS transactions correctly group related writes.
- Basket deletion naturally prevents repeated finalization.
- A device-session lease addresses concurrent cashiers pragmatically.
- Orders snapshot pricing/customization/stock consumption for historical stability.
- Rules distinguish multiple operational roles and deny unauthenticated access.
- QR assignment and account/person linking are server-transactional.
- Carryover includes explicit duplicate/missing-identifier validation and source stamping.
- Staging and production projects/modes are separated and PWA cache staleness was considered.

## Recommended sequence

1. Remove cross-user food order access and replace it with a privacy-safe queue projection.
2. Move accounting/order/refund mutations behind trusted server commands and make records append-only.
3. Redesign event close and people import for bounded, resumable execution.
4. Repair bulk-operation idempotency and add lifecycle invariants.
5. Add CI and tests that exercise shipped modules/Rules/Functions.
6. Introduce pagination/materialized analytics and route code splitting.
7. Gradually extract shared domain logic and explicit product/station types.

