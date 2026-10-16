# Functionality

This document describes behavior by user intent. All persistence references are event-relative unless explicitly global.

## Authentication and registration

**Purpose.** Establish a Firebase identity and an application account.

**Actors.** All users; administrators additionally create privileged accounts.

**Workflow.** A guest either signs in or registers with display name, Shibboleth, e-mail, and password. Firebase creates the Auth user, the client updates its display profile, and writes `accounts/{uid}` with role `user`. On every authenticated session, the client calls `bootstrapAdminSession`; an allowlisted e-mail may be promoted to admin by the server. It then refreshes token claims, ensures a normal account document exists, and subscribes to it.

**Rules and errors.** Passwords must meet Firebase's minimum; the UI specifies six characters. Registration account documents must match the authenticated UID/e-mail and role/status `user`/`active`. Privileged account creation, role changes, and disabling require an admin callable. An admin cannot disable itself through that callable. Role changes require token refresh before becoming effective.

**Data/side effects.** Firebase Auth user, custom `role` claim, account document. Auth persistence is browser-local. No password is stored in Firestore.

**Implementation.** `src/features/auth/`, `src/lib/roles.js`, account callables in `functions/index.js`.

## Event lifecycle and configuration

### Create and activate

Admins create a draft or immediately active event. A second active event is rejected by the client service when the runtime pointer is already populated. Event creation and runtime selection are one batch; optional catalog cloning follows as a separate operation, so clone failure leaves the event created.

Cloning copies templates, products, barcode indexes, and stock definitions; stock quantities reset to zero. It does not copy people, orders, balances, QR assignments, movements, or audit history.

### Runtime recovery

The admin event screen calls `ensureRuntimeDocument`. If the runtime pointer is empty and exactly one not-closed event has status `active`, it repairs the pointer. Multiple active events are deliberately left for manual resolution.

### Operational flags

- `isKitchenClosed`: POS-capable staff can toggle it; the write and audit entry share a batch.
- `allowSingleNegativePurchase`: admin-only through route/UI and Firestore event-update authority; controls checkout behavior.

### Close and carry balances

Only an active event can close. The server reads all non-deleted people and rejects closure when:

- any nonzero balance lacks a normalized Shibboleth; or
- two active people normalize to the same Shibboleth.

For each person with a Shibboleth, it writes/overwrites `carryoverBalances/{normalizedShibboleth}`. If an older carryover was never stamped as applied to the current person, its amount is rescued and added before overwrite. The same transaction marks the event closed, clears `system/runtime.activeEventId`, and writes an audit summary.

**Edge cases.** The operation is atomic but too large for sufficiently large attendee sets; see the assessment. Zero-balance people without Shibboleth do not block closure and receive no carryover record. Negative balances carry forward.

**Implementation.** `src/features/events/eventService.js`, `eventModels.js`, `EventManagementPanel.jsx`, `closeEventAndCarryBalances` in `functions/index.js`.

## Participant directory

### Import

Staff/admin import text, CSV-like rows, or Excel. Each row maps to name, team, attendee type, and Shibboleth. Names are required; attendee type must normalize to `freshman/gólya` or `organizer/animátor`. Each accepted person gets a generated `P-{8 chars}` internal ID and active status.

Before the batch is written, the client reads matching carryover documents. A nonzero carryover initializes balance, stamps `carryoverAppliedFromEventId`, and generates a `carryoverIn` ledger entry. One audit record summarizes the import and rejected rows are returned to the UI.

**Important limit.** All accepted people and associated ledger/audit writes use one client batch, so large imports can exceed the 500-write limit.

### Edit, delete, restore

Editing changes name/team/type/Shibboleth and updates event-link metadata. Changing to a Shibboleth with unapplied carryover may credit balance transactionally. Deletion is soft: it marks the person deleted, clears account/QR fields, removes the account event link, revokes the QR, and audits. Restore only changes record status/deletion metadata; links are not restored.

### Search and display identity

The preferred display identifier is QR ID, then Shibboleth, then internal ID. Lists normalize case and diacritics for search. The people subscription returns the most recent 500 documents only.

**Implementation.** `src/features/people/`, `PeopleManagementPanel.jsx`.

## Account-to-person linking

### Participant self-join

An authenticated user submits a Shibboleth (or uses the account's stored value). The callable normalizes it, returns an existing event link idempotently, or queries active people. Exactly one match must exist and cannot belong to another account. The transaction updates the account identifier, creates the event link, links the person, updates any assigned QR's account pointer, optionally applies carryover once, writes ledger, and audits.

### Admin linking

An admin can link or unlink any event person and account. Relinking a person deletes its prior account link; linking an account already mapped to another person clears that former person's link fields. QR account metadata and carryover application are synchronized in the same transaction.

**Risks/edge cases.** Person uniqueness by normalized Shibboleth is checked at join/close, not enforced on write. Account/person links are denormalized across two or three documents and rely on these controlled workflows.

**Implementation.** `joinEventByShibboleth` and `linkAccountToPersona` in `functions/index.js`; `src/features/user/`, `src/features/auth/accountService.js`.

## QR credential management

Admins generate up to 250 random four-digit credentials per call or import up to 1,000 codes. Generation uses atomic document creation and retries collisions. Pool records are event-local and use a fixed production URL.

Assignment transactionally verifies person and credential, rejects deleted people/revoked credentials/cross-person reuse, revokes a person's previous QR when replacing it, and updates person, credential, and audit. Revocation clears the person and permanently marks the pool record revoked. A linked participant can self-assign only an unassigned credential and only if the linked person has none. POS/top-up lookup uses a staff-only callable so staff never receive the full QR pool.

Scanning accepts a plain four-digit code, a `/qr/{code}` URL/path, or `code`/`qr` query parameter. `/qr/:qrCode` is a public informational route that displays the code and explicitly reveals no participant data; meaningful resolution still requires an authenticated staff callable.

**Implementation.** `src/features/qr/`, QR callables in `functions/index.js`, scanner hooks in POS/people UI.

## Balance management

### Top-up

Admin or top-up staff select/scan an active person and enter a positive integer HUF amount. The callable transaction updates balance and creates a ledger and audit record. Deleted persons are rejected.

### Manual adjustment

Admin UI can apply a nonzero positive or negative adjustment. This currently executes as a direct browser Firestore transaction; reason is stored in ledger/audit.

### Bulk adjustment

Admin selects people explicitly or by team/type and supplies one nonzero delta and optional reason. The UI warns about deleted people, negative outcomes, large per-person amounts, and large aggregate effects. The callable de-duplicates IDs, caps at 5,000, processes chunks of 150 people, and creates per-person ledger/audit records plus a summary record. A caller-provided correlation ID is intended to collapse retries.

**Failure behavior.** Chunks are atomic individually, not collectively. Failed chunks are counted while earlier chunks remain committed. The summary is written afterward. Two simultaneous first invocations with the same correlation ID can both pass the pre-check.

**Implementation.** balance functions in `src/features/people/personService.js`, `PeopleManagementPanel.jsx`, `functions/index.js`.

## Catalog and modifiers

Participants have a separate read-only `/menu` page for the active event. It shows active products grouped by category with category filters, search, prices including the DRS deposit when applicable, and temporary or kitchen-closed availability labels. It does not require a linked participant profile.

Staff, Főbüfé, and admins manage products and modifier templates. A product contains name, normalized name, category, nonnegative integer price, active and temporary-unavailable flags, optional DRS flag, optional modifier-template link, barcodes, and a stock recipe.

Barcodes are numeric, unique by index document, and may not be four digits. Saving a product transactionally updates the product, removes obsolete barcode indexes, creates current indexes, and audits. Imports validate the file in the browser and write chunks of 200. Clear/delete hard-delete products and barcode indexes but preserve historical order snapshots.

Modifier templates define default ingredients and optional priced extras with maximum quantities. Deleting a template does not migrate products that reference it.

POS long-press can toggle temporary availability without catalog access; the Rule permits only that field plus actor/time metadata.

**Implementation.** `src/features/products/`, `src/features/modifiers/`, `ProductManagementPanel.jsx`.

## Stock and recipes

Stock items have piece/ml units, current quantity, low threshold, active flag, and audit metadata. Product recipes contain fixed components and choice groups. Selected choices are embedded in order-line customization and consumption snapshots.

Manual stock add uses an absolute positive delta; manual correction replaces the counted total and records the difference. Excel import upserts by normalized name and records corrections. Checkout aggregates all product-line recipe quantities and subtracts them transactionally; refunds restore proportional quantities.

**Rules.** Quantities are integers. No business rule prevents negative stock or blocks an unavailable recipe component. A missing referenced stock item does not abort a sale/refund; a movement with null before/after and explanatory reason is recorded.

**Implementation.** `src/features/stock/`, product import preparation, `posService.js`, `orderService.js`.

## POS baskets and checkout

### Identify and lock

Staff search by participant fields, scan a four-digit QR via camera/keyboard, or scan a longer product barcode after a participant is selected. Selecting a person creates/refreshes `baskets/{personId}`. The lock is owned by account UID and a persistent browser session UUID. Another session is rejected for 45 seconds after the last update; heartbeat runs every 15 seconds.

### Build basket

Products merge when product and customization keys match. Food may open burger/gyros/pizza customizers or a hidden “catch game” mode. DRS products create linked 50-HUF deposit lines. Bottle return and reusable-cup return entries carry negative totals. The UI debounces basket saves by 220 ms.

### Finalize

The transaction re-reads basket, person, event, and affected stock; validates owner/staleness, nonempty basket, active person, and balance rules; then creates:

- finalized order snapshot;
- new person balance;
- one ledger entry;
- optional DRS-return record;
- stock item updates and stock movement records;
- detailed audit record;
- deletion of the open basket.

The order's food stations start at `new`. Because deletion is in the same transaction, a repeated finalize sees no basket and cannot double-charge.

### Abandon/cancel

Explicit cancel deletes the basket if the caller owns it or it is stale. UI attempts to cancel after 60 seconds of abandonment and intercepts page navigation/logout. Browser termination can leave a lock until its stale timeout.

**Implementation.** `src/features/pos/`, especially `StaffPosPanel.jsx`, `basketModels.js`, and `posService.js`.

## Kitchen fulfillment

The kitchen subscribes to all food orders, splits an order into station tickets, filters by persisted station preferences, and displays new/preparing/ready columns. Audio cues play for arrivals unless muted. Staff update one station in a transaction; the service supports legacy orders without station maps by synthesizing the map first. The event-level kitchen-closed flag controls service availability.

The participant dashboard shows every active food order with a live queue count per station (burger, gyros, pizza, or other). Each station ticket counts as one order regardless of quantity. Preparing tickets precede new tickets, then creation time and order ID break ties; ready and delivered tickets have no waiting count. The dashboard and kitchen board share the tie-breaker so equal timestamps remain consistent.

Participants can opt in to Firebase Cloud Messaging web-push alerts per device. The `notifyFoodOrderReady` Firestore trigger sends one pickup alert when the whole order first becomes ready, including mixed-station orders. Tokens live under the participant account and are removed on opt-out or sign-out. Push requires a project-specific public VAPID key and deployed Hosting, Functions, and Rules; see `docs/FIREBASE-ENVIRONMENTS.md`.

Transitions are not strictly enforced: the UI presents forward movement, but the service only validates that the requested status is one of the four allowed values. A caller with Firestore rights can jump or reverse states.

**Implementation.** `src/features/kitchen/`, `updateFoodOrderStatus` in `orderService.js`.

## Refunds and returns

The POS can refund a chosen line quantity; the admin audit screen can refund an entire remaining order. Both execute transactions that guard remaining refundable amount, credit the person, update order lines/totals/history, create ledger/audit entries, and restore stock. Synthetic negative lines can mathematically produce negative refund amounts if exposed to these flows; UI controls determine what is selectable and should be reviewed when changing refund behavior.

DRS bottle returns can be recorded either as basket lines or through `createDrsReturn`; both credit balance and produce DRS tracking records. Repohár returns are order lines only and are summarized from order history.

## Reporting and audit

The separate `/statistics` page is available to admins and Főbüfé (`head_pos`). It subscribes to raw orders, ledger entries, people, and products for a selected active or closed event, then computes revenue, item/category/product composition, customers/teams/types, staff activity, refunds, hourly/daily series, DRS, and cup metrics in-browser. CSV exports are generated with Blob downloads.

Audit logs are event-local and include actor, target, person, details, and server timestamp. The admin audit UI enriches them with live person/account names and supports event/type/search filters. It is an operational audit aid, not tamper-proof: POS roles can write arbitrary audit documents under current Rules.

## Error handling

- Firebase subscription errors are generally surfaced as panel banners.
- Services throw `Error`; callables use Firebase `HttpsError` codes.
- There is no global React error boundary or standardized error envelope.
- No automatic retry/circuit breaker exists beyond Firebase SDK transaction retries/listener behavior.
- Multi-batch work reports some partial failures but no general compensation mechanism exists.
- Console logging is limited mainly to workload subscriptions and bulk-adjustment chunk failures.
