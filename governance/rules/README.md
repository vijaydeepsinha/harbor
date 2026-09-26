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
match:                              # which operations — every present clause must match; "*" = anything
  service: trafficking
  operation: createCampaign         # OpenAPI operationId
  # method: POST
  # path: /campaigns                # OpenAPI path template, exactly as in the spec
conditions:                         # when — a boolean tree over request values
  allOf:
    - percent_of: { part: body.budget, whole: body.totalBudget }
      greater_than: 20              # budget is more than 20% of the total budget
    - not: { field: query.dryRun, equals: true }
action:                             # what — advisory only
  type: REQUIRE_APPROVAL            # ALLOW | DENY | REQUIRE_APPROVAL
  reason: Campaign budget exceeds the approval threshold
```

## Conditions

`conditions` is a tree. Each node is one of:

| Node | Holds when |
|---|---|
| `allOf: [node, …]` | every child holds (AND) |
| `anyOf: [node, …]` | at least one child holds (OR) |
| `not: node` | the child does not hold (NOT) |
| a **leaf** | its operators hold on its operand |

A leaf reads exactly **one operand** and applies one or more **operators** (all
must hold):

| Operand | Value compared |
|---|---|
| `field: body.budget` | a request value — `budget` ≡ `body.budget`; `body.a.b`, `query.x`, `path.id` select explicitly; arrays may be indexed (`body.tags.0`) |
| `ratio: { numerator: body.bid, denominator: body.currentBid }` | numerator ÷ denominator — *"bid > 1.3× the current bid"* → `greater_than: 1.3` |
| `percent_of: { part: body.budget, whole: body.totalBudget }` | 100 × part ÷ whole — *"budget > 20% of the total"* → `greater_than: 20` |
| `days_between: { from: body.startDate, to: body.endDate }` | days from `from` to `to` (negative if `to` is earlier) — *"end is 30 days after start"* → `equals: 30` |

Operators: `equals, not_equals, greater_than, greater_than_or_equal, less_than,
less_than_or_equal, in, not_in, exists, starts_with, contains`. On a computed
operand (`ratio`, `percent_of`, `days_between`) only the numeric ones apply, with
number values.

Evaluation is a pure function of the rule and the request — no I/O, no clock:

- A leaf on a **missing field** holds only for `exists: false`; comparisons
  between mismatched types are false.
- A computed operand that **cannot be computed** — a missing or non-number
  field, a zero denominator, a date that is not strict ISO 8601 — is treated
  exactly like a missing field.
- Dates are `YYYY-MM-DD` or date-times **with a zone** (`2026-03-01T09:00:00Z`,
  `…+05:30`). A zone-less date-time or an impossible date (`2026-02-30`) does
  not compute: JavaScript would read the first in the host's time zone and roll
  the second into March.
- Computed numbers are rounded to 9 decimal places, so `1.43 / 1.1` compares
  as `1.3` and `100 × 1.1` as `110`.

**Flat shorthand.** The earlier form is still accepted and means `allOf` of
`field` leaves:

```yaml
conditions:                         # ≡ allOf: [{ field: budget, greater_than: 1000000 }, …]
  budget: { greater_than: 1000000 }
  query.dryRun: { not_equals: true }
```

A body field named like a tree key (`allOf`, `anyOf`, `not`, `field`, `ratio`,
`percent_of`, `days_between`) must be written with its prefix in the
shorthand — `body.not`, not `not`.

**Limits.** At most 8 levels of nesting and 64 nodes per rule.

## Actions

`action` is advisory: `type` (`ALLOW`, `DENY`, `REQUIRE_APPROVAL`) and an
optional `reason`. A rule never rewrites the request and has no side effects;
any other key is a load error.

Precedence among matched rules: **DENY > REQUIRE_APPROVAL > ALLOW**. No match
⇒ `GOVERNANCE_DEFAULT_DECISION` (default `ALLOW`).

## Validation

An invalid rule file stops the gateway from starting — a typo never silently
becomes "not enforced". The error names the file, the rule and the exact
place, e.g. `rules.yaml (rule 2): invalid Governance Rule —
conditions.anyOf.1.starts_with: ratio yields a number …`.

In YAML flow style (`{ … }`), quote OpenAPI templates:
`match: { method: DELETE, path: '/campaigns/{id}' }` — unquoted, the braces
are YAML syntax.

See [`docs/code-mode-governance.md`](../../docs/code-mode-governance.md).
