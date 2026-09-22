# E2E Governance Rule fixtures

Loaded by the `harbor` E2E instance (`GOVERNANCE_RULES_DIR` points here,
`GOVERNANCE_DEFAULT_DECISION=ALLOW`). Files load in filename order; the numeric
prefixes fix that order because it is the tie-break for precedence.

| Operation | Rules that match | Decision |
|---|---|---|
| `getCustomer customer-001` | allow-read-customer | ALLOW |
| `getCustomer customer-002` | allow-read-customer, deny-restricted-customer | DENY (precedence) |
| `getPaymentDetails` | payment-details-require-approval | REQUIRE_APPROVAL |
| `createOrder amount ≤ 10000` | — | ALLOW (default, `NO_MATCHING_RULE`) |
| `createOrder amount > 10000` | high-value-order-requires-approval | REQUIRE_APPROVAL |
| `getOrder` | — | ALLOW (default) |
| `updateOrder {status: shipped}` | allow-update-order | ALLOW |
| `updateOrder {status: cancelled}` | allow-update-order, deny-cancel-via-update | DENY (precedence) |
| `updateOrder {expedite: true}` | allow-update-order, expedite-requires-approval | REQUIRE_APPROVAL (precedence) |
| `deleteOrder` | deny-delete-order | DENY |
| `createPayment` | charge-payment-requires-approval | REQUIRE_APPROVAL |
| `sendNotification` | allow-notifications | ALLOW |
| `unstableOperation`, `ping` | — | ALLOW (default) |
| `ops createAdminUser` | deny-admin-user-creation | DENY |
| `ops listAdminUsers`, `ops ping` | allow-ops-reads | ALLOW |

`../strict` is the rule set of the `harbor-strict` instance (default DENY);
`../invalid` is a malformed file used to prove the gateway refuses to boot.
