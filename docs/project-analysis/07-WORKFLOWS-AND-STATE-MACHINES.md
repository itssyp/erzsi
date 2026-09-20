# Workflows and State Machines

## Participant onboarding

```mermaid
sequenceDiagram
  actor Guest
  participant UI as Login/User dashboard
  participant Auth as Firebase Auth
  participant Fn as joinEventByShibboleth
  participant DB as Firestore
  Guest->>UI: Register(name, Shibboleth, e-mail, password)
  UI->>Auth: Create user and set display name
  UI->>DB: Create accounts/{uid}
  DB-->>UI: system/runtime active event
  Guest->>UI: Join event
  UI->>Fn: eventId + Shibboleth
  Fn->>DB: Read account, existing link, matching people, carryover
  Fn->>Fn: Require exactly one active unlinked match
  Fn->>DB: Transaction: account + eventLink + person + QR + optional ledger + audit
  DB-->>UI: Listener reveals linked profile/orders
```

**Preconditions:** authenticated account, active event, exactly one non-deleted person with matching normalized Shibboleth. **Side effects:** denormalized links, possible one-time carryover credit, QR account metadata, audit. **Recovery:** admin can fix duplicate/missing identifiers or relink manually.

## POS sale

```mermaid
sequenceDiagram
  actor Cashier
  participant POS as StaffPosPanel
  participant QR as resolveAssignedQrCredential
  participant DB as Firestore
  Cashier->>POS: Scan/search participant
  opt QR scan
    POS->>QR: eventId + code
    QR->>DB: Read credential and person
    QR-->>POS: Person
  end
  POS->>DB: Transaction acquire basket lease
  Cashier->>POS: Scan/add/customize products and returns
  POS->>DB: Debounced transaction save basket
  loop every 15 seconds
    POS->>DB: Refresh lease
  end
  Cashier->>POS: Finalize
  POS->>DB: Transaction read basket/person/event/stock
  POS->>POS: Validate owner, totals, negative-balance rule
  POS->>DB: Write order, person, ledger, audit, DRS, stock movements; delete basket
  DB-->>POS: Commit/order ID/balance
  DB-->>Cashier: Real-time UI reset
```

### Checkout invariants

- Person exists and is active.
- Basket exists, contains lines, and is owned by caller session or stale.
- Totals are recalculated for normalized items, although an already stored `basket.totalAmount` takes precedence when non-null.
- Starting negative balance blocks positive purchases.
- Crossing below zero is allowed only when event flag is enabled and start was nonnegative.
- Balance/order/ledger/audit/stock/basket mutation is one transaction.

### Failure paths

Lock conflict, empty basket, missing person, insufficient balance, or transaction failure leaves the basket intact. A committed transaction deletes it, so a retry cannot finalize twice. Missing stock records do not fail checkout. Network loss interacts with Firestore offline behavior; no explicit pending-write reconciliation UI is documented.

## Basket state

```mermaid
stateDiagram-v2
  [*] --> Absent
  Absent --> OpenOwned: acquire
  OpenOwned --> OpenOwned: add/remove/save/heartbeat
  OpenOwned --> OpenStale: no update for 45s
  OpenOwned --> Absent: cancel
  OpenOwned --> Absent: finalize atomically
  OpenStale --> OpenOwned: another session takes over\nand stale contents are discarded
  OpenStale --> Absent: another session cancels
```

There is only one persisted basket status (`open`); absence represents cancelled/finalized. The UI also starts a 60-second abandonment cancellation timer.

## Kitchen fulfillment

```mermaid
sequenceDiagram
  participant Sale as Checkout transaction
  participant DB as Order document
  participant KDS as Kitchen display
  actor Cook
  Sale->>DB: Create food order with station map = new
  DB-->>KDS: onSnapshot
  KDS->>KDS: Split lines by station
  Cook->>KDS: Advance station
  KDS->>DB: Transaction update station + derived overall + audit
  DB-->>KDS: Updated ticket columns
  DB-->>Guest: Updated own active-order tracker
```

```mermaid
stateDiagram-v2
  [*] --> new
  new --> preparing
  preparing --> ready
  ready --> delivered
  delivered --> [*]
```

The diagram is the intended UI progression. **Confirmed:** the service accepts any allowed next status and does not enforce adjacency or terminality, so reverse/jump transitions are technically possible. Multi-station overall status is the least advanced station; only all-delivered yields overall delivered.

## Refund

```mermaid
sequenceDiagram
  actor Staff
  participant UI as POS/Audit UI
  participant OS as orderService/posService
  participant DB as Firestore
  Staff->>UI: Refund line quantity or full remaining order
  UI->>OS: event/order/line/quantity
  OS->>DB: Transaction read order and person
  OS->>OS: Validate remaining refundable amount/quantity
  OS->>DB: Read affected stock
  OS->>DB: Update order refund fields, credit balance, write ledger/audit, restore stock
  DB-->>UI: Listener refresh
```

Orders remain `finalized`; refund lifecycle is expressed by `refundedQuantity`, `refundedTotal`, `netAmount`, and history rather than a separate status.

## QR lifecycle

```mermaid
stateDiagram-v2
  [*] --> unassigned: generate/import
  unassigned --> assigned: admin assign or participant self-claim
  assigned --> revoked: revoke, replace, or delete person
  unassigned --> [*]: delete
  revoked --> [*]: admin delete
```

Revoked → assigned is disallowed. Deleting an assigned credential is disallowed. Replacing a person's QR revokes the previous credential.

## Person lifecycle

```mermaid
stateDiagram-v2
  [*] --> active: import/create
  active --> active: edit/link/QR/balance/order
  active --> deleted: soft delete
  deleted --> active: restore
```

Delete removes account and QR associations. Restore does not recreate them. Deleted people cannot be used in POS, top-up, QR assignment, self-join, or carryover close population.

## Event lifecycle and carryover

```mermaid
stateDiagram-v2
  [*] --> draft: create without activation
  [*] --> active: create and activate
  draft --> active: activate
  active --> closed: validate and carry balances
  closed --> active: technically possible via generic activation service
```

```mermaid
sequenceDiagram
  actor Admin
  participant UI as EventManagementPanel
  participant Fn as closeEventAndCarryBalances
  participant DB as Firestore
  Admin->>UI: Close active event
  UI->>UI: Display missing/duplicate Shibboleth health
  UI->>Fn: eventId
  Fn->>DB: Transaction read event + all people + existing carryovers
  Fn->>Fn: Reject missing nonzero/duplicate identifiers
  loop each active person with Shibboleth
    Fn->>DB: Upsert global carryover
  end
  Fn->>DB: Mark event closed, clear runtime, audit
  DB-->>UI: Summary carried count/total
```

### Carryover application points

Carryover may be applied during person import, person Shibboleth edit, admin account link, or participant self-join. Each stamps the source event on the person. The stamp prevents the same source from applying twice. Close also rescues a previous carryover that appears not to have been applied.

## Bulk balance adjustment

The UI generates one correlation ID per confirmation. The Function first searches for a completed summary. If absent, it processes groups of 150, each transaction reading people then writing person + ledger + per-person audit. It finally writes a summary. Partial chunk failures are returned.

```mermaid
flowchart LR
  Request --> Dedup[Validate/deduplicate IDs]
  Dedup --> Existing{Summary exists?}
  Existing -->|yes| Cached[Return cached counts]
  Existing -->|no| Chunks[Process 150-person transactions]
  Chunks --> Summary[Write summary audit]
  Summary --> Result[Return applied/skipped/failed]
```

The idempotency check and summary write are separate, so it protects ordinary retries after completion, not simultaneous duplicate invocations.

## Catalog/stock import

Files are parsed in the browser. Product import may first upsert/create stock items, then create products/barcode indexes in later batches, then write an audit record. Consequently this is a saga without compensation: a later failure can leave stock but no product, or some products but no summary audit. Product saves outside import are transactional.

## Concurrency summary

| Shared resource | Protection | Remaining concern |
| --- | --- | --- |
| Person balance | Firestore transactions | Broad staff Rules permit out-of-band writes |
| Basket | UID+session lease in transaction | 45-second takeover; offline/pending behavior unclear |
| Checkout duplication | Basket delete in same transaction | No external idempotency key needed for committed retry |
| Stock | Included in checkout/refund transaction | Negative stock allowed; missing items tolerated |
| QR assignment | Admin SDK transaction | Four-digit namespace exhaustion eventually possible |
| Account-person link | Admin SDK transaction | Auth/account operations elsewhere are not atomic |
| Bulk balances | Per-chunk transactions + summary lookup | Concurrent same-correlation race; partial operation |
| Event activation | Batched client check/write | No database uniqueness invariant for active event |

