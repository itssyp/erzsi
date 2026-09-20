# API and Integrations

## Interface model

There is no REST or GraphQL API. The effective API has three surfaces:

1. direct Firestore reads/listeners/writes from feature services;
2. Firebase callable Functions invoked with an Auth ID token;
3. Firebase Authentication SDK operations.

Inputs/outputs are JavaScript objects, with validation distributed among UI, service, Rules, and Functions.

## Callable Functions

All Functions are v2 callable HTTPS endpoints in `europe-west1`, accept configured browser origins, and return Firebase callable responses/errors.

### Session and account administration

| Callable | Caller / authorization | Behavior and side effects |
| --- | --- | --- |
| `bootstrapAdminSession` | Any authenticated account; e-mail must be in `BOOTSTRAP_ADMIN_EMAILS` to elevate | Sets admin custom claim and upserts admin account; otherwise returns current normalized role |
| `createPrivilegedAccount` | Admin | Creates Firebase Auth user, role claim, and account document; rejects `user` role |
| `setAccountRole` | Admin | Rewrites target role claim and account role |
| `disablePrivilegedAccount` | Admin; not self | Disables Auth user and marks account disabled |

These operations are not transactionally coupled across Firebase Auth and Firestore. Auth success followed by Firestore failure can leave partial state.

### Balance operations

| Callable | Authorization | Important input/rules | Result |
| --- | --- | --- | --- |
| `topUpPersonBalance` | Admin or top-up staff | event/person IDs, positive integer amount; active person required | Transactional balance, ledger, audit |
| `bulkAdjustPersonBalance` | Admin | up to 5,000 unique person IDs, nonzero integer delta, required correlation ID | Per-chunk counts/skips/failures and summary audit |

### QR operations

| Callable | Authorization | Behavior |
| --- | --- | --- |
| `generateQrCredentials` | Admin | Reserve 1–250 unique random four-digit documents; audit batch |
| `importQrCredentials` | Admin | Import/deduplicate up to 1,000 codes; skip existing; audit |
| `deleteQrCredential` | Admin | Delete only a non-assigned credential; audit |
| `assignQrCredentialToPersona` | Admin | Replace/revoke old credential and link new one transactionally |
| `revokeQrCredentialFromPersona` | Admin | Revoke current credential and clear person |
| `resolveAssignedQrCredential` | Admin/staff/POS staff | Validate assigned, non-revoked credential and return full person |
| `selfAssignQrCredential` | Any authenticated linked user | Claim unassigned QR for own linked person only |

### Account/person/event operations

| Callable | Authorization | Behavior |
| --- | --- | --- |
| `linkAccountToPersona` | Admin | Link/unlink denormalized account/person/QR state and optionally carry balance |
| `joinEventByShibboleth` | Authenticated | Find exactly one active person, link caller, optionally carry balance |
| `closeEventAndCarryBalances` | Admin | Validate Shibboleths; write global carryover; close event/clear runtime |

## Direct Firestore API by domain

### Common reads

All screens subscribe with `onSnapshot`. Authenticated users may read the event root, products, barcode indexes, modifier templates, and stock items. POS users additionally read people, baskets, orders, ledger, stock movements, and DRS returns. Admins read QR assignments and audit logs. Participant access is narrowed to their own person/order—with the explicit food-order exception discussed below.

### Event operations

Admin client batches create/activate events and update runtime. Staff/POS client batches may update only kitchen closure fields. Admin can update all event fields under Rules. No conditional version/uniqueness check exists in Rules.

### Commerce operations

POS-capable clients run transactions directly over baskets, orders, people, stock, stock movements, ledger, audit, and DRS returns. The intended request schema is defined only by model builders. Rules do not fully validate totals, references, pricing, state transitions, or append-only behavior for orders/ledger/audit/DRS.

### Admin/catalog operations

Staff/admin clients create/update/delete people, products, barcodes, templates, and stock. Product/barcode coherence is enforced in the transaction code. People linking and QR assignment use Functions because those subcollections are admin-only and involve Auth/hidden mappings.

## Authentication interface

Firebase Auth provides:

- `createUserWithEmailAndPassword` for normal registration;
- `signInWithEmailAndPassword`;
- `signOut`;
- `updateProfile` for display name;
- `getIdTokenResult(forceRefresh)` for claims;
- Admin SDK account creation/disable/custom claims in Functions.

No OAuth/social provider, password reset UI, MFA, App Check setup, or custom session cookie is present in this repository.

## External integrations

### Firebase Authentication

**Why:** managed identity and signed role claims. **Data sent/received:** e-mail, password during Auth calls, display name, UID, ID tokens/custom claims. **Failure:** surfaced through page errors; no alternate login. **Required:** yes.

### Cloud Firestore

**Why:** real-time operational database and transaction engine. **Data:** all application business state. **Authentication:** Firebase ID token for clients; Admin credentials in Functions/seed. **Failure:** subscription/action error banners; cached reads may exist due IndexedDB, but no designed offline conflict UX. **Required:** yes.

### Cloud Functions

**Why:** protect Auth administration, QR mappings, top-ups, linking, carryover. **Authentication:** callable SDK automatically supplies ID token; each sensitive function checks claims. **Failure:** Firebase error code/message; no application-level retry except user reattempt. **Required:** yes for core identity/top-up/QR/event-close workflows, although basic cached UI may load without them.

### Firebase Hosting / Workbox

**Why:** deliver SPA/PWA. **Data:** static assets and manifest. **Failure:** installed production client may use cached assets; entry/service-worker files use no-cache headers. **Required:** production delivery could technically be replaced by any static host with SPA fallback.

### Browser camera and keyboard scanners

`qr-scanner` reads camera frames locally; keyboard wedge scanners are interpreted by timing buffers. No scan images are uploaded. Camera permission/availability errors show in the scanner UI. Manual entry remains available.

### SheetJS

Excel files are parsed/generated in the browser. Imported participant/product/stock data is then written to Firebase. Export uses local file download. There is no server file upload or long-term file storage.

### Recharts

Pure client-side visualization of Firestore-derived aggregates; no external analytics service receives data.

## Events, queues, streams, and callbacks

- Firestore real-time listeners are the event stream.
- Kitchen audio cues are triggered by detecting newly arrived order IDs in client state.
- PWA service-worker callbacks check for updated bundles every 30 minutes and on visibility changes.
- There are no application webhooks, queues, cron jobs, SSE endpoints, or explicit WebSockets.

## Failure and retry behavior

- Firestore automatically retries transaction callbacks under contention.
- QR generation retries document-ID collisions up to 50 attempts per requested credential.
- Bulk adjustments catch and count failed chunks but do not retry them internally.
- Multi-batch imports stop on thrown errors; prior chunks remain.
- Functions set `maxInstances: 10`; platform queuing/cold starts are otherwise unmanaged.
- There are no client request IDs for checkout/refund. Transaction/basket semantics provide limited natural idempotency.

## Important privacy implication

Participant dashboards calculate “orders ahead” by subscribing to every food order. `firestore.rules` accordingly allows any linked participant to read any order whose `hasFood` is true, not only their own. The returned document includes another participant's name/IDs and order lines. This is a concrete cross-user data exposure, not merely frontend-only access.

