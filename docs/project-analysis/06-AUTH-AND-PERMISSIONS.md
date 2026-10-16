# Authentication and Permissions

## Authentication flow

```mermaid
sequenceDiagram
  actor User
  participant UI as React app
  participant Auth as Firebase Auth
  participant Fn as bootstrapAdminSession
  participant DB as Firestore
  User->>UI: Register or sign in
  UI->>Auth: E-mail/password
  Auth-->>UI: User + persisted session
  UI->>Fn: Callable with ID token
  Fn->>Fn: Check bootstrap e-mail allowlist
  opt allowlisted
    Fn->>Auth: Set admin role claim
    Fn->>DB: Upsert admin account
  end
  UI->>Auth: Force-refresh token claims
  UI->>DB: Ensure/read accounts/{uid}
  DB-->>UI: Live account record
  UI->>UI: Resolve claim role; render guarded routes
```

Firebase uses browser-local persistence. Logout calls Firebase `signOut`. Token expiry/refresh is managed by the Firebase SDK; the application explicitly refreshes after bootstrap and when account role differs from cached claims. There is no inactivity timeout, server-side session revocation UI, MFA, or password reset workflow in this repository.

## Role source and status

The role exists twice:

1. Firebase custom claim `role`—used by Functions and preferred by Rules/client.
2. `accounts/{uid}.role`—fallback for Rules and display/directory synchronization.

Rules also read the account document on privileged checks to reject `status == disabled`. The disable callable disables the Firebase Auth user and updates the document. Role/status changes may not affect an already issued token until refresh; disabling the Auth account prevents later token renewal, while the Rules document read supplies immediate database blocking if synchronized.

## Authorization layers

| Layer | Purpose | Security boundary? |
| --- | --- | --- |
| Route guards/menu visibility | User experience and navigation | No |
| Feature service/UI validation | Correct workflow and friendly errors | No |
| Firestore Security Rules | Direct database authorization/partial validation | Yes |
| Callable Function claim checks | Server-side operation authorization | Yes |
| Firebase Auth disabled state | Prevent identity use/token renewal | Yes |

Frontend-only restrictions must never be treated as sufficient. For example the UI gives manual balance adjustment only to admins, but `staff` Rules allow arbitrary person edits because `canManagePeople()` grants full update; a custom client could bypass the UI.

## Permission matrix

Legend: R read, W intended write/use, L limited field write, — unavailable. This combines intended UI and backend enforcement; caveats follow.

| Capability | user | topup_staff | pos_staff | staff | head_pos | admin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Own account/profile | R/W limited | R/W limited | R/W limited | R/W limited | R/W limited | R/W/all accounts |
| Account directory | — | R | R | R | R | R/W via Functions |
| Join event / own link | W via Function / R | same | same | same | same | same + manage links |
| Read event/catalog/stock | R | R | R | R | R | R |
| Read people | own linked | all | all | all | all | all |
| Positive top-up callable/page | — | W | — | — | — | W |
| POS baskets/orders/refunds | — | — | W | W | W | W |
| Kitchen page | — | — | W | W | — | W |
| POS availability toggle | — | — | L | L | L | L |
| Manage people | — | — | — | W | — | W |
| Manage catalog/stock | — | — | — | W | W | W |
| QR pool/manage assignment | own self-claim Function | resolve only | resolve only | resolve only | resolve only | R/W/Functions |
| Manage events/runtime | — | — | kitchen flag only | kitchen flag only | — | W |
| Manual/bulk balance adjustment UI | — | — | — | — | — | W |
| Ledger | — | R | R/W | R/W | R/W | R/W |
| Audit logs | — | — | W but not R | W but not R | W but not R | R/W |
| Statistics page | — | — | — | — | R | R |
| Admin page | — | — | — | — | — | W |

The POS Rules branch also permits limited direct balance updates for `head_pos`, as it does for `pos_staff`. This is broader than the top-up page/callable permission and remains part of the direct-client accounting risk described in the architectural assessment.

## Firestore rule details

### Accounts

Users read/update their own account but immutable fields are UID, e-mail, role, and status; other fields may change. Staff-like and top-up roles can read all accounts. Admin can mutate/delete accounts, but intended Auth synchronization occurs only through Functions.

Account event links are readable by their owner/admin and writable only by admin under direct Rules. Functions use Admin SDK for self-join.

### Event public-to-authenticated data

Any signed-in identity can read all event roots, products, product barcode mappings, modifier templates, and stock items for any known event ID—including closed events. This exposes catalog and inventory quantities across authenticated users.

### People and commerce

- A participant reads only its linked person document.
- Top-up staff read all people, accounts, and ledger entries.
- POS roles can update only `balance`/`updatedAt` on people under the restricted POS branch, but `staff`/`admin` also satisfy full people-management update.
- POS roles have unrestricted basket writes and unrestricted order writes (create/update/delete).
- POS roles have unrestricted ledger/audit/DRS writes; stock movement creation has partial shape checks and cannot be changed/deleted afterward.

### Participant order reads

A linked user may read its own orders **or any food order**. The second branch enables global food queue calculation and exposes cross-user order documents. Query authorization requires the query constraint to match what Rules can prove; `subscribeFoodOrders` uses `where(hasFood == true)`.

### QR

Direct QR-pool reads/writes are admin-only. Staff resolves a single assignment via a callable Function. This hides the complete credential pool from staff clients.

## Callable authorization

- `ensureAuthenticated`: any valid Firebase identity.
- `ensureAdmin`: custom token claim must be exactly `admin`.
- `ensureStaffLike`: `admin`, `staff`, `pos_staff`, or `head_pos` claim.
- `ensureTopupLike`: `admin` or `topup_staff` claim.

Functions do not consult account `status`; they rely on Auth token/disabled-user behavior. A token issued before disable may remain usable for Functions until revoked/expired unless Firebase automatically rejects it; the code does not explicitly revoke refresh tokens or check the Firestore account status.

## Privileged operations

- Admin creation/role/disable changes Firebase Auth state.
- Bootstrap allowlist can grant permanent admin claims to any authenticated account with a configured e-mail.
- Event closure moves every attendee balance into global carryover.
- QR management controls physical credentials.
- Bulk/manual balance changes alter event money.
- Rules allow admin deletion of event/account roots, although the UI does not provide a comprehensive destructive workflow.

## Security findings summary

1. **High, Confirmed:** cross-participant food-order reads expose personal/order data.
2. **High, Confirmed:** compromised POS/staff clients can directly forge orders/ledger/audit/DRS documents or violate state rules because Rules authorize collections broadly.
3. **Medium, Confirmed:** callable Functions check claims but not account disabled status; immediate revocation semantics are unclear.
4. **Medium, Confirmed:** Auth and account-document changes are not atomic, enabling drift on partial failure.
5. **Medium, Strongly supported:** no App Check initialization/configuration is present, so callable/API abuse protection relies on Auth and quotas.
6. **Low, Confirmed:** all authenticated accounts can read event-wide catalog and stock quantities.

No committed secret values were found in tracked `.env` files: only example environment files are tracked. Firebase web configuration is not itself a server secret, but production access still depends on correct Rules and project separation.

## Safely changing permissions

When adding or changing a role, update and test all of:

1. `src/lib/roles.js` constants and route helpers;
2. menus/routes in `src/app/`;
3. Function `ROLES` and relevant `ensure*` helper;
4. `firestore.rules` effective-role predicates and collection rules;
5. account-management UI role options;
6. Auth custom-claim migration for existing users;
7. Rules emulator tests and function-level tests.

