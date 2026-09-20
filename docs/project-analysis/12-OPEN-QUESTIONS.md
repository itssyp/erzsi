# Open Questions and Uncertainties

These questions cannot be answered confidently from the repository alone. Executable code was treated as current behavior where comments/reports differ.

## Product and operations

### What is the supported maximum event size?

**Evidence:** people UI/listener caps at 500; bulk balance accepts 5,000; QR space has 9,000 codes; event close and people import are unbounded single atomic operations. **Competing interpretations:** expected events may stay well below 500, or scale requirements were never reconciled. **Confirm:** attendee/order peaks and explicit support target with operators.

### What does the `Paku` role represent operationally?

**Evidence:** it maps to `topup_staff` and can only use balance top-up UI. **Confirm:** terminology, training, and whether it should read all accounts/ledger entries.

### How is external money reconciled with top-ups?

**Evidence:** ledger records internal credits, but no cash/card tender, receipt, payment-provider, drawer, or settlement entity exists. **Confirm:** whether another system/process records received money and handles disputes/refunds.

### Are negative carryovers intentional?

**Evidence:** close explicitly carries negative balances; single-negative purchase exists. **Confirm:** policy for collecting debt at next event and whether all attendee types share it.

### Is a closed event ever meant to be reopened?

**Evidence:** status model says closed, but activation code can set any event active. **Confirm:** valid transition policy and whether reopen requires explicit audit/approval.

## Identity and privacy

### What exactly is “Shibboleth” here?

**Evidence:** it is a free-text identifier entered at registration/import and normalized locally; no SAML/Shibboleth identity-provider integration exists. **Confirm:** uniqueness authority, format, sensitivity, and whether users are expected to know it.

### Is guest access to all food tickets intentional?

**Evidence:** it enables queue-position calculation but exposes entire food-order documents. **Competing interpretations:** intentional operational transparency versus an implementation shortcut. **Confirm:** privacy requirements; regardless, minimal projections should replace raw documents.

### What are the required session revocation guarantees?

**Evidence:** disable changes Auth user and Firestore status; Functions inspect claims only. **Confirm:** behavior of preexisting ID tokens in deployed Firebase and the acceptable revocation window.

### Is Firebase App Check configured externally?

**Evidence:** no client initialization or repository configuration. **Confirm:** Firebase Console settings and whether enforcement is planned.

## Data and lifecycle

### Are there production records using legacy fields/categories?

**Evidence:** code supports paired QR field names, legacy categories, and legacy single kitchen status. **Confirm:** counts and migration feasibility before removing compatibility code.

### What is the source of truth when balance and ledger disagree?

**Evidence:** runtime reads `person.balance`; analytics also reads ledger. No reconciliation tool exists. **Likely:** person balance is operational authority, ledger is evidence. **Confirm:** accounting policy and repair procedure.

### What are backup, retention, and deletion requirements?

**Evidence:** no TTL/export/backup or recursive event deletion workflow exists. **Confirm:** Firebase scheduled backups, regulatory retention, right-to-delete, and recovery objectives configured outside the repo.

### Are product/template/stock hard deletes acceptable?

**Evidence:** orders snapshot lines, but live references and analytics may still rely on catalog data. **Confirm:** desired referential/audit behavior and whether inactive/soft-delete should replace deletion.

### What happens to unapplied carryover after several skipped events?

**Evidence:** close attempts to rescue one previous carryover if the current person has not applied it; one global record stores only the latest source. **Confirm:** multi-event absence scenarios with real data and expected debt/credit accumulation.

## Deployment and operations

### What is the real production/staging domain and Firebase configuration state?

**Evidence:** code references three domains and two project aliases; local populated env files exist but were not disclosed. **Confirm:** Firebase Console projects, DNS/TLS, Auth authorized domains, CORS, and deployed versions.

### Is there CI/CD outside this repository?

**Evidence:** no GitHub Actions or other pipeline definition. **Confirm:** external build service/manual release process, approvals, and rollback ownership.

### What monitoring and alerts exist in Firebase/Google Cloud?

**Evidence:** none is codified. **Confirm:** console alerts, budgets, log sinks, uptime checks, error reporting, and on-call contacts.

### Are scheduled Firestore backups enabled?

**Evidence:** not in repository. **Confirm:** backup schedule, retention, region, restore drill, and who can execute recovery.

### Why do QR links always use production?

**Evidence:** client/server QR builders hard-code `https://kasszaserzsi.hu`; staging seed supports an override. **Competing interpretations:** physical QR cards are environment-independent production credentials, or staging links are an oversight. **Confirm:** test/production QR asset policy.

## Testing and repository state

### Which current changes are intended for release?

**Evidence:** the working tree was already heavily modified, including Rules, Functions, POS, orders, products, stock, styles, and assets. **Confirm:** branch/commit ownership and release baseline. This documentation describes the inspected working tree on 2026-09-20.

### Is `tests/RESULTS.md` historical or maintained?

**Evidence:** it claims 55 unit assertions and a previous negative-balance defect, while current unit execution reports 66 and current checkout includes the fix. **Conclusion:** historical. **Confirm:** whether it should be regenerated or replaced by CI artifacts.

### Can the full emulator suite pass on a clean supported environment?

**Evidence:** historical report says yes; current run failed in orchestration because child processes could not locate `firebase`/`node`, not because assertions failed. **Confirm:** run on Node 20 with Firebase CLI in PATH and record current Rules/concurrency results.

### What browser/device matrix is supported?

**Evidence:** README mentions phones; PWA/camera/fullscreen/audio APIs are used. **Confirm:** iOS/Android/browser versions, scanner hardware, accessibility requirements, and offline expectations.

## Architecture intent

### Was direct client accounting an explicit trust decision?

**Evidence:** transactions are carefully designed, yet Rules broadly authorize POS writes. **Competing interpretations:** trusted-event-staff threat model versus unfinished backend migration. **Confirm:** threat model and acceptable insider/device-compromise risk.

### Is the kitchen wait-time formula calibrated?

**Evidence:** hard-coded throughput is 0.25 item/minute, producing 84 minutes for 21 new items. **Confirm:** empirical throughput and whether estimates are guest-visible/operationally relied upon.

### Should stock ever block a sale?

**Evidence:** low/negative stock is display information; missing stock records do not abort checkout. **Confirm:** whether this is deliberate soft inventory or a missing constraint.

