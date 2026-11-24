# Code Mode Governance Layer

Durable executions, an external-call journal with replay, declarative
Governance Rules, and human approval over MCP — for the JavaScript programs
agents run through `api_execute`.

> **The V8 isolate is ephemeral. The execution is durable.**

Rule format: [`governance/rules/README.md`](../governance/rules/README.md).
Requirement → test mapping: [`tests/REQUIREMENT_COVERAGE.md`](../tests/REQUIREMENT_COVERAGE.md).
History: the 2026-08-28 requirements ([`docs/poc/requirements-aug28.md`](poc/requirements-aug28.md))
and gap analysis ([`docs/poc/implementation-plan.md`](poc/implementation-plan.md));
where they disagree with this document, this document and the code win.

---

## 1. Why

An agent program such as

```javascript
async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const id = campaigns.data[0].id
  await api.request({ method: 'POST', path: `/campaigns/${id}/activate` })
  await api.request({ method: 'POST', path: `/campaigns/${id}/finalize` })
}
```

may need a human to approve the activation. The program cannot be "paused"
inside V8 and kept alive across an approval that takes minutes or days, and it
must never repeat a `POST` it already made. Harbor therefore records every
external call as an **activity**, stops the isolate at the approval point, and
on resume runs the *original* program again in a fresh isolate while replaying
the recorded responses for activities that already completed.

## 2. Execution lifecycle

```
CREATED ──► RUNNING ──► COMPLETED
               │
               ├──► WAITING_APPROVAL ──(decided: approve)──► RUNNING …
               │                     ──(decided: reject) ──► DENIED
               │                     ──(decided: cancel) ──► CANCELLED
               ├──► INTERRUPTED   (retryable failure: circuit open, sandbox time limit, internal error) ──► RUNNING …
               ├──► DENIED        (a Governance Rule said DENY)
               └──► FAILED        (replay diverged, unknown outcome, non-retryable error — incl. a failed call the program did not catch)
```

| Fact | Where |
|---|---|
| One logical program = one `executionId` (UUID minted by Harbor) | `src/runtime/execution/execution-manager.ts` |
| The code first submitted is persisted — before the first run, because an interrupted or crashed run resumes from it — and is authoritative for every resume; replacement code is ignored (logged) | `ExecutionRecord.originalCode` |
| Once the execution is terminal its code is dropped (`EXECUTION_CODE_RETENTION=DROP`, default; `KEEP` keeps it against the `executionId`); the execution is stamped `finishedAt` and, under `EXECUTION_RETENTION_SEC`, `expiresAt` | `ExecutionManager` |
| Every run takes a per-execution lock; a concurrent run gets `EXECUTION_LOCKED` (retryable). A `RUNNING` record whose lock is free is a crashed run and may resume | `ExecutionManager.beginRun` |
| Terminal states are not resumable (`EXECUTION_NOT_RESUMABLE`) | same |
| A resume that arrives while the approval is still undecided is not a failure: the run does not start, the execution stays `WAITING_APPROVAL`, and the caller gets the pause again (`ApprovalPendingError` → `input_required`, or `APPROVAL_REQUIRED` for clients without elicitation) | same, and `src/tools/execute-api.tool.ts` |

## 3. Activity journal

Every `api.request()` that reaches the host bridge becomes activity `#N`,
numbered in **arrival order** within the execution — never by variable name,
never by hashing code (`src/runtime/execution/activity-journal.ts`). Each record
holds the request (`method`, the canonical concrete path (§5), resolved
OpenAPI path template, `operationId`, path params, query, body — never
headers) and, once the call returns, the response (`status`, `ok`, `data`).

**Updated in place, never rebuilt.** There is exactly one activity record per
call, keyed by `executionId + sequence`. An approval moves that same record
`WAITING_APPROVAL → APPROVED → EXECUTING → COMPLETED` (or `DENIED` /
`CANCELLED`); every resume starts a fresh isolate and a fresh cursor at `#1`
that reads the same records — completed ones are replayed, nothing is copied
or recreated. Approvals and governance decisions are separate records bound
to their sequence. Records are deleted only with their execution, by the
retention sweep (§12).

The journal is also the run's single record of what happened to each call —
replayed, executed (with the response) or failed. Nothing else keeps call
state: the audit line's `endpointsAccessed` / `apiCallCount` (calls made in
this run) and the `progress` returned on failure (replayed + executed +
failed calls) are projections of it (`AuditCollector`, `ProgressCollector`).

Activity states:

| State | Meaning |
|---|---|
| `EXECUTING` | call in flight; found on resume ⇒ the previous process died mid-call |
| `COMPLETED` | response recorded (any HTTP status) — replayable |
| `FAILED` | the call threw — transport error, timeout, a 5xx that retries did not clear (§10), or an abort when the run ended; `failure.outcomeKnown: false` — Harbor does not know whether the API executed |
| `WAITING_APPROVAL` / `APPROVED` / `DENIED` / `CANCELLED` | governance and human-decision states |

## 4. Replay

On every run the program starts from the top. At activity `#N` the bridge
(`src/runtime/sandbox/bridge-request-handler.ts`) asks the activity gate
(`src/runtime/execution/activity-gate.ts`), which looks the sequence up:

| Journaled record at `#N` | Bridge action |
|---|---|
| none | evaluate Governance Rules (see §6) |
| `COMPLETED` | return the stored response — **no external call** |
| `APPROVED` | execute now, record `COMPLETED` |
| `WAITING_APPROVAL` | pause again |
| `DENIED` / `CANCELLED` | stop |
| `FAILED`, or `EXECUTING` with a non-`GET` method | stop with `ACTIVITY_OUTCOME_UNKNOWN` — never silently repeat |
| `EXECUTING` with `GET` | re-execute (safe method) |

**Divergence.** Every record binds the call's method, resolved template and
concrete canonical path (§5): a replayed response must belong to the same
resource. A record that is about to execute or is in front of a human —
`APPROVED`, `WAITING_APPROVAL`, `EXECUTING` — also binds the query and the
body (compared independently of key order): an approval is for the request
the human saw, and a program that reaches the same sequence with another
amount or filter (a clock-dependent branch, `Promise.all` siblings arriving in
another order) must not inherit it. A mismatch stops the run with
`REPLAY_DIVERGED` and the execution is `FAILED`; nothing is executed under
the old history and the recorded activity is left as it was. A `COMPLETED`
record still replays when only its query or body drifted — nothing executes,
and a timestamp in a body does not make a sequential program unresumable
(§14) — **unless it was admitted concurrently** (below): then its query and
body are bound too.

**Deterministic replay contract.** Given the same persisted program and the
same recorded responses, replay reproduces the same external-call sequence.
Harbor controls what the program observes from the outside world; it does not
control `Date.now()`, `Math.random()` or similar inside the program. A program
that branches on those before an external call can diverge — the divergence
check then stops it.

**Stopped runs stay stopped.** Once a run has paused or stopped, any further
`api.request()` in that isolate — even inside a `try/catch` — is refused
without executing, with the code of why the run stopped (`GOVERNANCE_DENIED`,
`REPLAY_DIVERGED`, `EXECUTION_CANCELLED`, `ACTIVITY_OUTCOME_UNKNOWN`, else
`APPROVAL_REQUIRED`). The first run-stopping signal stands — a sibling's
later pause never turns a DENY into a question the human is asked — and it is
re-raised after the isolate settles so user code cannot mask it.

**Concurrent calls are admitted one at a time.** For calls a program starts
together (`Promise.all`), the journal lookup, governance, the stop check and
journaling `EXECUTING` form one critical section per run, taken in arrival
order. A call admitted after a sibling paused or denied the run therefore
sees that stop and can neither execute nor open a second approval. The
external calls themselves still overlap.

**How concurrent calls are numbered.** Each call takes the next sequence
when it reaches the bridge — arrival order, not completion order. Five
creates started by one `Promise.all` are #1–#5 in array order, however their
responses come back, and on a resume each is handed its own recorded
response. Five approval-gated calls started together take five approval
rounds: the first pauses the run, the others are refused in that run and
reach governance one per resume. Arrival order can depend on timing, though:
two chains that each read and then create (`await get(); await create()`)
reach their creates in the order their reads returned. On a resume the
reads replay at once, in sequence order, so the creates may now arrive the
other way round. A call admitted while another call of the run was in flight
is therefore journaled with `admittedConcurrently: true`, and replay binds
its query and body even once it is `COMPLETED`: a sibling that reaches its
sequence first is a divergence (`REPLAY_DIVERGED`, *calls started together
arrived in another order*), never a sibling handed another call's response —
which is what happened before, silently, with the run completing on the
wrong resource's id.

**The run ends when its calls end.** When the program's function settles,
calls it started without awaiting (`ids.forEach(async …)`, a floating
promise) get the rest of the run's time budget (`executeTimeoutMs`) to finish
and be journaled; whatever is still in flight is then aborted and journaled
`FAILED` (outcome unknown), and a connector that ignores the abort is
abandoned after one second. Only then is the run's outcome recorded, so
nothing reaches the backend or the store after the execution is marked
finished. An un-awaited call that paused or was denied decides the outcome
like an awaited one (`src/runtime/sandbox/bridge-request-handler.ts`).

## 5. Governance decision point

```
V8 api.request() → bridge → canonicalise path → resolve OpenAPI operation → evaluate rules → ALLOW | DENY | REQUIRE_APPROVAL
                                                                                              │       │            │
                                                                                           execute  stop      pause (approval)
```

Governance always runs **before** the external call, never after. The
evaluator (`src/runtime/governance/rule-evaluator.ts`) is a pure function of the
rule set and the request — no I/O, no clock, no model.

**One spelling of the path.** The bridge canonicalises every `api.request`
path once, before resolution (`src/runtime/sandbox/request-path.ts`), and
governance, the journal and the connector all use that spelling. Otherwise
the rules would judge the raw string while axios, the URL parser and the
backend normalise it on the way out: `/orders/./1`, `/x/../orders/1` or
`/%6frders/1` would reach an operation a rule denies while the resolver
reported "no such operation" (ungoverned, allowed).

- **Refused** with `INVALID_API_REQUEST` — nothing is sent or journaled:
  absolute or protocol-relative URLs (`http://…`, `//host`), backslashes,
  `#` fragments, empty interior segments (`//`), `.` / `..` segments (literal
  or `%2e`), a segment that decodes to `/`, `\` or a control character,
  malformed percent-encoding, a query key repeated in the path or given both
  in the path and in `params`, and `params` that is not an object
  (`bad-params`).
- **Normalised**: a missing leading slash is added; escapes of characters
  that need none are decoded (`%6f` → `o`); a trailing slash is kept and
  resolves to the same template; a query string written into the path moves
  into `params`, so `query.*` conditions see it.

`ApiClient` also refuses to leave the service's base URL (axios
`allowAbsoluteUrls: false`), whoever calls it.

## 6. Governance Rules

For each new API activity, the central execution runtime evaluates two
separate sources: the shared **gateway-owned** rule set and only the selected
service's **service-owned** rule set. Gateway rules are loaded from top-level
`*.yaml|yml|json` files in `GATEWAY_GOVERNANCE_RULES_DIR` (default
`governance/rules/`). This source is file-only and independent of service
folders and enablement. `GATEWAY_GOVERNANCE_RULES_REFRESH_SEC` controls its
periodic refresh (`0` loads once). The initial directory and rules must be
readable and valid before startup completes; an existing empty directory is
allowed. Refreshes swap a complete validated set; failures or an empty set
that would replace active rules retain the last-known-good set.

Service rules continue to come from each enabled service's configured source
(`src/spi/governance/rule-source.ts`). By default, the top-level
`*.yaml|yml|json` files in `<serviceDir>/governance/rules/` are read through
`governance.rulesSource: "file"`; a service may instead configure a URL
(`"url"`) or a source registered with
`registerGovernanceRuleSourceBackend`. Source and `rulesRefreshSec` are
configured in each service's `config.json`; relative `rulesDir` paths resolve
against that service's directory. Each active service has an isolated rule
store/refresher. Rules from one service are never evaluated for another. A
disabled service is skipped before its source is constructed or loaded.

With service `rulesRefreshSec` above 0, only that service's source is
re-read on its interval (`src/runtime/governance/rule-refresher.ts`); the
gateway file set has its own independent interval. A changed set is swapped
in atomically; an unreachable source, invalid set, or empty set that would
replace a non-empty one keeps that source's last valid set. Invalid service
URL/refresh config discovered during scanning skips that service; an unknown
service source type, unreadable initial source, or invalid initial ruleset
after registration stops boot. A missing default service directory is
tolerated at boot with a warning; the gateway-owned directory is not. The
service URL source is fetched and validated once during startup, before the
first periodic timer. Format and operators are in
[`governance/rules/README.md`](../governance/rules/README.md).

Example service configuration:

```json
{
  "governance": {
    "rulesSource": "file",
    "rulesDir": "governance/rules",
    "rulesRefreshSec": 60
  }
}
```

- **Targeting** uses the service's own OpenAPI document: a call to
  `POST /campaigns/C1/activate` resolves to `operationId: activateCampaign`,
  path template `/campaigns/{id}/activate`, `pathParams.id = "C1"`
  (`src/runtime/governance/operation-resolver.ts`). Literal segments compare
  on the decoded segment and ignore letter case (exact case preferred) —
  many backends route `/Orders/1` like `/orders/1`, and a call must not
  escape a rule by changing case. A segment mixing literals and parameters
  (`/files/{name}.json`, `/v1/{job}:cancel`) resolves; the most specific
  template wins (literal > mixed > `{param}`). A path the spec does not have
  resolves to no operation: no `operationId`, and a template made by
  collapsing id-like segments to `{id}`. Rules match on `service`,
  `operation`, `method` (one or a list), `path` (a template starting with
  `/`, or `/prefix/**` for a template and everything beneath it) — `*`
  matches any *present* value, so `operation: '*'` never targets a call
  without an `operationId`.
- **Conditions** are a bounded boolean tree — `allOf` (AND), `anyOf` (OR),
  `not` (NOT) — over actual request values. A leaf compares one operand: a
  field (bare names from the body, `query.*`, `path.*`, `body.a.b`) or a
  number computed from two fields (`ratio`, `percent_of`, `days_between` with
  strict ISO 8601 dates). A leaf on a missing field — or on an operand that
  cannot be computed, e.g. a zero denominator — holds only for `exists:
  false`; comparisons across types are false. Three readings follow what
  reaches the backend: a body passed as a JSON string is read as the object
  it encodes; `query.*` values compare in wire form (`equals: true` matches
  `'true'`, ordering reads a numeric string as a number); and only the
  request's own properties are read (`constructor` or `__proto__` is a
  missing field). The earlier flat map is still accepted as shorthand for
  `allOf`. At most 8 levels and 64 nodes.
- **Actions are advisory**: `ALLOW`, `DENY` or `REQUIRE_APPROVAL` plus a
  reason. A rule never rewrites the request and has no side effects.
- **Levels**: what `match` names sets a rule's level — an operation or path ⇒
  endpoint, a service only ⇒ service, neither ⇒ gateway, within the rule's
  source. Source ownership controls its broadest tier: a gateway-owned rule is
  gateway-tier even when it names a service/operation/path; a service-owned
  method-only or otherwise broad rule is service-tier, and an operation/path
  rule is endpoint-tier. The most specific matching tier decides (endpoint
  overrides service, service overrides non-final gateway); a matching
  `final: true` rule pins the decision to its tier. A service-owned rule can
  never become a cross-service gateway rule.
- **Precedence** within the deciding level: `DENY > REQUIRE_APPROVAL >
  ALLOW`; the first rule (file order) carrying the winning action is the
  deciding rule. `matchedRules` on the decision lists every matched rule.
- **Default**: a call some rule *targets* (its `match` fits) but no rule
  matches gets `GOVERNANCE_DEFAULT_DECISION` — default `DENY`
  (`NO_MATCHING_RULE`). A call no rule targets is ungoverned and allowed
  (`NO_GOVERNANCE`) **whatever `GOVERNANCE_DEFAULT_DECISION` says**, so a
  gateway without rules behaves as before. To fail closed for everything
  else — paths the spec does not have included — add a gateway-level rule
  that targets every call, e.g. `match: { service: '*' }` with a `DENY`
  action in the gateway rule directory; more specific rules still override it
  unless the gateway rule is `final` (§14).
- **Fail closed**: an evaluation error is a `DENY`; an invalid rule file stops
  the gateway at boot; a duplicate rule name is an error.
- **Every decision is persisted** per activity: decision, reason, matched
  rules, owner-qualified `name@version#contentHash12` for each, the deciding
  rule, timestamp.

## 7. Human approval over MCP

Approval uses the MCP 2026-07-28 **multi round-trip request** pattern — the
standard mechanism for server-initiated user interaction — with a **form
elicitation**. No custom MCP methods.

1. `api_execute` returns `resultType: "input_required"` with
   `inputRequests.approval` (an `elicitation/create` form: `approve: boolean`,
   `comment?: string`) and an opaque `requestState`.
2. The `requestState` is HMAC-SHA256 sealed by the SDK codec
   (`createRequestStateCodec`) with a TTL (`GOVERNANCE_APPROVAL_TTL_SEC`), bound
   to the JSON-RPC method, and carries `{ executionId, approvalId,
   activitySequence, userIdHash }`. The server verifies it *before* the tool
   runs (`ServerOptions.requestState.verify`); the tool re-checks that the
   caller is the same principal. Tampered, expired or foreign state is
   refused with `-32602`.
3. The client retries the **same** `tools/call` with `inputResponses.approval`
   (`accept` + form content, `decline`, or `cancel`) and the echoed
   `requestState`. Harbor applies the decision once, then resumes the original
   program in a fresh isolate.
4. Mapping: `accept` with `approve: true` → `APPROVED` (the activity executes
   on resume); `accept` with `approve: false` or `decline` → `REJECTED`
   (execution `DENIED`); `cancel` → `CANCELLED`. `approve` may also be a word,
   for approvers who answer in a chat rather than tick a box: `yes`, `sure`,
   `proceed`, `approve`, `approved` approve; `no`, `reject`, `rejected`,
   `deny`, `denied`, `decline`, `declined` reject (`APPROVAL_ANSWER_WORDS` in
   `src/core/constants.ts`; the whole value, trimmed, any case). Both channels
   read the field with the same function (`readApprovalAnswer` in
   `src/runtime/execution/approval-service.ts`). An `accept` whose `approve`
   is missing or is anything else — a number, `null`, the strings `"true"` /
   `"false"`, a sentence such as `"yes please"` — is refused
   (`INVALID_API_REQUEST`) and the approval stays pending: an answer Harbor
   does not recognise is never read as a yes.

An approval is bound to **one activity**. If a later activity needs approval,
the run pauses again with a new elicitation and a new `requestState` —
**multiple approval rounds** are simply repeated `input_required` results.

**Stale and conflicting answers change nothing.** Under the execution lock,
`ApprovalService.decide` (`src/runtime/execution/approval-service.ts`)
re-checks that the approval is still the question its execution waits on: if
the execution has finished, or the activity is no longer `WAITING_APPROVAL`
on this approval, the answer is refused (`EXECUTION_NOT_RESUMABLE`) and
nothing is written. An MRTR retry whose answer differs from a decision
already recorded — a decline arriving after an HTTP approve — gets
`APPROVAL_ALREADY_DECIDED` and nothing runs (`EXECUTION_NOT_RESUMABLE` once
the execution has finished); a retry repeating the recorded decision (the
client lost the response) resumes. Errors on this path keep their own
`retryable` flag — `EXECUTION_LOCKED` is retryable.

**Clients without elicitation.** If the request's `clientCapabilities` do not
declare `elicitation`, the tool returns an `isError` result with code
`APPROVAL_REQUIRED`, the ids in `_meta`, and instructions. A human decides via
`POST /executions/{id}/approvals/{approvalId}`; the client then calls
`api_execute` again with `_meta["harbor/execution-id"]` set to resume.

**Client capability, server capability.** The server advertises only what it
implements (`tools`); elicitation is a *client* capability, read per request
from the `_meta` envelope. The transport stays stateless — execution state
lives in the execution store, never in the MCP session (there is none).

## 8. `_meta`

Harbor's keys use the vendor prefix `harbor/` (`META_PREFIX` — one constant,
placeholder until the project's public name is settled):

| Key | Direction | Meaning |
|---|---|---|
| `harbor/execution-id` | response | the durable execution this call ran |
| `harbor/execution-status` | response | status after the call |
| `harbor/approval-id` | response | the approval the execution waits on |
| `harbor/execution-id` | request | resume this execution (fallback path) |

Reserved `io.modelcontextprotocol/*` keys are never written by Harbor except
`serverInfo`.

A resume refused before a run starts (the execution is locked, finished, or
still waiting on an undecided approval) changes nothing, and
`harbor/execution-status` reports the status as stored — not the status the
error would have given a run.

**Outbound headers.** Harbor sets its own headers on every backend call
*after* the program's, so a program's copy never wins. Correlation is scoped
to the MCP request; the durable execution id is kept separately in governed
execution state and activity idempotency keys:

| Header | Value | Purpose |
|---|---|---|
| `X-Correlation-ID` | the MCP request id for this sandbox run | ties together the run's backend calls; a later approval resume is a new MCP request and therefore has a new correlation id |
| `X-Idempotency-Key` | `mcp-{service}-{executionId}-{sequence}` | one key per activity: two executions of one program never share a key, and a resume keeps its keys. Ungoverned (legacy) runs use `mcp-{service}-{userIdHash12}-{codeHash16}-c{n}`, n = the call's arrival index |
| `X-Harbor-Server-ID` | `HARBOR_SERVER_ID` (default `HARBOR_GATEWAY`) | Harbor's stamp: this gateway made the call |
| `X-Harbor-Client-ID` | the caller's `X-Harbor-Client-ID` request header | optional: lets the caller identify itself to the backend; omitted when not sent (and on stdio) |
| `X-Harbor-Execution-ID` | the governed `executionId` | links backend calls from separate MCP requests and sandbox runs in the same approval workflow; absent for legacy runs |

A program may set `Accept`, `Content-Type` and its own `X-…` headers. It may
not set the following, in any letter case — its copies are dropped
(`src/runtime/api-client/api-client.ts`):

- **Harbor's own**: `Authorization`, `X-Request-Source`, `X-MCP-Tool`,
  `X-MCP-Service`, `X-MCP-Version`, `X-MCP-Session-ID` (no longer sent, still
  reserved), `X-Idempotency-Key`, `X-Correlation-ID`, `X-Harbor-Server-ID`,
  `X-Harbor-Client-ID`, `X-Harbor-Execution-ID`. A program
  that could set these could act as another principal or defeat
  deduplication.
- **Routing, framing and ambient credentials**: `Host`, `Content-Length`,
  `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`,
  `Trailer`, `Proxy-Authorization`, `Proxy-Connection`, `Cookie`,
  `Forwarded`, `X-Forwarded-For` / `-Host` / `-Proto` / `-Port` / `-Prefix`,
  `X-Real-IP`, `X-HTTP-Method-Override`, `X-HTTP-Method`,
  `X-Method-Override`, `X-Original-URL`, `X-Rewrite-URL`,
  `X-Original-Method`. These would let the backend, or a proxy in front of
  it, serve a different method, URL or host than the one governance resolved,
  or smuggle a second request.

## 9. Sequence

```
Agent                Harbor (api_execute)          V8 #1              Backend            Execution store
  │  code                    │                        │                   │                     │
  ├──────────────────────────►  create execution, persist original code ───────────────────────►│
  │                          ├─ run ─────────────────►│                   │                     │
  │                          │              GET #1 ───┼── governance ALLOW ──► call ──► resp ───►│ activity 1 COMPLETED
  │                          │              GET #2 ───┼── ALLOW ────────────► call ──► resp ───►│ activity 2 COMPLETED
  │                          │              POST #3 ──┼── REQUIRE_APPROVAL ──────────────────────►│ activity 3 WAITING, approval A
  │                          │◄─ pause; isolate disposed                  │                     │
  │◄─ input_required { elicitation, requestState } ──│                   │                     │
  │  (human answers)         │                        │                   │                     │
  ├─ retry + inputResponses ─►  apply decision A ──────────────────────────────────────────────►│ approval A APPROVED, activity 3 APPROVED
  │                          ├─ run ─────────────────► V8 #2              │                     │
  │                          │              GET #1 ───┼── replay ◄─────────────────────────────┤ (no call)
  │                          │              GET #2 ───┼── replay ◄─────────────────────────────┤ (no call)
  │                          │              POST #3 ──┼── APPROVED → call ──► resp ────────────►│ activity 3 COMPLETED
  │                          │              POST #4 ──┼── governance ALLOW ──► call ──► resp ──►│ activity 4 COMPLETED
  │◄─ result + _meta ────────│                        │                   │                     │ execution COMPLETED
```

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| API answered with a status below 500 | activity `COMPLETED` with that status — replayable; the program sees `{ ok, status, data }`, `ok: false` for a 4xx |
| 5xx or transport error (timeout, socket) on `POST` / `PATCH` | sent once, never retried — it may already have taken effect; activity `FAILED`, `outcomeKnown: false`; a later run stops at it with `ACTIVITY_OUTCOME_UNKNOWN` |
| 5xx or transport error on `GET` / `PUT` / `DELETE` | retried inside the activity up to the service's `maxRetries` (backoff 500·2ⁿ ms + jitter); still failing ⇒ `FAILED`, `outcomeKnown: false`, as above |
| A failed call the program does not catch | `SANDBOX_RUNTIME` (not retryable) ⇒ execution `FAILED`. `SANDBOX_TIMEOUT` is only the run's own time limit, whatever a backend's error message says |
| Process died mid-call | activity left `EXECUTING`; on resume `GET` re-executes, anything else fails closed |
| Calls still in flight when the program returned | finished within the run's time budget, else aborted and journaled `FAILED` (outcome unknown), before the run's outcome is recorded (§4) |
| Circuit open / other retryable error | execution `INTERRUPTED` (resumable via `_meta["harbor/execution-id"]`); no activity recorded for the unmade call |
| Governance evaluation error | `DENY` with `GOVERNANCE_EVALUATION_FAILED` |
| Malformed answer (`accept` whose `approve` is missing or neither a boolean nor a listed word, §7) | `INVALID_API_REQUEST` (HTTP 400); the approval stays pending |
| Approval decided twice | second decision refused (`APPROVAL_ALREADY_DECIDED`); an MRTR retry repeating the recorded decision resumes, a conflicting one runs nothing (§7) |
| Answer for an approval the execution no longer waits on | `EXECUTION_NOT_RESUMABLE`; nothing is written (§7) |
| Concurrent approval decisions | decisions serialize on the execution lock; a contender gets `EXECUTION_LOCKED` (HTTP 409) without changing state, then can retry and observe `APPROVAL_ALREADY_DECIDED` |
| Resume before the approval is decided | the pause is returned again with the same approval id and `_meta["harbor/execution-status"] = WAITING_APPROVAL`; nothing runs, the execution is untouched |
| Store write failure before a call | the call is refused to the program and never sent: nothing is executed without its journal entry |
| Store write failure after the outcome was decided (an activity's `FAILED`, a run's end) | the outcome stands and reaches the client unchanged; the failed write is reported (`event: persistence_failure`, `execution_persistence_failures_total`) and recovered by the next run (§12 *Persistence guarantees*) |
| The program completed but settlement threw | Read back the execution: confirmed `COMPLETED` returns its recorded result, even if only the acknowledgement or lock release failed. Otherwise `RUN_OUTCOME_NOT_RECORDED` (retryable) reports the observed status, or omits it if unreadable. Inspect persistence and the lock before resuming with `_meta["harbor/execution-id"]`; completed calls replay without being sent again. Never mark completed work `FAILED` or submit a fresh execution to repeat it |
| A decision cut short between its writes | completed by the next decide or resume (§12 *Persistence guarantees*) |
| Replay mismatch | `REPLAY_DIVERGED`, execution `FAILED` (§4) |
| Two resumes at once | second gets `EXECUTION_LOCKED` (retryable) |

Only methods whose repetition is harmless (RFC 9110 §9.2.2) are retried, and
those retries are invisible to the journal. The circuit breaker counts one
failure per logical call however many attempts it took, under the key the
bridge checks — the OpenAPI template in a governed run — and in `HALF_OPEN`
lets one probe through at a time.

## 11. Inspection

`GET /executions/{id}` returns `{ execution, activities, approvals,
decisions, history }`. `POST /executions/{id}/approvals/{approvalId}` with
`{ "action": "accept" | "decline" | "cancel", "approve"?: boolean | word,
"comment"?: string }` (the words are listed in §7) decides an approval — the fallback for clients without
elicitation (§7) — and returns `{ approval, outcome, executionStatus }`
(`src/runtime/http/execution-routes.ts`).

The bearer is validated through that execution's service auth strategy, and
the authenticated principal must match the execution owner for both
inspection and HTTP approval decisions — a syntactically valid bearer alone
is not sufficient. The route authorizes on the execution before it looks at
the approval. A decision also names the execution it targets
(`ApprovalDecisionInput.executionId`), and `ApprovalService.decide` refuses —
as `APPROVAL_NOT_FOUND`, before taking the lock — any approval that does not
belong to it. The decision mutates the approval's *own* execution, so without
that assertion a caller authorized against one execution could decide an
approval belonging to another; checking it at the mutation point covers both
the HTTP and the MCP door.

| Status | When |
|---|---|
| `200` | the inspection, or the decision applied |
| `400 INVALID_API_REQUEST` | body not a JSON object, `action` not one of the three, or `accept` whose `approve` is missing or not a recognised answer (the approval stays pending) |
| `400 EXECUTION_NOT_RESUMABLE` | the execution has finished, or its activity no longer waits on this approval (§7) |
| `401` | bearer missing or malformed (with `WWW-Authenticate` when `HARBOR_RESOURCE_URI` is set), or rejected by the service's auth strategy |
| `403 AUTH_FAILED` | the bearer belongs to a different principal than the execution's owner |
| `404 EXECUTION_NOT_FOUND` / `APPROVAL_NOT_FOUND` | unknown (or swept) execution; unknown approval, or one that belongs to another execution — answered alike, so the reply does not confirm it exists |
| `405` | any other method |
| `409 APPROVAL_ALREADY_DECIDED` / `EXECUTION_LOCKED` | the approval was decided already; a run or another decision holds the execution lock (retry) |
| `413 PAYLOAD_TOO_LARGE` | the body exceeds 64 KiB |
| `503` | the service's auth backend is unavailable (retry) |

For a terminal execution, `execution` comes back without `originalCode` under
the default `DROP`; once the retention sweep has deleted it the route answers
`404 EXECUTION_NOT_FOUND`. `history` is derived from the records, e.g.

```
EXECUTION:CREATED
ACTIVITY:ENCOUNTERED#1  ACTIVITY:COMPLETED#1 (HTTP 200)
GOVERNANCE:REQUIRE_APPROVAL#3 (RULE_MATCHED … [activate-campaign])
ACTIVITY:ENCOUNTERED#3  APPROVAL:REQUESTED#3
EXECUTION:WAITING_APPROVAL
APPROVAL:APPROVED#3 (mcp-elicitation)
ACTIVITY:COMPLETED#3
…
EXECUTION:COMPLETED
```

**Audit trail.** Every persisted state change of an execution — the end of
each run (paused, interrupted, terminal) and each human decision — is
published to the audit sinks (`AUDIT_SINKS`, default `console`) as a
`{ kind: 'execution', state }` event, which the console sink logs as
`execution-state`: statuses, activities with HTTP status, approvals and
governance decisions with rule versions. Request and response bodies and the
program are never included. The per-call `audit` line of a resumed run
carries the program that ran (the persisted one, not the code the resume
sent), and a resume that was refused, or that the answer itself ended
(decline, cancel), is audited with its execution id and outcome.
`ENABLE_AUDIT=false` turns both off. Destinations beyond the console
implement `AuditSink` (`src/spi/observability/audit-sink.ts`) and register
with `registerAuditSinkBackend` (`src/wiring/strategy-builders.ts`).

## 12. Storage

`EXECUTION_STORE_TYPE=in-memory` (default) keeps executions in the process;
`file` writes one JSON document per execution under `EXECUTION_STORE_DIR`
(temp file + rename) and reloads them at boot, so a single gateway survives a
restart. Both are bound to one pod.

`memcache` shares executions across pods
(`src/adapters/execution/memcache-execution-store.ts`): the execution, every
activity, the approvals and the decisions live in memcache — read there on
every access, never cached in a pod — and the run lock is an atomic `add` with
a TTL, held across pods. A run paused on one pod can be approved and resumed
on another (set the same `GOVERNANCE_REQUEST_STATE_KEY` on every pod).
Connection settings follow the token cache (`EXECUTION_STORE_MEMCACHE_HOST`,
`_PORT`, `_TIMEOUT_MS`); `_KEY_PREFIX` namespaces the keys and `_LOCK_TTL_SEC`
(default 300) is how long a crashed pod's lock survives — it must exceed the
longest run. Retention uses item TTLs.

All stores implement the same SPI (`src/spi/execution/execution-store.ts`)
and pass the contract suite in `tests/unit/execution-store.test.ts`. Register
another backend (e.g. Redis) with `registerExecutionStoreBackend('redis',
factory)` from `src/wiring/strategy-builders.ts` and select it with
`EXECUTION_STORE_TYPE=redis`: any kebab-case name passes config validation,
and a name nothing registered stops the gateway at boot.

**Retention.** A finished (terminal) execution and everything recorded for it
— activities, approvals, decisions — is deleted `EXECUTION_RETENTION_SEC`
after it finished (default one day; `0` keeps it for good). The sweep
(`src/runtime/execution/execution-retention.ts`) runs every min(retention, 1 h) and
uses the SPI's `listExpiredExecutions` / `deleteExecution`. Paused and
interrupted executions are never deleted. Independently, the program text of
a terminal execution is dropped at once unless `EXECUTION_CODE_RETENTION=KEEP`.

### Persistence guarantees

The run lock serialises runs and decisions on one execution; it does not make
a sequence of writes atomic. No store here offers a transaction across
records, so the guarantee Harbor gives is narrower and holds on every
backend: **each single write is atomic, every multi-write operation has a
commit point, and whatever a crash or a store outage leaves after the commit
point is completed by the next run or decision — or, before it, leaves
nothing that decides anything.**

What a single write means per adapter:

| Store | One write | A crash or an outage | Locks |
|---|---|---|---|
| `in-memory` | a map update; cannot fail on its own | the process takes the whole store with it: nothing partial survives because nothing survives | in-process; die with the process |
| `file` | the execution's whole document, rewritten through a temp file + rename — atomic, never torn | the document keeps the last completed write. No `fsync`: a power loss can lose the most recent writes. A write that fails on disk (full, unwritable) has already changed the copy in memory, so the process keeps running on state that a restart would not see | in-process |
| `memcache` | one item per record (`set` is atomic per key); index keys are separate writes | an outage or a crash between two writes leaves the earlier ones; items without a TTL can still be evicted under memory pressure — size memcache for what you keep, and treat the audit trail as the durable record | `add` with a TTL; a crashed pod's lock expires after `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC` |
| registered backend | must make each record write atomic — the recovery below assumes nothing more | | must be held across processes, with an expiry |

What a cut leaves, per operation, and how it recovers (tests:
`tests/integration/decision-crash-consistency.test.ts`,
`tests/integration/persistence-failures.test.ts`):

| Operation | Writes, in order (commit point **bold**) | Cut after | Left | Recovery |
|---|---|---|---|---|
| A human decision (`ApprovalService.decide`) | **approval decided** → activity → execution (reject / cancel only) | nothing | nothing changed | decide again |
| | | the approval | approval decided, activity still `WAITING_APPROVAL` | the next decide (refused as already decided) or the next resume completes it first (`completeDecisions`): the approved call runs once, a rejection or cancellation ends the execution. Before this, every resume paused on the old question and every answer was refused — the execution was stuck |
| | | the activity | execution still `WAITING_APPROVAL` | as above; a resume would also stop at the `DENIED` / `CANCELLED` activity |
| A call (bridge) | **activity `EXECUTING`** → the call → `COMPLETED` or `FAILED` | `EXECUTING` | the call may or may not have reached the backend | the next run sends a `GET` again and stops on anything else (`ACTIVITY_OUTCOME_UNKNOWN`) — never a silent repeat. A failed `FAILED` write is reported (below) and leaves exactly this |
| Ending a run (`endRun`) | **execution status** → lock release attempted in `finally` | before or after the status write, or at lock release | the previous status or the new status; the lock may remain held if release fails | read back the status, never infer it from a rejected write. Confirmed `COMPLETED` returns the persisted result. Otherwise a completed program gets `RUN_OUTCOME_NOT_RECORDED` with the observed status (omitted if unreadable); stopped runs preserve their primary error but also report the observed status. Restore persistence and inspect any retained lock before resuming; the journal replays completed calls without sending them again |
| Starting a run (`beginRun`) | lock → **execution `RUNNING`** | the lock | lock held, record unchanged | the lock is released when the write fails; after a crash it dies with the process (or expires, memcache) |
| A new activity's decision (gate) | decision record → approval → **activity `WAITING_APPROVAL` / `DENIED`** | before the activity | a decision record, perhaps a `PENDING` approval nothing waits on | the call is refused to the program and never sent; an orphan approval cannot be decided once its execution is finished (`ApprovalStaleError`) |

**Secondary failures are reported, not swallowed.** When a write that records
an outcome already decided fails — an activity's `FAILED`, a run's end — the
outcome stands (the client gets it unchanged) and the failed write is
reported once: an error log line with `event: "persistence_failure"`,
`operation` (`activity.recordFailure`, `execution.endRun`), the execution and
activity, what the write `intended`, what the store was `left` holding and
the `recovery` above; and `execution_persistence_failures_total{operation}`
(`src/runtime/execution/persistence-failure.ts`). Alert on the metric: every
count needs investigation, not necessarily a resume: the result may already
be recorded. A failed read-back emits a separate diagnostic with `left:
"unknown"`; Harbor does not claim that the write was unapplied or the lock
was released. A file store read-back reflects its current in-memory state,
not a new guarantee that a failed disk write survived a restart.

## 13. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXECUTION_STORE_TYPE` | `in-memory` | `in-memory` \| `file` \| `memcache` (shared across pods) \| the name of a registered backend |
| `EXECUTION_STORE_DIR` | `./var/executions` | file store directory |
| `EXECUTION_STORE_MEMCACHE_HOST` / `_PORT` | — | memcache store connection (required with it); `_TIMEOUT_MS` default `2000` |
| `EXECUTION_STORE_MEMCACHE_KEY_PREFIX` | `harbor:exec:` | key namespace |
| `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC` | `300` | how long a crashed pod's run lock survives; must exceed the longest run |
| `EXECUTION_CODE_RETENTION` | `DROP` | `DROP`: a terminal execution's program text is removed · `KEEP`: stored against the `executionId` |
| `EXECUTION_RETENTION_SEC` | `86400` | seconds a finished execution and its records are kept before deletion; `0` = keep forever |
| `GOVERNANCE_DEFAULT_DECISION` | `DENY` | a call some rule targets but none matches; calls no rule targets are allowed (`NO_GOVERNANCE`) whatever this says |
| `GOVERNANCE_REQUEST_STATE_KEY` | *(random per process)* | ≥32-char HMAC key; required for multi-instance deployments |
| `GOVERNANCE_APPROVAL_TTL_SEC` | `600` | how long a paused execution's `requestState` stays redeemable (the approval itself does not expire, §14) |
| `ENABLE_AUDIT` | `true` | `true`/`1` or `false`/`0` (anything else stops boot); off drops both the per-call audit line and the execution-state events |
| `AUDIT_SINKS` | `console` | comma list of `console` and registered sink types; empty while audit is on stops boot |
| `HARBOR_SERVER_ID` | `HARBOR_GATEWAY` | `X-Harbor-Server-ID` on every backend call (printable ASCII, ≤128 characters) |
| `MCP_MAX_BODY_BYTES` | `4194304` (4 MiB) | largest `/mcp` request body; over it ⇒ `413 PAYLOAD_TOO_LARGE`. `/executions` bodies have a fixed 64 KiB cap |

Each service's `config.json` independently selects its governance source and
refresh schedule; see [Configuration](configuration.md)
and the rule authoring [reference](../governance/rules/README.md).

## 14. Known limitations and open decisions

What is true of the code today. Items marked **Decision** wait on an owner's
call rather than a fix.

**Governance coverage**

- **Decision:** a call no rule targets is allowed (`NO_GOVERNANCE`) even with
  `GOVERNANCE_DEFAULT_DECISION=DENY` — the default applies only to calls some
  rule targets. A path the spec does not have has no `operationId`, so only a
  gateway-owned broad rule, a service-owned broad rule for that service, or a
  `path` rule naming its `{id}`-collapsed form reaches it. Should unresolved
  operations fail closed? Until decided, a deployment that must fail closed
  adds a catch-all in the gateway rule directory (§6).
- Rule targets are not checked against the specs. A typo in `service`,
  `operation` or `path` loads fine and targets nothing; a spec refresh that
  renames an `operationId` or drops a path silently un-governs the rules
  written for it.
- **Decision:** `final` pins the decision to the broadest level holding a
  matched `final` rule, whatever its action — a gateway `final` ALLOW beats a
  service `final` DENY.
- `not_equals` and `not_in` do not hold on a missing field (only `exists:
  false` does), so a DENY rule written with them does not fire when the field
  is absent; pair it with `exists: false` under `anyOf`. There are no
  case-insensitive or "any element of an array" operators, and numeric
  strings in the body compare strictly (only `query.*` reads them as
  numbers).
- Rules see no principal: `GovernanceRequest`
  (`src/runtime/governance/rule-evaluator.ts`) carries the service, operation
  and request values, not who is calling.
- A decision is made once per activity. A rule change between an approval and
  the resume is not re-applied to the approved activity (later activities see
  the rules in force). A stored approval never expires — only the
  `requestState` carrying it does (`GOVERNANCE_APPROVAL_TTL_SEC`), and a
  resume via `_meta["harbor/execution-id"]` is asked the same question again.
- Harbor ships an active gateway-owned `final` rule that denies every
  `DELETE`. The demo order service ships a service-owned INR threshold policy.
  Top-level files under
  `GATEWAY_GOVERNANCE_RULES_DIR` are loaded once as the shared gateway policy;
  each enabled service also loads its configured service-owned source. The
  gateway source is file-only and a missing/unreadable gateway directory fails
  startup. A missing default service-local directory leaves that service with
  no rules and logs a warning.

**Approvals and identity**

- The approver is the requester. `/executions` decisions require the
  execution's owner, so the HTTP fallback is self-approval; there is no
  approver role or requester/approver separation.
- `requestState` binds the principal hash (`userIdHash`, sealed in the
  payload) and the JSON-RPC method (via the codec). The principal is the
  bearer itself when the auth strategy maps no `userId`, and the user — not
  the specific bearer — when it does.
- `userIdHash` is the SHA-256 of `metadata.userId` when the auth strategy maps
  a non-empty string or finite number, otherwise of the raw inbound bearer —
  never the middleware's `access_token`, which the background/sync refresh
  rotates behind the caller. Without a mapped `userId`, two bearers for the
  same human are two principals, so an execution paused under one bearer is
  not resumable under the other.
- Every audit line names the principal that authenticated for that tool
  call — on the success, error, approval-pause and refused-resume paths
  alike. For a resume refused because the execution belongs to someone else
  that is the caller who tried, not the owner. It reads `"unknown"` only when
  the call failed before authentication finished.

**Execution and replay**

- Approval, activity, and execution updates are separate store writes, not a
  cross-record transaction (§12 *Persistence guarantees*). A decision cut
  short is completed by the next decide or resume; an execution nobody
  touches again keeps the partial records until then (retention does not
  sweep a `WAITING_APPROVAL` execution).
- The `file` store does not `fsync`, and a write that fails on disk has
  already changed the in-memory copy the process keeps running on.
- A `COMPLETED` activity replays even when the program now sends another
  query or body at that sequence (§4): nothing executes, but the program sees
  the response to the request originally sent.
- Calls started together are numbered in arrival order (§4). If siblings
  with the same template arrive in a different order on resume — chains
  racing on their responses, or approval-gated siblings — the content check
  stops the run with `REPLAY_DIVERGED` (fail closed) rather than executing the
  wrong one or handing one sibling another's response; the program has to be
  submitted again as a new execution. The same check stops a concurrently
  admitted call whose body carries the time (`Date.now()`), since its body
  differs on every run — the case the open deterministic-replay decision
  (seeded `Math.random()`, a clock anchored to recorded times) would remove.
- Programs that depend on time or randomness before an external call are not
  made deterministic.
- There is no API to cancel an execution: `CANCELLED` comes only from a
  `cancel` answer to an approval, and MCP request cancellation does not abort
  a running sandbox.
- Neither a backend response (held in host memory and journaled — a memcache
  item is capped at 1 MB by default) nor a request body a program sends has a
  size cap.
- Idempotency strategies cache non-2xx responses, 401 included, for their
  TTL. Keys are per execution and call, so this reaches only a repeat of the
  same call.

**Stores and retention**

- With the `in-memory` and `file` stores the run lock is process-local and a
  paused execution resumes only on its own pod; across pods use
  `EXECUTION_STORE_TYPE=memcache` with one `GOVERNANCE_REQUEST_STATE_KEY`.
- On memcache, items without a TTL (live executions, and finished ones when
  `EXECUTION_RETENTION_SEC=0`) can be evicted under memory pressure — size it
  for what you keep; the audit trail is the durable record. The run lock must
  outlive the longest run (`EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC`); its owner
  is the process, not the run, and releasing it is a non-atomic
  get-then-delete.
- The file store does not fsync, and skips a document it cannot read at boot.
- Retention deletes only finished executions. A paused or interrupted
  execution nobody resumes or cancels stays in the store.
- `EXECUTION_CODE_RETENTION` governs the execution store. The per-call audit
  line still carries the program that ran (`codeSubmitted`) to the log
  pipeline while `ENABLE_AUDIT` is on.

## 15. Invariants (from the requirements) and where they hold

| # | Invariant | Enforced by |
|---|---|---|
| 1 | one program = one `executionId` | `ExecutionManager.create` |
| 2 | stored original code is authoritative | tool ignores incoming code on resume |
| 3 | V8 can be destroyed wherever execution is suspended | pause = bridge refusal + isolate disposal; state is in the store |
| 4 | restarting V8 never repeats completed calls | replay of `COMPLETED` activities |
| 5 | every external call has exactly one sequence | `ActivityJournal.next` |
| 6 | approval binds to one activity | `ApprovalRecord.activitySequence`; and to one execution — `decide` asserts `input.executionId` |
| 7 | multiple approval rounds | repeated `input_required` |
| 8 | governance before side effect | bridge order: decide → execute |
| 9 | V8 cannot bypass governance | every call crosses `__makeRequest`; no network in the isolate |
| 10 | completed POSTs never replay against the service | replay returns the stored response |
| 11 | transport stateless | no session; per-request `McpServer` |
| 12 | durability in the store | `ExecutionPersistence` |
| 13 | Skills and Governance Rules remain distinct | same service ownership, but separate directories, formats, audiences, and evaluation paths |
| 14 | decisions deterministic, no LLM | pure evaluator; no model dependency |
