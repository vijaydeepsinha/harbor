# Architecture

_Harbor 1.0.0 — Architecture Reference_
_Last updated: 2026-09-27_

---

## 1. System Overview

Harbor sits between an AI agent (Claude, Cursor, or any MCP client) and one or more backend microservices. It speaks the **Model Context Protocol (MCP)**, revision 2026-07-28 only, inbound and delegates outbound calls through the **ConnectorAPI** interface — HTTP/REST by default. The agent's program (the `code` of an `api_execute` call) runs inside a **V8 isolate**; it never touches the gateway process, filesystem or network directly. Its only way out is `api.request()`, and every such call passes the host bridge: path canonicalisation, the activity journal, Governance Rules, the permission guard and the circuit breaker, in that order, before anything goes on the wire.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AI Agent  (Claude / Cursor / any MCP client)                            │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │  MCP 2026-07-28 — Streamable HTTP (stateless) or stdio
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  HARBOR                                                                  │
│                                                                          │
│  src/runtime/http/  ─ /mcp (bearer format, body limit) · /health ·       │
│                       /.well-known/oauth-protected-resource* ·           │
│                       /executions/{id}[/approvals/{approvalId}]          │
│        │  one McpServer per request                                      │
│        ▼                                                                 │
│  src/tools/  discover_services · discover_skills · get_skill_details ·   │
│              search_code · api_execute                                   │
│        │                                                                 │
│        ▼                                                                 │
│  src/runtime/                                                            │
│   registry (services, specs, skills)   sandbox (isolate + host bridge)   │
│   execution (executions, journal,      governance (operation resolver,   │
│     activity gate, approvals,            rule store / evaluator,         │
│     requestState codec)                  rule refresher)                 │
│   api-client (ApiClient)   spec (refresher)   observability (audit,      │
│   gateway (service resources)                   metrics, logger)         │
│        │ contracts                         ▲ built by                    │
│        ▼                                   │                             │
│  src/spi/   auth · connector · execution (ExecutionPersistence) ·               │
│             governance (GovernanceRuleSource) · observability            │
│             (AuditSink) · idempotency · permissions · resilience · spec  │
│        ▲ implemented by                    │                             │
│  src/adapters/  auth · idempotency · execution · observability ·         │
│                 resilience · infra                                       │
│                                            │                             │
│  src/wiring/  composition root ────────────┘ builders, register*Backend  │
│  src/core/    constants, config, types, utils (imported by every layer)  │
└──────────────────────────────────────────────────────────┬───────────────┘
                                                           │  ConnectorAPI
                                                           ▼
                                            ┌─────────────────────────┐
                                            │  Backend microservices  │
                                            │  (HTTP / gRPC / any)    │
                                            └─────────────────────────┘
```

There is no session state anywhere: every MCP request gets its own `McpServer`, and everything that must outlive a request — executions, the activity journal, approvals — lives in the `ExecutionPersistence`.

---

## 2. Module Responsibilities

### `src/core/` — Framework Nucleus   ✅ Stable

Every other layer imports from here; nothing here imports from another Harbor layer. Its only third-party imports are `zod` (config validation), the `pino` logger type and the MCP SDK's reserved `_meta` key constants.

| File | Responsibility |
|------|----------------|
| `constants.ts` | String literals and enums — tool names, `ERR` codes, `OUTCOME`, `EXECUTION_STATUS`, `ACTIVITY_STATUS`, `GOVERNANCE_DECISION`/`GOVERNANCE_REASON`, HTTP routes and headers, `harbor/*` `_meta` keys, store type ids, metric names, log prefixes. Env var names are not here; they are the Zod keys in `config/config.ts` |
| `config/config.ts` | Zod validation of `process.env`; `MCP_CONFIG_FILE` loader (K8s ConfigMap, `KEY: value` lines); produces the typed `GlobalConfig`; exits on misconfiguration |
| `types/auth.types.ts` | `TokenPayload`, `AuthResult`, the `AuthError` hierarchy |
| `types/audit.types.ts` | `AuditRecord` — one `api_execute` call in the audit trail |
| `types/circuit-breaker.types.ts` | `CircuitState`, `CircuitOpenError` |
| `types/config.types.ts` | `GlobalConfig`, `ExecutionConfig`, `SandboxLimits`, `SandboxOverride`, `ServiceAuthConfig`, token-cache / idempotency / execution-store backend configs |
| `types/connector.types.ts` | `ApiRequest`, `ApiResponse`, `ExecuteRequestContext` — the transport contract types |
| `types/execution.types.ts` | `ExecutionRecord`, `ActivityRecord`, `ApprovalRecord`, `GovernanceDecisionRecord`; the `ExecutionError` hierarchy (`ApprovalRequiredError`, `GovernanceDeniedError`, `ReplayDivergedError`, `ExecutionLockedError`, …) |
| `types/logger.types.ts` | `Logger` (pino) |
| `types/metrics.types.ts` | `MetricsCollector` |
| `types/oauth.types.ts` | `OAuthResourceConfig`, `ProtectedResourceMetadata` (RFC 9728) |
| `types/permission.types.ts` | `PermissionDeniedError` |
| `types/sandbox-error.types.ts` | `SandboxError` hierarchy — timeout, memory, syntax, runtime, call limit, concurrency limit, invalid `api.request`, internal |
| `types/spec.types.ts` | `OpenAPISpec`, `SpecLoadError` |
| `utils/errors.ts` | `ensureError`, `errorCode`, `errorRetryable`, `errorMessage` |
| `utils/header-value.ts` | `SAFE_HEADER_VALUE`, `safeHeaderValue` — what may be forwarded as `X-Harbor-*` |
| `utils/url.ts` | `joinUrl`, `normalizeEndpointPath`, `redactUrl` |
| `utils/user-id-hash.ts` | `hashAuthenticatedPrincipal` — sha256 of `metadata.userId` when it is a non-empty string or finite number, else of the raw inbound bearer |

---

### `src/spi/` — Extension Contracts   ✅ Stable / 🟡 Experimental (execution, governance)

SPI = _Service Provider Interface_. Defines what the framework calls; `src/adapters/` (or third-party code) implements it. All provider interfaces live here, with declarative contracts only: no loaders, middleware or default strategies. Core holds shared data types, errors and configuration, not provider interfaces. `ExecutionPersistence` and `GovernanceRuleSource` belong to the Code Mode governance layer, new in 1.0.0, and may still gain members in a minor release (`API_STABILITY.md`).

This is a greenfield pre-release cleanup: former implementation and core-contract paths were removed, not kept as compatibility shims. `tests/unit/layer-boundaries.test.ts` checks declarative SPI files, unique contract declarations and dependency boundaries; lint rejects direct runtime/tool adapter imports.

| Contract | Interface | Default |
|----------|-----------|---------|
| `src/spi/auth/auth-strategy.ts` | `AuthStrategy` | — (chosen per service by `config.json` `auth.type`) |
| `src/spi/auth/token-cache.ts` | `TokenCacheStrategy` | in-memory adapter; shared base in `src/adapters/auth/abstract-token-cache.ts` |
| `src/spi/connector/connector-api.ts` | `ConnectorAPI` | `ApiClient` (HTTP/axios) |
| `src/spi/execution/execution-store.ts` | `ExecutionPersistence` — executions, activities, approvals, decisions, run lock | in-memory adapter |
| `src/spi/governance/rule-source.ts` | `GovernanceRuleSource` | `DirectoryRuleSourceStrategy` (`file`); `UrlRuleSourceStrategy` (`url`) — both in `src/adapters/governance/strategies/` |
| `src/spi/observability/audit-sink.ts` | `AuditSink`, `AuditEvent`, `ExecutionStateSnapshot` | `ConsoleAuditSink` (adapter) |
| `src/spi/idempotency/idempotency-strategy.ts` | `IdempotencyStrategy` | `NoopIdempotencyStrategy` in `src/adapters/idempotency/strategies/` |
| `src/spi/permissions/permission-guard.ts` | `PermissionGuard` | `ForwardTokenPermissionGuardStrategy` in `src/adapters/permissions/strategies/` (admits everything) |
| `src/spi/resilience/circuit-breaker.ts` | `CircuitBreakerStrategy` | `NoopCircuitBreakerStrategy` in `src/adapters/resilience/strategies/` |
| `src/spi/spec/spec-loader.ts` | `SpecLoaderStrategy` | file, URL and fallback loaders in `src/adapters/spec/strategies/` |

**`ConnectorAPI`**:
```typescript
// src/spi/connector/connector-api.ts
export interface ConnectorAPI {
  request(
    apiRequest: ApiRequest,       // canonical path, method, params, body, program headers
    ctx: ExecuteRequestContext    // tokenPayload, invalidate, idempotencyKey, idempotencyKeyTtlMs,
                                  // correlationId, clientId?, endpoint?, signal?
  ): Promise<ApiResponse>
}
```
`SandboxExecutionContext.apiClient` and `ServiceResources.apiClient` are typed as `ConnectorAPI`. `ApiClient` implements it and is what `src/runtime/gateway/service-resources-factory.ts` builds for every service. `ApiClient` is also where the outbound headers, the forbidden-header filter, retries, idempotency and the circuit breaker's `recordFailure` live — see [§5](#5-extension-points) before replacing it.

---

### `src/adapters/` — Built-in Implementations   ✅ Stable

Concrete implementations of `src/spi/` contracts, selected by env or `config.json`.
No-op and default strategies are implementations too: they belong here, not in SPI.
Adapter code depends only on core, contracts and other adapter support, never runtime, tools or wiring.

```
src/adapters/
├── auth/strategies/
│   ├── static-token.strategy.ts           forwards the caller's bearer; the config token is only a fallback
│   ├── oauth-introspection.strategy.ts    RFC 7662-style introspection (GET + query by default; method,
│   │                                      path, token placement and response mapping configurable);
│   │                                      honours `active`, relative `expires_in` or absolute `exp`
│   ├── jwt-validation.strategy.ts         local JWT verification via JWKS; exp required; RS/PS/ES/EdDSA only
│   ├── oauth-discovery.strategy.ts        OAuth 2.1 AS metadata discovery → JWKS → JWT verification
│   ├── resource-binding.ts                fail-closed `audience` check (jwt-validation, oauth-2.1)
│   ├── in-memory-token-cache.strategy.ts  Map + TTL eviction
│   ├── memcache-token-cache.strategy.ts   Memcache KV with TTL
│   └── couchbase-token-cache.strategy.ts  Couchbase KV with TTL
├── execution/
│   ├── in-memory-execution-store.ts       ExecutionPersistence in process memory (default); process-local lock
│   ├── file-execution-store.ts            in-memory store persisted to EXECUTION_STORE_DIR
│   └── memcache-execution-store.ts        shared across pods: records + run lock (add + TTL) in memcache
├── governance/strategies/
│   ├── directory-rule-source.strategy.ts filesystem rule documents
│   └── url-rule-source.strategy.ts       HTTP rule documents
├── idempotency/strategies/
│   ├── noop-idempotency.strategy.ts      pass-through, no deduplication
│   ├── in-memory-idempotency.strategy.ts  Map<key, result> dedup for the key TTL
│   ├── memcache-idempotency.strategy.ts
│   ├── couchbase-idempotency.strategy.ts
│   └── keygen.ts                          generateKey helper: mcp-{userIdHash}-{timestamp}-{random}
├── infra/
│   ├── couchbase-client.ts                Couchbase REST document client (http, basic auth)
│   └── memcache-client.ts                 memjs client factory
├── observability/
│   └── console-audit-sink.ts              AUDIT_SINKS=console: `audit` and `execution-state` log lines
├── permissions/strategies/
│   └── forward-token-permission-guard.strategy.ts delegates authorization to the backend
├── resilience/strategies/
│   ├── noop-circuit-breaker.strategy.ts  no circuit blocking
│   └── count-based-circuit-breaker.strategy.ts   OPEN after N failed calls per endpoint; one HALF_OPEN probe
└── spec/strategies/
    ├── file-spec-loader.strategy.ts
    ├── url-spec-loader.strategy.ts
    └── url-with-fallback-spec-loader.strategy.ts
```

Shared token-cache implementation is in `src/adapters/auth/abstract-token-cache.ts`.
Authentication orchestration and bearer parsing are in `src/runtime/auth/`:
`auth-middleware.ts` validates and refreshes through provider contracts;
`bearer-authorization.ts` and `bearer-header-parser.ts` handle inbound credentials.

`keygen.ts` backs `IdempotencyStrategy.generateKey`, which nothing in the request path calls; the key a backend call actually carries is built by the tool and the bridge — see [Idempotency keys](#idempotency-keys).

**External registration** — plug in custom backends without forking, then select them by name:
```typescript
// An entry point in src/, like src/index.ts. The register functions are in src/wiring/strategy-builders.ts
import {
  registerTokenCacheBackend, registerIdempotencyBackend, registerExecutionStoreBackend,
  registerAuditSinkBackend, registerGovernanceRuleSourceBackend
} from './wiring/strategy-builders.js'

// Called once at startup, before createMcpGateway()
registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs))
registerIdempotencyBackend('postgres', (config, logger) => new PostgresIdempotency(config))
registerExecutionStoreBackend('postgres', (config, logger) => new PostgresExecutionStore(config))
```
`TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE` and `EXECUTION_STORE_TYPE` accept a built-in type or any kebab-case name (`^[a-z][a-z0-9-]*$`); a per-service `config.json` `idempotency.type` may name a registered backend too. The builder checks the registry before its built-in switch and refuses a name nothing registered: at boot for the env vars, by skipping the service for `config.json`. `AUDIT_SINKS` resolves the same way. Governance Rule sources are registered
centrally but selected per service through `config.json`'s `governance` block.

---

### `src/runtime/` — Gateway Orchestration   ✅ Stable / 🟡 Experimental (sandbox, governance layer)

```
src/runtime/
├── server-factory.ts              boot: scan services, token cache, registry, audit pipeline, Code Mode
│                                  runtime, MCP server factory, transport; shutdown
├── api-client/
│   └── api-client.ts              implements ConnectorAPI: outbound headers (program may not set Harbor's or
│                                  routing ones), idempotency, retries for GET/PUT/DELETE, breaker recordFailure
├── gateway/
│   ├── service-resources-factory.ts   wires ServiceDefinition → ServiceResources
├── execution/                     Code Mode governance layer (see docs/code-mode-governance.md)
│   ├── execution-manager.ts       create / load / beginRun (run lock) / endRun / inspect / history
│   ├── activity-gate.ts           per call of a governed run: replay | execute | stop; governance for new activities
│   ├── activity-journal.ts        CallLog (the run's call outcomes) + ActivityJournal (durable activity record)
│   ├── approval-service.ts        human approvals bound to one activity; decide() exactly once
│   ├── request-state.ts           HMAC-sealed MRTR requestState codec (TTL, bound to the JSON-RPC method)
│   ├── execution-retention.ts     sweeps terminal executions after EXECUTION_RETENTION_SEC
│   └── governance-runtime.ts       process-wide execution/approval wiring plus per-service rule stores
├── governance/
│   ├── operation-resolver.ts      canonical path + method → OpenAPI template, operationId, path params
│   ├── rule-schema.ts             Zod schema of a Governance Rule (match, conditions, levels, final)
│   ├── rule-loader.ts             parses and validates rule documents; all-or-nothing
│   ├── rule-store.ts              the rule set in force; atomic swap
│   ├── rule-evaluator.ts          pure evaluateGovernance(): ALLOW | DENY | REQUIRE_APPROVAL + reason
│   └── rule-refresher.ts          per-service config reloads; a failed or emptying refresh keeps that service's set
├── http/
│   ├── http-gateway.ts            node:http server: /mcp, /health, protected-resource metadata, /executions
│   ├── read-body.ts               bounded body reader (413 PAYLOAD_TOO_LARGE + Connection: close)
│   ├── execution-routes.ts        GET /executions/{id}, POST /executions/{id}/approvals/{approvalId}; owner-bound
│   ├── mcp-server-factory.ts      per-request McpServer: registers the five tools, requestState.verify hook
│   ├── mcp-request-identity.ts    advisory MCP-Protocol-Version / Mcp-Method / Mcp-Name view (logging only)
│   ├── http-error.ts              typed HTTP error
│   ├── oauth-metadata-handler.ts  RFC 9728 protected resource metadata document
│   └── send-response.ts           JSON response helpers (sendJson, sendGatewayError)
├── observability/
│   ├── audit.ts                   AuditCollector — projection of the run's call log; writeAuditRecord
│   ├── audit-pipeline.ts          fans audit records and execution-state events out to the AUDIT_SINKS sinks
│   ├── logger.ts                  pino factory; pino-caller adds source location in non-prod
│   ├── metrics.ts                 MetricsRegistry — in-memory counters, logged as `metrics_flush` every 60 s
│   └── progress.ts                ProgressCollector — projection of the run's call log (per-call status, created ids)
├── registry/
│   ├── filesystem-scanner.ts      scans services/*: config.json, spec, skills/*.md → ServiceDefinition
│   ├── service-registry.ts        service name → ServiceResources
│   └── skill-store.ts             SkillMetadata[] of one service; atomic swap on refresh
├── sandbox/
│   ├── sandbox-core.ts            isolated-vm isolate lifecycle; wall-clock + CPU timeouts; error classification
│   ├── execute-api-in-sandbox.ts  runs one program: installs api.request, drains un-awaited calls, promotes violations
│   ├── bridge-request-handler.ts  the host bridge: per-call pipeline and the run's bookkeeping
│   ├── request-path.ts            canonicalises the api.request path once; refuses ambiguous spellings
│   ├── skills-search-in-sandbox.ts  discover_skills program over the skill list
│   └── spec-search-in-sandbox.ts    search_code program over the (permission-filtered) spec
├── spec/
│   ├── spec-store.ts              the service's dereferenced OpenAPI document; atomic swap
│   └── service-refresher.ts       per-service reload of spec + skills together; no overlapping refreshes
└── transport/
    └── stdio-gateway.ts           MCP over stdio (serveStdio, legacy: 'reject') for embedded / local use
```

---

### `src/wiring/` — Composition Root   ✅ Stable

The composition layer selects concrete implementations from `src/adapters/`.
`src/runtime/` reaches adapters only through wiring. The default permission
guard is selected here too. Synchronous rule-directory loading and its
missing-directory error are exposed here for the existing runtime convenience
API. No legacy path re-exports remain.

| File | Responsibility |
|------|----------------|
| `strategy-builders.ts` | Builders: `buildTokenCacheStrategy`, `buildIdempotencyStrategy`, `buildExecutionStore`, `buildAuditSinks`, `buildGovernanceRuleSource`, `buildSpecLoader`. Registration points: `registerTokenCacheBackend`, `registerIdempotencyBackend`, `registerExecutionStoreBackend`, `registerAuditSinkBackend`, `registerGovernanceRuleSourceBackend` |
| `service-wiring.ts` | `resolveAuth` — the `AuthStrategy` for a `ServiceAuthConfig` (no `auth` ⇒ the service is skipped; `audience` required for `jwt-validation` and `oauth-2.1`); `resolveCircuitBreaker` — noop unless `count-based` is configured; `resolvePermissionGuard` — the forward-token default |

---

### `src/tools/` — MCP Tool Layer   ✅ Stable

Five tools, registered on a fresh `McpServer` for every request by `src/runtime/http/mcp-server-factory.ts` (stdio uses the same factory). Tool names and input schemas are public API and frozen.

| Tool | MCP name | Auth (`validateAuth`) | Sandbox |
|------|----------|-----------------------|---------|
| `discover-services.tool.ts` | `discover_services` | No | No — reads the registry |
| `discover-skills.tool.ts` | `discover_skills` | Yes | Yes — agent's filter over the skill list |
| `get-skill-details.tool.ts` | `get_skill_details` | Yes | No — reads the skill store |
| `search-code.tool.ts` | `search_code` | Yes | Yes — agent's search over `PermissionGuard.filterSpec(spec)` |
| `execute-api.tool.ts` | `api_execute` | Yes | Yes — runs the agent's program |

`tool-helpers.ts` holds the shared pieces: `mcpSuccess` / `mcpError` (serverInfo in `_meta`), service resolution (`UNKNOWN_SERVICE`, not retryable), `validateAuth`, the `runSandboxTool` pipeline and the advisory request `_meta` reader. `api_execute` is the only tool that makes backend calls, and therefore the only one that touches executions, governance, the circuit breaker, idempotency and the audit trail. It is split along those concerns:

| File | Owns |
|---|---|
| `execute-api.tool.ts` | the tool's description and registration; per call: the SDK boundary, service, auth, then the **responder** — a report becomes metrics, one audit record and the MCP result (`input_required`, `APPROVAL_REQUIRED`, a success or an error) |
| `mcp-request-view.ts` | the **SDK boundary**: `readMcpRequest` is the only code that reads `ServerContext`; it validates the sealed `requestState`'s shape, the human's answer (`approve` read once) and `_meta["harbor/execution-id"]`, and returns a view the rest works on |
| `execute-api-run.ts` | the **run orchestrator** `runApiExecute`: which execution (create, or resume and apply the answer), the run lock, the sandbox run, the run's outcome in the store; returns a report and never throws |
| `execute-api-outcome.ts` | the **outcome mapping**: one table from a failure to its audit outcome, execution status and metrics, read by persistence and the responder alike |

---

## 3. Request Lifecycle

### `api_execute` — Full Path

The booted gateway always builds a `GovernanceRuntime`, so every `api_execute` is a governed, durable execution. (Without a runtime — tests, or an embedder calling `registerExecuteApiTool` without one — the tool runs the legacy path: no execution, journal or governance, only the in-run `CallLog`.)

```
AI Agent
  │  POST /mcp   Authorization: Bearer <token>
  │  MCP-Protocol-Version: 2026-07-28 · Mcp-Method · Mcp-Name · params._meta envelope
  ▼
src/runtime/http/http-gateway.ts
  ├─ bearer *format* check (one Authorization header; JWT or ≥ 32 base64url chars)
  │     missing / malformed / duplicate ⇒ HTTP 401 (+ WWW-Authenticate when HARBOR_RESOURCE_URI is set)
  ├─ readBoundedBody ≤ MCP_MAX_BODY_BYTES (4 MiB) ⇒ 413 PAYLOAD_TOO_LARGE; not JSON ⇒ JSON-RPC -32700
  └─ createMcpHandler (legacy: 'reject') → buildMcpServerFactory → new McpServer + five tools
        an echoed MRTR requestState is verified by the SDK (HMAC, TTL, method binding) before the handler
  ▼
src/tools/execute-api.tool.ts
  ├─ 0. readMcpRequest(ctx) — the SDK boundary (mcp-request-view.ts): the only read of ServerContext
  ├─ 1. resolveService(service)                    ⇒ UNKNOWN_SERVICE (not retryable)
  ├─ 2. validateAuth → AuthMiddleware.validateRequest (token cache; strategy.validate on a miss)
  │        a token the auth strategy rejects is a tool error (HTTP 200), not a 401
  │     userIdHash = hashAuthenticatedPrincipal(payload, bearer)
  │  runApiExecute — the run orchestrator (execute-api-run.ts); steps 3–7, returns a report
  ├─ 3. openExecution
  │        requestState (MRTR retry) or _meta["harbor/execution-id"] ⇒ resume:
  │           load; same principal and service or EXECUTION_NOT_RESUMABLE;
  │           apply the human's answer (ApprovalService.decide) — reject/cancel end it here;
  │           still pending without an answer ⇒ input_required again
  │        otherwise ⇒ ExecutionManager.create — the program is persisted as the authoritative original
  ├─ 4. ExecutionManager.beginRun — run lock, RUNNING, runCount + 1
  │        EXECUTION_LOCKED (retryable) · EXECUTION_NOT_RESUMABLE · approval still pending ⇒ the pause again
  │     makeBridge → ActivityJournal, resolveOperation, governance decide()
  ├─ 5. program = persisted originalCode (incoming code is ignored on resume)
  │     idempotency key base = mcp-{service}-{executionId}
  ├─ 6. runApiInSandbox(program, sandboxCtx)                 src/runtime/sandbox/execute-api-in-sandbox.ts
  │     ├─ sandbox-core.ts: new isolate (memoryLimitMb); wall-clock timer (executeTimeoutMs)
  │     │   disposes it; ivm CPU timeout inside
  │     ├─ api.request(arg) → BridgeRequestHandler.handle   src/runtime/sandbox/bridge-request-handler.ts
  │     │   ├─ admit: run already stopped? call limit (maxApiCalls)? concurrency (maxConcurrentCalls)?
  │     │   ├─ validate arg; canonicalise path (request-path.ts)       ⇒ INVALID_API_REQUEST, nothing sent
  │     │   ├─ resolve → OpenAPI template (src/runtime/governance/operation-resolver.ts)
  │     │   ├─ per-run admission lock — one call at a time, in arrival order:
  │     │   │    ├─ stop check (a sibling paused or stopped the run ⇒ refused with that reason)
  │     │   │    ├─ ActivityGate.admit: journal lookup → replay (COMPLETED) | execute | stop;
  │     │   │    │     new activity → evaluateGovernance → ALLOW | DENY | REQUIRE_APPROVAL
  │     │   │    ├─ authorize: PermissionGuard.canExecute, CircuitBreaker.check(template)
  │     │   │    └─ ActivityGate.begin → activity journaled EXECUTING
  │     │   ├─ ConnectorAPI.request(apiRequest, ctx)   (outside the lock: calls still overlap)
  │     │   │     ApiClient: idempotency.checkAndExecute(key-{sequence}) → axios;
  │     │   │     retries GET/PUT/DELETE only; recordFailure(ctx.endpoint) once per failed call
  │     │   └─ record: journal COMPLETED (any HTTP status) + CircuitBreaker.recordSuccess;
  │     │         a throw ⇒ FAILED, outcome unknown
  │     ├─ drain: calls the program did not await get the rest of executeTimeoutMs, then are
  │     │   aborted (journaled FAILED) — a connector ignoring the abort is abandoned after 1 s
  │     └─ throwIfViolated: the first run-stopping violation (pause, deny, divergence,
  │         unknown outcome) becomes the run's typed error, even if the program caught it
  ├─ 7. ExecutionManager.endRun(completed | waitingApproval | interrupted | failed | denied | cancelled)
  │     releases the lock; the new state is published to the audit sinks
  ├─ 8. metrics.increment(tool_calls_total) · writeAuditRecord → AuditPipeline → each AUDIT_SINKS sink
  └─ 9. response (_meta: harbor/execution-id, harbor/execution-status[, harbor/approval-id])
         completed            → mcpSuccess(result)
         ApprovalRequired     → client declared elicitation ? input_required (form elicitation +
                                sealed requestState) : APPROVAL_REQUIRED tool error naming
                                POST /executions/{id}/approvals/{approvalId}
         anything else        → mcpError(message, code, retryable, progress)
```

Why the admission lock: the journal lookup, governance, the stop check and journaling EXECUTING must see each other's results. Without it, two `Promise.all` siblings could both pass the stop check while the first was opening an approval, and the second would execute on a run that had already paused. Only admission is serialised; the backend calls themselves still run concurrently. The handler is also the one place that sees a run's other calls, so it tells the gate whether a call was admitted while another was in flight; the journal records that, and replay binds such a call's content (`docs/code-mode-governance.md` §4).

#### Idempotency keys

Every backend call carries `X-Idempotency-Key`, and the configured `IdempotencyStrategy` deduplicates on it for `idempotencyKeyTtlMs`.

| Path | Key |
|------|-----|
| Governed (always, in the booted gateway) | `mcp-{service}-{executionId}-{sequence}` — two executions of one program never share a key; a resume keeps its keys |
| Legacy (no `GovernanceRuntime`) | `mcp-{service}-{userIdHash12}-{codeHash16}-c{n}` — `n` is the call's arrival index in the run, so an agent retrying the identical tool call is deduplicated |

### Read Path (`discover_services`, `discover_skills`, `get_skill_details`, `search_code`)

```
AI Agent → per-request McpServer → tool handler
  ├─ discover_services:  ServiceRegistry.listServices()                         — no auth, no sandbox
  ├─ discover_skills:    validateAuth → runSkillsSearchInSandbox(code, skills)  — sandbox, searchTimeoutMs
  ├─ get_skill_details:  validateAuth → SkillStore lookup                       ⇒ UNKNOWN_SKILL
  └─ search_code:        validateAuth → PermissionGuard.filterSpec(spec, token)
                           → runSpecSearchInSandbox(code, spec)                 — sandbox, searchTimeoutMs
```

None of them calls a backend, the circuit breaker or the execution store.

---

## 4. Service Registration Lifecycle

```
src/index.ts
  ├─ dotenv/config — load .env
  ├─ src/core/config/config.ts loads MCP_CONFIG_FILE (default /etc/harbor-config/config.yaml) into
  │    process.env when present; variables already set win
  ├─ servicesDir = SERVICES_DIR (resolved against the working directory) or <install root>/services
  ├─ validateGlobalConfig() — Zod parse of process.env; exit on error
  └─ createMcpGateway(servicesDir, globalConfig)
       ▼
src/runtime/server-factory.ts
  ├─ 1. scanServicesDirectory(servicesDir)                src/runtime/registry/filesystem-scanner.ts
  │       for each entry of services/ (an unreadable entry is skipped):
  │         a. config.json — enabled: false ⇒ skipped
  │         b. spec.json | spec.yaml | spec.yml → SwaggerParser.dereference (relative $refs beside the file)
  │         c. api config — config.api, else spec servers[0].url (no port ⇒ 80/443)
  │         d. resolveAuth (config.auth required) · resolveCircuitBreaker · idempotency block ·
  │            sandbox overrides · spec source · refresh interval / timeout checks
  │         e. scanSkills — skills/*.md; a file that cannot be read or parsed is skipped alone
  │       a service that throws is logged ("Failed to scan service …") and skipped; none left ⇒ exit
  │
  ├─ 2. buildTokenCacheStrategy(TOKEN_CACHE_TYPE)        — one cache shared by all services
  │
  ├─ 3. for each ServiceDefinition: buildServiceResources   src/runtime/gateway/service-resources-factory.ts
  │         ├─ SpecStore / SkillStore seeded from the scan
  │         ├─ buildSpecLoader(spec source) + ServiceRefresher
  │         ├─ AuthMiddleware(svc.auth, shared token cache)
  │         ├─ buildIdempotencyStrategy(config.json block ?? IDEMPOTENCY_TYPE) — unknown type ⇒ throws
  │         ├─ SandboxLimits = config.json sandbox overrides ∪ SANDBOX_* defaults
  │         ├─ ApiClient(baseUrl, api config, circuit breaker, idempotency, …)
  │         └─ refresher.start() — last, so a service that failed above leaves no timer behind
  │       ServiceRegistry.register(name, resources); a throw skips the service; none left ⇒ exit
  │
  ├─ 4. AuditPipeline — buildAuditSinks(AUDIT_SINKS) when ENABLE_AUDIT, else no sinks
  │
  ├─ 5. buildGovernanceRuntime(globalConfig.execution, registeredServices, logger, auditPipeline)
  │         ├─ buildExecutionStore(EXECUTION_STORE_TYPE)
  │         ├─ ExecutionManager (state changes → audit pipeline) · retention sweeper · ApprovalService
  │         ├─ for each registered service: build its GovernanceRuleSource → load → validate
  │         │     unreadable source or invalid rule ⇒ boot fails; missing default directory ⇒ WARN for that service
  │         ├─ per-service GovernanceRuleRefresher (`config.json` `rulesRefreshSec`; 0 = boot only)
  │         └─ requestState codec (GOVERNANCE_REQUEST_STATE_KEY, else a per-process random key)
  │
  ├─ 6. buildMcpServerFactory({ registry, globalConfig, logger, metrics, stdioToken, governanceRuntime, auditPipeline })
  │
  └─ 7. start transport
          HTTP:  startHttpGateway({ host, port, maxBodyBytes, createMcpServer, registry, logger,
                                   oauthConfig, governanceRuntime })
          stdio: MCP_TOKEN required and must pass the bearer parser, else exit;
                 startStdioGateway({ createMcpServer, registry, logger })
          SIGTERM / SIGINT: close the HTTP listener, then governanceRuntime.shutdown(), auditPipeline.close(),
                 token cache destroy, registry.shutdownAll() (refreshers, metrics), gateway metrics stop
```

---

## 5. Extension Points

### ✅ `ConnectorAPI`

**File:** `src/spi/connector/connector-api.ts`

**What it unlocks:** a different outbound transport (gRPC, GraphQL, a message bus) without touching sandbox code. The bridge calls the interface; it never sees HTTP.

**How to use:** there is no registration hook. Build your connector in `src/runtime/gateway/service-resources-factory.ts` in place of `ApiClient`, or construct `ServiceResources` yourself when embedding.

```typescript
// A module in src/ — the interface is src/spi/connector/connector-api.ts.
import type { ConnectorAPI, ApiRequest, ApiResponse, ExecuteRequestContext } from './spi/connector/connector-api.js'

class GrpcConnector implements ConnectorAPI {
  async request(req: ApiRequest, ctx: ExecuteRequestContext): Promise<ApiResponse> {
    // call the backend, return { data, status, ok }
  }
}
```

A custom connector takes over everything `ApiClient` does after the bridge hands the call over:
- deduplication through `ctx.idempotencyKey` / `ctx.idempotencyKeyTtlMs`;
- retries, and only for methods whose repetition is harmless;
- `circuitBreaker.recordFailure(ctx.endpoint)` once per failed call, so failures land on the key the bridge checks;
- dropping program-supplied identity and routing headers, and sending the correlation, idempotency and `X-Harbor-*` headers;
- honouring `ctx.signal`, and `ctx.invalidate()` on a backend 401.

A throw becomes a FAILED activity with an unknown outcome. The run stops there and the call is never retried silently.

---

### ✅ External Backend Registration

**File:** `src/wiring/strategy-builders.ts`

**What it unlocks:** custom token caches, idempotency stores, execution stores, audit sinks and Governance Rule sources without forking.

| Register | Selected by | Contract |
|----------|-------------|----------|
| `registerTokenCacheBackend(type, factory)` | `TOKEN_CACHE_TYPE` | `TokenCacheStrategy` (extend `AbstractTokenCache`) |
| `registerIdempotencyBackend(type, factory)` | `IDEMPOTENCY_TYPE`, or `config.json` `idempotency.type` | `IdempotencyStrategy` |
| `registerExecutionStoreBackend(type, factory)` | `EXECUTION_STORE_TYPE` | `ExecutionPersistence`; run the contract suite in `tests/unit/execution-store.test.ts` |
| `registerAuditSinkBackend(type, factory)` | an entry of `AUDIT_SINKS` | `AuditSink` |
| `registerGovernanceRuleSourceBackend(type, factory)` | per-service `config.json` `governance.rulesSource` | `GovernanceRuleSource` (`load()` throws rather than return part of a set) |

Register before `createMcpGateway()`. Built-in types (in-memory, memcache, couchbase, noop, file-backed execution store, file Governance Rule source, url Governance Rule source, console) remain available. An unregistered name stops boot, or skips the service for a `config.json` idempotency type. See `docs/adapter-guide.md`.

---

### ✅ `AuditSink`

**Where:** `src/spi/observability/audit-sink.ts`, fanned out by `src/runtime/observability/audit-pipeline.ts`.

Every `api_execute` audit record (`{ kind: 'audit', record }`) and every execution state change (`{ kind: 'execution', state }` — statuses, approvals and decisions, no request/response bodies and no program text) goes to each sink listed in `AUDIT_SINKS`. Built in: `console` (the `audit` and `execution-state` log lines). Register others (S3, PostgreSQL, a SIEM) without forking:

```typescript
// An entry point in src/ (see External registration above).
import { registerAuditSinkBackend } from './wiring/strategy-builders.js'

registerAuditSinkBackend('s3', ({ loggerFor }) => new S3AuditSink(/* bucket, prefix */))
// AUDIT_SINKS=console,s3
```

A sink that throws is logged and skipped; the other sinks and the request are unaffected. An unknown name in `AUDIT_SINKS` stops boot, and so does an empty `AUDIT_SINKS` while `ENABLE_AUDIT` is on.

---

### ⚠️ `ProtocolAdapter`   NOT YET IMPLEMENTED

**File that needs it:** `src/runtime/server-factory.ts`

**Problem:** transport selection is a hard-coded `if/else` on `config.mcp.transport`. Adding WebSocket or a Unix socket means editing the bootstrap file.

**Proposed interface:**
```typescript
// src/spi/transport/protocol-adapter.ts
export interface ProtocolAdapter {
  start(createMcpServer: GatewayMcpServerFactory, config: GlobalConfig, logger: Logger): Promise<void>
  stop(): Promise<void>
}
```

---

### ⚠️ `SkillProvider`   NOT YET IMPLEMENTED

**File that needs it:** `src/runtime/registry/filesystem-scanner.ts` + `skill-store.ts`

**Problem:** skills come only from the service folder on disk (read at boot, re-read by the service refresher). There is no database source and no remote CMS.

**Proposed interface:**
```typescript
// src/spi/skill/skill-provider.ts
export interface SkillProvider {
  listSkills(serviceName: string): Promise<SkillMetadata[]>
  getSkill(serviceName: string, skillId: string): Promise<SkillMetadata | undefined>
}
```

---

### ⚠️ `ToolResolver`   NOT YET IMPLEMENTED

**File that needs it:** `src/runtime/http/mcp-server-factory.ts`

**Problem:** the five tools are hard-registered on every per-request `McpServer`. There is no dynamic registration and no custom tool. The five tools are frozen by design (AGENTS.md), so adding this is an API decision, not a refactor.

**Proposed interface:**
```typescript
// src/spi/tool/tool-resolver.ts
export interface ToolResolver {
  registerAll(server: McpServer, registry: ServiceRegistry, config: GlobalConfig): void
}
```

---

## 6. Known Issues

### `src/runtime/server-factory.ts` — mixed responsibilities

Bootstrap, audit and Code Mode wiring, transport selection and shutdown handling are one function. See the `ProtocolAdapter` extension point above. Fix when a second transport is needed.

### The transport checks the bearer's format, not its validity

`/mcp` refuses a missing, malformed or duplicated `Authorization` header with 401. A well-formed token that the auth strategy rejects (invalid, expired, revoked) is reported by the tool as an error inside an HTTP 200, and `discover_services` needs no valid token at all. `/health` lists service names. There is no `Origin`/`Host` validation. Open decision; see `docs/mcp-2026-07-28-compatibility.md`.

### No seam for metrics, no metric for spec refresh failure

`MetricsRegistry` is constructed directly in `src/runtime/server-factory.ts` and `src/runtime/gateway/service-resources-factory.ts`; there is no way to inject another collector. `service-refresher.ts` logs `warn` on a failed refresh but increments no counter, so repeated failures are invisible to dashboards.

### No size cap on backend responses or program request bodies

`ApiClient` buffers whatever a backend returns, and a program may send a body of any size its isolate can build.

The governance-specific limitations (untargeted calls are ungoverned, rule targets not checked against the specs, self-approval, and others) are listed in `docs/code-mode-governance.md` §14 and tracked in `ROADMAP.md`.

---

## 7. Stability Legend

| Module | Status | Notes |
|--------|--------|-------|
| `src/core/constants.ts` | ✅ Stable | Tool names, `ERR` codes and HTTP routes are public API; `META_PREFIX` (`harbor/`) is a placeholder |
| `src/core/config/config.ts` | ✅ Stable | The Zod schema (env var names and defaults) is the config contract |
| `src/core/types/` | ✅ Stable | Shared data types, errors and configuration; provider interfaces are in SPI |
| `src/tools/` | ✅ Stable | Tool names + input schemas are public API and frozen |
| `src/spi/` | ✅ Stable | Interfaces frozen; adding a required member is breaking |
| `src/spi/execution/`, `src/spi/governance/` | 🟡 Experimental | `ExecutionPersistence`, `GovernanceRuleSource` — may gain members in a minor release |
| `src/adapters/` | ✅ Stable | Internal field names may change; public factory signatures are stable |
| `src/runtime/registry/service-registry.ts` | ✅ Stable | `ServiceResources` shape is public API |
| `src/runtime/http/` | ✅ Stable | Stateless HTTP transport, body limits, protected-resource metadata |
| `src/runtime/http/execution-routes.ts` | 🟡 Experimental | `/executions` inspection and fallback approval routes |
| `src/runtime/execution/`, `src/runtime/governance/` | 🟡 Experimental | Code Mode governance layer; journal, rule format and `harbor/*` `_meta` keys may still change |
| `src/runtime/spec/service-refresher.ts` | ✅ Stable | Per-service interval from `config.json`; `0` = disabled |
| `src/runtime/observability/` | ✅ Stable | Audit record, execution-state event, metrics, logger, progress shapes established |
| `src/runtime/api-client/api-client.ts` | ✅ Stable | Implements `ConnectorAPI`; re-exports types for backwards compat |
| `src/wiring/strategy-builders.ts` | ✅ Stable | Provider builders and registration functions |
| `src/wiring/strategy-builders.ts` | ✅ Stable | Canonical builders; built-in switch + external registration |
| `src/wiring/service-wiring.ts` | ✅ Stable | Auth + circuit-breaker resolver; accepts config descriptors, returns strategy instances |
| `src/runtime/registry/filesystem-scanner.ts` | ✅ Stable | Returns config descriptors; strategy instantiation delegated to `src/wiring/service-wiring.ts` |
| `src/runtime/server-factory.ts` | 🔴 Needs Refactor | Mixed responsibilities; blocks `ProtocolAdapter` |
| `src/runtime/sandbox/` | 🟡 Experimental | `isolated-vm` native addon; the security model depends on a single library |

---

## 8. Future Evolution

- Add `spec_refresh_failed_total` metric to `service-refresher.ts`
- An injectable `MetricsCollector` (Prometheus / OpenTelemetry)
- OpenTelemetry trace propagation through the `ConnectorAPI.request()` bridge
- `ProtocolAdapter` — when a third transport is added
- `SkillProvider` — when skills need a DB or remote source
- `ToolResolver` — only if the frozen five-tool surface is ever opened up
- Built-in S3 / GCS audit sinks — the `AuditSink` interface exists; `console` is the only built-in
- Remote service registry (etcd / Consul) — replace the filesystem scanner
- Multi-tenant namespacing — isolated registries per tenant within one gateway

### Architectural Invariants — Never Break

1. **Sandbox isolation** — the agent's program has no direct access to the gateway process, filesystem or network. `api.request()` → the host bridge → `ConnectorAPI` is the only outbound surface from inside the isolate.
2. **Governance before side effect, journal before call** — the bridge canonicalises the path, evaluates rules and journals the activity EXECUTING before the connector is called. A completed activity is replayed, never re-executed; an unknown outcome stops the run.
3. **SPI boundary** — `src/runtime/` imports `src/spi/` contracts and `src/wiring/`, never `src/adapters/` concrete classes directly. `src/wiring/` is the composition root and the sole exception by design.
4. **`src/core/` independence** — `src/core/` has no imports from `src/runtime/`, `src/tools/`, `src/spi/`, `src/wiring/` or `src/adapters/`. It stays importable by consumers without pulling in the framework.
5. **Stateless transport** — execution state lives in `ExecutionPersistence`, never in an MCP session or a per-connection map.
