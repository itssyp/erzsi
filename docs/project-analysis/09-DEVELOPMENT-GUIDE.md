# Development Guide

## Prerequisites

- Node.js and npm. Cloud Functions declares Node 20; use Node 20 across the project to minimize differences.
- Firebase CLI for emulator/deployment.
- Access to the correct staging Firebase project and, for the seed, Application Default Credentials.
- A modern browser; a phone on the same network for camera/PWA testing.

## Install and run

```bash
npm install
npm --prefix functions install
npm --prefix tests install
npm run dev
```

`npm run dev` deliberately uses staging mode and serves on all interfaces at port 3000. Open `http://localhost:3000`, or use the machine's LAN IP on a phone. Production-mode local development is `npm run dev:prod`; preview of built output is `npm run preview` on port 4173.

Populate a local `.env.staging` from `.env.staging.example`; never point it at production for ordinary development. Firebase Auth and Firestore resources must exist in that project. The repository does not start Auth/Functions emulators as part of the Vite command.

## Tests and checks

| Command | Scope |
| --- | --- |
| `node tests/01-unit-tests.js` | Pure-JS calculations and simulated concurrency |
| `node tests/05-qr-carryover-regression.js` | QR/carryover regression using Admin Firestore setup |
| `node tests/run-emulator-tests.js` | Starts Firestore emulator, then concurrency and Rules scripts |
| `npm run lint` | Repository ESLint |
| `npm run build` | Production Vite/PWA build |
| `node tests/04-staging-validation.js` | Real staging checks; requires credentials and intentional staging writes |

### Verification observed during this analysis

- `01-unit-tests.js`: 66 passed, 0 failed.
- `05-qr-carryover-regression.js`: 42 passed, 0 failed.
- Production Vite compilation completed successfully and reported a 2,058.40-kB main JS chunk (587.97 kB gzip), with the standard large-chunk warning. The surrounding Windows command session did not exit cleanly and was interrupted after successful build output.
- ESLint failed with 11 errors and 3 warnings. Current-root errors include unused `valueLabel` parameters in analytics charts and unused values in staging/test runners; auxiliary `.claude/worktrees` are also included and contribute findings. `BurgerCatchGame` has a hook dependency warning.
- Emulator orchestration could not be rerun in the current shell because spawned `firebase`/`node` executables were not on its PATH. Historical `tests/RESULTS.md` claims 107/107 for an earlier state and is not authoritative for the current dirty working tree.

## Repository map

### `src/app/`

Application composition and navigation. Start here for routes, role visibility, active-event gating, or shell-level basket navigation protection. Depends on feature contexts and dashboard pages.

### `src/features/auth/`, `events/`, `user/`

Session/bootstrap, account records, global active-event selection, and participant dashboard/linking. These areas connect global Firebase identity to event-scoped personas.

### `src/features/pos/`, `orders/`, `kitchen/`

The transactional heart. `StaffPosPanel.jsx` is a very large orchestration/UI module; `posService.js` owns basket/checkout transactions; `orderService.js` owns kitchen updates/full refund; station/model files define state and calculations.

### `src/features/people/`, `qr/`

Participant lifecycle, import, balances, carryover hooks, QR parsing/pool clients. Privileged execution continues in `functions/index.js`.

### `src/features/products/`, `modifiers/`, `stock/`

Catalog schema, barcode uniqueness/index, Excel import preparation, customization templates, inventory recipes and movements.

### `src/features/admin/`

Large administrative panels for events, people, products, accounts, audit, returns, and analytics. Several files exceed 2,000 lines and contain parsing/domain logic as well as UI.

### `src/lib/`

Firebase initialization, path constants, roles, normalization, money, and browser POS session ID. Change path/role helpers here, but also check their duplicated server/Rules equivalents.

### `functions/`

One deployable Functions package. `index.js` contains every callable and duplicated domain helpers. Node runtime is 20.

### `tests/`

Standalone scripts rather than a Jest/Vitest suite. They copy some production algorithms instead of importing the implementation, so passing tests do not always prove the production module is exercised.

### Root Firebase/build configuration

`firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc`, `vite.config.js`, env examples, and package scripts define runtime/deployment behavior.

## Where do I change X?

### Add a UI page

Create the feature page, register it in `src/app/AppRoutes.jsx`, add an appropriate `RequireRole`/`RequireActiveEvent`, add navigation/title in `AppShell.jsx`, and update Rules/Functions if new data is accessed. Route guards do not replace backend authorization.

### Add a callable backend operation

Add the callable and server validation/role check in `functions/index.js`, add a typed-by-convention wrapper with `httpsCallable` in the relevant client service, update CORS only if the caller origin changes, then add emulator/function tests. Keep all transaction reads before writes.

### Add a direct Firestore operation

Add/modify path constants, model builder, feature service, Rules, indexes when queried, UI, and Rules emulator tests. Explicitly decide whether the client should be trusted to enforce each invariant; sensitive financial mutations should normally move behind a Function.

### Add a database entity

Define its location in `firestorePaths.js`, model/record builder, CRUD/subscriptions, Rule match, required indexes, lifecycle/retention, and migration/backfill strategy. Firestore has no migrations or referential integrity, so document compatibility behavior.

### Modify checkout or balance rules

Review `basketModels.js`, `posService.js`, `orderModels.js`, refund code in both `posService.js` and `orderService.js`, ledger/audit models, DRS/cup calculations, `firestore.rules`, Functions balance/carryover logic, analytics helpers, and all concurrency/regression tests. This rule set is distributed.

### Add a product category or kitchen station

Update product category normalization, admin import/UI options, station constants/patterns/classification, the duplicate classification inside `orderModels.js` and `orderService.js`, POS customizer selection, kitchen filters/styles, analytics category colors, and tests.

### Add a role or change permissions

Update client and Function role constants, claim creation, default route/menu, route guards, Rules predicates, account-management UI, tests, and existing-user claims. See the checklist in the auth document.

### Change person linking or Shibboleth normalization

Update both `src/lib/normalize.js` and the server's normalization implementation, then inspect person import/edit, self-join, admin link, event close, carryover keys, seed, and regression tests. A normalization change is a data migration because it changes document IDs.

### Add an environment variable

Add it to appropriate `.env.*.example`, read with `import.meta.env` (browser/build time) or Functions params/environment (server runtime), configure staging/production deployment, and document whether it is secret. Never put a secret in a `VITE_` variable because it is bundled into client JavaScript.

### Add an external integration

Prefer a dedicated feature adapter/service. Keep credentials server-side, define timeouts/retries/idempotency, decide whether checkout can proceed when it fails, record safe audit metadata, mock it in tests, and configure each Firebase environment independently.

### Change analytics

Update `eventAnalyticsHelpers.js` for definitions, `useEventStatistics.js` for source data, charts/tables/panel for rendering, and CSV builders for exports. Remember calculations load raw collections in-browser and should use net/refunded semantics consistently.

## Debugging common failures

| Symptom | First checks |
| --- | --- |
| Blank/no active event | `system/runtime`, event status, `ensureRuntimeDocument`, Rules errors |
| Role page redirects | token `role` claim vs account role; force sign-out/in; account status |
| Query listener error | browser console, deployed composite indexes, Rules query compatibility |
| QR not found | active event, credential status/person link, callable region/deployment |
| Basket locked | basket `lockOwnerUid`, `lockSessionId`, `updatedAt`; wait 45 seconds or admin intervention |
| Wrong balance | compare person balance with ledger and order/refund/audit chronology |
| Stock mismatch | order line `stockConsumption`, stock movements, missing/deleted stock item |
| Kitchen ticket missing | order `hasFood`, category normalization, station maps, kitchen flag, food-order index |
| Stale UI after deploy | Hosting release, service-worker registration/cache, staging env flag |
| Function permission denied | ID-token custom claim, account disabled state, deployed Function version |

## Coding cautions

- The inspected repository was already materially modified; preserve unrelated changes.
- Several modules duplicate constants/logic. Search globally before changing a rule.
- Server timestamps are sentinels until committed; avoid assuming `.toDate()` immediately.
- Firestore transaction callbacks may run multiple times; do not perform non-idempotent external side effects inside them.
- Query/listener scale and Rule document reads affect both latency and billing.
- Do not trust model builders as validation when Rules permit direct custom clients.

