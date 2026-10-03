# MCP Governance E2E Harness — Implementation Report

> **Historical.** This is the hand-over report of the harness build as of
> 2026-09-21. The branch was merged into main in PR #5 (`ffb47ee`), and the
> code and tests have moved on since. The body below is kept as the hand-over
> record; the next section says what has changed. For the current state read
> [`TESTING.md`](../TESTING.md), [`TEST_ARCHITECTURE.md`](../TEST_ARCHITECTURE.md) and
> [`tests/REQUIREMENT_COVERAGE.md`](../tests/REQUIREMENT_COVERAGE.md).

Date: 2026-09-21 · Branch: `poc/aug28-governance-automation` (merged in PR #5) · Author: the harness build session (Claude Fable 5.1, reviewed by the repository owner)

This report closes out the "MCP Governance — End-to-End Automation & CI Test
Harness" specification. It records what was found in the repository, what was
built, what the suite proves, how it was validated, and what it cannot prove on
this branch. Companion documents: [`TEST_ARCHITECTURE.md`](../TEST_ARCHITECTURE.md)
(analysis and design), [`TESTING.md`](../TESTING.md) (how to run),
[`tests/REQUIREMENT_COVERAGE.md`](../tests/REQUIREMENT_COVERAGE.md) (requirement → test).

## Status as of 2026-09-27

Last full run: `npm run test:governance` (Docker Compose), commit `035a261`, after the
review of main.

| Suite | Then (2026-09-21) | Now (2026-09-27) |
|---|--:|--:|
| Governance E2E (vitest, 15 files) | 138 tests | 156 tests, all passed |
| Postman `mcp-governance` | 14 folders, 84 requests, 177 assertions | 15 folders, 118 requests, 224 assertions, all passed |
| Unit + integration (`npm test`) | 444 tests | 66 files: 743 passed + 1 skipped |

The §K findings for the owner:

| # | Finding | Status |
|---|---|---|
| 1 | A program can override the outbound `Authorization` header | **Resolved** by 24bdc72: identity, Harbor-owned and routing headers a program sets are dropped. The pinned test is now `bypass › should_not_let_program_supplied_headers_change_the_outbound_identity_or_routing`. |
| 2 | An uncaught backend timeout is reported as `SANDBOX_TIMEOUT` | **Resolved** by a46d977: errors are classified by what happened; this one is `SANDBOX_RUNTIME` (execution `FAILED`, not retryable). The test is now `failures › should_report_an_uncaught_backend_timeout_as_a_runtime_error_not_a_sandbox_timeout`. |
| 3 | Any valid bearer can inspect and decide another principal's execution over `/executions/*` | **Resolved** on main by owner binding (3cbc9df, 12ca119): anyone but the owner gets 403 and the approval stays pending. Pinned by `authorization › should_bind_http_inspection_and_decisions_to_the_execution_owner`. |
| 4 | `Dockerfile` `HEALTHCHECK` resolves `localhost` to IPv6 on Alpine | **Open.** |

What has changed since hand-over, so the body no longer says it:

- A POST that gets a 5xx or times out is sent once, not retried (78ead14); only GET, PUT and DELETE are retried. The §D/§H "500 retried once" case is now `failures › should_not_retry_a_post_that_got_a_500_and_journal_the_activity_as_failed_with_unknown_outcome`.
- The default decision is DENY and applies only to a call some rule targets but none matches (`NO_MATCHING_RULE`); a call no rule targets is ALLOW `NO_GOVERNANCE` (5928732). The §D "default ALLOW with `NO_MATCHING_RULE`" case is now `allow › should_allow_an_ungoverned_call_when_no_rule_targets_it`.
- A resume while the approval is still pending gets the pause again rather than `EXECUTION_NOT_RESUMABLE` (4f9a832). A stale answer is not applied; the current approval is reissued (`authorization › should_not_apply_a_stale_answer_and_reissue_the_current_approval`).
- A terminal execution's `originalCode` is dropped by default (`EXECUTION_CODE_RETENTION`, 79622ee).
- Each service can refresh its own rules using `governance.rulesRefreshSec` in `config.json` (66f7b41); a `memcache` store shares the journal and run lock across pods (0a9dc25).
- Replay binds the approved request: `APPROVED`, `WAITING_APPROVAL` and `EXECUTING` records bind query and body as well as method and path (241d217).
- The bridge logic the §K mutations targeted now lives in `src/runtime/sandbox/bridge-request-handler.ts` and `src/runtime/execution/activity-gate.ts` (see `TESTING.md`).
- Per-file E2E counts in §D changed: approval 12 → 14, bypass 8 → 22, idempotency 7 → 8, protocol 24 → 25.

`poc/sept01-governance`, which §K names for principal-aware rules, was never merged: rules on
main still see no principal. The review's still-open items are listed in
[`tests/REQUIREMENT_COVERAGE.md`](../tests/REQUIREMENT_COVERAGE.md#open-items-from-the-2026-09-27-review-not-fixed-decisions-for-the-owner).

## Verification at hand-over (2026-09-21)

Last full run, Docker Compose mode (`npm run test:governance`), on the production image:

| Suite | Count | Result |
|---|--:|---|
| Governance E2E (vitest, 15 files) | 138 tests | 138 passed, 0 skipped |
| Postman collection (14 folders, 84 requests) | 177 assertions | 177 passed |
| Existing unit + integration (`npm test`) | 444 tests | 444 passed |
| `npm run typecheck`, `npm run typecheck:e2e`, `npm run lint` | | clean |
| Mutation validation (6 injected defects) | 6 | all detected, all reverted |

Commits on the branch (local increments, in order):

| Commit | Increment |
|---|---|
| `86a7efa` | E2E infrastructure — mock backend, fixtures, Compose topology, orchestrator |
| `d3b74ab` | Real MCP 2026-07-28 client, gateway/mock control clients, scenario diagnostics |
| `68a3aae` | Governance behaviour suite over real MCP calls (138 tests, 15 files) |
| `dc95ea8` | Postman collection generator + environment + dependency-free runner |
| `cbdbc5d` | `governance-e2e.yml` GitHub Actions workflow |
| `09f631b` | TEST_ARCHITECTURE, TESTING, REQUIREMENT_COVERAGE; AGENTS/README/CHANGELOG pointers |

No production source was changed. The three pre-existing untracked owner files
(`GOVERNANCE-REVIEW-AND-BUILD-PLAN.md`, `PROJECT-GOALS.md`, `examples/demo/irctc-agent/`)
were left untracked on purpose.

---

## A. Repository understanding

- **Protocol.** MCP revision 2026-07-28 only (`legacy: 'reject'`), SDK v2 `@modelcontextprotocol/server` 2.0.0. Stateless Streamable HTTP: one `McpServer` per request, no `initialize`, no session id; `server/discover` is the probe. Every `POST /mcp` needs `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (for `tools/call`) and the `_meta` envelope; the SDK answers `-32022` (unsupported version), `-32602` (missing envelope), `-32020` (header/body mismatch), `-32600` (batches) before Harbor runs. Tool-argument validation failures are `isError` tool results, not JSON-RPC errors.
- **Tools.** Exactly five, frozen; `api_execute { service, code }`.
- **Auth.** Bearer format enforced at the transport (JWT or ≥ 32 base64url chars, else 401 with a `reason`). The E2E services use `static-token`, which forwards the client bearer unchanged and derives the principal as `sha256(bearer)` — distinct bearers are distinct principals.
- **Governance.** At the host bridge, before every outbound call: resolve the OpenAPI operation → evaluate YAML rules (`match` on service/operation/method/path template, `conditions` on body/query/path values, `DENY > REQUIRE_APPROVAL > ALLOW`, configurable default) → persist the decision with `name@version#hash12` tags → execute / stop / pause. Invalid rule files stop boot. Rules carry **no principal attributes** (still true on main).
- **Execution.** A workflow is the agent's JavaScript program; each `api.request()` is activity #N. Pause = activity `WAITING_APPROVAL`, run-stopping violation (every later call in that isolate refused), isolate disposed, `input_required` + `elicitation/create` form + HMAC-sealed `requestState` (TTL, bound to `tools/call`, carries `userIdHash`). Resume reruns the **stored** program in a fresh isolate, replays `COMPLETED` activities from the journal, executes the `APPROVED` one, governs new ones. Fallback for clients without elicitation: `APPROVAL_REQUIRED` + ids, `POST /executions/{id}/approvals/{approvalId}`, resume via `_meta["harbor/execution-id"]`. Explicit 4xx statuses are journaled `COMPLETED` (replayable); a 5xx after retries and transport failures are `FAILED` with `outcomeKnown:false` and are never repeated; an `EXECUTING` record found after a crash re-executes only for `GET`. Per-execution in-process lock; terminal or pending-approval executions are `EXECUTION_NOT_RESUMABLE`.
- **Persistence.** `in-memory` or `file` (one JSON document per execution, written through before the next step). The rules engine, store and approval channel are embedded in the gateway — no separate services exist to containerise.
- **Existing tests.** Unit and integration layers exercise the real governance path with fake connectors and a fake `ServerContext`; the Python smoke covers the five tools and auth strategies. Nothing exercised a real listener, real downstream HTTP, container lifecycle, the file store across a restart, TTL expiry, the fail-closed default, boot refusal, or a Postman flow.

## B. Governance requirements identified

Thirty stable ids, RG-001 … RG-030, derived from `docs/poc/requirements-aug28.md` (R§6–§47) and `docs/code-mode-governance.md` (D§6–§14): durable execution id, authoritative original code, lifecycle states, activity journal, replay without re-execution, multiple approval rounds, governance before side effect / no sandbox bypass, OpenAPI-aware targeting, request-value conditions, deterministic evaluator without an LLM, precedence + default, decision persistence with rule versions, approval over MCP elicitation, approval bound to one activity, fresh isolate on resume, bridge-owned governance, replay divergence, execution locking, failure handling, inspection + history, namespaced `_meta`, stateless transport, restart durability, bearer auth + principal binding, `requestState` integrity, fail closed, HTTP fallback, decide-once, the §47 acceptance scenario, MCP protocol correctness. The full table with sources is `TEST_ARCHITECTURE.md` §2.

## C. Test coverage

| Requirement | E2E | Postman | CI | Status |
|---|--:|--:|--:|---|
| RG-001 durable execution id | ✓ | ✓ | ✓ | PASS |
| RG-002 original code authoritative | ✓ | ✓ | ✓ | PASS |
| RG-003 lifecycle states | ✓ | ✓ | ✓ | PASS |
| RG-004 activity journal | ✓ | ✓ | ✓ | PASS |
| RG-005 replay without re-execution | ✓ | ✓ | ✓ | PASS |
| RG-006 multiple approval rounds | ✓ | ✓ | ✓ | PASS |
| RG-007 governance before side effect / no bypass | ✓ | ✓ | ✓ | PASS |
| RG-008 OpenAPI-aware targeting | ✓ | ✓ | ✓ | PASS |
| RG-009 request-value conditions | ✓ | ✓ | ✓ | PASS |
| RG-010 deterministic, no LLM | ✓ | ✓ | ✓ | PASS |
| RG-011 precedence + default | ✓ | ✓ | ✓ | PASS |
| RG-012 decision persistence + rule versions | ✓ | ✓ | ✓ | PASS |
| RG-013 approval over MCP elicitation | ✓ | ✓ | ✓ | PASS |
| RG-014 approval per activity | ✓ | ✓ | ✓ | PASS |
| RG-015 fresh isolate on resume | ✓ | ✓ | ✓ | PASS |
| RG-016 bridge owns governance, sandbox untrusted | ✓ | ✓ | ✓ | PASS |
| RG-017 replay divergence | ✓ | — (needs a clock wait) | ✓ | PASS |
| RG-018 execution locking | ✓ | — (needs concurrency) | ✓ | PASS |
| RG-019 failure handling | ✓ | ✓ | ✓ | PASS |
| RG-020 inspection + history | ✓ | ✓ | ✓ | PASS |
| RG-021 namespaced `_meta` | ✓ | ✓ | ✓ | PASS |
| RG-022 stateless transport | ✓ | ✓ | ✓ | PASS |
| RG-023 restart durability | ✓ | — (needs container control) | ✓ | PASS |
| RG-024 bearer auth + principal binding | ✓ | ✓ | ✓ | PASS |
| RG-025 requestState integrity | ✓ | ✓ | ✓ | PASS |
| RG-026 fail closed (boot refusal, default DENY) | ✓ | — | ✓ | PASS |
| RG-027 HTTP fallback approval | ✓ | ✓ | ✓ | PASS |
| RG-028 approval decided once | ✓ | ✓ | ✓ | PASS |
| RG-029 §47 acceptance end to end | ✓ | ✓ | ✓ | PASS |
| RG-030 MCP 2026-07-28 correctness | ✓ | ✓ | ✓ | PASS |

The per-test mapping, including the pre-existing unit/integration tests per requirement, is in `tests/REQUIREMENT_COVERAGE.md`.

## D. Test inventory

All files live in `tests/e2e/governance/`; each names its requirement ids at the top. Names follow `should_<behaviour>_when_<condition>`; one behavioural claim per test.

| File | Tests | What is proven |
|---|--:|---|
| `protocol.test.ts` | 24 | health advertises 2026-07-28 and the E2E services; `server/discover` lists one version and tools-only capabilities; exactly five tools with the fixed `api_execute` schema; legacy `initialize` → `-32022`; a seven-row header/envelope matrix (`-32022`, `-32602`, `-32020`); batches `-32600`; invalid JSON `-32700`; unknown method `-32601`; unknown tool `-32602`; four argument-validation cases return `isError` results and execute nothing; unknown extra arguments ignored; no session id issued and a client-supplied one ignored; `_meta` keys are vendor-prefixed; `GET /mcp` refused |
| `authentication.test.ts` | 9 | five rejected bearer shapes on `/mcp` (401 + reason code, nothing executed); 401 on the execution routes; an unknown identity is forwarded and the backend 401 is journaled as an explicit, replayable outcome; an expired-looking JWT is forwarded unchanged under static-token; executions are scoped per principal and never persist the bearer |
| `allow.test.ts` | 7 | one downstream call with decision, rule version tag, journal record and forwarded identity asserted; default ALLOW with `NO_MATCHING_RULE`; identity forwarded per caller; normal order allowed; the 10 000 boundary is not high value; method + wildcard-path rule; update allowed when only the allow rule matches |
| `deny.test.ts` | 8 | delete stops before the call, execution `DENIED`, zero DELETE requests, order still present; restricted `customer-002` denied though a broader allow matches; the unrestricted resource works; admin user creation denied; DENY wins over ALLOW; REQUIRE_APPROVAL wins over ALLOW; a denied execution is not resumable; declined high-value order executes nothing |
| `approval.test.ts` | 12 | elicitation form, message contents and sealed state; accept executes exactly once and completes with `runCount` 2; decline, cancel and `approve:false` execute nothing and end the execution; retry without an answer re-asks with the same approval; approval bound to the activity's operation and values; HTTP fallback: `APPROVAL_REQUIRED` with ids, accept then resume by id, decline then refused resume, resume refused while pending, body validation |
| `multi-step.test.ts` | 6 | the four-step workflow with approvals at steps 2 and 3, asserted from the MCP result, the store and the backend log at every pause (see §E); deny first; approve then deny; step 3 denied by rule after step 2 was approved; approval at the final step; two principals' workflows independent under concurrency |
| `lifecycle.test.ts` | 8 | one execution id across every round trip; fresh-isolate proof; refused calls after a swallowed pause; empty program; every lifecycle state visible; restart survival with the file store; SIGKILL mid-POST → `ACTIVITY_OUTCOME_UNKNOWN`, no repeat; SIGKILL mid-GET → safe re-execution |
| `replay.test.ts` | 8 | completed GET and POST replayed without backend calls; a recorded 404 replays as is; replacement code ignored on both resume paths; a completed execution is not re-run and exposes its persisted result; query/body/path params journaled, headers never; `REPLAY_DIVERGED` from a clock-branching program with nothing executed; a FAILED activity never repeated |
| `idempotency.test.ts` | 7 | duplicate MRTR answer, duplicate HTTP decision (409), duplicate resume; two simultaneous answers and two simultaneous resumes yield one run and one side effect; distinct idempotency keys per activity; identical submissions are separate executions by design |
| `authorization.test.ts` | 11 | tampered state refused before the tool runs; another principal cannot answer or resume; service mismatch refused; stale state from an earlier activity refused; replayed state after completion refused; cross-execution approval path 404; manipulated ids reported, not created; non-string `_meta` id ignored; state on the wrong method never decides; `known_gap` any-bearer HTTP inspection/decision |
| `failures.test.ts` | 18 | six explicit statuses journaled `COMPLETED` without retry; 500 retried once then `FAILED` with unknown outcome; backend timeout journaled unknown; middle-step failure keeps step 1; sandbox timeout → `INTERRUPTED`; syntax and runtime errors; call and concurrency limits; invalid request shape; unknown service; unmatched path; `known_quirk` timeout misclassification |
| `bypass.test.ts` | 8 | no network or host globals in the isolate; the raw bridge reference is still governed; swallowed denial cannot continue; a later step invoked directly is governed on its own; a resume cannot change resource or action; forged `_meta` status/approval ignored; spoofed envelope ignored; `known_gap` outbound Authorization override |
| `audit.test.ts` | 6 | decisions carry reason, rule identity, version and hash; hash stable across executions; approvals record who, when and comment; chronological history with the real ordering guarantees; terminal reasons and results; 404 / 405 on the route |
| `defaults.test.ts` | 5 | strict instance: default DENY for unmatched operations; explicit ALLOW still works; approval round trip within TTL; expired state refused while the HTTP channel still decides; a state minted by the other instance refused |
| `boot.test.ts` | 1 | the real gateway (Docker image in Compose mode, `src/index.ts` locally) refuses to start on an invalid rule file and says why |

## E. Multi-step approval flow — how the test proves it

Program: `GET /customers/{id} → POST /orders (amount > 10 000) → POST /payments → POST /notifications`, rules: ALLOW · REQUIRE_APPROVAL · REQUIRE_APPROVAL · ALLOW.

1. **Run 1.** MCP result is `input_required` whose elicitation names *Activity #2* and `createOrder`. `GET /executions/{id}`: `WAITING_APPROVAL`, `runCount` 1, `currentActivity` 2, activities `[COMPLETED, WAITING_APPROVAL]`, one `PENDING` approval bound to sequence 2, decisions `[ALLOW, REQUIRE_APPROVAL]`. Backend log: exactly `[GET /customers/customer-001]`.
2. **Approval 1 → Run 2.** The accept retry returns a second `input_required` for *Activity #3* with a **different approval id and a different sealed state**; its body shows `"orderId":"order-001"`, taken from the replayed order response — the program's state was restored from the journal, not recomputed. Backend log: `[GET, POST /orders]` — the GET was replayed, not re-issued. Store: `runCount` 2, activities `[COMPLETED, COMPLETED, WAITING_APPROVAL]`, activity 2 keeps approval 1's id, approvals `[APPROVED, PENDING]`.
3. **Approval 2 → Run 3.** Completed with statuses `[200, 201, 201, 201]` and ids `order-001 / payment-001 / notification-001`. Backend log: exactly four calls in program order across three isolates; the mock's state holds one order, one payment, one notification. Store: `COMPLETED`, `runCount` 3, `runIndex` `[1, 1, 2, 3]`, both approvals `APPROVED` via `mcp-elicitation`, decisions `[ALLOW, REQUIRE_APPROVAL, REQUIRE_APPROVAL, ALLOW]`, history ends with `EXECUTION:COMPLETED`.
4. **Isolate cleanup and recreation.** The program's first line is `const startedAt = Date.now()`; the final result's `startedAt` is asserted to be later than the second approval's `decidedAt`. A merely suspended isolate would have captured it before the first pause, so this value is only possible if the program restarted from the top in a new isolate after the human decided. The refused-calls test (`swallowPauseAndContinue`) shows that once paused nothing else in that isolate reaches the backend, and `runCount` counts the isolates.
5. **Persistence.** Separate lifecycle tests restart the real container (`docker compose restart`) while paused — the pending approval and the pre-restart `requestState` still work, thanks to the file store and the fixed HMAC key — and SIGKILL it mid-call to prove fail-closed resume.

## F. Replay

Pause-then-resume tests assert the backend log before and after the resume differs by exactly the newly approved call, that the resumed program consumed the stored responses (same `order-001`), and that a recorded 404 replays unchanged. Replacement code sent with either resume path is ignored (the original runs; `originalCode` is unchanged; no call from the replacement program reaches the backend). A completed execution cannot be resumed and its `result` is served from the store. Divergence is triggered deterministically: the program branches on a wall-clock threshold 1.5 s ahead; run 1 pauses on the early branch, the test waits for the clock to pass the threshold (a clock predicate, not a race), and the resume issues a different operation at sequence 2 → `REPLAY_DIVERGED`, execution `FAILED`, activity 2 left `APPROVED` without a response, nothing executed. A `FAILED` (outcome unknown) activity stops a later run with `ACTIVITY_OUTCOME_UNKNOWN` and is never repeated.

## G. Idempotency

Duplicate MRTR answers and duplicate `_meta` resumes after completion → `EXECUTION_NOT_RESUMABLE`, backend count unchanged. A second HTTP decision → 409 `APPROVAL_ALREADY_DECIDED`; the first decision stands. Two simultaneous answers to a slow (1.5 s) approved payment → one `completed`, one `EXECUTION_LOCKED` (retryable) or `EXECUTION_NOT_RESUMABLE`, one backend call; the same for two simultaneous `_meta` resumes. Idempotency keys carry the activity sequence (`…-1`, `…-2`, `…-3`, same prefix) and a replayed activity is never re-sent. Two fresh submissions with identical code and JSON-RPC id are two executions — documented design, pinned.

## H. Negative and security cases

Bearer: missing header, non-Bearer scheme, empty, short/low-entropy, over-long; unknown identity downstream; expired-looking JWT. `requestState`: tampered, garbage, expired (TTL 3 s), minted by the other instance, from another principal, stale from an earlier activity, replayed after completion, sent on the wrong method. Ids: unknown, well-formed unknown UUID, path traversal, SQL-shaped, 2000-char, non-string `_meta`, cross-execution approval path, unknown approval, unknown execution on the HTTP route. Forgery: `harbor/execution-status`/`approval-id`/`approved` in request `_meta`, spoofed `serverInfo` and capabilities. Sandbox: `fetch`/`require`/`process`/`XMLHttpRequest`/`WebSocket`/`Buffer`/`setTimeout`/dynamic `import` absent; the raw `__makeRequest` reference still governed; swallowed pause and denial cannot continue; resumes cannot change resource, action, code or service; a later step invoked directly is governed on its own. Protocol: the header/envelope matrix, batches, invalid JSON, unknown method/tool, argument validation. Failures: every backend status, 500 retry-then-unknown, timeout, sandbox timeout/syntax/runtime, call and concurrency limits, invalid request shape, unknown service. Policy: default DENY, boot refusal on an invalid file.

## I. Postman

```bash
npm run governance:up               # Docker Compose (add -- --local for host processes); prints the env vars
npm run test:postman                # built-in runner → artifacts/postman/{junit.xml,results.json}
POSTMAN_RUNNER=newman npm run test:postman   # the identical collection through npx newman
npm run governance:down
```

Or import `postman/mcp-governance.postman_collection.json` and `postman/environments/local.postman_environment.json` into Postman and run the folders top to bottom: 01 Health · 02 MCP Discovery · 03 Allowed · 04 Denied · 05 Approval Required · 06 Approve + Resume (MRTR) · 07 HTTP Fallback Approval · 08 Multi-Step Workflow (two approvals) · 09 Approval Denial · 10 Replay & Inspection · 11 Idempotency · 12 Error Cases · 13 Security / Authorization · 14 Audit. Requests chain `executionId`, `approvalId` and `requestState` through collection variables; every request asserts semantic fields (`resultType`, tool error `code`, execution/activity/approval status, downstream call counts read from the mock control plane). The collection is generated by `npm run postman:build` (`tests/postman/build-collection.mts`) from the same programs and identities as the vitest suite. Because `postman/README.md` records the project's decision to keep newman out of `package.json` and CI, `tests/postman/run-collection.mjs` is a dependency-free Newman-compatible runner (the `pm.*` subset the collection uses; cli/junit/json reporters).

## J. GitHub CI

`.github/workflows/governance-e2e.yml` runs on every push and pull request touching `src/`, `governance/`, the Dockerfile, `docker/governance-e2e/`, `tests/e2e/`, `tests/postman/`, the Postman files, the E2E vitest config, `package*.json`, `tsconfig.json` and the workflow itself. Steps: `npm ci` → `typecheck` + `typecheck:e2e` → lint the suite → build the production Dockerfile with buildx (GHA layer cache) → `npm run test:governance -- --no-build` (compose up → health → boot refusal + E2E → Postman → `governance-test-summary.json` → container logs → down) → summary table in the job summary → always upload `artifacts/` (JUnit, JSON, logs, per-test failure dumps). The job fails when the image does not build, a container never becomes healthy, the boot check fails, any E2E test or Postman assertion fails, or setup fails; nothing is swallowed. Unit tests, the `npm audit` gate and the Python demo smoke remain in `ci.yml`.

## K. Known gaps, findings and validation

### Mutation validation (all detected, all reverted; the tree has no production change)

| Injected defect | Where | Detected by |
|---|---|---|
| DENY evaluated as ALLOW | `src/runtime/governance/rule-evaluator.ts` | `deny.test.ts` (5 of 8 fail) |
| REQUIRE_APPROVAL does not pause | `src/runtime/sandbox/execute-api-in-sandbox.ts` | `approval.test.ts` (12/12), `multi-step.test.ts` (6/6) |
| Resume not counted as a new run (`runCount`) | `src/runtime/execution/execution-manager.ts` | `lifecycle.test.ts` (2), `approval.test.ts` (4) |
| COMPLETED activity re-executed instead of replayed | bridge replay switch | `replay.test.ts` (4), `multi-step.test.ts` (4) |
| Later calls proceed after a denial/pause stopped the run | bridge run-stopping guard | `bypass.test.ts` (1), `lifecycle.test.ts` (1) |
| DENIED / COMPLETED execution resumable | `ExecutionManager.assertNotTerminal` | `multi-step.test.ts` (1), `deny.test.ts` (1), `replay.test.ts` (2) |

### Gaps that cannot be tested on this branch

- **Role- / user-based rules** ("readonly-user cannot WRITE", per-user resource access): rules carry no principal attributes here (`GovernanceRequest`); the policy matrix is per operation and request value. Identities are used for principal binding on resume and for downstream identity forwarding. Principal-aware rules exist on `poc/sept01-governance`.
- **Approval timeout**: only the `requestState` TTL exists; the stored approval never expires and the HTTP channel still decides it. Tested exactly as implemented (strict instance, TTL 3 s).
- **Policy versioning across a pause / rule reload**: rules load at boot; no reload endpoint. `ruleVersions` tags on decisions are tested.
- **Sessions**: none (2026-07-28); tested as absence. **stdio**: unit-tested only. **Body-level replay divergence**: not detected by design. **Multi-instance locking**: process-local lock; concurrency tests run against one instance.

### Findings for the owner (pinned as `known_gap_` / `known_quirk_` tests, deliberately not fixed by the harness)

1. **A program can override the outbound `Authorization` header** via `api.request({ headers: { Authorization: … } })` — `src/runtime/api-client/api-client.ts` spreads `apiRequest.headers` after the auth header, so the backend sees another identity (`bypass.test.ts › known_gap_program_supplied_headers_can_override_the_outbound_authorization_header`). Rules are unaffected on this branch (they do not read identity); backend authorization is. Recommended production fix: spread program headers first, or drop `Authorization` from them.
2. **An uncaught backend timeout is reported as `SANDBOX_TIMEOUT`** (`failures.test.ts › known_quirk_…`): `src/runtime/sandbox/sandbox-core.ts normalizeIsolateError` classifies any error message containing "timeout" as a sandbox timeout. The journal is right (activity `FAILED`, outcome unknown); only the tool-level code and message mislead.
3. **Any valid bearer can inspect and decide another principal's execution** over `/executions/*` (`authorization.test.ts › known_gap_…`), as documented in `docs/code-mode-governance.md` §14. The resume itself stays principal-bound.
4. **`Dockerfile` `HEALTHCHECK` uses `http://localhost:3333/health`**; alpine resolves `localhost` to `::1` while the gateway binds IPv4, so the container reports *unhealthy* under Docker 29. The Compose file uses `127.0.0.1`. A one-line Dockerfile change is recommended.
5. Observed and pinned semantics worth knowing: a sandbox timeout leaves the execution `INTERRUPTED` (retryable), not `FAILED`; `runIndex` is the run that first *encountered* an activity (a paused-then-executed activity keeps run 1); the governance decision is timestamped before the activity record exists, so history may show `GOVERNANCE:*#n` before `ACTIVITY:ENCOUNTERED#n`.
