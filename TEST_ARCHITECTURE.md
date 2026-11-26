# MCP Governance — Test Architecture

This document records what the repository analysis found (Phase 1 of the
governance test-harness build) and the test architecture derived from it.
Everything below was first read from the code on branch
`poc/aug28-governance-automation` (2026-09-21; merged in PR #5) and brought up
to date with main on 2026-09-27 (commit `035a261`, after the review fixes);
nothing is assumed.

Requirements source of truth: [`docs/poc/requirements-aug28.md`](docs/poc/requirements-aug28.md)
(the requirements document the harness was built against). Design record of what was built:
[`docs/code-mode-governance.md`](docs/code-mode-governance.md).
Requirement → test mapping: [`tests/REQUIREMENT_COVERAGE.md`](tests/REQUIREMENT_COVERAGE.md).
How to run: [`TESTING.md`](TESTING.md).
Implementation report: [`docs/governance-e2e-report.md`](docs/governance-e2e-report.md).

---

## 1. Architecture discovered

### 1.1 MCP layer

| Aspect | Finding | Where |
|---|---|---|
| Protocol revision | **2026-07-28 only**. `legacy: 'reject'` — a 2025-era client (or any request without the 2026-07-28 headers/envelope) is refused by the SDK before any Harbor code runs. | `src/runtime/http/http-gateway.ts`, `src/runtime/transport/stdio-gateway.ts` |
| SDK | `@modelcontextprotocol/server` **2.4.0** + `@modelcontextprotocol/node` **2.1.2** (GA). `createMcpHandler(factory, { legacy: 'reject' })` → `toNodeHandler`. | `package.json`, `http-gateway.ts` |
| Transport | Streamable HTTP, **stateless**. One `McpServer` instance per request; no `initialize` / `notifications/initialized`, no `Mcp-Session-Id`. The connection probe is `server/discover`. stdio is the second transport (same factory, `serveStdio`). | `mcp-server-factory.ts`, `docs/mcp-2026-07-28-compatibility.md` |
| Required request shape | `POST /mcp`, headers `Authorization: Bearer …`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, and `Mcp-Name: <tool>` for `tools/call`; JSON-RPC 2.0 body whose `params._meta` carries the envelope `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`. Header/body mismatch → JSON-RPC `-32020`. The gateway reads the body itself, bounded by `MCP_MAX_BODY_BYTES` (default 4 MiB): over the limit ⇒ HTTP 413 `PAYLOAD_TOO_LARGE`; `/executions` bodies are capped at 64 KiB with the same readable 413. | `tests/demo_e2e.py` (`_mcp_headers`, `_mcp_envelope`), SDK |
| Responses | JSON or `text/event-stream` (the SDK picks); every tool result carries `_meta` with `io.modelcontextprotocol/serverInfo` plus Harbor's application metadata. | `src/tools/tool-helpers.ts` |
| Tools | Exactly five, frozen: `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`. Input schemas fixed (`api_execute` = `{ service, code }`). | `src/tools/` |
| Server capabilities | `{ tools: {} }` only. Elicitation is a **client** capability read per request from the envelope. | `buildMcpServerOptions` |
| Authentication | Bearer required on `/mcp` and `/executions/*`. Format enforced at the transport: a JWT (`h.p.s`) or an opaque token of ≥ 32 base64url characters; otherwise **401** with a machine-readable `reason`; two `Authorization` headers ⇒ 401 `duplicate_authorization_header`. Per-service strategy then validates. The principal is `metadata.userId` when the strategy maps a string or finite number, otherwise `sha256` of the raw bearer. The E2E services use `static-token`, which forwards the client bearer unchanged to the backend and maps no `metadata.userId`, so distinct bearers ⇒ distinct principals. | `src/runtime/auth/bearer-authorization.ts`, `src/adapters/auth/strategies/static-token.strategy.ts`, `execute-api.tool.ts` |
| Authorization | No role model. `PermissionGuard` admits everything (`forwardTokenPermissionGuard`). Governance Rules are the only authorization layer over calls, and on main they see **no principal attributes** (see §6 gaps). `/executions/*` inspection and decisions are bound to the principal that owns the execution (anyone else ⇒ 403). | `src/spi/permissions`, `src/runtime/governance/rule-evaluator.ts`, `src/runtime/http/execution-routes.ts` |
| Error handling | Transport errors are JSON-RPC errors (`-32700`, `-32600`, `-32601`, `-32602`, `-32020`, `-32022`). Tool-level failures are `isError: true` results whose single text block is JSON `{ error, code, retryable, …extra }` with `code` from `src/core/constants.ts ERR`. | `tool-helpers.ts mcpError` |

### 1.2 Governance layer

| Aspect | Finding | Where |
|---|---|---|
| Decision point | Inside the host bridge, for every `api.request()` the isolate makes, **before** the outbound call. Order: canonicalise the path once (absolute URLs, dot segments, encoded slashes, backslashes, fragments and ambiguous queries ⇒ `INVALID_API_REQUEST`, nothing journaled) → resolve the OpenAPI operation → journal lookup (replay or divergence) → (new activity) evaluate rules → persist decision → `ALLOW` execute / `DENY` stop / `REQUIRE_APPROVAL` pause. Concurrent calls of one run (`Promise.all`) are admitted one at a time in arrival order; their external calls still overlap. Governance, the journal and the wire all use the canonical path. | `src/runtime/sandbox/request-path.ts`, `src/runtime/sandbox/bridge-request-handler.ts`, `src/runtime/execution/activity-gate.ts`, `makeBridge` in `src/tools/execute-api.tool.ts` |
| Policy representation | Gateway-owned policy is file-only: top-level files in `GATEWAY_GOVERNANCE_RULES_DIR` (default `governance/rules/`), with refresh via `GATEWAY_GOVERNANCE_RULES_REFRESH_SEC`. Each enabled service separately selects a YAML/JSON rule source in `config.json` (`governance.rulesSource`: `file` or `url`, `rulesDir`, `rulesUrl`; registered source names also work). Service URL sources are fetched at startup and on scheduled refresh. Refresh failures or invalid replacements keep the last valid rules. One rule = `name`, `version`, `match` (`service`, `operation`, `method` — one or a list — and `path` — a template, a `/x/**` subtree or `*`), optional `final`, `conditions` (a tree of `allOf` / `anyOf` / `not` over leaves), `action { type, reason }`. Validated with zod; invalid initial sources fail boot; duplicate names within one source are refused. Gateway and service rules are passed separately; same names are distinguished by owner-qualified audit identities. | `src/runtime/governance/rule-schema.ts`, `rule-loader.ts`, `src/spi/governance/rule-source.ts` |
| Rule matching | A rule *targets* a call when every present `match` clause fits it (`*` = any present value, so `operation: '*'` does not target a call without an operationId), and *matches* when its conditions also hold. `operation` is the OpenAPI `operationId`; `path` is the spec template (`/orders/{orderId}`). Ownership establishes the broad tier: gateway-source rules are always gateway-level; service-source rules are service-level unless operation/path-specific (endpoint-level). Leaves read actual request values: bare names = body fields, `body.a.b`, `query.x` (compared in wire form), `path.x`, or a computed operand (`ratio`, `percent_of`, `days_between`). A body passed as a JSON string is read as the object it encodes; only own properties are read. Operators: equals, not_equals, greater_than(_or_equal), less_than(_or_equal), in, not_in, exists, starts_with, contains. A missing field satisfies only `exists: false`; cross-type comparisons are false. | `rule-evaluator.ts` |
| Precedence / conflicts | One tier decides: endpoint > service > gateway, unless a matched `final` rule pins the broadest tier holding one. Within it **DENY > REQUIRE_APPROVAL > ALLOW**; deciding rule = first (file order) rule of that tier carrying the winning action. A rule targets the call but none matches ⇒ `GOVERNANCE_DEFAULT_DECISION` (default **`DENY`**; reason `NO_MATCHING_RULE`). No rule targets the call ⇒ ALLOW `NO_GOVERNANCE`, whatever the default. Evaluator exception ⇒ `DENY` (`GOVERNANCE_EVALUATION_FAILED`). | `src/core/constants.ts GOVERNANCE_PRECEDENCE`, `rule-evaluator.ts` |
| Attributes available to rules | service, operationId, method, spec path template, path params, query, body. **Not** available: user/principal, role, tenant, time. | `GovernanceRequest` |
| Audit | Every decision is persisted per activity (`decision`, `reason`, owner-qualified `matchedRules`, `ruleVersions` as `owner/name@version#hash12`, `decidingRule`, `evaluatedAt`). Approvals persist `status`, `decidedAt`, `decidedVia`, `comment`. `GET /executions/{id}` returns a derived chronological `history`. With `ENABLE_AUDIT` on (default; `false`/`0` turn it off) every tool call publishes an `audit` record, and every execution state change a `kind: 'execution'` event, to the sinks named in `AUDIT_SINKS` (default `console`). A resumed run is audited with the persisted program. | `execution.types.ts`, `execution-manager.ts buildHistory`, `src/runtime/observability/audit.ts`, `src/runtime/execution/governance-runtime.ts` |
| PII / redaction | Activity records never store headers (neither the bearer nor program-supplied headers are journaled). Approval summaries never carry credentials. No other redaction exists. | `toRequestRecord`, `ApprovalSummary` |
| Policy reload / versioning | Gateway-owned file rules load at boot and refresh via `GATEWAY_GOVERNANCE_RULES_REFRESH_SEC`; each service loads its own rules and with that service's `governance.rulesRefreshSec` > 0 its source is re-read on that interval. Changed sets swap atomically; failed reads, invalid sets, or empty replacements preserve each active last-known-good set. There is no reload endpoint. Version context = owner-qualified `ruleVersions` tags on decisions. | `src/runtime/governance/rule-refresher.ts`, `governance-runtime.ts` |

### 1.3 Execution layer

| Aspect | Finding | Where |
|---|---|---|
| Request → execution | `tools/call api_execute { service, code }` with no execution reference ⇒ `ExecutionManager.create` mints a UUIDv4 `executionId` and persists `originalCode`. A call carrying a verified `requestState` (MRTR retry) or `_meta["harbor/execution-id"]` (durable resume handle) ⇒ load + resume. They may accompany one another; the explicit id selects the execution and the verified state must name the same id before its answer is applied. | `openExecution` |
| "Workflow" representation | There is no DAG/workflow engine (a stated non-goal). A workflow **is** the agent's JavaScript program; each `api.request()` it makes is one **activity** numbered 1..N in arrival order. "Step k" in this harness = activity #k. | `src/runtime/execution/activity-journal.ts` |
| Lifecycle | `CREATED → RUNNING → COMPLETED \| WAITING_APPROVAL \| INTERRUPTED \| DENIED \| FAILED \| CANCELLED`. Activity states: `WAITING_APPROVAL, EXECUTING, APPROVED, COMPLETED, FAILED, DENIED, CANCELLED`. Approval states: `PENDING, APPROVED, REJECTED, CANCELLED`. | `src/core/constants.ts` |
| Persistence | `ExecutionPersistence` SPI; `in-memory` (default), `file` (one JSON document per execution, temp+rename, reloaded at boot) or `memcache` (shared across pods). Every mutation is written through **before** the next step proceeds (journal-before-call). | `src/spi/execution/execution-store.ts`, `src/adapters/execution/*` |
| Approval pause | Bridge records the activity `WAITING_APPROVAL`, records a **run-stopping violation** (the first one stands: a DENY is never replaced by a sibling's pause), refuses every further `api.request()` in that isolate, and returns a bridge error to user code. After the run's calls settle the violation is promoted to `ApprovalRequiredError`; an elicitation-capable client gets `resultType: "input_required"` with an `elicitation/create` form and HMAC-sealed `requestState`, while another client gets `APPROVAL_REQUIRED` and uses the HTTP decision channel. | `src/runtime/sandbox/bridge-request-handler.ts`, `approvalResult` in `src/tools/execute-api.tool.ts` |
| Run end | The run ends when its calls end: calls the program did not await get the rest of `executeTimeoutMs`, then are aborted and journaled `FAILED` (outcome unknown); a connector that ignores the abort is abandoned after 1 s. An un-awaited call that paused or was denied decides the run's outcome. | `bridge-request-handler.ts` (`drain`) |
| Isolate creation / destruction | `runInSandbox` creates a fresh `ivm.Isolate` per run and **always disposes it in `finally`**; the wall-clock timer disposes it on timeout and aborts in-flight HTTP via `AbortController`. Nothing is kept alive across an approval. | `src/runtime/sandbox/sandbox-core.ts` |
| Resume | The **stored** program runs again from the top in a new isolate (`runCount` increments; new activities carry `runIndex` = that run). Journaled `COMPLETED` activities are replayed from the store (no outbound call); the `APPROVED` activity executes; new activities go through governance. Incoming `code` on resume is ignored (logged). | `ActivityGate.admit` in `src/runtime/execution/activity-gate.ts` |
| Replay divergence | Every journaled record binds method, template and concrete canonical path; records that will execute or are in front of a human (`APPROVED`, `WAITING_APPROVAL`, `EXECUTING`) also bind query and body (key order ignored). A mismatch ⇒ `REPLAY_DIVERGED`, execution `FAILED`, nothing executed, the approved request left as it was. A `COMPLETED` record still replays when only the body drifted (a replay reads history). | `ActivityJournal.next` |
| Failure handling | 4xx ⇒ activity `COMPLETED` with that status (`ok:false`), replayable. 5xx or transport throw (timeout/socket/abort), after any retries ⇒ activity `FAILED`, `outcomeKnown:false`, **never replayed and never repeated**; a later run stops with `ACTIVITY_OUTCOME_UNKNOWN`. An `EXECUTING` record found on resume (process died mid-call) ⇒ `GET` re-executes, anything else fails closed. Circuit open ⇒ execution `INTERRUPTED` (resumable). | `bridge-request-handler.ts`, `activity-gate.ts`, docs §10 |
| Idempotency | `api_execute` calls are **not** deduplicated by request id or code hash: each fresh call is a new execution (by design — the execution id is the identity). Within an execution, replay guarantees a completed activity is never re-issued. The per-service `idempotency` strategy (default: `IDEMPOTENCY_TYPE`, itself `noop` by default) caches by the key forwarded as `X-Idempotency-Key`: `mcp-{service}-{executionId}-{sequence}` in governed runs (kept across a resume, never shared by two executions), `mcp-{service}-{userHash12}-{codeHash16}-c{n}` on the legacy path. | `execute-api.tool.ts`, `bridge-request-handler.ts`, `api-client.ts` |
| Retry | `ApiClient` retries only GET, PUT and DELETE on 5xx and transport errors, up to `api.maxRetries` with backoff, inside one activity. POST and PATCH are sent once: their outcome is unknown after a 5xx or timeout. The circuit breaker counts one failure per logical call under the OpenAPI template the bridge checks; HALF_OPEN admits one probe. | `api-client.ts`, `src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.ts` |
| Timeout / errors | Sandbox wall clock `SANDBOX_EXECUTE_TIMEOUT_MS` (per-service override) ⇒ `SANDBOX_TIMEOUT` (retryable, execution `INTERRUPTED`); outbound `api.requestTimeoutMs`. A governed non-GET call whose transport outcome is unknown ⇒ `ACTIVITY_OUTCOME_UNKNOWN` (not retryable, execution `FAILED`) even if user code caught the bridge error. An ordinary uncaught program error, or an uncaught error on a governed GET/legacy call, is `SANDBOX_RUNTIME`; `SANDBOX_MEMORY` only means the isolate ran out of heap. | config, `src/runtime/sandbox/sandbox-core.ts`, `bridge-request-handler.ts` |
| Cancellation | Only via the approval answer (`cancel` ⇒ execution `CANCELLED`). No API cancels a running execution. | `approval-service.ts` |
| Locking | Per-execution lock around every run and decision (in-process for `in-memory` and `file`; memcache `add` with a TTL, shared across pods); a concurrent run gets retryable `EXECUTION_LOCKED`. Terminal executions are `EXECUTION_NOT_RESUMABLE`; an execution whose approval is still `PENDING` gets the pause again, untouched. | `ExecutionManager.beginRun` |

### 1.4 Approval lifecycle (as implemented)

```
governance REQUIRE_APPROVAL at activity #N
   → ApprovalRecord{approvalId, executionId, activitySequence:N, PENDING}
   → activity #N WAITING_APPROVAL, execution WAITING_APPROVAL (pendingApprovalId)
   → client with elicitation:   result.resultType = "input_required",
                                inputRequests.approval = elicitation/create (form: approve:boolean, comment?:string),
                                requestState = HMAC-SHA256 sealed {executionId, approvalId, activitySequence, userIdHash}
                                bound to JSON-RPC method "tools/call", TTL GOVERNANCE_APPROVAL_TTL_SEC
     client without elicitation: isError result code APPROVAL_REQUIRED + ids in _meta + instructions
   → decision (exactly once):
        MRTR retry: same tools/call + requestState + inputResponses.approval {action: accept|decline|cancel, content:{approve, comment}}
        HTTP fallback: POST /executions/{id}/approvals/{approvalId} {action, approve?, comment?}  (owner only; other principals ⇒ 403)
        accept+approve:true → APPROVED (activity APPROVED; execution still WAITING_APPROVAL, resumable)
        accept+approve:false | decline → REJECTED (activity DENIED, execution DENIED)
        accept without a boolean approve → INVALID_API_REQUEST (HTTP 400); nothing changes, approval stays PENDING
        cancel → CANCELLED (activity CANCELLED, execution CANCELLED)
        second HTTP decision → APPROVAL_ALREADY_DECIDED (HTTP 409)
        MRTR answer after a decision: the same decision resumes; a conflicting one → APPROVAL_ALREADY_DECIDED
          while the execution can still run, EXECUTION_NOT_RESUMABLE once it has finished; nothing runs
        stale answer (an earlier activity's state) → not applied; the current pending approval is reissued
        a decision is refused (EXECUTION_NOT_RESUMABLE) when the execution is terminal or the activity is no longer
          WAITING_APPROVAL on this approval
   → resume: fresh isolate, replay 1..N-1, execute N, continue; a later REQUIRE_APPROVAL repeats the cycle with a new approvalId/requestState.
```

### 1.5 Downstream services

Services are folders `services/<name>/` with `config.json` (`api.{protocol,host,port,basePath,requestTimeoutMs,maxRetries}`, `auth`, `idempotency`, `sandbox` overrides) and an OpenAPI `spec.yaml`. Harbor calls `{protocol}://{host}:{port}{basePath}{path}` via axios (`allowAbsoluteUrls: false`, and the bridge refuses an absolute or protocol-relative path before governance, so a call never leaves the service's base URL) with headers `Authorization` (client bearer under `static-token`), `X-Correlation-ID` (the current MCP request id, shared by all calls in that sandbox run; approval resumes use a new request id), `X-Harbor-Server-ID` (the gateway stamp), `X-Harbor-Client-ID` (the inbound caller's id when supplied), `X-Harbor-Execution-ID` (the durable governed execution id across approval turns, omitted on legacy runs), `X-Request-Source`, `X-MCP-Tool`, `X-MCP-Service`, `X-MCP-Version`, and `X-Idempotency-Key` (the execution id plus activity sequence for governed runs). A program may add ordinary headers (`Accept`, `Content-Type`, its own `X-…`) but not, in any letter case, identity, Harbor-owned, hop-by-hop, forwarding or method-override headers (`Authorization`, `Cookie`, `Host`, `X-Forwarded-*`, `X-HTTP-Method-Override`, …): those are dropped and Harbor's own values are applied last. Query params and JSON bodies pass through. The isolate has **no** network: `fetch`, `require`, `process` do not exist inside it; `api.request` (bridged `__makeRequest`) is the only door.

### 1.6 Existing tests

| Layer | What exists | Notes |
|---|---|---|
| Unit (vitest) | evaluator/loader (`governance-rules.test.ts`), resolver, journal/store contracts, execution manager, approval service, request-state, execution routes, tool handler under governance (`execute-api.tool.codemode.test.ts`), sandbox | Call internal classes directly with fake connectors. |
| Integration (vitest) | `code-mode-replay.test.ts` (bridge + real isolate + counting connector), `code-mode-acceptance.test.ts` (§47 scenario through the tool handler with a fake `ServerContext`), `mcp-approval-wire.test.ts` (real SDK handler via `handler.fetch`, no HTTP listener, fake connector) | Governance path is real; **network, HTTP listener, service scanning, file store, container lifecycle and downstream HTTP are not exercised**. |
| Since then (2026-09-27) | 73 unit and integration files, 838 passed + 1 skipped. The review of main added `tests/unit/request-path.test.ts`, `tests/unit/api-client.test.ts` (real `ApiClient` against local listeners), `tests/unit/sandbox-core.test.ts`, `tests/unit/file-spec-loader.test.ts`, `tests/unit/filesystem-scanner.test.ts`, `tests/unit/server-factory.test.ts`, `tests/integration/run-lifecycle.test.ts` and `tests/integration/outbound-resilience.test.ts` (governed `api_execute` over the real `ApiClient` and a local listener: circuit breaker, idempotency keys). | Downstream HTTP is now also exercised below the E2E layer; the container lifecycle remains E2E-only. |
| E2E (Python) | `tests/demo_e2e.py` — boots demo backends + gateway as local processes and checks the five tools, auth strategies, INR order totals and the ₹5,000 approval boundary. | Demo smoke coverage; remains separate from the dedicated governance E2E suite. |

**Missing coverage the new suite adds:** the whole chain over a real listener and real downstream HTTP; approvals over the wire in both channels; multi-round approvals with intermediate state; isolate disposal/recreation observed from outside; file-store persistence across a real process restart; crash mid-call; requestState TTL expiry; the fail-closed default instance; boot refusal on invalid rules; malformed protocol input; concurrency; a Postman collection; CI.

---

## 2. Requirement identifiers used by the suite

Stable IDs so tests, the coverage matrix and CI reports can refer to requirements. Section numbers are from `docs/poc/requirements-aug28.md` (R§) and `docs/code-mode-governance.md` (D§).

| ID | Requirement | Source |
|---|---|---|
| RG-001 | One logical program ⇒ one durable `executionId`, returned in `_meta` | R§6, R§36, Inv.1 |
| RG-002 | Original code persisted and authoritative; replacement code on resume ignored | R§7, R§26, Inv.2 |
| RG-003 | Explicit execution lifecycle states | R§8 |
| RG-004 | Activity journal: monotonic sequence, request + response records, no headers | R§9–§13, Inv.5 |
| RG-005 | Replay: completed activities (GET and POST) never re-executed; stored response returned | R§14, Inv.4, Inv.10 |
| RG-006 | Multiple approval rounds in one program | R§15, Inv.7 |
| RG-007 | Governance evaluated before every external side effect; V8 cannot bypass it | R§16, R§28, Inv.8, Inv.9 |
| RG-008 | OpenAPI-aware targeting (operationId / path template / path params) | R§17–§18 |
| RG-009 | Conditions on actual request values (body, query, path) | R§19 |
| RG-010 | Declarative rules; deterministic evaluator; no LLM | R§20–§21, Inv.14 |
| RG-011 | Precedence DENY > REQUIRE_APPROVAL > ALLOW; explicit default when nothing matches | R§22, D§6 |
| RG-012 | Decision persisted per activity with reason, matched rules, rule versions | R§23, R§35 |
| RG-013 | Human approval over the MCP-standard mechanism (elicitation inside MRTR `input_required`); accept / decline / cancel mapped | R§24, D§7 |
| RG-014 | Approval bound to exactly one activity | R§25, Inv.6 |
| RG-015 | Resume runs the stored program in a **fresh isolate**; client need not resend code | R§26, Inv.3 |
| RG-016 | Bridge owns replay/governance; sandbox stays untrusted, no direct network | R§27–§28 |
| RG-017 | Replay divergence stops the execution (`REPLAY_DIVERGED`) | R§29–§30 |
| RG-018 | Execution locking against concurrent resumes | R§31 |
| RG-019 | Failure handling distinguishes explicit API failure from unknown outcome; no silent retry of side effects | R§32, D§10 |
| RG-020 | Inspection + chronological history | R§33–§34 |
| RG-021 | Harbor metadata travels in namespaced `_meta` keys | R§36 |
| RG-022 | Transport stays stateless; durability lives in the store | R§37, Inv.11–12 |
| RG-023 | Storage abstraction; executions survive a process restart with the file store | R§39, D§12 |
| RG-024 | Bearer authentication on every entry point; principal binding on resume | D§7, D§14 |
| RG-025 | `requestState` integrity: HMAC, TTL, method binding; tampered/expired/foreign state refused | D§7 |
| RG-026 | Fail closed: invalid rule file stops boot; evaluation error denies; default decision honoured | D§6, D§9 |
| RG-027 | HTTP fallback approval channel for clients without elicitation | D§7 |
| RG-028 | An approval is decided exactly once; duplicates refused; no duplicate side effect | D§10 |
| RG-029 | §47 acceptance scenario end to end (two approval rounds, every call exactly once) | R§47 |
| RG-030 | MCP protocol correctness: 2026-07-28 headers/envelope, legacy rejected, malformed requests rejected, five frozen tools | R§3, R§40, `docs/mcp-2026-07-28-compatibility.md` |

---

## 3. Proposed test architecture

### 3.1 Layers

```
Layer 1  unit          tests/unit            (existing; unchanged)
Layer 2  integration   tests/integration     (existing; unchanged)
Layer 3  E2E           tests/e2e             (new) real MCP wire → real gateway → real rules → real isolate → real HTTP → mock API
         Postman       postman/              (new) the same flows, manually executable, with assertions
         CI            .github/workflows/governance-e2e.yml (new)
```

The E2E layer never imports Harbor runtime code. It talks to the gateway only
through `POST /mcp` (JSON-RPC over Streamable HTTP, 2026-07-28), `GET /health`,
and the governance HTTP routes `GET /executions/{id}` and
`POST /executions/{id}/approvals/{approvalId}`, and to the mock API's control
plane. Nothing in the governance path is mocked.

### 3.2 Environment topology (Docker Compose)

```
                 host (vitest / postman runner)
                    │  http://localhost:3333/mcp   http://localhost:3334/mcp   http://localhost:4010/__admin/*
   ┌────────────────┼────────────────────────────────────────────────────────────┐
   │ compose network│                                                            │
   │        ┌───────▼───────┐        ┌───────────────┐        ┌───────────────┐  │
   │        │ harbor  :3333 │        │ harbor-strict │        │ mock-api:4010 │  │
   │        │ default ALLOW │        │ :3334         │        │ deterministic │  │
   │        │ file store    │◄──────►│ default DENY  │◄──────►│ request log   │  │
   │        │ rules/default │  HTTP  │ TTL 3s        │  HTTP  │ fault inject  │  │
   │        └───────────────┘        │ in-memory     │        └───────────────┘  │
   │                                 └───────────────┘                           │
   └─────────────────────────────────────────────────────────────────────────────┘
```

- **`harbor`** — built from the repository `Dockerfile` (the production image). Env: file execution store bind-mounted on `artifacts/executions`, fixed `GOVERNANCE_REQUEST_STATE_KEY` (so a restarted process can still verify a `requestState` minted before the restart), `GOVERNANCE_DEFAULT_DECISION=ALLOW`, rules from `tests/e2e/fixtures/governance/default`, services from `tests/e2e/fixtures/services` (mounted read-only), `ENABLE_AUDIT=true`.
- **`harbor-strict`** — the same image, `GOVERNANCE_DEFAULT_DECISION=DENY`, in-memory store, a three-rule set (`tests/e2e/fixtures/governance/strict`: ALLOW `ping`, REQUIRE_APPROVAL `createPayment`, REQUIRE_APPROVAL `createOrder` over 10 000), `GOVERNANCE_APPROVAL_TTL_SEC=3`. Exists to test the fail-closed default and `requestState` expiry without slowing the main instance. The default DENY applies to a call a rule targets but none matches (a `createOrder` of 10 000 or less); a call no rule targets is still ALLOW `NO_GOVERNANCE`.
- **`mock-api`** — `tests/e2e/mock-api/server.mjs` on `node:22-alpine`, zero dependencies. Implements the READ / WRITE / UPDATE / DELETE / SENSITIVE / ADMIN / MULTI-STEP / FAILURE endpoints (§3.5) plus a control plane: `GET /__admin/requests`, `POST /__admin/reset`, `GET /__admin/state`, `GET /health`. Every received request is logged with method, path, query, body, a redacted bearer fingerprint, the identity it resolved to and the Harbor headers the call carried (`X-Correlation-ID`, `X-Idempotency-Key`, `X-MCP-*`, `X-Harbor-*`): request IDs group calls within a sandbox run, while `X-Harbor-Execution-ID` links governed calls across approval turns.
- No separate policy engine, state store or approval service containers: all three are embedded in the gateway in the shipped architecture (rules in-process, file store, approvals over MCP/HTTP). Adding containers for them would test something other than the shipped architecture.

Readiness is polled (`/health` for both gateways, `/health` for the mock) with a timeout and a clear error; no fixed sleeps.

A **local-process mode** (`--local`) starts the same three processes with `tsx` and the mock server directly on the host (services materialised with `host: 127.0.0.1`). It exists for fast iteration and for machines without Docker; the tests are identical because they only read `MCP_BASE_URL`, `MCP_STRICT_BASE_URL`, `MOCK_API_URL` and the restart hooks from the environment.

### 3.3 Test client

`tests/e2e/client/mcp-client.ts` — a real 2026-07-28 client over `fetch`:
`discover()`, `listTools()`, `callTool()`, `apiExecute()` (typed outcome:
`completed | input_required | tool_error | rpc_error`), `answerApproval()`
(the MRTR retry: same `tools/call`, echoed `requestState`, `inputResponses`),
`resumeByMeta()` (fallback channel), `rawPost()` (for malformed requests), and
a transcript of every request/response for diagnostics. It builds the exact
headers and `_meta` envelope the SDK validates and parses both JSON and SSE
responses. No MCP method is invented.

Why not `@modelcontextprotocol/client`: the repository deliberately keeps its
dependency surface minimal (see `postman/README.md`), the governance tests
need to send *malformed* frames the SDK client would refuse to build, and the
2026-07-28 wire format is small and fully specified by the server SDK the
gateway already uses.

`tests/e2e/client/harbor-admin.ts` wraps `/health`, `GET /executions/{id}`
and the HTTP approval route. `tests/e2e/client/mock-api.ts` wraps the mock
control plane (`reset`, `requests`, `count(method, path)`, `calls`, `state`,
`health`).

### 3.4 Fixtures

- **Identities** (`tests/e2e/fixtures/identities.json`, typed by `tests/e2e/fixtures/identities.ts`): `alice`, `bob`, `admin`, `readonly-user`, `finance-user`, `untrusted-user` — fixed ≥32-char opaque tokens. Harbor accepts all of them (static-token); the mock API rejects `untrusted-user` with 401 so "wrong identity downstream" is observable. Because rules cannot see the principal on main, identities are used for **principal binding** (who may resume/approve) and **downstream identity forwarding**, not for role-based policy (§6).
- **Resources**: `customer-001`, `customer-002`, orders minted deterministically `order-001, order-002, …` (counter reset by `/__admin/reset`), `payment-001…`, `notification-001…`.
- **Services**: `commerce` (customers, orders, payments, notifications, unstable) and `ops` (admin users) — both backed by the same mock API so cross-service resume can be tested.
- **Rules** (`tests/e2e/fixtures/governance/default/*.yaml`): allow read customer; deny delete order; high-value order (`amount > 10000`) requires approval; resource-scoped deny (`path.customerId == customer-002`); payment details (sensitive) requires approval; charge payment requires approval; notifications allowed; admin user creation denied; conflicting rules on `PATCH /orders/{id}` (ALLOW vs DENY when `status == cancelled`, ALLOW vs REQUIRE_APPROVAL when `expedite == true`); an `ops` method + wildcard-path ALLOW (`method: GET, path: "*"`) to show `*`. Operations no rule targets (`getOrder`, `ping`, `unstableOperation`) are ungoverned: ALLOW `NO_GOVERNANCE`. `strict/` holds three rules (ALLOW `ping`, two REQUIRE_APPROVAL); the strict default DENY decides only targeted calls none of them matches. `invalid/` holds a malformed rule for the boot test.
- **Programs** (`tests/e2e/fixtures/programs.ts`): the JavaScript workflows, including the canonical 4-step `read customer → create high-value order → charge payment → send notification`.

### 3.5 Mock API surface

| Category | Endpoint | Behaviour |
|---|---|---|
| READ | `GET /ping` | 200 `{ pong, identity }` — echoes who the backend saw (ungoverned on the default instance) |
| READ | `GET /customers/{customerId}` | 200 fixed customer; 404 unknown |
| READ | `GET /orders/{orderId}` | 200 the order; 404 unknown |
| SENSITIVE | `GET /customers/{customerId}/payment-details` | 200 masked card data |
| WRITE | `POST /orders` | 201 `order-NNN`; 400 when `customerId`/`amount` missing |
| UPDATE | `PATCH /orders/{orderId}` | 200 merged; 404 unknown |
| DELETE | `DELETE /orders/{orderId}` | 204; 404 unknown |
| MULTI-STEP | `POST /payments`, `POST /notifications` | 201 `payment-NNN` / `notification-NNN` |
| ADMIN | `POST /admin/users`, `GET /admin/users` | 201 / 200 list |
| FAILURE | `POST /unstable` | status from body `mode` or query `status` (any 200–599; the suite uses 400/401/403/404/409/429/500) or `mode: timeout` (held for 60 s, past every client timeout) ; `?delayMs=` on any endpoint delays the response deterministically |
| Auth | all business endpoints | 401 unless the bearer is a known identity |
| Control | `GET /__admin/requests` (`?method=&path=`), `POST /__admin/reset`, `GET /__admin/state`, `GET /health` | request log (with the Harbor headers each call carried: `X-Correlation-ID`, `X-Idempotency-Key`, `X-MCP-*`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `X-Harbor-Execution-ID`), reset, state, liveness |

### 3.6 Test inventory (files)

```
tests/e2e/
  client/        mcp-client.ts · harbor-admin.ts · mock-api.ts
  fixtures/      identities.json · identities.ts · programs.ts · services/ · governance/{default,strict,invalid}/
  helpers/       env.ts (env contract) · setup.ts (checks the env contract and that every target is healthy) · assertions.ts (expectCompleted/Paused/ToolError)
                 · diagnostics.ts (failure dumps) · wait.ts (polling)
  mock-api/      server.mjs
  setup/         run-governance.mjs (orchestrator) · local-stack.mjs · local-control.mjs (local restart/kill hooks)
                 · materialize-services.mjs (+ .d.mts) · wait-for.mjs · summary.mjs
  governance/                                        tests at runtime (157)
    protocol.test.ts        RG-030, RG-022, RG-021    25  (incl. 413 on an oversized body)
    authentication.test.ts  RG-024                     9
    allow.test.ts           RG-007, RG-008, RG-011, RG-012   7
    deny.test.ts            RG-007, RG-009, RG-011, RG-012   8
    approval.test.ts        RG-013, RG-014, RG-027, RG-028  14  (incl. malformed accept, conflicting answer)
    multi-step.test.ts      RG-006, RG-014, RG-029     6
    lifecycle.test.ts       RG-001, RG-003, RG-015, RG-019, RG-023   8
    replay.test.ts          RG-002, RG-004, RG-005, RG-017, RG-019   8
    idempotency.test.ts     RG-018, RG-028             8  (incl. concurrent HTTP decisions, per-execution keys)
    authorization.test.ts   RG-024, RG-025, RG-028    11  (incl. owner-bound HTTP inspection and decisions)
    failures.test.ts        RG-003, RG-019            18
    bypass.test.ts          RG-002, RG-007, RG-008, RG-009, RG-014, RG-016, RG-017   22  (incl. path spellings, headers)
    audit.test.ts           RG-010, RG-012, RG-020     6
    defaults.test.ts        RG-011, RG-025, RG-026     5  (strict instance)
    boot.test.ts            RG-026                     1  (real gateway boot with an invalid rule file)
```

Naming: `should_<behaviour>_when_<condition>` (GIVEN in the describe block,
WHEN/THEN in the test name). One test, one behavioural claim. Files run
**sequentially** (`fileParallelism: false`) because they share the two gateway
instances and the mock request log; each test resets the mock log in
`beforeEach`, and tests that restart or kill the gateway live in
`lifecycle.test.ts` and are documented there as intentionally serial.

### 3.7 How the multi-step approval proof is observed from outside

For the 4-step program with approvals at steps 2 and 3 the test asserts, at
**every** pause, all of: the MCP result (`input_required`, elicitation
message names the operation, `_meta` execution id + status); the mock request
log (exactly the calls that should have gone out so far, none of the paused
one); `GET /executions/{id}` (execution `WAITING_APPROVAL`, `runCount`,
activity statuses `[COMPLETED…, WAITING_APPROVAL]`, the pending approval's
`activitySequence`, decision records); and, after each resume, that
`runCount` incremented, replayed activities kept `runIndex` of the run that
first executed them, and the program's own `startedAt = Date.now()` captured
at the top of the program is later than the approval's `decidedAt` — which is
only possible if the program restarted from the top in a fresh isolate after
the human decided (a suspended isolate would have captured it before the
pause).

### 3.8 Postman

`postman/mcp-governance.postman_collection.json` (+ `postman/environments/local.postman_environment.json`)
drives the same gateway with the same fixtures. Folders: Health · MCP
Discovery (`server/discover`, `tools/list` — 2026-07-28 has no `initialize`)
· Allowed · Denied · Approval Required · Approve + Resume (MRTR) · HTTP
fallback approval · Multi-step / multiple approvals · Approval denial ·
Replay & inspection · Idempotency · Error cases · Security · Audit · Review
Hardening (folder 15, added 2026-09-27: path spellings, program-supplied
headers, JSON-string bodies, malformed and conflicting approval answers, no
silent POST retry, error classification, per-execution idempotency keys) —
15 folders, 118 requests, 232 assertions. Requests
chain through variables (`executionId`, `approvalId`, `requestState`,
`orderId`). Every request has `pm.test` assertions on semantic fields
(`resultType`, tool error `code`, execution status, activity statuses,
downstream call counts read from the mock control plane).

`npm run test:postman` runs it from the CLI. The project's `postman/README.md`
records a deliberate decision not to depend on `newman` (CVE surface). The
harness therefore ships a small dependency-free runner
(`tests/postman/run-collection.mjs`) that executes Postman v2.1 collections
with the `pm.*` subset the collection uses and emits JUnit + JSON; set
`POSTMAN_RUNNER=newman` to run the identical collection through `npx newman`
instead.

### 3.9 CI

`.github/workflows/governance-e2e.yml` runs on `push` and `pull_request`
for governance-relevant paths: build the image (buildx, GHA layer cache) →
`docker compose up` → wait for health → boot-refusal check → `test:e2e` →
`test:postman` → summary → upload `artifacts/` (JUnit, JSON summary, Newman-style
report, container logs, per-test failure dumps) → `compose down`. Any step
failing fails the job; no step swallows errors. Typecheck, lint and the unit
suite remain in the existing `ci.yml`.

### 3.10 Diagnostics on failure

Each E2E test has an `afterEach` hook that, when the test failed, writes to
`artifacts/e2e/failures/<file>/<test>/`: the MCP transcript (requests + responses,
bearer redacted), the execution inspection for every execution the test
touched, the mock API request log, and a `context.json` with the correlation
ids (`testId`, JSON-RPC request ids, `executionId`, `approvalId`,
`activitySequence`, downstream `X-Correlation-ID`s and `X-Harbor-Execution-ID`s). The orchestrator adds
`docker compose logs` per container.

---

## 4. Validation of the suite itself

After implementation the suite was validated (2026-09-21) by temporarily
introducing six defects and confirming the E2E tests fail. The defects
actually run, the files that hold that logic now, and the test files that
caught each one are listed in [`TESTING.md`](TESTING.md#mutation-validation-of-the-suite);
that list supersedes the plan written here before the build. No defect is left
in the final tree.

---

## 5. Decisions

1. **No new production dependency.** The MCP client, the mock API and the Postman runner are dependency-free. `vitest` (already present) runs the E2E layer with a separate config so `npm test` stays unchanged.
2. **Default `vitest.config.ts` excludes `tests/e2e/**`** — the E2E suite needs a running environment and must not break `npm test`.
3. **Two gateway instances** rather than restarting one with different env between test files: keeps the suite deterministic and lets the strict-mode tests run in the same pass.
4. **Restart/kill hooks are environment-provided commands** (`HARBOR_RESTART_CMD`, `HARBOR_KILL_CMD`, `HARBOR_START_CMD`); the compose orchestrator sets them to `docker compose` commands, the local runner to process signals. Tests needing them are skipped with an explicit reason when the hooks are absent (only when running the suite by hand against an arbitrary URL).
5. **`postman/` is git-ignored** (`.gitignore` pattern `postman/*`, first added as `postman/` in `0c5deb1`). The committed collections, the local environment and the README are un-ignored explicitly so they ship with the repo; local exports stay out.

---

## 6. Requirement coverage gaps (what cannot be tested on main, and why)

| Gap | Reason | Consequence for the suite |
|---|---|---|
| Role- / user-based rules (`readonly-user cannot WRITE`, per-user resource access) | `GovernanceRequest` carries no principal attributes; rules match only service/operation/method/path/request values. Principal-aware rules exist only on the unmerged `poc/sept01-governance` branch. | The policy matrix is expressed per **operation and request value**. Identities are tested for principal binding on resume and for downstream identity forwarding. Documented as not applicable, not silently omitted. |
| Separate approver identity / approver roles | `/executions/*` inspection and decisions are bound to the execution's owner (anyone else ⇒ 403), so the approver is the requester's own principal; there is no approver role (D§14). | Owner binding is asserted by `authorization › should_bind_http_inspection_and_decisions_to_the_execution_owner`; requester/approver separation is not applicable until an approver model lands. |
| Approval expiry / timeout | Only the MRTR `requestState` expires (TTL). The stored approval never expires; the HTTP fallback can still decide it. | Tested exactly as implemented on the strict instance (TTL 3 s): expired state ⇒ `-32602`; HTTP decision still possible. |
| Policy versioning across a pause / rule reload | Each service loads rules at boot and, with its `governance.rulesRefreshSec` > 0, refreshes on that interval; there is no reload endpoint, and an already approved activity is not re-evaluated on resume. The E2E instances do not refresh. | Per-service refresh is unit-tested (`governance-rule-sources.test.ts`); `ruleVersions` tags on decisions are asserted; "policy changes between pause and resume" is not exercised end to end. |
| Cancelling a running execution | No API; MCP request cancellation is not propagated into the sandbox. | Only the `cancel` approval outcome is tested. |
| Session semantics (invalid/expired session, session cleanup) | No sessions exist (stateless 2026-07-28). | Tested as: no `Mcp-Session-Id` is issued or required; arbitrary session headers are ignored; repeated requests are independent. |
| stdio transport | Not the production transport for this deployment; needs a child process per client. | Covered by unit tests only. |
| Body drift on a `COMPLETED` activity | By design a replay reads history: a `COMPLETED` record binds the resource but not the body. `APPROVED`, `WAITING_APPROVAL` and `EXECUTING` records bind query and body too (241d217). | Method/path divergence and the approved-request binding are tested (`replay › should_stop_with_replay_diverged…`, `bypass › should_not_execute_a_request_other_than_the_one_approved_when_the_persisted_program_branches_on_the_clock`); COMPLETED body drift is unit-tested (`activity-gate.test.ts`). |
| Deterministic triggering of `REPLAY_DIVERGED` from outside | With authoritative stored code the only nondeterminism is time/random. | The tests use a program that branches on a wall-clock threshold chosen so run 1 and the resume take different branches (a clock predicate the test waits for, not a race). |
| pino `audit` log lines | Log formatting is not a contract. | Audit is asserted semantically through `GET /executions/{id}` (decisions, approvals, history). |
| Distributed lock / multi-instance | With `memcache` the lock is shared across pods (`add` + TTL); with `in-memory` and `file` it is process-local (D§14). | Concurrency tests run against one instance (file store); the memcache lock is unit-tested (`memcache-execution-store.test.ts`). |

### Findings the harness pinned, and where they stand (2026-09-27)

| Finding | Status |
|---|---|
| A program could override the outbound `Authorization` header (`known_gap_program_supplied_headers_can_override_the_outbound_authorization_header`) | Resolved by 24bdc72 (review of main, 2026-09-27): identity, Harbor-owned and routing headers are dropped. The test is now `bypass › should_not_let_program_supplied_headers_change_the_outbound_identity_or_routing`. |
| An uncaught backend timeout was reported as `SANDBOX_TIMEOUT` (`known_quirk_an_uncaught_backend_timeout_is_reported_as_sandbox_timeout`) | Resolved in two stages: a46d977 classified a backend timeout separately from the sandbox timer; the later unknown-outcome fix reports a governed non-GET timeout as `ACTIVITY_OUTCOME_UNKNOWN`, prevents a caught error from completing the run, and keeps the execution `FAILED`. The test is `failures › should_report_an_uncaught_backend_timeout_as_outcome_unknown_not_a_sandbox_timeout`. |
| Any valid bearer could inspect and decide another principal's execution over `/executions/*` | Resolved on main before the review by owner binding (3cbc9df, 12ca119); pinned by `authorization › should_bind_http_inspection_and_decisions_to_the_execution_owner`. |
| A POST that got a 5xx was retried by the API client (the E2E test asserted two attempts) | Resolved by 78ead14 (review of main, 2026-09-27): only GET, PUT and DELETE are retried. The test is now `failures › should_not_retry_a_post_that_got_a_500_and_journal_the_activity_as_failed_with_unknown_outcome`. |
| The production `Dockerfile` `HEALTHCHECK` used `localhost` (IPv6 on Alpine) | Resolved. The image now probes `127.0.0.1:3333` directly, and the governance CI builds and boots that production image. |

Other open items from the 2026-09-27 review that bear on requirements (ungoverned calls under a DENY
default, rule targets not validated against the specs, `final` semantics, operators on missing
fields, …) are listed with their requirement ids in
[`tests/REQUIREMENT_COVERAGE.md`](tests/REQUIREMENT_COVERAGE.md#open-items-from-the-2026-09-27-review-not-fixed-decisions-for-the-owner).
