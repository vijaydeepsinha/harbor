# Architecture

_Harbor v0.1.0 — Architecture Reference_
_Last updated: 2026-05-27_

---

## 1. System Overview

Harbor sits between an AI agent (Claude, Cursor, or any MCP client) and one or more backend microservices. It speaks the **Model Context Protocol (MCP)** inbound and delegates outbound calls through the **ConnectorAPI** interface — HTTP/REST by default. Skill code supplied per-service runs inside a **V8 isolate**; the agent's JavaScript never touches the gateway process directly.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AI Agent  (Claude / Cursor / any MCP client)                        │
└────────────────────────┬─────────────────────────────────────────────┘
                         │  MCP — Streamable HTTP  (or stdio)
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  HARBOR                                                              │
│                                                                      │
│   ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│   │   tools/   │    │   runtime/                       │   │
│   │                     │───▶│   server-factory   registry      │   │
│   │  discover_services  │    │   sandbox          http-gw       │   │
│   │  discover_skills    │    │   spec-store       audit         │   │
│   │  get_skill_details  │    │   observability    session-mgr   │   │
│   │  search_code        │    └──────────────┬───────────────────┘   │
│   │  api_execute        │                   │                        │
│   └─────────────────────┘           spi/ contracts                  │
│                                             │                        │
│   ┌──────────────────────────────────────┐  │                        │
│   │  spi/                                │◀─┘                        │
│   │  auth  idempotency  permissions      │                           │
│   │  resilience  spec  connector         │                           │
│   └──────────────────┬───────────────────┘                           │
│                      │ implemented by                                 │
│   ┌──────────────────▼───────────────────┐                           │
│   │  adapters/                           │                           │
│   │  auth  idempotency  infra  resilience│                           │
│   └──────────────────────────────────────┘                           │
└────────────────────────────────────────────────────────────┬─────────┘
                                                             │  ConnectorAPI
                                                             ▼
                                              ┌─────────────────────────┐
                                              │  Backend microservices  │
                                              │  (HTTP / gRPC / any)    │
                                              └─────────────────────────┘
```

---

## 2. Module Responsibilities

### `core/` — Framework Nucleus   ✅ Stable

Zero runtime dependencies. Every other module imports from here. Nothing here imports from other framework modules.

| File | Responsibility |
|------|----------------|
| `constants.ts` | All string literals — tool names, metric keys, log prefixes, env names, store type IDs, auth schemes, HTTP methods |
| `config/config.ts` | Zod validation of `process.env`; K8s ConfigMap file loader; produces typed `GlobalConfig`; exits on misconfiguration |
| `types/auth.types.ts` | `AuthStrategy`, `TokenCacheStrategy`, `TokenPayload` |
| `types/circuit-breaker.types.ts` | `CircuitBreakerStrategy`, `CircuitOpenError` |
| `types/config.types.ts` | `GlobalConfig`, `SandboxLimits`, `SandboxOverride`, `TokenCacheBackendConfig`, `IdempotencyBackendConfig` |
| `types/connector.types.ts` | `ApiRequest`, `ApiResponse`, `ExecuteRequestContext` — shared transport contract types |
| `types/idempotency.types.ts` | `IdempotencyStrategy` |
| `types/permission.types.ts` | `PermissionGuard`, `PermissionDeniedError` |
| `types/sandbox-error.types.ts` | `SandboxError` hierarchy — execution, call-limit, concurrent-limit, timeout, syntax, invalid-request |
| `types/spec.types.ts` | `SpecLoaderStrategy`, `ParsedSpec`, `OpenAPISpec` |
| `utils/errors.ts` | `ensureError`, `errorCode`, `errorRetryable`, `errorMessage` |
| `utils/url.ts` | `joinUrl`, `normalizeEndpointPath` |

---

### `spi/` — Extension Contracts   ✅ Stable

SPI = _Service Provider Interface_. Defines what the framework calls; `adapters/` (or third-party code) implements it. Interfaces here are frozen — changing them is a breaking change.

| Contract | Interface | Default |
|----------|-----------|---------|
| `spi/auth/abstract-token-cache.ts` | `AbstractTokenCache` | — (in-memory is default) |
| `spi/auth/auth-middleware.ts` | `AuthStrategy` | — (required per-service) |
| `spi/auth/bearer-authorization.ts` | Bearer token validation helpers | — |
| `spi/connector/connector-api.ts` | `ConnectorAPI` | `ApiClient` (HTTP/axios) |
| `spi/idempotency/strategies/` | `IdempotencyStrategy` | `NoopIdempotencyStrategy` |
| `spi/permissions/strategies/` | `PermissionGuard` | `ForwardTokenPermissionGuardStrategy` |
| `spi/resilience/strategies/` | `CircuitBreakerStrategy` | `NoopCircuitBreakerStrategy` |
| `spi/spec/strategies/` | `SpecLoaderStrategy` | `FileSpecLoaderStrategy` |

**`ConnectorAPI`**:
```typescript
// spi/connector/connector-api.ts
export interface ConnectorAPI {
  request(
    apiRequest: ApiRequest,
    ctx: ExecuteRequestContext  // includes idempotencyKeyTtlMs, correlationId, sessionId
  ): Promise<ApiResponse>
}
```
`SandboxExecutionContext.apiClient` and `ServiceResources.apiClient` are typed as `ConnectorAPI`. The `ApiClient` (HTTP/axios) implements this interface and is the default. Swap it by injecting any `ConnectorAPI` implementation into `ServiceResources`.

---

### `adapters/` — Built-in Implementations   ✅ Stable

Concrete implementations of `spi/` contracts. All optional — disable any by not wiring it.

```
adapters/
├── auth/strategies/
│   ├── static-token.strategy.ts           validates static bearer (demo / test)
│   ├── oauth-introspection.strategy.ts    POST /oauth/token introspect; caches result
│   ├── jwt-validation.strategy.ts         local JWT verification via JWKS endpoint
│   ├── oauth-discovery.strategy.ts        OAuth 2.1 AS auto-discovery + JWT verification
│   ├── in-memory-token-cache.strategy.ts  Map<token, payload> + TTL eviction
│   ├── memcache-token-cache.strategy.ts   Memcache KV with TTL
│   └── couchbase-token-cache.strategy.ts  Couchbase KV with TTL
├── idempotency/strategies/
│   ├── in-memory-idempotency.strategy.ts  Map<key, result> dedup
│   ├── memcache-idempotency.strategy.ts
│   ├── couchbase-idempotency.strategy.ts
│   └── keygen.ts                           mcp-{service}-{random} key generator
├── infra/
│   ├── couchbase-client.ts                singleton cluster + bucket wrapper
│   └── memcache-client.ts                 singleton memjs client
└── resilience/strategies/
    └── count-based-circuit-breaker.strategy.ts   opens after N consecutive 5xx; half-open probe
```

**External registration** — plug in custom backends without forking:
```typescript
import { registerTokenCacheBackend, registerIdempotencyBackend } from './runtime/gateway/strategy-builders.js'

// Called once at startup, before createMcpGateway()
registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs))
registerIdempotencyBackend('postgres', (config, logger) => new PostgresIdempotency(config))
```
Set `TOKEN_CACHE_TYPE=redis` or `IDEMPOTENCY_TYPE=postgres` in env. The registry is checked before the built-in switch; unrecognised types fall through to the switch and exit with an error.

---

### `runtime/` — Gateway Orchestration   ✅ Stable / 🟡 Experimental (sandbox only)

```
runtime/
├── server-factory.ts              bootstrap — scans services, builds registry, wires tools, starts transport
├── api-client/
│   └── api-client.ts              implements ConnectorAPI; outbound axios; auth headers; retry + backoff
├── gateway/
│   ├── service-resources-factory.ts   wires ServiceDefinition → ServiceResources
│   └── strategy-builders.ts           thin re-export of wiring/strategy-builders.ts
├── execution/                     Code Mode governance layer (see docs/code-mode-governance.md)
│   ├── execution-manager.ts       execution lifecycle, run lock, history
│   ├── activity-gate.ts           replay / governance decision for each call of a governed run
│   ├── activity-journal.ts        CallLog (the run's call outcomes) + ActivityJournal (durable activity record)
│   ├── approval-service.ts        human approvals bound to one activity
│   ├── request-state.ts           HMAC-sealed MRTR requestState codec
│   └── code-mode-runtime.ts       process-wide wiring of store, manager, approvals, rules
├── http/
│   ├── http-gateway.ts            Streamable HTTP server (node:http); /mcp + /health endpoints
│   ├── http-error.ts              typed HTTP error
│   ├── oauth-metadata-handler.ts  RFC 9728 protected resource metadata
│   └── send-response.ts           SSE response writer
├── observability/
│   ├── audit.ts                   AuditCollector — projection of the run's call log (endpoints called); writeAuditRecord
│   ├── audit-pipeline.ts          fans audit records and execution-state events out to the AUDIT_SINKS sinks
│   ├── logger.ts                  pino factory; pino-caller adds source location in non-prod
│   ├── metrics.ts                 MetricsRegistry — in-memory counters (no push endpoint yet)
│   └── progress.ts                ProgressCollector — projection of the run's call log (per-call status, created ids)
├── registry/
│   ├── filesystem-scanner.ts      scans services/*; parses spec + config.json + skills/*.md
│   ├── service-registry.ts        in-memory map of service name → ServiceResources
│   └── skill-store.ts             in-memory map of skill id → SkillDocument; atomic swap on refresh
├── sandbox/
│   ├── sandbox-core.ts            isolated-vm isolate lifecycle; dual-timeout fence; JSON bridge
│   ├── execute-api-in-sandbox.ts  runs one program: wires the bridge into the isolate; violation promotion
│   ├── bridge-request-handler.ts  per-run api.request() pipeline (ConnectorAPI bridge); violation capture
│   ├── skills-search-in-sandbox.ts  skill relevance filter inside sandbox
│   └── spec-search-in-sandbox.ts    OpenAPI endpoint search inside sandbox
├── spec/
│   ├── spec-store.ts              swagger-parser validation + atomic spec swap
│   └── service-refresher.ts       per-service background reload (interval from config.json)
└── transport/
    └── stdio-gateway.ts           MCP over stdio for embedded / local use
```

---

### `wiring/` — Composition Root   ✅ Stable

The only layer that imports from both `adapters/` and `spi/`. Keeps the layer invariant intact: `runtime/` imports only from `wiring/` (via re-exports), never from `adapters/` directly.

| File | Responsibility |
|------|----------------|
| `strategy-builders.ts` | Factory registry for token-cache and idempotency backends; `buildTokenCacheStrategy`, `buildIdempotencyStrategy`, `buildSpecLoader`, `buildGovernanceRuleSource`, `buildAuditSinks`; external `registerTokenCacheBackend` / `registerIdempotencyBackend` / `registerGovernanceRuleSourceBackend` / `registerAuditSinkBackend` registration points |
| `service-wiring.ts` | `resolveAuth` — instantiates the correct `AuthStrategy` from a `ServiceAuthConfig` descriptor; `resolveCircuitBreaker` — instantiates `CircuitBreakerStrategy` from config |

`runtime/gateway/strategy-builders.ts` is a thin re-export shell (`export * from '../../wiring/strategy-builders.js'`) so existing import paths stay valid.

---

### `tools/` — MCP Tool Layer   ✅ Stable

Five tools registered per session on `McpServer`. Tool names and input schemas are public API — changing either is a breaking change.

| Tool | MCP name | Auth required | Sandbox |
|------|----------|---------------|---------|
| `discover-services.tool.ts` | `discover_services` | No | No — reads registry |
| `discover-skills.tool.ts` | `discover_skills` | No | Yes — JS relevance filter |
| `get-skill-details.tool.ts` | `get_skill_details` | No | No — reads skill store |
| `search-code.tool.ts` | `search_code` | No | Yes — JS endpoint search |
| `execute-api.tool.ts` | `api_execute` | Yes | Yes — runs skill code |

`api_execute` is the only tool that touches auth, permission guard, circuit breaker, idempotency, audit, and the ConnectorAPI bridge. The other four are stateless reads.

---

## 3. Request Lifecycle

### `api_execute` — Full Path

```
AI Agent
  │
  │  POST /mcp
  │  Accept: application/json, text/event-stream
  │  Authorization: Bearer <client-token>
  ▼
http-gateway.ts
  ├─ extract Bearer token from header (every request)
  ├─ create fresh stateless transport + McpServer
  └─ McpServer.handle(request)
       ▼
  MCP SDK  →  route tools/call  →  execute-api.tool.ts handler
       ▼
execute-api.tool.ts
  ├─ 1.  ServiceRegistry.get(serviceName)
  │         ServiceResources | → UNKNOWN_SERVICE error
  │
  ├─ 2.  AuthMiddleware.validate(clientToken)
  │         TokenPayload    | → SessionExpiredError / MissingTokenError
  │
  ├─ 3.  PermissionGuard.filterSpec(spec, tokenPayload)
  │         filtered OpenAPISpec | → PermissionDeniedError
  │
  ├─ 4.  CircuitBreakerStrategy.check(endpoint)
  │         pass | → CircuitOpenError
  │
  ├─ 5.  IdempotencyStrategy.checkAndExecute(key, fn, ttl)
  │         cached result (return early) | null (proceed to sandbox)
  │
  ├─ 6.  CallLog for the run (the execution's ActivityJournal when governed);
  │       AuditCollector / ProgressCollector are read-only projections of it
  │
  ├─ 7.  runApiInSandbox(userCode, sandboxCtx)
  │       │
  │       └─ sandbox-core.ts
  │            ├─ new ivm.Isolate({ memoryLimitMb })
  │            ├─ wall-clock timer → dispose isolate on executeTimeoutMs
  │            ├─ inject __makeRequest bridge into isolate global
  │            ├─ compile + run userCode as async function
  │            │    │
  │            │    └─ api.request(opts) → BridgeRequestHandler.handle
  │            │         ├─ enforce maxApiCalls + maxConcurrentCalls
  │            │         ├─ validate opts (path, method)
  │            │         ├─ ActivityGate.admit (governed runs): replay | execute | pause | stop
  │            │         ├─ PermissionGuard.canExecute(path, method, tokenPayload)
  │            │         ├─ CircuitBreakerStrategy.check(path)
  │            │         ├─ ConnectorAPI.request(apiRequest, ctx, ttlMs)
  │            │         │      └─ ApiClient → HTTP → backend service
  │            │         └─ journal: one record of the outcome (durable activity when governed)
  │            │
  │            └─ enforce: V8 CPU timeout (script.run) + wall-clock (setTimeout)
  │
  ├─ 8.  CircuitBreakerStrategy.recordSuccess(endpoint)
  ├─ 9.  MetricsRegistry.increment(TOOL_CALLS, {outcome: success})
  └─ 10. writeAuditRecord() → audit pipeline → each AUDIT_SINKS sink (console: pino line; endpoints from AuditCollector)
          └─ mcpSuccess(result) → SSE event → AI Agent
```

### Read Path (`discover_services`, `discover_skills`, `search_code`)

```
AI Agent → McpServer → tool handler
  ├─ discover_services: ServiceRegistry.listServices()  — zero sandbox, zero auth
  ├─ discover_skills:   runSkillSearchInSandbox(query)  — sandbox, no auth, no CB
  └─ search_code:       runSpecSearchInSandbox(query)   — sandbox, no auth, no CB
```

---

## 4. Service Registration Lifecycle

```
index.ts                          ← SERVICES_DIR defaults to ./services/
  ├─ dotenv/config  — load .env
  ├─ validateGlobalConfig()  — Zod parse process.env; exit on error
  └─ createMcpGateway(servicesDir, globalConfig)
       │
       ▼
server-factory.ts
  │
  ├─ 1. scanServicesDirectory(servicesDir)
  │       for each subdir in services/:
  │         a. find spec.yaml / spec.json
  │         b. SwaggerParser.dereference(specPath)   — validates OpenAPI
  │         c. read config.json                      — ServiceConfig
  │         d. resolveAuth(config)                   — instantiates AuthStrategy
  │         e. resolveCircuitBreaker(config)
  │         f. scanSkills(serviceDir)                — reads skills/*.md
  │         g. return ServiceDefinition
  │
  ├─ 2. buildTokenCacheStrategy(globalConfig)        — shared across all services
  │
  ├─ 3. for each ServiceDefinition:
  │       buildServiceResources(svc, globalConfig, tokenCacheStrategy)
  │         ├─ SpecStore.swap(svc.spec)
  │         ├─ SkillStore.swap(svc.skills)
  │         ├─ buildSpecLoader(svc.specSource)
  │         ├─ new ServiceRefresher(...)
  │         │     refresher.start()  ← per-service interval from config.json
  │         ├─ new AuthMiddleware(svc.auth, tokenCacheStrategy)
  │         ├─ buildIdempotencyStrategy(svc.idempotencyBackend)
  │         ├─ merge sandboxOverride ∪ globalConfig.sandbox  → SandboxLimits
  │         └─ new ApiClient(api, circuitBreaker, idempotency)
  │               ApiClient satisfies ConnectorAPI
  │
  ├─ 4. ServiceRegistry.register(name, resources)  × N services
  │
  ├─ 5. createMcpServer(clientToken): McpServer
  │       registerDiscoverServicesTool(...)
  │       registerDiscoverSkillsTool(...)
  │       registerGetSkillDetailsTool(...)
  │       registerSearchCodeTool(...)
  │       registerExecuteApiTool(...)
  │
  └─ 6. start transport
          HTTP:  startHttpGateway({ host, port, createMcpServer })
          stdio: startStdioGateway({ clientToken, createMcpServer })
```

---

## 5. Extension Points

### ✅ `ConnectorAPI`

**File:** `spi/connector/connector-api.ts`

**What it unlocks:** swap the outbound transport without touching sandbox code. Implement `ConnectorAPI`, pass the instance into `ServiceResources.apiClient`. The sandbox bridge calls the interface — it never sees HTTP, gRPC, or anything else directly.

**How to use:**
```typescript
import type { ConnectorAPI, ApiRequest, ApiResponse, ExecuteRequestContext } from './spi/connector/connector-api.js'

class GrpcConnector implements ConnectorAPI {
  async request(req: ApiRequest, ctx: ExecuteRequestContext): Promise<ApiResponse> {
    // call gRPC backend, return { data, status, ok }
    // access ctx.idempotencyKeyTtlMs, ctx.correlationId etc. from ctx
  }
}
```
Wire by replacing `apiClient` in `service-resources-factory.ts` or injecting into `ServiceResources` directly.

---

### ✅ External Backend Registration

**File:** `runtime/gateway/strategy-builders.ts`

**What it unlocks:** custom token-cache and idempotency backends without forking the framework.

```typescript
registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs))
registerIdempotencyBackend('postgres', (config, logger) => new PostgresIdempotency(config))
```

Set env vars: `TOKEN_CACHE_TYPE=redis`, `IDEMPOTENCY_TYPE=postgres`. Built-in types (in-memory, memcache, couchbase) still work unchanged.

---

### ⚠️ `ProtocolAdapter`   NOT YET IMPLEMENTED

**File that needs it:** `runtime/server-factory.ts`

**Problem:** transport selection is hardcoded `if/else` on `config.mcp.transport`. Adding WebSocket or Unix socket requires editing the bootstrap file.

**Proposed interface:**
```typescript
// spi/transport/protocol-adapter.ts
export interface ProtocolAdapter {
  start(server: McpServer, config: McpConfig, logger: Logger): Promise<void>
  stop(): Promise<void>
}
```

---

### ⚠️ `SkillProvider`   NOT YET IMPLEMENTED

**File that needs it:** `runtime/registry/filesystem-scanner.ts` + `skill-store.ts`

**Problem:** skills are loaded from disk at startup. No runtime update, no database source, no remote CMS.

**Proposed interface:**
```typescript
// spi/skill/skill-provider.ts
export interface SkillProvider {
  listSkills(serviceName: string): Promise<SkillDocument[]>
  getSkill(skillId: string): Promise<SkillDocument | undefined>
}
```

---

### ⚠️ `ToolResolver`   NOT YET IMPLEMENTED

**File that needs it:** `runtime/server-factory.ts`

**Problem:** five tools are hard-registered at startup. No dynamic registration, no custom tools.

**Proposed interface:**
```typescript
// spi/tool/tool-resolver.ts
export interface ToolResolver {
  registerAll(server: McpServer, registry: ServiceRegistry, config: GlobalConfig): void
}
```

---

### ✅ `AuditSink`

**Where:** `spi/observability/audit-sink.ts`, fanned out by `runtime/observability/audit-pipeline.ts`.

Every `api_execute` audit record and every execution state change (statuses,
approvals, decisions — no request/response bodies) goes to each sink listed
in `AUDIT_SINKS`. Built in: `console` (the structured log line, as before).
Register others — S3, PostgreSQL, a SIEM — without forking:

```typescript
import { registerAuditSinkBackend } from './runtime/gateway/strategy-builders.js'

registerAuditSinkBackend('s3', ({ loggerFor }) => new S3AuditSink(/* bucket, prefix */))
// AUDIT_SINKS=console,s3
```

A sink that throws is logged and skipped; the other sinks and the request are
unaffected. An unknown name in `AUDIT_SINKS` stops boot.

---

## 6. Known Issues

### `runtime/server-factory.ts` — mixed responsibilities

Bootstrap, tool wiring, transport selection, and shutdown handling are one function. See `ProtocolAdapter` and `ToolResolver` extension points above. Fix when a second transport or dynamic tools are needed.

### No metric for spec refresh failure

`service-refresher.ts` logs `warn` on failure but does not increment a metric counter. Silent repeated failures are invisible to dashboards. Fix: add `spec_refresh_failed_total` metric.

---

## 7. Stability Legend

| Module | Status | Notes |
|--------|--------|-------|
| `core/constants.ts` | ✅ Stable | Public API — env var names and tool names are breaking changes |
| `core/config/config.ts` | ✅ Stable | Zod schema is the config contract |
| `core/types/` | ✅ Stable | All SPI interfaces root here |
| `tools/` | ✅ Stable | Tool names + input schemas are public API |
| `spi/` | ✅ Stable | All interfaces frozen; adding fields is breaking |
| `adapters/` | ✅ Stable | Internal field names may change; public factory signatures are stable |
| `runtime/registry/service-registry.ts` | ✅ Stable | `ServiceResources` shape is public API |
| `runtime/http/` | ✅ Stable | HTTP transport + session manager |
| `runtime/spec/service-refresher.ts` | ✅ Stable | Per-service interval from `config.json`; `0` = disabled |
| `runtime/observability/` | ✅ Stable | Audit, metrics, logger, progress shapes established |
| `runtime/api-client/api-client.ts` | ✅ Stable | Implements `ConnectorAPI`; re-exports types for backwards compat |
| `runtime/gateway/strategy-builders.ts` | ✅ Stable | Thin re-export of `wiring/strategy-builders.ts`; `registerTokenCacheBackend` / `registerIdempotencyBackend` public API preserved |
| `wiring/strategy-builders.ts` | ✅ Stable | Canonical factory registry; built-in switch + external registration |
| `wiring/service-wiring.ts` | ✅ Stable | Auth + circuit-breaker resolver; accepts config descriptors, returns strategy instances |
| `runtime/registry/filesystem-scanner.ts` | ✅ Stable | Returns config descriptors; strategy instantiation delegated to `wiring/service-wiring.ts` |
| `runtime/server-factory.ts` | 🔴 Needs Refactor | Mixed responsibilities; blocks `ProtocolAdapter` + `ToolResolver` |
| `runtime/sandbox/sandbox-core.ts` | 🟡 Experimental | `isolated-vm` native addon; security model depends on single library |

---

## 8. Future Evolution

- Add `spec_refresh_failed_total` metric to `service-refresher.ts`
- OpenTelemetry trace propagation through `ConnectorAPI.request()` bridge
- `ProtocolAdapter` — when a third transport is added
- `SkillProvider` — when skills need a DB or remote source
- `ToolResolver` — when custom tools are needed
- Built-in S3 / GCS audit sinks — the `AuditSink` interface exists; `console` is the only built-in
- Remote service registry (etcd / Consul) — replace filesystem scanner
- Multi-tenant namespacing — isolated registries per tenant within one gateway

### Architectural Invariants — Never Break

1. **Sandbox isolation** — skill code must have zero direct access to gateway process, filesystem, or network. `ConnectorAPI` is the only outbound surface from inside the isolate.
2. **SPI boundary** — `runtime/` must only import `spi/` interfaces, never `adapters/` concrete classes directly. `wiring/` is the sole exception by design — it is the composition root whose entire purpose is wiring concrete adapters.
3. **`core/` independence** — `core/` has no imports from `runtime/`, `tools/`, `spi/`, or `adapters/`. It must stay importable by consumers without pulling in the full framework.
