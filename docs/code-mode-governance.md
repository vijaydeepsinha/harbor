# Code Mode Governance Layer

Durable executions, an external-call journal with replay, declarative
Governance Rules, and human approval over MCP — for the JavaScript programs
agents run through `api_execute`.

> **The V8 isolate is ephemeral. The execution is durable.**

Requirements: [`docs/poc/requirements-aug28.md`](poc/requirements-aug28.md).
Design decisions and the gap analysis: [`docs/poc/implementation-plan.md`](poc/implementation-plan.md).

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
               ├──► INTERRUPTED   (retryable failure: circuit open, timeout, transport) ──► RUNNING …
               ├──► DENIED        (a Governance Rule said DENY)
               └──► FAILED        (replay diverged, unknown outcome, non-retryable error)
```

| Fact | Where |
|---|---|
| One logical program = one `executionId` (UUID minted by Harbor) | `runtime/execution/execution-manager.ts` |
| The code first submitted is persisted and is authoritative for every resume; replacement code is ignored (logged) | `ExecutionRecord.originalCode` |
| Every run takes a per-execution lock; a concurrent run gets `EXECUTION_LOCKED` (retryable). A `RUNNING` record whose lock is free is a crashed run and may resume | `ExecutionManager.beginRun` |
| Terminal states are not resumable (`EXECUTION_NOT_RESUMABLE`) | same |
| A resume that arrives while the approval is still undecided is not a failure: the run does not start, the execution stays `WAITING_APPROVAL`, and the caller gets the pause again (`ApprovalPendingError` → `input_required`, or `APPROVAL_REQUIRED` for clients without elicitation) | same, and `tools/execute-api.tool.ts` |

## 3. Activity journal

Every `api.request()` that reaches the host bridge becomes activity `#N`,
numbered in **arrival order** within the execution — never by variable name,
never by hashing code (`runtime/execution/activity-journal.ts`). Each record
holds the request (`method`, raw path, resolved OpenAPI path template,
`operationId`, path params, query, body — never headers) and, once the call
returns, the response (`status`, `ok`, `data`).

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
| `FAILED` | the transport threw; `failure.outcomeKnown: false` — Harbor does not know whether the API executed |
| `WAITING_APPROVAL` / `APPROVED` / `DENIED` / `CANCELLED` | governance and human-decision states |

## 4. Replay

On every run the program starts from the top. At activity `#N` the bridge
(`runtime/sandbox/bridge-request-handler.ts`) asks the activity gate
(`runtime/execution/activity-gate.ts`), which looks the sequence up:

| Journaled record at `#N` | Bridge action |
|---|---|
| none | evaluate Governance Rules (see §6) |
| `COMPLETED` | return the stored response — **no external call** |
| `APPROVED` | execute now, record `COMPLETED` |
| `WAITING_APPROVAL` | pause again |
| `DENIED` / `CANCELLED` | stop |
| `FAILED`, or `EXECUTING` with a non-`GET` method | stop with `ACTIVITY_OUTCOME_UNKNOWN` — never silently repeat |
| `EXECUTING` with `GET` | re-execute (safe method) |

**Divergence.** If the call at `#N` has a different method or resolved path
than the record, the run stops with `REPLAY_DIVERGED` and the execution is
`FAILED`; nothing is executed under the old history.

**Deterministic replay contract.** Given the same persisted program and the
same recorded responses, replay reproduces the same external-call sequence.
Harbor controls what the program observes from the outside world; it does not
control `Date.now()`, `Math.random()` or similar inside the program. A program
that branches on those before an external call can diverge — the divergence
check then stops it.

**Stopped runs stay stopped.** Once a run has paused or stopped, any further
`api.request()` in that isolate — even inside a `try/catch` — is refused
without executing, and the control-plane signal is re-raised after the
isolate settles so user code cannot mask it.

## 5. Governance decision point

```
V8 api.request() → bridge → resolve OpenAPI operation → evaluate rules → ALLOW | DENY | REQUIRE_APPROVAL
                                                                          │       │            │
                                                                       execute  stop      pause (approval)
```

Governance always runs **before** the external call, never after. The
evaluator (`runtime/governance/rule-evaluator.ts`) is a pure function of the
rule set and the request — no I/O, no clock, no model.

## 6. Governance Rules

Rules live in `governance/rules/*.yaml|yml|json` (`GOVERNANCE_RULES_DIR`);
format and operators in [`governance/rules/README.md`](../governance/rules/README.md).

- **Targeting** uses the service's own OpenAPI document: a call to
  `POST /campaigns/C1/activate` resolves to `operationId: activateCampaign`,
  path template `/campaigns/{id}/activate`, `pathParams.id = "C1"`
  (`runtime/governance/operation-resolver.ts`). Rules match on `service`,
  `operation`, `method`, `path` (template) — `*` matches anything.
- **Conditions** read actual request values: bare names from the body,
  `query.*`, `path.*`, `body.a.b`. A condition on a missing field holds only
  for `exists: false`; comparisons across types are false.
- **Precedence** among matched rules: `DENY > REQUIRE_APPROVAL > ALLOW`; the
  first rule (file order) carrying the winning action is the deciding rule.
  No match ⇒ `GOVERNANCE_DEFAULT_DECISION` (default `ALLOW`, which preserves
  pre-governance behaviour when no rules exist).
- **Fail closed**: an evaluation error is a `DENY`; an invalid rule file stops
  the gateway at boot; a duplicate rule name is an error.
- **Every decision is persisted** per activity: decision, reason, matched
  rules, `name@version#contentHash12` for each, the deciding rule, timestamp.

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
   (execution `DENIED`); `cancel` → `CANCELLED`.

An approval is bound to **one activity**. If a later activity needs approval,
the run pauses again with a new elicitation and a new `requestState` —
**multiple approval rounds** are simply repeated `input_required` results.

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
| API returned an explicit status (4xx/5xx) | activity `COMPLETED` with that status; the program sees `{ ok: false, status }` as before |
| Transport threw (timeout, socket) | activity `FAILED`, `outcomeKnown: false`; never replayed or retried silently; a later run stops with `ACTIVITY_OUTCOME_UNKNOWN` |
| Process died mid-call | activity left `EXECUTING`; on resume `GET` re-executes, anything else fails closed |
| Circuit open / other retryable error | execution `INTERRUPTED` (resumable via `_meta["harbor/execution-id"]`); no activity recorded for the unmade call |
| Governance evaluation error | `DENY` with `GOVERNANCE_EVALUATION_FAILED` |
| Approval decided twice | second decision refused (`APPROVAL_ALREADY_DECIDED`); a duplicate MRTR retry after the decision simply resumes |
| Resume before the approval is decided | the pause is returned again with the same approval id and `_meta["harbor/execution-status"] = WAITING_APPROVAL`; nothing runs, the execution is untouched |
| Store write failure | the tool call fails; nothing is executed without its journal entry |
| Replay mismatch | `REPLAY_DIVERGED`, execution `FAILED` |
| Two resumes at once | second gets `EXECUTION_LOCKED` (retryable) |

Note: `ApiClient` retries 5xx responses up to `maxRetries` (pre-existing
behaviour); those retries happen inside one activity and are opaque to the
journal.

## 11. Inspection

`GET /executions/{id}` (bearer) returns `{ execution, activities, approvals,
decisions, history }`. `history` is derived from the records, e.g.

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

## 12. Storage

`EXECUTION_STORE_TYPE=in-memory` (default) keeps executions for the life of
the process; `file` writes one JSON document per execution under
`EXECUTION_STORE_DIR` (temp file + rename) and reloads them at boot, so a
single gateway survives a restart. Both implement the same SPI
(`spi/execution/execution-store.ts`); register another backend with
`registerExecutionStoreBackend('postgres', factory)` in `wiring/strategy-builders.ts`.

## 13. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXECUTION_STORE_TYPE` | `in-memory` | `in-memory` \| `file` |
| `EXECUTION_STORE_DIR` | `./var/executions` | file store directory |
| `GOVERNANCE_RULES_DIR` | `./governance/rules` | rule files (top level only) |
| `GOVERNANCE_DEFAULT_DECISION` | `ALLOW` | when no rule matches |
| `GOVERNANCE_REQUEST_STATE_KEY` | *(random per process)* | ≥32-char HMAC key; required for multi-instance deployments |
| `GOVERNANCE_APPROVAL_TTL_SEC` | `600` | how long a paused execution's `requestState` stays redeemable |

## 14. Known limitations (POC)

- The run lock is process-local; the file store persists records, not locks.
  Multi-instance deployments need a shared store with a real lock.
- `requestState` binds the principal via `userIdHash` inside the sealed
  payload and the JSON-RPC method via the codec; it is not bound to the
  transport bearer itself.
- `/executions` accepts any bearer the gateway would accept on `/mcp`; there
  is no approver role model yet.
- The approver is the connected client's user (elicitation) or whoever can
  reach the HTTP endpoint — separation of requester and approver is policy
  for a later iteration.
- Replay compares method + resolved path, not bodies (by design, §29); a
  program that changes a body between runs is not detected.
- Error-path audit lines keep the pre-existing `userIdHash: "unknown"`.
- Programs that depend on time or randomness before an external call are not
  made deterministic.

## 15. Invariants (from the requirements) and where they hold

| # | Invariant | Enforced by |
|---|---|---|
| 1 | one program = one `executionId` | `ExecutionManager.create` |
| 2 | stored original code is authoritative | tool ignores incoming code on resume |
| 3 | V8 can be destroyed wherever execution is suspended | pause = bridge refusal + isolate disposal; state is in the store |
| 4 | restarting V8 never repeats completed calls | replay of `COMPLETED` activities |
| 5 | every external call has exactly one sequence | `ActivityJournal.next` |
| 6 | approval binds to one activity | `ApprovalRecord.activitySequence` |
| 7 | multiple approval rounds | repeated `input_required` |
| 8 | governance before side effect | bridge order: decide → execute |
| 9 | V8 cannot bypass governance | every call crosses `__makeRequest`; no network in the isolate |
| 10 | completed POSTs never replay against the service | replay returns the stored response |
| 11 | transport stateless | no session; per-request `McpServer` |
| 12 | durability in the store | `CodeModeStore` |
| 13 | Skills ≠ Governance Rules | separate directories, code, vocabulary |
| 14 | decisions deterministic, no LLM | pure evaluator; no model dependency |
