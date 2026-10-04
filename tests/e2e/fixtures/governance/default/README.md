# E2E Governance Rule fixtures

The shared test-only gateway policy lives in `../gateway/10-deny-delete.yaml`.
Both E2E gateway profiles load it through `GATEWAY_GOVERNANCE_RULES_DIR`,
independently of the repository's deployable `governance/rules/` directory.
It denies all DELETE activities with `final: true`, so service-level fixtures
cannot override it. The Python demo E2E uses the same fixture and asserts that
a task DELETE is denied and the task remains present.

The `harbor` E2E profile assigns the `commerce/` policy directory to its
commerce service and `ops/` to its operations service through each generated
service's `config.json`. These sets are loaded independently. Files load in
filename order within their service; numeric prefixes fix that order because
it is the tie-break for precedence. The gateway's process-wide fallback is
`GOVERNANCE_DEFAULT_DECISION=ALLOW`.

The default decision applies only when a rule *targets* an operation but none
*matches* (`NO_MATCHING_RULE`). An operation no rule targets is ungoverned and
allowed (`NO_GOVERNANCE`) whatever the default says.

| Operation                         | Rules that match                                     | Decision                            |
|-----------------------------------|------------------------------------------------------|-------------------------------------|
| `getCustomer customer-001`        | allow-read-customer                                  | ALLOW                               |
| `getCustomer customer-002`        | allow-read-customer, deny-restricted-customer        | DENY (precedence)                   |
| `getPaymentDetails`               | payment-details-require-approval                     | REQUIRE_APPROVAL                    |
| `createOrder amount ≤ 10000`      | —                                                    | ALLOW (default, `NO_MATCHING_RULE`) |
| `createOrder amount > 10000`      | high-value-order-requires-approval                   | REQUIRE_APPROVAL                    |
| `getOrder`                        | —                                                    | ALLOW (ungoverned, `NO_GOVERNANCE`) |
| `updateOrder {status: shipped}`   | allow-update-order                                   | ALLOW                               |
| `updateOrder {status: cancelled}` | allow-update-order, deny-cancel-via-update           | DENY (precedence)                   |
| `updateOrder {expedite: true}`    | allow-update-order, expedite-requires-approval       | REQUIRE_APPROVAL (precedence)       |
| `deleteOrder`                     | deny-delete-order, gateway `deny-all-delete` (final) | DENY (gateway final)                |
| `createPayment`                   | charge-payment-requires-approval                     | REQUIRE_APPROVAL                    |
| `sendNotification`                | allow-notifications                                  | ALLOW                               |
| `unstableOperation`, `ping`       | —                                                    | ALLOW (ungoverned, `NO_GOVERNANCE`) |
| `ops createAdminUser`             | deny-admin-user-creation                             | DENY                                |
| `ops listAdminUsers`, `ops ping`  | allow-ops-reads                                      | ALLOW                               |

`../strict` is the rule set of the `harbor-strict` instance (default DENY, which
denies only operations one of its three rules targets without matching; the
rest stay ungoverned);
`../invalid` is a malformed file used to prove the gateway refuses to boot.
