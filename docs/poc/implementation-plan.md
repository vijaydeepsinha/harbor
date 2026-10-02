# Code Mode Governance Layer — Gap Analysis and Implementation Plan

> **Historical plan (2026-08-28).** Implemented on `main` via PR #4 and
> changed since; kept as the record of the original analysis. Where it
> disagrees with the code, [`docs/code-mode-governance.md`](../code-mode-governance.md)
> and [`tests/REQUIREMENT_COVERAGE.md`](../../tests/REQUIREMENT_COVERAGE.md) are
> authoritative. Notably, since this was written:
>
> - The host bridge is `src/runtime/sandbox/bridge-request-handler.ts`, and the
>   replay/governance decisions live in `src/runtime/execution/activity-gate.ts`;
>   the `file:line` references below point at the pre-PR #4 code.
> - `GOVERNANCE_DEFAULT_DECISION` defaults to `DENY`, and only for calls some
>   rule targets; calls no rule targets are allowed (`NO_GOVERNANCE`). Rules
>   gained levels, `final`, method lists, `/**` subtrees and condition trees.
> - A `memcache` store shares executions and the run lock across pods;
>   registered store backends are selectable by `EXECUTION_STORE_TYPE`.
>   `INTERRUPTED` joined the lifecycle states.
> - Replay divergence also binds the concrete path, and — for approved,
>   waiting and in-flight activities — the query and body.
> - `ApiClient` retries only GET, PUT and DELETE; a POST or PATCH is sent once.
> - Resume is `resolveExecution` → `ExecutionManager.beginRun`; there is no
>   `ExecutionManager.resume()`. The sealed `requestState` also carries
>   `userIdHash`, and `/executions` is bound to the execution's owner.
> - The SDK is 2.0.0 (not 2.0.0-beta.4).

Branch: `poc/aug28-governance` (from `mcp28_july_changes`). Requirements: [`requirements-aug28.md`](requirements-aug28.md).
Written 2026-08-28 after reading the code on that branch; nothing below is assumed.

## 1. What exists today (the Code Mode execution path)

```
MCP client ──tools/call api_execute {service, code}──▶ src/tools/execute-api.tool.ts
   auth (validateAuth → per-service AuthMiddleware)            │
   idempotencyKey = mcp-{service}-{userIdHash12}-{codeHash16}   │  one key per run (shared by every call)
                                                               ▼
                               src/runtime/sandbox/execute-api-in-sandbox.ts  (host bridge)
                                     runInSandbox(userCode)  ← isolated-vm, no network
                                       jail.__makeRequest(json)           ← the ONLY door out
                                         validateApiRequest → normalizeEndpointPath
                                         permissionGuard.canExecute → circuitBreaker.check
                                         apiClient.request()            ← ConnectorAPI (ApiClient/axios)
                                         circuitBreaker.recordSuccess, auditCollector.record, progressCollector
                                     BridgeViolation captured → throwIfViolated after the isolate settles
```

Facts that shape the design:

| Fact | Where | Consequence |
|---|---|---|
| Sandbox API is `api.request({method,path,params,body,headers})`, not `fetch()` | `execute-api.tool.ts:52-64`, bridge bootstrap `execute-api-in-sandbox.ts:253-268` | Activities are `api.request` calls. The requirements' `fetch()` examples map 1:1. |
| Every external call crosses `__makeRequest` | bridge line 142 | The activity journal, replay and governance hook in exactly one place (§16, §27). |
| Control-plane signals already use the *violation* pattern (`CircuitOpenError`, `PermissionDeniedError`) so user code cannot mask them | bridge lines 61-66, 111-120, 229-231, 271-282 | `APPROVAL_REQUIRED`, `GOVERNANCE_DENIED`, `REPLAY_DIVERGED` join the same mechanism (§27, §28, Invariant 9). |
| The isolate is disposed when the run ends; `onDispose` aborts in-flight calls | `sandbox-core.ts`, bridge line 136 | "Destroy V8 at the approval point" is the existing behaviour once the bridge refuses to continue. |
| One `McpServer` per request; HTTP transport stateless (`createMcpHandler`, `legacy:'reject'`) | `src/runtime/http/http-gateway.ts`, `mcp-server-factory.ts` | Execution state must live in a process-global store, never on the transport (§37, Invariant 11/12). |
| SDK v2 (2.0.0-beta.4) implements MRTR: handlers **return** `inputRequired({inputRequests, requestState})`; retries carry `ctx.mcpReq.inputResponses` + `ctx.mcpReq.requestState()`; `createRequestStateCodec` is an HMAC-SHA256 codec with TTL + principal binding; `ctx.mcpReq.elicitInput` **throws** on 2026-07-28 requests | `@modelcontextprotocol/server` `index.d.mts:325-427`, `createMcpHandler-*.d.mts:1350-1480` | Human approval = an elicitation embedded in an `input_required` result; resume = the client's retry of the same `tools/call` (§3, §24, §26). No custom MCP method. |
| Response `_meta` builder exists (`buildResponseMeta(appMeta)`), request `_meta` reader exists (`readRequestMeta`) | `src/tools/tool-helpers.ts` | Execution ids travel in `_meta` under a Harbor namespace (§36). |
| OpenAPI specs are dereferenced and held per service (`SpecStore.getSpec()`), but nothing resolves a concrete path to its template/`operationId`; `normalizeEndpointPath` is a digit heuristic | `src/runtime/spec/spec-store.ts`, `src/core/utils/url.ts:22-31` | A spec-path/operation resolver is new (§18). |
| Pluggable backends follow one pattern: `STORE_TYPE` discriminant in env → `resolveStoreTypeConfig` → registry + `build*Strategy` | `src/core/config/config.ts`, `src/wiring/strategy-builders.ts` | The execution store follows it (§39). Existing KV adapters (memcache/couchbase) are caches with TTL — not a fit for a durable journal; an in-memory store plus a file-backed store ship now, behind one SPI. |
| Skills are markdown under `services/<name>/skills/`, agent-facing | `src/runtime/registry/skill-store.ts` | Untouched (§2, Invariant 13). Governance Rules live elsewhere (`governance/rules/*.yaml`). |
| Tests: vitest, `tests/unit`, `tests/integration` (mock `axios`/connector), Python E2E | `vitest.config.ts`, `tests/` | New tests follow the same shapes. |
| `api-client.ts` retries 5xx up to `maxRetries` (existing) | `src/runtime/api-client/api-client.ts:105-175` | Left as is; documented under failure handling (§32). Network errors surface as thrown errors → activity outcome *unknown*. |

## 2. Gap analysis (requirement → status)

| § | Requirement | Status today | Change |
|---|---|---|---|
| 6 | Durable `executionId` | none (per-run `correlationId` only) | `ExecutionManager.create()`; id returned in result `_meta` |
| 7 | Persist original code; ignore replacement code on resume | none | `ExecutionRecord.originalCode`; resume ignores incoming `code` |
| 8 | Lifecycle states | none | `CREATED · RUNNING · WAITING_APPROVAL · COMPLETED · FAILED · DENIED · CANCELLED` |
| 9-13 | Activity journal, monotonic sequence, request/response records | none (audit line lists endpoints only) | `ActivityJournal` at the bridge; records persisted through `ActivityStore` |
| 14-15 | Replay, multiple approval rounds | none | bridge consults the journal before calling out; completed → stored response; approved → execute |
| 16-23 | Governance at the boundary, OpenAPI-aware, parameter conditions, declarative rules, evaluator, precedence, decision persistence | none (`PermissionGuard` admits everything) | `governance/rules/*.yaml` → zod schema → pure evaluator (DENY > REQUIRE_APPROVAL > ALLOW; no match → configured default); decisions persisted per activity |
| 24-26 | Human approval via MCP standard, bound to one activity, resume with fresh V8 | none | MRTR `input_required` + form elicitation; `requestState` = HMAC-sealed `{executionId, approvalId, activitySequence}`; retry resumes |
| 27-28 | Bridge owns replay/governance; sandbox untrusted | bridge exists | all new logic host-side; sandbox surface unchanged |
| 29-30 | Replay divergence; deterministic replay contract | none | method+resolved path recorded per activity; mismatch → `REPLAY_DIVERGED`, execution `FAILED` |
| 31 | Execution locking | none | in-process lock per `executionId` in the store (`EXECUTION_LOCKED`, retryable) |
| 32 | Failure handling | partial (typed sandbox errors) | activity outcomes `COMPLETED` (response, any status) vs `FAILED` (`outcomeKnown:false` when the transport threw) |
| 33-34 | Inspection + history | none | `GET /executions/{id}` on the gateway (bearer-authenticated); history derived from journal + approvals + decisions |
| 35 | Version context | none | rule `version` + content hash stored on each decision |
| 36 | `_meta` | response `_meta` builder exists | `harbor/execution-id`, `harbor/execution-status`, `harbor/approval-id` (vendor prefix is a placeholder — `META_PREFIX` constant, one edit to rename) |
| 37 | Transport stays stateless | already | unchanged |
| 38-39 | Data model + store SPI | none | `src/core/types/execution.types.ts`, `src/spi/execution/execution-store.ts`, `src/adapters/execution/{in-memory,file}-execution-store.ts` |
| 40 | Tests | 345 existing | per-step unit tests + acceptance integration test (§47) |

## 3. Design decisions (documented before implementation, per §22/§30)

1. **Identity.** `executionId` = UUIDv4 minted by Harbor. Activities are identified by `executionId + sequence`; no code hashing for identity (§11). The existing idempotency key keeps its per-run derivation and additionally gains `-{sequence}` so distinct calls in one run never collide (this also fixes a latent bug in the current key).
2. **Replay cursor.** The journal advances one sequence per `api.request` arrival. Replay of activity *N*: if a record exists and is `COMPLETED` → return the stored response (no call); if `APPROVED` → execute now; if `WAITING_APPROVAL` → pause again; if `DENIED`/`FAILED` → stop. A new sequence → governance.
3. **Divergence.** Each record stores `method`, `specPath` (resolved template, fallback normalized path) and `operationId`. A replay whose call at *N* has a different `method` or `specPath` fails closed with `REPLAY_DIVERGED` (§29). Bodies are recorded for audit but not compared (the requirements forbid making request hashing core).
4. **Precedence.** `DENY > REQUIRE_APPROVAL > ALLOW` among matched rules; no matching rule → `GOVERNANCE_DEFAULT_DECISION` (default `ALLOW`, so existing behaviour is preserved when no rules are configured). Evaluation errors (bad field access, unknown operator at runtime) → `DENY` with reason `GOVERNANCE_EVALUATION_FAILED` — fail closed.
5. **Rule shape.** `match: {service?, operation?, method?, path?}` (all present clauses must match; `operation` = OpenAPI `operationId`), `conditions: { <field>: { <op>: value } }` where `<field>` is `body.x.y`, `query.x`, `path.x`, or bare (`budget` ≡ `body.budget`); ops `equals, not_equals, greater_than, greater_than_or_equal, less_than, less_than_or_equal, in, not_in, exists, starts_with, contains`. No regex, no expressions.
6. **Approval carrier.** Primary: MRTR elicitation (`elicitation` client capability declared). The tool returns `input_required` with `inputRequests.approval` (form: `approve: boolean`, `comment?: string`) and a sealed `requestState`. Fallback for clients without elicitation: the tool returns an `isError` result `APPROVAL_REQUIRED` carrying `executionId`/`approvalId` in `_meta`; a decision is posted to `POST /executions/{id}/approvals/{approvalId}` and the client resumes by calling `api_execute` again with `_meta["harbor/execution-id"]`. Both paths converge on the same `ExecutionManager.resume()`.
7. **Approval outcome mapping.** `accept` + `approve:true` → `APPROVED`; `accept` + `approve:false` or `decline` → `REJECTED` (execution `DENIED`); `cancel` → `CANCELLED` (execution `CANCELLED`).
8. **Locking.** `store.acquireLock(executionId)` around every run; a second concurrent run gets `EXECUTION_LOCKED` (retryable). In-process only for the POC; the file store persists records, not locks (documented limitation).
9. **Storage.** `EXECUTION_STORE_TYPE=in-memory|file`. `file` writes one JSON document per execution under `EXECUTION_STORE_DIR` (default `./var/executions`) on every mutation and loads on boot — enough to survive a process restart for the POC without a new database.
10. **Nondeterminism boundary.** Replay reproduces the recorded responses, not wall-clock time or randomness. A program that branches on `Date.now()`/`Math.random()` before an external call can diverge; the divergence check catches method/path drift and stops. Documented, not solved (§30).

## 4. Implementation order (each step: code → tests → targeted run → full `npm test` → diff review → commit)

| Step | Capability | Files |
|---|---|---|
| 1 | Models + constants + typed errors | `src/core/types/execution.types.ts`, `src/core/constants.ts` |
| 2 | Store SPI + in-memory + file adapters + builder/env config | `src/spi/execution/execution-store.ts`, `src/adapters/execution/*`, `src/wiring/strategy-builders.ts`, `src/core/config/config.ts`, `src/core/types/config.types.ts` |
| 3 | ExecutionManager (create/load/lock/lifecycle/history) | `src/runtime/execution/execution-manager.ts` |
| 4 | Operation resolver (OpenAPI template matching) | `src/runtime/governance/operation-resolver.ts` |
| 5 | Activity journal + bridge interception + replay + divergence | `src/runtime/execution/activity-journal.ts`, `src/runtime/sandbox/execute-api-in-sandbox.ts` |
| 6 | Governance rules: schema, loader/store, evaluator, precedence, decision persistence | `src/runtime/governance/*` |
| 7 | Bridge governance hook (ALLOW/DENY/REQUIRE_APPROVAL) | bridge |
| 8 | Approval service + request-state codec | `src/runtime/execution/approval-service.ts`, `src/runtime/execution/request-state.ts` |
| 9 | Tool integration: execution lifecycle, MRTR `input_required`, resume, `_meta` | `src/tools/execute-api.tool.ts`, `src/runtime/http/mcp-server-factory.ts`, `src/runtime/server-factory.ts` |
| 10 | Inspection + fallback approval HTTP routes | `src/runtime/http/execution-routes.ts`, `src/runtime/http/http-gateway.ts` |
| 11 | Acceptance scenario (§47) integration test; MCP-level MRTR test | `tests/integration/*` |
| 12 | Docs, `.env.example`, CHANGELOG, `AGENTS.md`, demo rules | `docs/code-mode-governance.md`, … |
