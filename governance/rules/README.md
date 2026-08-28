# Governance Rules

Harbor-facing policy over the external operations that Code Mode programs
attempt. Rules answer *"is Harbor allowed to execute this operation, and under
what conditions?"* — they are **not** Skills (which tell the agent *how* to
accomplish a task and live under `services/<name>/skills/`).

Every `*.yaml` / `*.yml` / `*.json` file **directly in this directory** is
loaded at boot (`GOVERNANCE_RULES_DIR`, default `./governance/rules`). Files in
sub-directories are not — `examples/` is documentation.

A file holds one rule, a list of rules, or `{ rules: [...] }`:

```yaml
name: high-budget-campaign          # kebab-case, unique
version: 2                          # free-form revision marker, recorded on every decision
description: Large spends need a human
match:                              # every present clause must match; "*" = anything
  service: trafficking
  operation: createCampaign         # OpenAPI operationId
  # method: POST
  # path: /campaigns                # OpenAPI path template, exactly as in the spec
conditions:                         # all must hold; bare names read from the request body
  budget: { greater_than: 1000000 }
  query.dryRun: { not_equals: true }
action:
  type: REQUIRE_APPROVAL            # ALLOW | DENY | REQUIRE_APPROVAL
  reason: Campaign budget exceeds the approval threshold
```

Operators: `equals, not_equals, greater_than, greater_than_or_equal, less_than,
less_than_or_equal, in, not_in, exists, starts_with, contains`. Field paths:
`budget` ≡ `body.budget`; `body.a.b`, `query.x`, `path.id` select explicitly.

Precedence among matched rules: **DENY > REQUIRE_APPROVAL > ALLOW**. No match
⇒ `GOVERNANCE_DEFAULT_DECISION` (default `ALLOW`). An invalid rule file stops
the gateway from starting — a typo never silently becomes "not enforced".

See [`docs/code-mode-governance.md`](../../docs/code-mode-governance.md).
