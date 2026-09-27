# MCP Governance — Test Architecture

This document records what the repository analysis found (Phase 1 of the
governance test-harness build) and the test architecture derived from it.
Everything below was read from the code on branch
`poc/aug28-governance-automation`; nothing is assumed.

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
| SDK | `@modelcontextprotocol/server` + `@modelcontextprotocol/node` **2.0.0** (GA). `createMcpHandler(factory, { legacy: 'reject' })` → `toNodeHandler`. | `package.json`, `http-gateway.ts` |
| Transport | Streamable HTTP, **stateless**. One `McpServer` instance per request; no `initialize` / `notifications/initialized`, no `Mcp-Session-Id`. The connection probe is `server/discover`. stdio is the second transport (same factory, `serveStdio`). | `mcp-server-factory.ts`, `docs/mcp-2026-07-28-compatibility.md` |
| Required request shape | `POST /mcp`, headers `Authorization: Bearer …`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, and `Mcp-Name: <tool>` for `tools/call`; JSON-RPC 2.0 body whose `params._meta` carries the envelope `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`. Header/body mismatch → JSON-RPC `-32020`. | `tests/demo_e2e.py` (`_mcp_headers`, `_mcp_envelope`), SDK |
| Responses | JSON or `text/event-stream` (the SDK picks); every tool result carries `_meta` with `io.modelcontextprotocol/serverInfo` plus Harbor's application metadata. | `src/tools/tool-helpers.ts` |
| Tools | Exactly five, frozen: `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`. Input schemas fixed (`api_execute` = `{ service, code }`). | `src/tools/` |
| Server capabilities | `{ tools: {} }` only. Elicitation is a **client** capability read per request from the envelope. | `buildMcpServerOptions` |
| Authentication | Bearer required on `/mcp` and `/executions/*`. Format enforced at the transport: a JWT (`h.p.s`) or an opaque token of ≥ 32 base64url characters; otherwise **401** with a machine-readable `reason`. Per-service strategy then validates. The E2E services use `static-token`, which forwards the client bearer unchanged to the backend and derives the principal as `sha256(bearer)` (no `metadata.userId`). Distinct bearers ⇒ distinct principals. | `src/spi/auth/bearer-authorization.ts`, `src/adapters/auth/strategies/static-token.strategy.ts`, `execute-api.tool.ts` |
| Authorization | No role model. `PermissionGuard` admits everything (`forwardTokenPermissionGuard`). Governance Rules are the only authorization layer, and on this branch they see **no principal attributes** (see §6 gaps). | `src/spi/permissions`, `src/runtime/governance/rule-evaluator.ts` |
| Error handling | Transport errors are JSON-RPC errors (`-32700`, `-32600`, `-32601`, `-32602`, `-32020`, `-32022`). Tool-level failures are `isError: true` results whose single text block is JSON `{ error, code, retryable, …extra }` with `code` from `src/core/constants.ts ERR`. | `tool-helpers.ts mcpError` |

### 1.2 Governance layer

| Aspect | Finding | Where |
|---|---|---|
| Decision point | Inside the host bridge, for every `api.request()` the isolate makes, **before** the outbound call. Order: journal lookup → (new activity) resolve OpenAPI operation → evaluate rules → persist decision → `ALLOW` execute / `DENY` stop / `REQUIRE_APPROVAL` pause. | `src/runtime/sandbox/execute-api-in-sandbox.ts`, `makeBridge` in `src/tools/execute-api.tool.ts` |
| Policy representation | YAML/JSON files in `GOVERNANCE_RULES_DIR` (top level only). One rule = `name`, `version`, `match { service, operation, method, path }`, `conditions { <field>: { operator: value } }`, `action { type, reason }`. Validated with zod; **invalid file ⇒ gateway refuses to boot**; duplicate names refused. | `src/runtime/governance/rule-schema.ts`, `rule-loader.ts` |
| Rule matching | Every present `match` clause must equal the request (`*` = anything). `operation` is the OpenAPI `operationId`; `path` is the spec template (`/orders/{orderId}`). Conditions read actual request values: bare names = body fields, `body.a.b`, `query.x`, `path.x`. Operators: equals, not_equals, greater_than(_or_equal), less_than(_or_equal), in, not_in, exists, starts_with, contains. Missing field satisfies only `exists: false`; cross-type comparisons are false. | `rule-evaluator.ts` |
| Precedence / conflicts | Among matched rules **DENY > REQUIRE_APPROVAL > ALLOW**; deciding rule = first (file order) rule carrying the winning action. No match ⇒ `GOVERNANCE_DEFAULT_DECISION` (`ALLOW` default). Evaluator exception ⇒ `DENY` (`GOVERNANCE_EVALUATION_FAILED`). | `src/core/constants.ts GOVERNANCE_PRECEDENCE`, `rule-evaluator.ts` |
| Attributes available to rules | service, operationId, method, spec path template, path params, query, body. **Not** available: user/principal, role, tenant, time. | `GovernanceRequest` |
| Audit | Every decision is persisted per activity (`decision`, `reason`, `matchedRules`, `ruleVersions` as `name@version#hash12`, `decidingRule`, `evaluatedAt`). Approvals persist `status`, `decidedAt`, `decidedVia`, `comment`. `GET /executions/{id}` returns a derived chronological `history`. A pino `audit` log line is also written per tool call when `ENABLE_AUDIT=true`. | `execution.types.ts`, `execution-manager.ts buildHistory`, `observability/audit.ts` |
| PII / redaction | Activity records never store headers (bearer never journaled). Approval summaries never carry credentials. No other redaction exists. | `toRequestRecord`, `ApprovalSummary` |
| Policy reload / versioning | Rules load once at boot; there is no reload endpoint on this branch. Version context = the `ruleVersions` tags on decisions. | `code-mode-runtime.ts` |

### 1.3 Execution layer

| Aspect | Finding | Where |
|---|---|---|
| Request → execution | `tools/call api_execute { service, code }` with no execution reference ⇒ `ExecutionManager.create` mints a UUIDv4 `executionId` and persists `originalCode`. A call carrying a verified `requestState` (MRTR retry) or `_meta["harbor/execution-id"]` (fallback) ⇒ load + resume. | `resolveExecution` |
| "Workflow" representation | There is no DAG/workflow engine (a stated non-goal). A workflow **is** the agent's JavaScript program; each `api.request()` it makes is one **activity** numbered 1..N in arrival order. "Step k" in this harness = activity #k. | `src/runtime/execution/activity-journal.ts` |
| Lifecycle | `CREATED → RUNNING → COMPLETED | WAITING_APPROVAL | INTERRUPTED | DENIED | FAILED | CANCELLED`. Activity states: `WAITING_APPROVAL, EXECUTING, APPROVED, COMPLETED, FAILED, DENIED, CANCELLED`. Approval states: `PENDING, APPROVED, REJECTED, CANCELLED`. | `src/core/constants.ts` |
| Persistence | `CodeModeStore` SPI; `in-memory` (default) or `file` (one JSON document per execution, temp+rename, reloaded at boot). Every mutation is written through **before** the next step proceeds (journal-before-call). | `src/spi/execution/execution-store.ts`, `src/adapters/execution/*` |
| Approval pause | Bridge records the activity `WAITING_APPROVAL`, records a **run-stopping violation**, refuses every further `api.request()` in that isolate, and returns a bridge error to user code. After the isolate settles the violation is promoted to `ApprovalRequiredError`; the tool persists `WAITING_APPROVAL` and returns `resultType: "input_required"` with an `elicitation/create` form and an HMAC-sealed `requestState`. | `execute-api-in-sandbox.ts`, `approvalResult` |
| Isolate creation / destruction | `runInSandbox` creates a fresh `ivm.Isolate` per run and **always disposes it in `finally`**; the wall-clock timer disposes it on timeout and aborts in-flight HTTP via `AbortController`. Nothing is kept alive across an approval. | `src/runtime/sandbox/sandbox-core.ts` |
| Resume | The **stored** program runs again from the top in a new isolate (`runCount` increments; new activities carry `runIndex` = that run). Journaled `COMPLETED` activities are replayed from the store (no outbound call); the `APPROVED` activity executes; new activities go through governance. Incoming `code` on resume is ignored (logged). | bridge switch on `existing.status` |
| Replay divergence | Recorded `method` + `specPath` at sequence N must equal the encountered call; otherwise `REPLAY_DIVERGED`, execution `FAILED`, nothing executed. Bodies are not compared (documented). | `ActivityJournal.next` |
| Failure handling | Explicit HTTP status (4xx/5xx after client retries) ⇒ activity `COMPLETED` with that status (`ok:false`), replayable. Transport throw (timeout/socket/abort) ⇒ activity `FAILED`, `outcomeKnown:false`, **never replayed and never retried**; a later run stops with `ACTIVITY_OUTCOME_UNKNOWN`. An `EXECUTING` record found on resume (process died mid-call) ⇒ `GET` re-executes, anything else fails closed. Circuit open ⇒ execution `INTERRUPTED` (resumable). | bridge `catch`, docs §10 |
| Idempotency | `api_execute` calls are **not** deduplicated by request id or code hash: each fresh call is a new execution (by design — the execution id is the identity). Within an execution, replay guarantees a completed activity is never re-issued. The per-service `idempotency` strategy (default `noop`) is a separate, pre-existing cache keyed `mcp-{service}-{userHash12}-{codeHash16}-{sequence}` and forwarded as `X-Idempotency-Key`. | `execute-api.tool.ts`, `api-client.ts` |
| Retry | `ApiClient` retries 5xx and transport errors up to `api.maxRetries` (per service config) with backoff, inside one activity. | `api-client.ts` |
| Timeout | Sandbox wall clock `SANDBOX_EXECUTE_TIMEOUT_MS` (per-service override); outbound `api.requestTimeoutMs`. | config |
| Cancellation | Only via the approval answer (`cancel` ⇒ execution `CANCELLED`). No API cancels a running execution. | `approval-service.ts` |
| Locking | Per-execution in-process lock around every run; a concurrent run gets retryable `EXECUTION_LOCKED`. Terminal executions and executions with a still-`PENDING` approval are `EXECUTION_NOT_RESUMABLE`. | `ExecutionManager.beginRun` |

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
        HTTP fallback: POST /executions/{id}/approvals/{approvalId} {action, approve?, comment?}
        accept+approve:true → APPROVED (activity APPROVED; execution still WAITING_APPROVAL, resumable)
        accept+approve:false | decline → REJECTED (activity DENIED, execution DENIED)
        cancel → CANCELLED (activity CANCELLED, execution CANCELLED)
        second decision → APPROVAL_ALREADY_DECIDED (HTTP 409; MRTR duplicate after decision just resumes/refuses)
   → resume: fresh isolate, replay 1..N-1, execute N, continue; a later REQUIRE_APPROVAL repeats the cycle with a new approvalId/requestState.
```

### 1.5 Downstream services

Services are folders `services/<name>/` with `config.json` (`api.{protocol,host,port,basePath,requestTimeoutMs,maxRetries}`, `auth`, `idempotency`, `sandbox` overrides) and an OpenAPI `spec.yaml`. Harbor calls `{protocol}://{host}:{port}{basePath}{path}` via axios with headers `Authorization` (client bearer under `static-token`), `X-Correlation-ID`, `X-Request-Source`, `X-MCP-Tool`, `X-MCP-Service`, `X-MCP-Version`, `X-MCP-Session-ID`, `X-Idempotency-Key`. Query params and JSON bodies pass through. The isolate has **no** network: `fetch`, `require`, `process` do not exist inside it; `api.request` (bridged `__makeRequest`) is the only door.

### 1.6 Existing tests

| Layer | What exists | Notes |
|---|---|---|
| Unit (vitest) | evaluator/loader (`governance-rules.test.ts`), resolver, journal/store contracts, execution manager, approval service, request-state, execution routes, tool handler under governance (`execute-api.tool.codemode.test.ts`), sandbox | Call internal classes directly with fake connectors. |
| Integration (vitest) | `code-mode-replay.test.ts` (bridge + real isolate + counting connector), `code-mode-acceptance.test.ts` (§47 scenario through the tool handler with a fake `ServerContext`), `mcp-approval-wire.test.ts` (real SDK handler via `handler.fetch`, no HTTP listener, fake connector) | Governance path is real; **network, HTTP listener, service scanning, file store, container lifecycle and downstream HTTP are not exercised**. |
| E2E (Python) | `tests/demo_e2e.py` — boots demo backends + gateway as local processes, 61 assertions on the five tools and auth strategies. **No governance coverage.** | Pre-governance; stays as is. |

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
| RG-030 | MCP protocol correctness: 2026-07-28 headers/envelope, legacy rejected, malformed requests rejected, five frozen tools | R§3, R§40, D§B |

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

- **`harbor`** — built from the repository `Dockerfile` (the production image). Env: file execution store on a named volume, fixed `GOVERNANCE_REQUEST_STATE_KEY` (so a restarted process can still verify a `requestState` minted before the restart), `GOVERNANCE_DEFAULT_DECISION=ALLOW`, rules from `tests/e2e/fixtures/governance/default`, services from `tests/e2e/fixtures/services` (mounted read-only), `ENABLE_AUDIT=true`.
- **`harbor-strict`** — the same image, `GOVERNANCE_DEFAULT_DECISION=DENY`, a one-rule set (`fixtures/governance/strict`), `GOVERNANCE_APPROVAL_TTL_SEC=3`. Exists to test the fail-closed default and `requestState` expiry without slowing the main instance.
- **`mock-api`** — `tests/e2e/mock-api/server.mjs` on `node:22-alpine`, zero dependencies. Implements the READ / WRITE / UPDATE / DELETE / SENSITIVE / ADMIN / MULTI-STEP / FAILURE endpoints (§3.5) plus a control plane: `GET /__admin/requests`, `POST /__admin/reset`, `GET /__admin/state`, `GET /health`. Every received request is logged with method, path, query, body, a redacted bearer fingerprint and the `X-Correlation-ID` / `X-Idempotency-Key` headers so tests can correlate downstream calls with executions.
- No separate policy engine, state store or approval service containers: all three are embedded in the gateway on this branch (rules in-process, file store, approvals over MCP/HTTP). Adding containers for them would test something other than the shipped architecture.

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
control plane (`reset`, `requests`, `count(method, path)`).

### 3.4 Fixtures

- **Identities** (`tests/e2e/fixtures/identities.ts`): `alice`, `bob`, `admin`, `readonly-user`, `finance-user`, `untrusted-user` — fixed ≥32-char opaque tokens. Harbor accepts all of them (static-token); the mock API rejects `untrusted-user` with 401 so "wrong identity downstream" is observable. Because rules cannot see the principal on this branch, identities are used for **principal binding** (who may resume/approve) and **downstream identity forwarding**, not for role-based policy (§6).
- **Resources**: `customer-001`, `customer-002`, orders minted deterministically `order-001, order-002, …` (counter reset by `/__admin/reset`), `payment-001…`, `notification-001…`.
- **Services**: `commerce` (customers, orders, payments, notifications, unstable) and `ops` (admin users) — both backed by the same mock API so cross-service resume can be tested.
- **Rules** (`tests/e2e/fixtures/governance/default/*.yaml`): allow read customer; deny delete order; high-value order (`amount > 10000`) requires approval; resource-scoped deny (`path.customerId == customer-002`); payment details (sensitive) requires approval; charge payment requires approval; notifications allowed; admin user creation denied; conflicting rules on `PATCH /orders/{id}` (ALLOW vs DENY when `status == cancelled`, ALLOW vs REQUIRE_APPROVAL when `expedite == true`); a service-wildcard ALLOW to show `*`. `strict/` holds a single REQUIRE_APPROVAL rule so the strict instance denies everything else. `invalid/` holds a malformed rule for the boot test.
- **Programs** (`tests/e2e/fixtures/programs.ts`): the JavaScript workflows, including the canonical 4-step `read customer → create high-value order → charge payment → send notification`.

### 3.5 Mock API surface

| Category | Endpoint | Behaviour |
|---|---|---|
| READ | `GET /customers/{customerId}` | 200 fixed customer; 404 unknown |
| SENSITIVE | `GET /customers/{customerId}/payment-details` | 200 masked card data |
| WRITE | `POST /orders` | 201 `order-NNN`; 400 when `customerId`/`amount` missing |
| UPDATE | `PATCH /orders/{orderId}` | 200 merged; 404 unknown |
| DELETE | `DELETE /orders/{orderId}` | 204; 404 unknown |
| MULTI-STEP | `POST /payments`, `POST /notifications` | 201 `payment-NNN` / `notification-NNN` |
| ADMIN | `POST /admin/users` | 201 |
| FAILURE | `POST /unstable` | status from body `mode` or query `status` (200/400/401/403/404/409/429/500) or `mode: timeout` (never responds) ; `?delayMs=` on any endpoint delays the response deterministically |
| Auth | all business endpoints | 401 unless the bearer is a known identity |
| Control | `GET /__admin/requests`, `POST /__admin/reset`, `GET /__admin/state`, `GET /health` | request log, reset, state, liveness |

### 3.6 Test inventory (files)

```
tests/e2e/
  client/        mcp-client.ts · harbor-admin.ts · mock-api.ts
  fixtures/      identities.ts · programs.ts · services/ · governance/{default,strict,invalid}/
  helpers/       env.ts (env contract) · diagnostics.ts (failure dumps) · wait.ts (polling)
  mock-api/      server.mjs
  setup/         run-governance.mjs (orchestrator) · local-stack.mjs · materialize-services.mjs · wait-for.mjs · summary.mjs
  governance/
    protocol.test.ts        RG-030, RG-022, RG-021
    authentication.test.ts  RG-024
    allow.test.ts           RG-007, RG-008, RG-011, RG-012
    deny.test.ts            RG-007, RG-009, RG-011, RG-012
    approval.test.ts        RG-013, RG-014, RG-027
    multi-step.test.ts      RG-006, RG-014, RG-029
    lifecycle.test.ts       RG-001, RG-003, RG-015, RG-019, RG-023
    replay.test.ts          RG-002, RG-004, RG-005, RG-017, RG-019
    idempotency.test.ts     RG-018, RG-028
    authorization.test.ts   RG-024, RG-025, RG-028
    failures.test.ts        RG-019
    bypass.test.ts          RG-002, RG-007, RG-016
    audit.test.ts           RG-012, RG-020
    defaults.test.ts        RG-011, RG-025, RG-026   (strict instance)
    boot.test.ts            RG-026                    (real gateway boot with an invalid rule file)
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
Replay & inspection · Idempotency · Error cases · Security · Audit. Requests
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
`artifacts/e2e/<file>/<test>/`: the MCP transcript (requests + responses,
bearer redacted), the execution inspection for every execution the test
touched, the mock API request log, and a `context.json` with the correlation
ids (`testId`, JSON-RPC request ids, `executionId`, `approvalId`,
`activitySequence`, downstream `X-Correlation-ID`s). The orchestrator adds
`docker compose logs` per container.

---

## 4. Validation of the suite itself

After implementation the suite is validated by temporarily introducing
defects and confirming the E2E tests fail (recorded in `TESTING.md` §
"Mutation validation"): DENY→ALLOW in the evaluator; skipping the
REQUIRE_APPROVAL pause; executing an `APPROVED` activity twice on resume;
executing a `COMPLETED` activity instead of replaying it; allowing a later
activity after a denied approval. No defect is left in the final tree.

---

## 5. Decisions

1. **No new production dependency.** The MCP client, the mock API and the Postman runner are dependency-free. `vitest` (already present) runs the E2E layer with a separate config so `npm test` stays unchanged.
2. **Default `vitest.config.ts` excludes `tests/e2e/**`** — the E2E suite needs a running environment and must not break `npm test`.
3. **Two gateway instances** rather than restarting one with different env between test files: keeps the suite deterministic and lets the strict-mode tests run in the same pass.
4. **Restart/kill hooks are environment-provided commands** (`HARBOR_RESTART_CMD`, `HARBOR_KILL_CMD`, `HARBOR_START_CMD`); the compose orchestrator sets them to `docker compose` commands, the local runner to process signals. Tests needing them are skipped with an explicit reason when the hooks are absent (only when running the suite by hand against an arbitrary URL).
5. **`postman/` is git-ignored** on this branch (`.gitignore` line `postman/`, added in `0c5deb1`). The new collection, environment and README are un-ignored explicitly so they ship with the repo.

---

## 6. Requirement coverage gaps (what cannot be tested on this branch, and why)

| Gap | Reason | Consequence for the suite |
|---|---|---|
| Role- / user-based rules (`readonly-user cannot WRITE`, per-user resource access) | `GovernanceRequest` carries no principal attributes; rules match only service/operation/method/path/request values. Principal-aware rules exist on the later `poc/sept01-governance` line, not here. | The policy matrix is expressed per **operation and request value**. Identities are tested for principal binding on resume and for downstream identity forwarding. Documented as not applicable, not silently omitted. |
| Separate approver identity / approver roles | Documented POC limitation (D§14): the approver is whoever holds a valid bearer; `/executions/*` accepts any bearer the gateway accepts. | Pinned by a clearly named "known limitation" test so the behaviour is visible and flips when an approver model lands. |
| Approval expiry / timeout | Only the MRTR `requestState` expires (TTL). The stored approval never expires; the HTTP fallback can still decide it. | Tested exactly as implemented on the strict instance (TTL 3 s): expired state ⇒ `-32602`; HTTP decision still possible. |
| Policy versioning across a pause / rule reload | Rules load at boot; no reload endpoint on this branch. | `ruleVersions` tags on decisions are asserted; "policy changes between pause and resume" is documented as not applicable. |
| Cancelling a running execution | No API. | Only the `cancel` approval outcome is tested. |
| Session semantics (invalid/expired session, session cleanup) | No sessions exist (stateless 2026-07-28). | Tested as: no `Mcp-Session-Id` is issued or required; arbitrary session headers are ignored; repeated requests are independent. |
| stdio transport | Not the production transport for this deployment; needs a child process per client. | Covered by unit tests only. |
| Body-level replay divergence | Not detected by design (D§14). | Documented; method/path divergence is tested. |
| Deterministic triggering of `REPLAY_DIVERGED` from outside | With authoritative stored code the only nondeterminism is time/random. | The test uses a program that branches on a wall-clock threshold chosen so run 1 and the resume take different branches (a clock predicate the test waits for, not a race). |
| pino `audit` log lines | Log formatting is not a contract. | Audit is asserted semantically through `GET /executions/{id}` (decisions, approvals, history). |
| Distributed lock / multi-instance | Lock is process-local (D§14). | Concurrency tests run against one instance. |
