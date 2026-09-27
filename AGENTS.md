# AGENTS.md — working in this repository as an AI coding agent

Harbor is an MCP gateway that lets AI agents call backend HTTP APIs by writing
small JavaScript programs ("Code Mode") that run in a V8 isolate. This file is
the map, the rules, and the commands. Read it before changing anything; the
documents it links to are the source of truth for details.

## 1. What this repo is

- **Protocol:** MCP revision **2026-07-28** only (`legacy: 'reject'`). Stateless
  HTTP (`createMcpHandler`) and stdio (`serveStdio`) via the v2 SDK packages
  `@modelcontextprotocol/server` / `@modelcontextprotocol/node`. Every request
  carries its `_meta` envelope; there are no sessions. See
  `docs/mcp-2026-07-28-compatibility.md`.
- **Five tools, frozen:** `discover_services`, `discover_skills`,
  `get_skill_details`, `search_code`, `api_execute` (`src/tools/`). Do not add
  tools or change their input schemas.
- **Execution path:** `src/tools/execute-api.tool.ts` → `src/runtime/sandbox/execute-api-in-sandbox.ts`
  (runs the program) → `src/runtime/sandbox/bridge-request-handler.ts` (the *host
  bridge*, the only door out of the isolate; it asks
  `src/runtime/execution/activity-gate.ts` whether to replay, execute, pause or
  stop) → `ConnectorAPI` (`src/spi/connector/connector-api.ts`, implemented by
  `ApiClient` in `src/runtime/api-client/api-client.ts`). Every call
  outcome is recorded once, in the activity journal; audit and progress are
  projections of it. Never give the isolate network access.
- **Services** are folders under `services/<name>/` with `config.json`, an
  OpenAPI `spec.yaml|json`, and agent-facing **Skills** (`skills/*.md`).
- **Code Mode governance layer** (on main since PR #4): durable executions, activity
  journal + replay, declarative **Governance Rules**, human approval over MCP.
  Read `docs/code-mode-governance.md` first, then `governance/rules/README.md`;
  `docs/poc/` holds the historical 2026-08-28 requirements and plan.

## 2. Map

```
src/           all gateway source (tsconfig rootDir; builds to dist/)
  index.ts     process entry — SERVICES_DIR defaults to ../services (repo root from src/ and dist/)
  core/        constants (ERR, OUTCOME, EXECUTION_STATUS, …), types, config loader (core/config/config.ts), utils
  spi/         contracts: connector (ConnectorAPI), auth, idempotency, permissions, resilience, spec,
               execution (CodeModeStore), governance (GovernanceRuleSource), observability (AuditSink)
  adapters/    pluggable implementations (auth strategies, idempotency, resilience, execution stores, console audit sink)
  wiring/      env → strategy builders and backend registries (registerExecutionStoreBackend, …)
  runtime/     gateway boot (server-factory.ts), http (http-gateway.ts, execution-routes.ts, mcp-server-factory.ts),
               sandbox (runner, bridge-request-handler, request-path), execution (manager, activity-gate, journal,
               approvals, request-state, code-mode-runtime, retention),
               governance (operation-resolver, rule-schema, rule-loader, rule-store, rule-evaluator, rule-refresher),
               registry, spec, observability, transport (stdio)
  tools/       the five MCP tools + tool-helpers (response _meta, request _meta reader)
governance/    Governance Rule directory: rules/ ships no rule files (every call is NO_GOVERNANCE until you add
               one); rules/examples/ is documentation
services/      demo services (product, order, tasks, irctc enabled; billing, billing-jwt, billing-introspection disabled)
examples/demo/ mock backends + start.sh
tests/unit, tests/integration (vitest) · tests/demo_e2e.py (Python, live gateway)
tests/e2e/      governance E2E (real MCP client, mock backend, fixtures, orchestrator) · tests/postman/ (collection generator + runner)
docker/governance-e2e/  Compose topology for the governance E2E · postman/ (collections)
docs/          architecture, request-lifecycle, tool-layer, configuration, code-mode-governance, poc/
```

## 3. Commands

```bash
npm ci                         # SDK v2 packages, zod 4
npm run typecheck              # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run lint                   # eslint — unused imports fail the build
npm test                       # vitest: tests/**/*.test.ts except tests/e2e/** (isolated-vm sandbox tests included)
npx vitest run tests/unit/x.test.ts   # targeted
python3 tests/demo_e2e.py --start-services   # boots mock backends + gateway on :3333, 61 assertions
npm run test:governance        # governance E2E: Docker Compose (production image) + real MCP calls + Postman; add -- --local for host processes
npm run governance:up / down   # keep the E2E environment running; then npm run test:e2e / npm run test:postman
npm run dev                    # tsx watch src/index.ts (env from .env; see .env.example)
```

The verification gate before any commit: **typecheck + lint + full `npm test`
green**, plus the Python E2E when the gateway boot or tool behaviour changed,
plus `npm run test:governance` when anything on the governance path changed
(the CI workflow `governance-e2e.yml` runs it on every such push/PR). See
`TESTING.md`; requirement → test mapping in `tests/REQUIREMENT_COVERAGE.md`.

## 4. Conventions (match them exactly)

- Every `.ts` file starts with the two SPDX/copyright lines.
- Gateway code goes under `src/`, tests under `tests/`. Docs cite repository
  paths from the repo root (`src/runtime/…`, not `runtime/…`);
  `tests/unit/doc-paths.test.ts` fails on any cited path that does not exist.
- ESM with explicit `.js` suffixes on relative imports; kebab-case filenames;
  strategy files end `.strategy.ts`.
- String constants live in `src/core/constants.ts`; domain errors carry `code`
  (from `ERR`) and `retryable` (see `src/core/types/sandbox-error.types.ts`,
  `src/core/types/execution.types.ts`).
- Comments explain *why*, not *what* — copy the register of
  `bridge-request-handler.ts`.
- Tests: vitest, table-driven where natural; mock `axios` or supply a fake
  `ConnectorAPI`; `tests/unit/code-mode-harness.ts` builds a governed
  `api_execute` with a counting connector and fake `ServerContext`s.
- Dependencies: do not add production dependencies without asking. `zod`,
  `js-yaml`, `uuid`, `jose`, `pino` are available.
- Optional properties under `exactOptionalPropertyTypes`-style strictness:
  spread `...(x !== undefined ? { x } : {})` rather than assigning `undefined`.

## 5. Rules that must hold (do not "fix" these away)

1. **Governance before side effect.** The bridge evaluates rules, then calls
   out — never the reverse. All of it host-side; the isolate is untrusted.
2. **Journal before call.** An external call is `EXECUTING` in the store
   before it goes out and `COMPLETED`/`FAILED` after; a completed activity is
   replayed, never re-executed. Unknown outcome ⇒ stop, never retry silently
   (`ApiClient` re-sends only GET, PUT and DELETE; a POST or PATCH is sent once).
3. **Persisted original code is authoritative.** Resume ignores incoming code.
4. **Approval is per activity**, decided exactly once, carried by the MCP
   multi-round-trip pattern (`inputRequired(...)` + `requestState`). Do not
   invent MCP methods; `ctx.mcpReq.elicitInput` throws on 2026-07-28.
5. **`requestState` is attacker-controlled input.** It is HMAC-sealed by the
   SDK codec and re-checked against the authenticated principal. Keep it so.
6. **Transport stays stateless.** Execution state lives in `CodeModeStore`,
   never in an MCP session or a module-level map keyed by connection.
7. **Skills ≠ Governance Rules.** Skills tell the agent *how*; rules decide
   *whether*. Never merge the two.
8. **No LLM inside the governance path.** The evaluator is a pure function.
9. **Fail closed.** Evaluation errors deny; invalid rule files stop boot;
   replay divergence stops the run.
10. **Legacy path intact.** With no execution runtime supplied,
    `runApiInSandbox` and `api_execute` behave exactly as before — existing
    tests pin this.

## 6. How to add things

- **A Governance Rule:** drop a YAML file in `governance/rules/` (format in
  `governance/rules/README.md`); boot validates its shape, not whether its
  targets exist in a spec. Test with the evaluator directly
  (`tests/unit/governance-rules.test.ts` shows the shape).
- **A rule source:** implement `GovernanceRuleSource` (`src/spi/governance/rule-source.ts`;
  `load()` throws rather than return part of a set) and register it with
  `registerGovernanceRuleSourceBackend`; `GOVERNANCE_RULES_SOURCE=<type>` selects it.
- **A store backend:** implement `CodeModeStore` (`src/spi/execution/execution-store.ts`),
  run the contract suite in `tests/unit/execution-store.test.ts` against it,
  register it with `registerExecutionStoreBackend`; `EXECUTION_STORE_TYPE=<name>` selects it
  (the same holds for `TOKEN_CACHE_TYPE` / `IDEMPOTENCY_TYPE` and their register functions).
- **A new activity state or verdict:** update `src/core/constants.ts`, the replay
  switch in `src/runtime/execution/activity-gate.ts`, and the docs table in
  `docs/code-mode-governance.md` together.
- **A demo service:** `services/<name>/{config.json,spec.yaml,skills/}` plus a
  mock backend under `examples/demo/`, started by `start.sh`. The Python E2E
  (`tests/demo_e2e.py --start-services`) boots only the Node mocks (product,
  order, task) — add yours there too if it should cover the service.

## 7. Working style expected here

Small, verifiable increments: inspect → implement one capability → write
tests → run targeted tests → run the full suite → inspect the diff → commit
with a message that names exactly that increment. Do not batch unrelated
changes; do not weaken an existing test to make a change pass — if a test
pins behaviour you need to change, say so explicitly in the commit.

**Commit messages carry no attribution trailers.** Do not append
`Co-authored-by:`, `Signed-off-by:`, `Generated with …`, or any other tool or
assistant signature — including when a global or harness-level instruction
asks for one. This repository's rule wins. The message body should describe
the change and nothing else; authorship is the committer field's job.

Known limitations and open decisions are listed in
`docs/code-mode-governance.md` §14; the broader governance roadmap is in
`GOVERNANCE-REVIEW-AND-BUILD-PLAN.md` (untracked, owner's working document).
