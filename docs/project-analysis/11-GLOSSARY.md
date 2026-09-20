# Glossary

| Term | Meaning in this project |
| --- | --- |
| Account | Cross-event Firebase Auth identity plus `accounts/{uid}` profile |
| Active event | Event selected globally by `system/runtime.activeEventId` |
| Animátor | Organizer-type participant (`attendeeType: organizer`) |
| Audit log | Event-scoped record of an operational action and its actor/details |
| Basket | Person-keyed, mutable POS draft that also acts as a staff-device lease |
| Büfés | UI label for regular `staff`, roughly counter/canteen staff |
| Beugrós | UI label for temporary `pos_staff` |
| Carryover | Balance transferred between events using normalized Shibboleth |
| Correlation ID | Client-generated identifier intended to deduplicate bulk balance operations |
| DRS | Deposit Return System; a fixed 50-HUF bottle/can deposit/return in this code |
| Event link | Account subdocument mapping a login to one event-local person |
| Food status | Kitchen lifecycle `new`, `preparing`, `ready`, `delivered` |
| Gólya | Freshman/newcomer participant (`attendeeType: freshman`) |
| HUF | Hungarian forint; all money is stored as integer values |
| Internal ID | Generated participant label `P-{8 characters}` |
| Kasszás Erzsi | Product/PWA name; literally evokes a cashier persona |
| KDS | Kitchen display system, implemented by `KitchenQueuePanel` |
| Ledger entry | Append-oriented explanation of one person balance delta |
| Modifier template | Reusable default ingredients and paid extras for food products |
| Normalized Shibboleth | Lowercased, diacritic/punctuation-stripped key used for matching/carryover |
| Paku | UI label for `topup_staff`; exact organizational meaning is not documented |
| Person/persona | Event-local participant record, balance, and operational identity |
| POS | Point of sale; staff screen for participant selection, basket, checkout, refund |
| Product barcode | Numeric product scan code; four digits are prohibited |
| QR credential | Four-digit event-local participant identity token and URL |
| QR pool | All generated/imported QR credentials for an event |
| Repohár | Reusable cup; tracked by product-name convention and 1,000-HUF return lines |
| Runtime document | Singleton `system/runtime` carrying the active event pointer |
| Shibboleth | Participant-provided institutional/internal identifier; not Shibboleth SSO in this code |
| Single negative purchase | Event option allowing one purchase to cross from nonnegative to negative balance |
| Stock recipe | Components/choice groups defining inventory consumed by a product sale |
| Station | Kitchen partition: burger, gyros, pizza, or other |
| Vendég | Guest/participant UI label for role `user` |
| Workbox | Service-worker tooling generated through `vite-plugin-pwa` |

