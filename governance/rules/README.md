# Governance Rules

Harbor-facing policy over the external operations that Code Mode programs
attempt. Rules answer *"is Harbor allowed to execute this operation, and under
what conditions?"* — they are **not** Skills (which tell the agent *how* to
accomplish a task and live under `services/<name>/skills/`).

Governance Rules may be **gateway-owned** or **service-owned**. Skills explain
*how* an agent should use an API; Governance Rules decide *whether* a backend
operation may execute, and can require human approval.

The gateway-owned, file-only source defaults to the root `governance/rules/`
directory. Set `GATEWAY_GOVERNANCE_RULES_DIR` to another directory if needed;
`GATEWAY_GOVERNANCE_RULES_REFRESH_SEC` controls periodic reload (`0` means
load once). Every top-level `*.yaml` / `*.yml` / `*.json` file is loaded;
nested folders and other file types are ignored. The README and nested
`examples/` directory are documentation, not active rule files. The gateway
source is loaded once and evaluated across all enabled services.

Each service may also own its own rule source, selected in that service's
`config.json`. Its default directory is
`<serviceDir>/governance/rules/` (where `serviceDir` is that service's
directory under `SERVICES_DIR`). Every top-level `*.yaml` / `*.yml` / `*.json`
file is loaded; nested folders are not. Service sources may independently use
`file`, `url`, or a registered source and refresh schedule. **No active rule
files ship by default.**

Each service may select its own source and refresh interval in its
`config.json`:

```json
{
  "governance": {
    "rulesSource": "file",
    "rulesDir": "governance/rules",
    "rulesRefreshSec": 0
  }
}
```

`rulesDir` is optional for the `file` source and defaults to the folder above;
relative paths are resolved from the service directory. A service may instead
set `rulesSource: "url"` and `rulesUrl` (one `{ rules: [...] }` document, a
list, or one rule, fetched with GET within `rulesUrlTimeoutMs`; JSON when the
response Content-Type says JSON or URL ends in `.json`, YAML otherwise), or
name a source registered with `registerGovernanceRuleSourceBackend`. Settings
are independent per service: a service can use a mounted directory while
another uses a URL or custom source, with its own `rulesRefreshSec`.

`rulesRefreshSec` defaults to `0` (load once). A changed set is swapped in
whole; a refresh that cannot reach the source, reads an invalid set, or reads
an empty set while rules are in force changes nothing — the last valid set
stays in force. Clearing all rules for a service requires restarting the
gateway.

The examples are kept separate by ownership: `order-governance.yaml` shows
service-owned order rules, and the nested gateway example shows cross-service
policy. These are documentation fixtures, not active policies. The order
example uses illustrative `amount`, `currency`, and `items` fields not present
in the demo order API; extend the service API before applying those rules.
Copy a rule to the appropriate source directory: gateway rules to
`GATEWAY_GOVERNANCE_RULES_DIR`, service rules to that service's configured
source. The directory loader reads only top-level files, so the nested
`examples/` tree is not loaded by default.

Every enabled service's source is loaded and validated during gateway
startup. For a URL source, Harbor performs the GET before startup completes
and uses the latest response immediately; it does not wait for the first
periodic refresh. A failed initial URL load stops startup because no last
valid in-memory set exists yet. Failed later refreshes keep the active set.

Once a service is registered, an unknown source type, unreadable configured
source or invalid initial rule set stops gateway startup so it cannot
accidentally run without its intended policy. Invalid URL/refresh config
discovered while scanning skips that service (as with other invalid service
config); if no other service registers, the gateway exits. The default
directory source is the exception:
if a service's default or configured directory does not exist, that service
starts with **no rules** and logs a warning. A refresh that finds it missing
keeps rules in force, and one that finds it created loads it. A service marked
`"enabled": false` is skipped before its governance source is constructed or
read.

A file holds one rule, a list of rules, or `{ rules: [...] }`:

```yaml
name: high-value-order              # kebab-case, unique
version: 2                          # free-form revision marker, recorded on every decision
description: Large orders need a human
match:                              # which operations — every present clause must match; "*" = any present value
  service: order
  operation: placeOrder              # OpenAPI operationId
  # method: POST                    # or a list: [POST, PUT]
  # path: /orders                    # OpenAPI path template starting with /, exactly as in the spec; /orders/** = it and everything beneath
conditions:                         # when — a boolean tree over request values
  allOf:
    - field: body.amount
      greater_than: 1000
    - not: { field: query.preApproved, equals: 'true' }
action:                             # what — advisory only
  type: REQUIRE_APPROVAL            # ALLOW | DENY | REQUIRE_APPROVAL
  reason: Order amount exceeds the approval threshold
```

## Levels

The source determines ownership; within a service-owned source, `match` sets
the rule's scope:

| Level | Source and `match` | Applies to | Example |
|---|---|---|---|
| **gateway** | Gateway source configured by `GATEWAY_GOVERNANCE_RULES_DIR`; any `match` | Calls across services that match the rule | `match: { method: DELETE }` |
| **service policy baseline** | A service's own source; no service, operation or path in `match` | Every call governed by that service's source | `match: { method: DELETE }` |
| **service** | A service's own source; a `service` only | Every endpoint of that service | `match: { service: order }` |
| **endpoint** | A service's own source; an `operation` or a `path` (incl. `/prefix/**`) | Those endpoints | `match: { service: order, operation: placeOrder }` |

Gateway rules are shared across services. Service-owned rule sources are
isolated: a rule loaded for one service is never evaluated for another.
Within one service's source, `*` (and the path `/**`) names nothing, so it
does not raise a rule's level.
It matches any *present* value: every call has a service and a path, but
`operation: '*'` never targets a call without an `operationId` — one whose
path the spec does not have, or whose operation declares none.
`method` — one method or a list — restricts a rule to those kinds of request at
any level; it does not change the level.

`path` is an OpenAPI template and must start with `/` (or be `*`).
`path: /campaigns/**` targets `/campaigns` and every template beneath it
(`/campaigns/{id}`, `/campaigns/{id}/finalize`, …), segment by segment — not
`/campaigns-archive`. `**` is only valid as the whole last segment.

Rules see the template the call resolved to, never the raw string the program
wrote: Harbor canonicalises the path first (`%6f` → `o`, a query string moves
into `query.*`) and refuses spellings such as `/x/../orders/1` or an absolute
URL outright. Literal segments match ignoring letter case, so `/Orders/1`
reaches the rules on `/orders/{id}`. A path the spec does not have gets no
`operationId`, and its "template" is the path with id-like segments collapsed
to `{id}` (`/admin/users/42` → `/admin/users/{id}`).

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
| `ratio: { numerator: body.bid, denominator: body.currentBid }` | numerator ÷ denominator — *"bid > 1.3× the current bid the request states"* → `greater_than: 1.3` (both values come from the request — see *A rule sees one request*) |
| `percent_of: { part: body.budget, whole: body.totalBudget }` | 100 × part ÷ whole — *"budget > 20% of the total"* → `greater_than: 20` |
| `days_between: { from: body.startDate, to: body.endDate }` | days from `from` to `to` (negative if `to` is earlier) — *"end is 30 days after start"* → `equals: 30` |

Operators: `equals, not_equals, greater_than, greater_than_or_equal, less_than,
less_than_or_equal, in, not_in, exists, starts_with, contains`. On a computed
operand (`ratio`, `percent_of`, `days_between`) only the numeric ones apply, with
number values.

Evaluation is a pure function of the rule and the request — no I/O, no clock:

- A leaf on a **missing field** holds only for `exists: false`; comparisons
  between mismatched types are false. That includes `not_equals` and
  `not_in`: a DENY written as `{ field: body.currency, not_in: [EUR, USD] }`
  does not fire when `currency` is absent — add `{ field: body.currency,
  exists: false }` under an `anyOf` if it should.
- **Query and path values compare as they travel**: on the wire every query
  value and path parameter is text (`params: { all: true }` and `?all=true`
  both send `all=true`; `/campaigns/42` carries `42`), so a `query.*` or
  `path.*` leaf compares text for equality (`equals: true` matches `'true'`,
  `path.id: { equals: 42 }` matches the segment `42`) and reads a numeric
  string as its number for ordering. Body values keep their JSON types — a
  body string `"5000"` is not `greater_than: 1000`.
- A **body passed as a JSON string** (`body: JSON.stringify({...})`) is read
  as the object it encodes: it reaches the backend as the same bytes.
- Only the request's **own** properties are read: `constructor`, `__proto__`
  or `toString` is a missing field, never something inherited.
- A computed operand that **cannot be computed** — a missing or non-number
  field, a zero denominator, a date that is not strict ISO 8601 — is treated
  exactly like a missing field.
- **A rule sees one request.** It reads the request Harbor is about to send —
  path parameters, query and body — and nothing else: Harbor does not fetch
  the resource's current state, and earlier calls' responses are not visible
  to a rule. A computed operand therefore compares two values *of the same
  request*. *"Bid raised by more than 30%"* can be written only when the
  API's request carries the old value as well (an update that sends `bid`
  and the `currentBid` it replaces); when the request has only the new
  value, no rule can see the change — compare against a fixed threshold, or
  leave the relative check to the backend, which holds the current state.
  The program writes the request, so such a value is its claim: also cover
  requests where the ratio cannot compute (`ratio: { numerator: body.bid,
  denominator: body.currentBid }` with `exists: false` under an `anyOf`),
  not just an omitted field: `null`, zero and non-numbers also invalidate
  the ratio. Require a positive claimed current bid too (`not: { field:
  body.currentBid, greater_than: 0 }`), so a negative denominator cannot
  hide an increase. Keep an absolute limit the claim cannot move.
  A rule should handle missing, zero and non-numeric old values as well as
  large increases; computed ratios are available when the request contains
  both values.
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

**Limits.** At most 8 levels of nesting and 64 nodes per rule — counted on the tree that is evaluated, so the flat shorthand (one `allOf` plus a leaf per field) takes at most 63 fields.

## Actions

`action` is advisory: `type` (`ALLOW`, `DENY`, `REQUIRE_APPROVAL`) and an
optional `reason`. A rule never rewrites the request and has no side effects;
any other key is a load error.

## How a call is decided

A rule **targets** a call when its `match` fits it, and **matches** it when it
targets it and its `conditions` hold.

1. **Ownership sets the broadest scope.** Every rule loaded from the gateway
   directory belongs to the gateway tier, even if it names a service,
   operation, or path. A rule loaded from a service's source belongs to that
   service: operation/path-specific rules are endpoint-tier; other service
   rules (including method-only rules) are service-tier. A service file can
   never define a cross-service gateway rule.
2. **The most specific matching tier decides**: endpoint rules override
   service rules, and service rules override non-final gateway rules. An
   endpoint rule whose conditions are false does not match, so the next
   matching tier decides.
3. **`final: true` pins a broader tier**: when a `final` rule matches, the
   decision is made at its tier and more specific tiers are not consulted
   (with several, the broadest wins, whatever their actions — a gateway
   `final` ALLOW beats a service `final` DENY).
4. **Within the deciding tier: DENY > REQUIRE_APPROVAL > ALLOW**; the first
   rule in file order carrying the winning action is the deciding rule.
5. **Nothing matches**:
   - some rule targets the call ⇒ `GOVERNANCE_DEFAULT_DECISION` (default
     **`DENY`**, reason `NO_MATCHING_RULE`);
   - no rule targets it ⇒ the call is ungoverned and **allowed** (reason
     `NO_GOVERNANCE`) **whatever `GOVERNANCE_DEFAULT_DECISION` says**. A
     gateway with no rules behaves exactly as without governance.

Gateway-owned rule file. Put it in the directory configured by
`GATEWAY_GOVERNANCE_RULES_DIR`; the source, not a `service` match clause,
determines gateway ownership:

```yaml
- name: no-deletes-anywhere
  match: { method: DELETE }
  final: true
  action: { type: DENY }
```

Service-owned rules belong in that service's configured source. The `service`
match value must be the service name Harbor registers:

```yaml
- name: order-reads
  match: { service: order, method: GET }
  action: { type: ALLOW }
- name: high-value-orders
  match: { service: order, operation: placeOrder }
  conditions: { amount: { greater_than: 1000 } }
  action: { type: REQUIRE_APPROVAL }
```

With these rules and the default `DENY`, a `POST /orders` with an amount of
500 is denied: the endpoint rule targets it but does not match, and no service
rule allows order creation. Add a service- or endpoint-level `ALLOW` for what
should pass.

The gateway DELETE rule does not target a `PATCH /orders/ord-1`, so other
policies decide it (step 5). Rules written for some operations leave every
other call — and every path the spec does not have — ungoverned. To target
every call at gateway scope, add a gateway-owned catch-all; without `final`,
more-specific service or endpoint rules can still decide:

```yaml
- name: deny-everything-else
  match: { service: '*' }
  action: { type: DENY, reason: No Governance Rule allows this operation }
```

## Validation

An invalid rule file stops the gateway from starting — a malformed rule never
silently becomes "not enforced". The error names the file, the rule and the
exact place, e.g. `rules.yaml (rule 2): invalid Governance Rule —
conditions.anyOf.1.starts_with: ratio yields a number …`.

Validation checks a rule's shape, not its targets. An `operation`, `service`
or `path` that no spec contains loads fine and never targets anything, and a
spec refresh that renames an `operationId` or drops a path silently
un-governs the rules written for it. Check new rules against a real call
(the decision is on `GET /executions/{id}`).

In YAML flow style (`{ … }`), quote OpenAPI templates:
`match: { method: DELETE, path: '/campaigns/{id}' }` — unquoted, the braces
are YAML syntax. Quote `'*'` everywhere: unquoted, `*` starts a YAML alias.

See [`docs/code-mode-governance.md`](../../docs/code-mode-governance.md).
