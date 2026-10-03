# API Stability Reference

_Harbor 1.x (`package.json` 1.0.0, `GATEWAY_VERSION`) — stability classifications for all public and internal surfaces_

---

## Stability Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Stable | Frozen. Changes require a MAJOR version bump. |
| 🟡 Experimental | Working but may change in a MINOR release. No deprecation notice guaranteed. |
| 🔴 Needs Refactor | Known violation or design debt. Expect a change; it will be called out in `CHANGELOG.md`. |
| ⚠️ Internal | Not public API. May change in any release without notice. |
| 🔮 Future | Planned. Interface proposed but not yet implemented. |

---

## Stable APIs

These surfaces are frozen as of 1.0.0. Any change to them is a breaking change and requires a MAJOR version bump.

### MCP Tool Names and Input Schemas

| Tool | MCP Name | Input Fields |
|------|----------|-------------|
| Discover services | `discover_services` | (none) |
| Discover skills | `discover_skills` | `service`, `code` |
| Get skill details | `get_skill_details` | `service`, `skill_id` |
| Search code | `search_code` | `service`, `code` |
| Execute API | `api_execute` | `service`, `code` |

The five tools are the whole tool surface (`src/runtime/http/mcp-server-factory.ts` registers them per request). **Breaking risk:** renaming a tool or adding a required input field breaks all existing AI clients.

### The program contract (`api.request`)

What an `api_execute` program sees is stable: `api.request({ method, path, params?, body?, headers? })` resolves to `{ data, status, ok }`; `method` is one of `GET POST PUT PATCH DELETE`; a bridge refusal is thrown as an `Error` whose message starts with the error code (`GOVERNANCE_DENIED: …`).

🟡 Two parts of it are hardening rules that may tighten in a MINOR release:

- **Path canonicalisation** (`src/runtime/sandbox/request-path.ts`): absolute or protocol-relative URLs, backslashes, `#` fragments, empty interior segments, `.`/`..` segments (literal or encoded), segments that decode to `/`, `\` or a control character, malformed percent-encoding, and a query key repeated in the path or given in both the path and `params` are refused with `INVALID_API_REQUEST`.
- **Forbidden program headers** (`PROGRAM_FORBIDDEN_HEADERS` in `src/runtime/api-client/api-client.ts`): identity, Harbor-owned, routing and framing headers are dropped in any letter case; `Accept`, `Content-Type` and custom `X-…` headers pass.

---

### `src/spi/` — Extension Contracts

Adding a required member to any of these is a breaking change for every downstream implementor.

Before the first 1.0.0 release, the greenfield source layout was cleaned up:
provider interfaces moved from core to SPI, concrete strategies to adapters,
auth orchestration/parsing to `src/runtime/auth/`, and the shared cache base
to `src/adapters/auth/abstract-token-cache.ts`. Former source/deep-import paths
were removed, not re-exported. Consumers of development builds must update
imports; interface members and runtime behaviour did not change.

| Interface | File | Members | Status |
|-----------|------|---------|--------|
| `ConnectorAPI` | `src/spi/connector/connector-api.ts` | `request(apiRequest, ctx): Promise<ApiResponse>` | ✅ |
| `AuthStrategy` | `src/spi/auth/auth-strategy.ts` | `name`, `validate(token)`, `refresh?(refreshToken, currentAccessToken?)`, `tokenRefreshBufferSec?` | ✅ |
| `TokenCacheStrategy` | `src/spi/auth/token-cache.ts` | `name`, `hashToken`, `getOrValidate`, `get`, `update`, `invalidate`, `destroy` | ✅ |
| `AbstractTokenCache` | `src/adapters/auth/abstract-token-cache.ts` | Base class — implement `name`, `readEntry`, `writeEntry`, `deleteEntry`, `destroy` | ✅ |
| `IdempotencyStrategy` | `src/spi/idempotency/idempotency-strategy.ts` | `name`, `checkAndExecute(key, fn, ttlMs)`, `generateKey(userIdHash)` | ✅ |
| `CircuitBreakerStrategy` | `src/spi/resilience/circuit-breaker.ts` | `name`, `check(endpoint)`, `recordSuccess`, `recordFailure`, `getState` | ✅ |
| `PermissionGuard` | `src/spi/permissions/permission-guard.ts` | `filterSpec(spec, token)`, `canExecute(endpoint, method, token)` | ✅ |
| `SpecLoaderStrategy` | `src/spi/spec/spec-loader.ts` | `name`, `load(): Promise<OpenAPISpec>` | ✅ |
| `AuditSink` | `src/spi/observability/audit-sink.ts` | `name`, `write(event)`, `close?()` | ✅ |
| `ExecutionPersistence` | `src/spi/execution/execution-store.ts` | `name`, `destroy?` plus the execution, activity, approval, decision and lock stores it extends | 🟡 |
| `GovernanceRuleSource` | `src/spi/governance/rule-source.ts` | `name`, `load(): Promise<GovernanceRuleDocument[]>` (throws rather than return part of a set) | 🟡 |

`ExecutionPersistence` and `GovernanceRuleSource` belong to the Code Mode governance layer, which is new in 1.0.0 and still has open decisions (`ROADMAP.md`); their contracts may gain members in a MINOR release. The `AuditEvent` payload `AuditSink.write` receives is 🟡 (see [Audit event shapes](#audit-event-shapes)).

---

### `src/core/` — Types and Constants

| Symbol | File | Notes |
|--------|------|-------|
| `GlobalConfig` | `src/core/types/config.types.ts` | The validated shape every env var maps to |
| `ApiRequest` / `ApiResponse` | `src/core/types/connector.types.ts` | Shared between the sandbox bridge and `ConnectorAPI` |
| `ExecuteRequestContext` | `src/core/types/connector.types.ts` | Passed from the bridge to `ConnectorAPI`: token payload, `invalidate`, idempotency key and TTL, correlation and client ids, `endpoint` (the breaker key), `signal` |
| `TOOL` | `src/core/constants.ts` | Tool names used in MCP tool registration |
| `ERR` | `src/core/constants.ts` | Error codes clients receive — see [Error codes](#error-codes) |
| `HTTP_ROUTES`, `HTTP_HEADER` | `src/core/constants.ts` | The gateway's routes and the headers it sends and reads |

Env var names are not constants: they are the keys of the Zod schema in `src/core/config/config.ts`.

---

### External Registration API

```typescript
// src/wiring/strategy-builders.ts
registerTokenCacheBackend(type: string, factory: TokenCacheFactory): void            // ✅
registerIdempotencyBackend(type: string, factory: IdempotencyFactory): void          // ✅
registerAuditSinkBackend(type: string, factory: AuditSinkFactory): void              // ✅
registerExecutionStoreBackend(type: string, factory: ExecutionStoreFactory): void    // 🟡
registerGovernanceRuleSourceBackend(type: string, factory: GovernanceRuleSourceFactory): void // 🟡
```

Call them once at startup, before `createMcpGateway`. A registered backend is selected by name: `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE` and `EXECUTION_STORE_TYPE` accept a kebab-case registered name, a service's `config.json` `idempotency.type` may name one, `AUDIT_SINKS` lists sink names, and each service's `config.json` `governance.rulesSource` selects its rule source. An unregistered name is refused at boot: the gateway stops, except that a service whose idempotency type names nothing registered is skipped. The factory types (`TokenCacheFactory`, `IdempotencyFactory`, `AuditSinkFactory`, `ExecutionStoreFactory`, `GovernanceRuleSourceFactory`) are exported beside them and carry the same status as their register function.

---

### Environment Variables

Every variable validated in `src/core/config/config.ts` and listed in `docs/configuration.md` is ✅ Stable, except the Code Mode governance variables (`EXECUTION_*`, `GOVERNANCE_*`), which are 🟡 with the layer. Adding a new variable is non-breaking. Removing or renaming is breaking.

---

### `ServiceResources` Shape

```typescript
// src/runtime/registry/service-registry.ts
interface ServiceResources {
  name: string
  description: string
  specStore: SpecStore
  skillStore: SkillStore
  refresher: ServiceRefresher
  apiClient: ConnectorAPI          // ← typed as the interface, not ApiClient
  authMiddleware: AuthMiddleware
  circuitBreaker: CircuitBreakerStrategy
  permissionGuard: PermissionGuard
  idempotencyKeyTtlMs: number
  idempotencyStrategyName: string
  circuitBreakerStrategyName: string
  authStrategyName: string
  sandboxLimits: SandboxLimits
  logger: Logger
  metrics: MetricsRegistry
}
```

`apiClient` typed as `ConnectorAPI` (not `ApiClient`) is a deliberate stability guarantee: code that supplies its own connector does not break when `ApiClient` internals change. The gateway itself always builds `ApiClient` (`src/runtime/gateway/service-resources-factory.ts`); a custom connector today means building `ServiceResources` yourself. Injection through `createMcpGateway` is on the roadmap. A custom connector owns its retries, breaker failure recording (under `ctx.endpoint`) and outbound headers.

---

### `config.json` Schema

All fields documented in `docs/service-onboarding.md` are stable. Additions are non-breaking. Field removals or type changes require MAJOR.

---

### HTTP Surface

| Route | Status | Contract |
|-------|--------|----------|
| `POST /mcp` | ✅ | MCP 2026-07-28 Streamable HTTP, stateless (`legacy: 'reject'`). Missing, malformed or duplicate bearer ⇒ `401` (+ `WWW-Authenticate` when `HARBOR_RESOURCE_URI` is set); body over `MCP_MAX_BODY_BYTES` ⇒ `413 PAYLOAD_TOO_LARGE` |
| `GET /health` | ✅ | `{ status, protocolVersion, services }` |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/mcp/.well-known/oauth-protected-resource` | ✅ | RFC 9728 metadata; served only when `HARBOR_RESOURCE_URI` is set, else `404` |
| `GET /executions/{id}` | 🟡 | Inspection; owner-bound (`401`/`503` on bearer failure, `403 AUTH_FAILED` for another principal, `404 EXECUTION_NOT_FOUND`) |
| `POST /executions/{id}/approvals/{approvalId}` | 🟡 | Fallback approval: `{ action: accept \| decline \| cancel, approve?, comment? }` (`approve`: a boolean or a word from `APPROVAL_ANSWER_WORDS`); `400` bad body or a decision that no longer applies, `404` unknown approval, `409` already decided or locked, `413` over 64 KiB |

Error bodies from these routes are `{ error, code, … }` with `code` from `ERR`.

### Protocol Metadata and Outbound Headers

| Surface | Status | Notes |
|---------|--------|-------|
| `io.modelcontextprotocol/serverInfo` in response `_meta` | ✅ | Protocol-defined; `{ name: "harbor", version }` |
| `harbor/execution-id`, `harbor/execution-status`, `harbor/approval-id` (`_meta`) | 🟡 | `META_PREFIX` (`src/core/constants.ts`) is a placeholder until the project's public name is settled; `harbor/execution-id` in a request `_meta` resumes an execution |
| `input_required` approval form (input key `approval`; `approve` boolean — the listed answer words are accepted too — and `comment`) | 🟡 | The MRTR pattern is the protocol's; the form content is Harbor's |
| Outbound `Authorization`, `Content-Type`, `X-Request-Source`, `X-MCP-Tool`, `X-MCP-Service`, `X-MCP-Version`, `X-Idempotency-Key`, `X-Correlation-ID` | ✅ | Header names. Values are not frozen: `X-Correlation-ID` is the current MCP request id (shared within one sandbox run), while governed idempotency keys include the durable execution id (`mcp-{service}-{executionId}-{sequence}`) |
| Outbound `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `X-Harbor-Execution-ID` | ✅ | Gateway stamp, optional forwarded caller ID, and governed execution ID respectively; `X-Harbor-Execution-ID` is absent on the legacy path |

### Error Codes

`ERR` in `src/core/constants.ts` is the vocabulary of every tool error (`{ error, code, retryable, … }` with `isError: true`) and HTTP error body. Removing or renaming a code, or flipping its `retryable`, is breaking; adding a code is not.

| Codes | Status |
|-------|--------|
| `UNKNOWN`, `UNKNOWN_SERVICE`, `UNKNOWN_SKILL`, `AUTH_FAILED`, `MISSING_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `SESSION_EXPIRED`, `INTROSPECTION_FAILED`, `API_ERROR`, `CIRCUIT_OPEN`, `PERMISSION_DENIED`, `CALL_LIMIT_EXCEEDED`, `CONCURRENT_LIMIT_EXCEEDED`, `SANDBOX_INTERNAL_ERROR`, `SANDBOX_TIMEOUT`, `SANDBOX_MEMORY`, `SANDBOX_SYNTAX`, `SANDBOX_RUNTIME`, `INVALID_API_REQUEST`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `INTERNAL` | ✅ |
| `APPROVAL_REQUIRED`, `GOVERNANCE_DENIED`, `REPLAY_DIVERGED`, `EXECUTION_LOCKED`, `EXECUTION_NOT_FOUND`, `EXECUTION_NOT_RESUMABLE`, `EXECUTION_CANCELLED`, `ACTIVITY_OUTCOME_UNKNOWN`, `RUN_OUTCOME_NOT_RECORDED`, `APPROVAL_NOT_FOUND`, `APPROVAL_ALREADY_DECIDED` | 🟡 |

The domain errors carrying them all expose `code` and `retryable`: `SandboxError` (`src/core/types/sandbox-error.types.ts`), `AuthError` (`src/core/types/auth.types.ts`), `ExecutionError` (`src/core/types/execution.types.ts`), plus `PermissionDeniedError`, `CircuitOpenError` and `ApiError` (`src/runtime/api-client/api-client.ts`). Class names are ⚠️ Internal; the codes are the contract.

---

## Experimental APIs

These work in 1.0.0 but may change in a MINOR release. Third parties should not build production dependencies on them.

### `src/runtime/sandbox/`

| File | Status | Risk |
|------|--------|------|
| `sandbox-core.ts` | 🟡 Experimental | Depends on `isolated-vm` native addon. If `isolated-vm` changes its API or is replaced, the bridge changes. |
| `execute-api-in-sandbox.ts` | 🟡 Experimental | Runs one program: wires the bridge into the isolate, drains calls the program did not await, and promotes recorded violations — may change shape if the sandbox model changes. |
| `bridge-request-handler.ts` | 🟡 Experimental | Internal bridge between sandbox and ConnectorAPI (the per-run `api.request()` pipeline and its admission lock) — may change shape if the sandbox or execution model changes. |
| `request-path.ts` | 🟡 Experimental | Path canonicalisation; the refused set may grow. |
| `skills-search-in-sandbox.ts` | 🟡 Experimental | Relevance filter algorithm may improve — output shape stable, implementation may change. |
| `spec-search-in-sandbox.ts` | 🟡 Experimental | Same as above. |

**Mitigation:** the `api.request()` contract visible to program authors is stable — only the internal bridge implementation is experimental.

### Code Mode governance layer

The execution engine (`src/runtime/execution/`), the governance runtime (`src/runtime/governance/`) and their SPIs, env vars, routes, `_meta` keys and error codes are 🟡 as a whole; the specifics are in the tables above and in `docs/code-mode-governance.md`.

The **Governance Rule file format** — documented in `governance/rules/README.md`, validated by `src/runtime/governance/rule-schema.ts` — is 🟡: several of its semantics are open owner decisions (`ROADMAP.md`). A rule set that validates today may be refused, or decided differently, after a MINOR release; `CHANGELOG.md` will say so.

### `MetricsRegistry`

```typescript
// src/runtime/observability/metrics.ts
```

In-memory counters only, flushed as a `metrics_flush` log line every 60 s. No push endpoint, no Prometheus format yet, and no injection seam (the gateway constructs `MetricsRegistry` itself). Counter names (`METRIC` in `src/core/constants.ts`) are stable; the registry API (`increment`, `stop`; tools see it as `MetricsCollector`, `src/core/types/metrics.types.ts`) may gain new methods.

### Audit event shapes

Every `api_execute` call produces one `AuditRecord` (`src/core/types/audit.types.ts`), and every persisted execution state change produces an `ExecutionStateSnapshot` (`src/spi/observability/audit-sink.ts`); both reach each `AUDIT_SINKS` sink as an `AuditEvent` (`{ kind: 'audit', record }` or `{ kind: 'execution', state }`). The built-in `console` sink logs them as `audit` and `execution-state` lines via pino. The field names are not yet frozen — SIEM integrations built on them may break in a MINOR release.

---

## Internal APIs

Not public API. May change in any release without notice or deprecation period.

| Module | Notes |
|--------|-------|
| `src/runtime/http/` internals | Routing, bounded body reader (`read-body.ts`), `HttpError` funnel, execution-route handlers |
| `src/runtime/execution/` internals | `ExecutionManager`, `ApprovalService`, `ActivityJournal`, `ActivityGate`, retention sweeper, `requestState` codec |
| `src/runtime/governance/` internals | Operation resolver, evaluator, loader, rule store and refresher — the rule *format* is the contract, not these modules |
| `src/runtime/gateway/service-resources-factory.ts` | Wiring logic between config and strategies |
| `src/runtime/spec/service-refresher.ts` | Internal refresh loop — interval API stable, retry logic internal |
| `src/adapters/infra/` | CouchbaseRestClient, memcache factory — internal singleton management |
| `src/adapters/auth/strategies/oauth-introspection.strategy.ts` | Internal HTTP logic may change |
| `examples/` | Not API — demo code, may change freely |

---

## Future Extension Points (Not Yet Implemented)

These are planned interfaces, not yet shipped. Do not build against them.

| Interface | Planned for | Notes |
|-----------|-------------|-------|
| `ProtocolAdapter` | v1.1 | Pluggable MCP transport — HTTP, stdio, WebSocket |
| `SkillProvider` | v1.1 | Load skills from database or remote CMS |
| `ConnectorAPI` injection | v1.1 | Supply a connector per service through `createMcpGateway` instead of building `ServiceResources` yourself |
| `ToolResolver` | v1.x | Dynamic tool registration beyond the five defaults. The five tools are frozen today, so this needs a maintainer decision first |

See the extension-points section of `docs/architecture.md` for proposed interface shapes; `ROADMAP.md` tracks them. (The planned `StorageProvider` shipped as `AuditSink`, `src/spi/observability/audit-sink.ts`.)

---

## Breaking Change Risk Matrix

| Change type | Breaking? | Mitigation |
|-------------|-----------|------------|
| Add required member to a ✅ `src/spi/` or `src/core/types/` interface | ✅ Yes | Make it optional; otherwise bump MAJOR |
| Remove member from a ✅ interface | ✅ Yes | Deprecate one MINOR first; bump MAJOR |
| Rename env var | ✅ Yes | Support old name for one MINOR via alias |
| Rename MCP tool | ✅ Yes | No alias possible in MCP — avoid |
| Rename an `ERR` code or flip its `retryable` | ✅ Yes | Add a new code instead |
| Add optional field to `config.json` | No | Additive; no action needed |
| Remove optional `config.json` field | ✅ Yes | Deprecate in CHANGELOG one MINOR first |
| Change any `register*Backend` signature | ✅ Yes (🟡 ones: MINOR) | Bump MAJOR for the ✅ ones |
| Rename a `harbor/*` `_meta` key | Experimental | Note in CHANGELOG; expected once `META_PREFIX` is settled |
| Tighten the Governance Rule schema | Experimental | Note in CHANGELOG; rule files may need edits |
| Change internal sandbox implementation | No | Not public API |
| Add new env var | No | Additive |
| Change pino log format | Potentially | Note in CHANGELOG if field names change |

---

## Recommendations for Stability Markers in Code

No exported interface carries a stability tag yet. Add `@public` and `@experimental` JSDoc tags so the classification above is visible where the code is:

```typescript
/**
 * Outbound transport contract. Implement this to replace HTTP/axios with gRPC, GraphQL, or a mock.
 * @public — part of the stable SPI surface. Changes require a MAJOR version bump.
 */
export interface ConnectorAPI { ... }

/**
 * @experimental — implementation depends on isolated-vm native addon.
 * The api.request() contract visible to program authors is stable; this bridge may change.
 */
export async function runApiInSandbox(...) { ... }
```

This makes stability intent machine-readable and surfaceable in generated API docs.
