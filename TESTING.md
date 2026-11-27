# Testing Harbor's MCP Governance

How to run every layer of the test suite, what each one proves, and how to
debug a failure. Architecture and rationale: [`TEST_ARCHITECTURE.md`](TEST_ARCHITECTURE.md).
Hand-over report (findings, validation, gaps): [`docs/governance-e2e-report.md`](docs/governance-e2e-report.md).
Requirement → test mapping: [`tests/REQUIREMENT_COVERAGE.md`](tests/REQUIREMENT_COVERAGE.md).

## Layers

The structural regression suite `tests/unit/layer-boundaries.test.ts` runs
with `npm test`. It prevents implementations or compatibility shims in SPI,
outward core/adapter dependencies and direct runtime/tool imports of adapters.
Every provider interface must have exactly one declaration, in SPI, not core.
Documentation paths and anchors are checked by `tests/unit/doc-paths.test.ts`.

| Layer | Command | What it exercises | Needs |
|---|---|---|---|
| Unit + integration | `npm test` | evaluator, journal, store contracts, tool handler, sandbox bridge, API client, request-path canonicalisation (fake connectors or local listeners) — 73 files, 839 passed + 1 skipped | nothing |
| **Governance E2E** | `npm run test:governance` | **real MCP 2026-07-28 calls → real gateway (production image) → real rules → real V8 isolate → real HTTP → deterministic mock backend** (158 tests in 15 files), plus the Postman collection (15 folders, 118 requests, 232 assertions) | Docker (or `-- --local`) |
| Demo smoke | `python3 tests/demo_e2e.py --start-services` | the five tools, the shopping workflow (product inventory → order → approval Yes / No → denied delete), the shopping demo Postman collection and the auth strategies against the demo services | Python 3.9+, Node 24 |

Focused PR #8 follow-up regressions:

```bash
npx vitest run tests/integration/persistence-failures.test.ts tests/unit/governance-rules.test.ts tests/unit/url-utils.test.ts
```

These inject failures before/after a completion write and during lock release,
check unreadable status reporting without repeating backend calls, exercise
unusable claimed current bids in the example rules, and verify URL diagnostics
redact every query value rather than relying on credential parameter names.

## The governance suite in one command

```bash
npm run test:governance            # Docker Compose: build image → up → wait → boot check + E2E → Postman → summary → logs → down
npm run test:governance -- --local # same suite, gateway + mock as host processes (no Docker; ~1 s startup)
```

Flags `run` accepts (after `--`): `--local`, `--no-build` (Compose: reuse the
image already built, as CI does), `--keep` (leave the environment up when the
run fails, like `DEBUG_GOVERNANCE=true`), `--skip-e2e`, `--skip-postman`.
Arguments after a second `--` go to vitest
(`npm run test:governance -- --local -- -t replay`); with a single `--` npm
consumes it and nothing is forwarded. `governance:up` accepts
`--local` and `--no-build`; `governance:down` accepts `--local`. The last full
Compose run (2026-09-27, commit `035a261`) reported 380 passed: 156 E2E tests
and 224 Postman assertions.
The 2026-11-21 local release-readiness run reported 389 passed: 157 E2E tests
and 232 Postman assertions.

Exit code is non-zero if the image fails to build, a container never becomes
healthy, any E2E test fails, any Postman assertion fails, or the setup itself
fails. Nothing is swallowed.

Output lands in `artifacts/` (git-ignored):

```
artifacts/
  governance-test-summary.json     { total, passed, failed, skipped, status, e2e: {...}, postman: {...} }
  e2e/junit.xml · e2e/results.json (vitest)
  e2e/failures/<file>/<test>/      context.json · mcp-transcript.json · executions.json · downstream-requests.json
  postman/junit.xml · postman/results.json (Newman-shaped)
  logs/harbor.log · logs/harbor-strict.log · logs/mock-api.log (container or process logs)
  executions/                      the main gateway's file store (bind mount) — one JSON document per execution
```

## Step by step

```bash
npm run governance:up              # (add -- --local for host processes, -- --no-build to reuse the image) prints the env vars the tests read
npm run test:e2e                   # vitest E2E suite            (env must be up)
npm run test:e2e -- -- tests/e2e/governance/multi-step.test.ts   # one file (vitest args follow the second --)
npm run test:postman               # the Postman collection      (env must be up)
npm run governance:logs            # dump container logs to artifacts/logs
npm run governance:down
```

Environment contract (set automatically by the scripts; export them to run
vitest against any gateway you like):

| Variable | Meaning |
|---|---|
| `MCP_BASE_URL` | main gateway (`GOVERNANCE_DEFAULT_DECISION=ALLOW`, file store), e.g. `http://127.0.0.1:3333` |
| `MCP_STRICT_BASE_URL` | fail-closed gateway (`GOVERNANCE_DEFAULT_DECISION=DENY`, 3 s requestState TTL); absent ⇒ `defaults.test.ts` is skipped with a reason |
| `MOCK_API_URL` | mock backend + control plane, e.g. `http://127.0.0.1:4010` |
| `HARBOR_RESTART_CMD`, `HARBOR_KILL_CMD`, `HARBOR_START_CMD` | shell commands the lifecycle tests run to restart / SIGKILL / start the main gateway; absent ⇒ those three tests are skipped with a reason |
| `HARBOR_IMAGE` | gateway image (compose mode) used by the boot-refusal test; absent ⇒ the test boots `src/index.ts` with tsx |
| `E2E_HARBOR_PORT`, `E2E_HARBOR_STRICT_PORT`, `E2E_MOCK_API_PORT` | override the default ports 3333 / 3334 / 4010 (`--local` also uses `E2E_LOCAL_CONTROL_PORT`, default 4099, for its restart/kill hooks) |
| `DEBUG_GOVERNANCE=true` | keep the environment running after a failure, and write diagnostics for passing tests too |
| `POSTMAN_RUNNER=newman` | run the collection through `npx newman` instead of the built-in runner |

## Topology

`docker/governance-e2e/compose.yaml` starts three containers: `harbor`
(production `Dockerfile`, default decision ALLOW, file-backed store
bind-mounted on `artifacts/executions`, fixed `GOVERNANCE_REQUEST_STATE_KEY`),
`harbor-strict` (same image, default decision DENY, in-memory store,
`GOVERNANCE_APPROVAL_TTL_SEC=3`, and a three-rule set: ALLOW `ping`,
REQUIRE_APPROVAL `createPayment`, REQUIRE_APPROVAL `createOrder` over 10 000)
and `mock-api` (`tests/e2e/mock-api/server.mjs`, zero dependencies). The
default decision applies only to a call some rule targets but none matches
(`NO_MATCHING_RULE`) — on the strict instance that is a `createOrder` of
10 000 or less; a call no rule targets is ALLOW `NO_GOVERNANCE` on both
instances. Rules come from `tests/e2e/fixtures/governance/{default,strict}`,
services from `tests/e2e/fixtures/services` (`commerce`, `ops`). The policy
engine, the execution store and the approval channel are embedded in the
gateway in the shipped architecture, so there are no separate containers for
them — the suite tests the architecture as shipped.

## Fixtures

- **Identities** (`tests/e2e/fixtures/identities.json`): `alice`, `bob`, `admin`, `readonly-user`, `finance-user`, `untrusted-user` — fixed test-only bearers. The mock backend rejects `untrusted-user`.
- **Rules** (`tests/e2e/fixtures/governance/default/README.md` has the decision table): allow reads, restricted `customer-002`, high-value orders (> 10 000) and payments need approval, deletes and admin-user creation are denied, deliberately conflicting update rules prove precedence. Operations no rule targets (`getOrder`, `ping`, `unstableOperation`) are ungoverned: ALLOW `NO_GOVERNANCE`.
- **Programs** (`tests/e2e/fixtures/programs.ts`): the JavaScript workflows, including the four-step `read → order (approval) → payment (approval) → notification`.
- **Mock API**: `GET /ping` (echoes the caller's identity), `GET /customers/{id}[/payment-details]`, `POST /orders`, `GET/PATCH/DELETE /orders/{id}`, `POST /payments|/notifications`, `POST /admin/users`, `GET /admin/users`, `POST /unstable` (body `mode` or query `status`: any status 200–599, or `timeout` to hold the request), `?delayMs=` on anything; `GET /health`; control plane `GET /__admin/requests` (filter with `?method=&path=`), `POST /__admin/reset`, `GET /__admin/state`. Every logged request records the Harbor headers it arrived with (`X-Correlation-ID`, `X-Idempotency-Key`, `X-MCP-*`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `X-Harbor-Execution-ID`).

## Reading a failure

Every failing E2E test prints a block like

```
TEST FAILED
test: tests/e2e/governance/multi-step.test.ts :: should_pause_at_step_2_then_step_3_and_complete_after_both_approvals_with_every_call_exactly_once
executionId: 3f2c…
approvalId: 9a1e…
error: expected [ 'GET /customers/customer-001' ] to deeply equal [ … ]
diagnostics: artifacts/e2e/failures/tests_e2e_governance_multi-step.test.ts/should_pause_…
```

and the diagnostics directory holds the full MCP transcript (bearer
redacted), every touched execution's inspection (`GET /executions/{id}`:
activities, approvals, decisions, history), the mock backend's request log and
a `context.json` with all correlation ids (JSON-RPC ids, execution / approval
ids, downstream request-scoped `X-Correlation-ID`s and `X-Harbor-Execution-ID`s). In governed runs,
`X-Idempotency-Key` carries the execution/activity identity. Container logs are in `artifacts/logs/`.
Run with `DEBUG_GOVERNANCE=true` to keep the containers up and poke at them.

## Postman

```bash
npm run governance:up
npm run test:postman                                  # built-in runner → artifacts/postman/{junit.xml,results.json}
POSTMAN_RUNNER=newman npm run test:postman            # the same collection through npx newman
```

Or import `postman/mcp-governance.postman_collection.json` and
`postman/environments/local.postman_environment.json` into Postman and run the
folders top to bottom (they chain `executionId` / `approvalId` /
`requestState` through collection variables). The collection is generated by
`npm run postman:build` from the same programs and identities the vitest suite
uses; edit `tests/postman/build-collection.mts`, not the JSON.

The project keeps `newman` out of `package.json` and CI on purpose (see
`postman/README.md`), so `tests/postman/run-collection.mjs` is a small
dependency-free runner for Postman v2.1 collections that implements the `pm.*`
subset the collection uses (`pm.test`, `pm.expect` chai subset, `pm.response`,
`pm.environment` / `pm.collectionVariables` / `pm.variables`). It does not
support `pm.sendRequest`, `postman.setNextRequest`, iterations or data files.

## CI

`.github/workflows/governance-e2e.yml` runs on every push and pull request
that touches governance-relevant paths (`src/`, `governance/`, the Dockerfile,
`docker/governance-e2e/`, `tests/e2e/`, `tests/postman/`, the Postman files
and the workflow itself). Pipeline: `npm ci` → typecheck (gateway + E2E) →
lint → build the production image with buildx (GHA layer cache) →
`npm run test:governance -- --no-build` → publish a summary table to the job
summary → upload `artifacts/` (always) → `compose down`. The job fails when the
image does not build, a container is unhealthy, the boot-refusal check fails,
any E2E test or Postman assertion fails, or setup fails. Unit tests, the
`npm audit` gate and the Python demo smoke stay in `ci.yml`.

## Writing a new governance test

1. Name it `should_<behaviour>_when_<condition>`; one behavioural claim per test.
2. Get everything through `useScenario()` (`tests/e2e/helpers/diagnostics.ts`): `s().client('alice')`, `s().admin`, `s().mock`. The mock is reset before every test.
3. Assert all three angles: the MCP result, `s().admin.inspect(executionId)` (policy decision ≠ execution result), and `s().mock.calls()` (downstream side effects).
4. `s().track(executionId)` so a failure dumps its inspection.
5. Add the rule you need to `tests/e2e/fixtures/governance/default/` (numeric prefix = load order = precedence tie-break) and update that folder's README table.
6. Map the test to its requirement in `tests/REQUIREMENT_COVERAGE.md`.

## Mutation validation of the suite

The suite was validated (2026-09-21) by introducing each defect below into the
gateway, running the named test file, confirming it fails, and reverting
(nothing is left in the tree). The bridge logic has since moved out of
`execute-api-in-sandbox.ts`; "Where" names the file that holds that logic now.
Re-run the exercise after significant changes to the governance path.

| Defect introduced | Where | Detected by |
|---|---|---|
| DENY evaluated as ALLOW | `src/runtime/governance/rule-evaluator.ts` | `deny.test.ts` |
| REQUIRE_APPROVAL does not pause (executes immediately) | `src/runtime/execution/activity-gate.ts` (`ActivityGate.admit`, new-activity branch) | `approval.test.ts`, `multi-step.test.ts` |
| Resume does not count as a new run (no fresh isolate observable) | `src/runtime/execution/execution-manager.ts` (`runCount`) | `lifecycle.test.ts`, `approval.test.ts` |
| A COMPLETED activity is executed again on resume instead of replayed | `src/runtime/execution/activity-gate.ts` (`ActivityGate.admit`, replay switch) | `replay.test.ts`, `multi-step.test.ts` |
| Later calls proceed after a denial / pause stopped the run | `src/runtime/sandbox/bridge-request-handler.ts` (run-stopping guard) | `bypass.test.ts`, `lifecycle.test.ts` |
| A DENIED / COMPLETED execution can be resumed | `src/runtime/execution/execution-manager.ts` (`assertNotTerminal`) | `multi-step.test.ts`, `deny.test.ts`, `replay.test.ts` |
