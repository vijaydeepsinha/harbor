# API Stability Reference

_Harbor v0.1.x — Stability classifications for all public and internal surfaces_

---

## Stability Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Stable | Frozen. Changes require a MAJOR version bump. |
| 🟡 Experimental | Working but may change in a MINOR release. No deprecation notice guaranteed. |
| 🔴 Needs Refactor | Known violation or design debt. Will change before v1.0. |
| ⚠️ Internal | Not public API. May change in any release without notice. |
| 🔮 Future | Planned. Interface proposed but not yet implemented. |

---

## Stable APIs

These surfaces are frozen as of v0.1.0. Any change to them is a breaking change and requires a MAJOR version bump.

### MCP Tool Names and Input Schemas

| Tool | MCP Name | Input Fields |
|------|----------|-------------|
| Discover services | `discover_services` | (none) |
| Discover skills | `discover_skills` | `service`, `code` |
| Get skill details | `get_skill_details` | `service`, `skill_id` |
| Search code | `search_code` | `service`, `code` |
| Execute API | `api_execute` | `service`, `code` |

**Breaking risk:** renaming a tool or adding a required input field breaks all existing AI clients.

---

### `spi/` — Extension Contracts

All SPI interfaces are frozen. Adding a field to any of these is a breaking change for all downstream implementors.

| Interface | File | Notes |
|-----------|------|-------|
| `ConnectorAPI` | `spi/connector/connector-api.ts` | `request(req, ctx, ttlMs): Promise<ApiResponse>` |
| `AuthStrategy` | `core/types/auth.types.ts` | `validate(token): Promise<TokenPayload>` |
| `AbstractTokenCache` | `spi/auth/abstract-token-cache.ts` | Base class — `readEntry`, `writeEntry`, `deleteEntry` |
| `IdempotencyStrategy` | `core/types/idempotency.types.ts` | `checkAndExecute(key, fn, ttlMs)` |
| `CircuitBreakerStrategy` | `core/types/circuit-breaker.types.ts` | `check(endpoint)`, `recordSuccess`, `recordFailure` |
| `PermissionGuard` | `core/types/permission.types.ts` | `filterSpec`, `canExecute` |
| `SpecLoaderStrategy` | `core/types/spec.types.ts` | `load(): Promise<OpenAPISpec>` |

---

### `core/` — Types and Constants

| Symbol | File | Notes |
|--------|------|-------|
| `GlobalConfig` | `core/types/config.types.ts` | All env var names map to this shape |
| `ApiRequest` / `ApiResponse` | `core/types/connector.types.ts` | Shared between sandbox bridge and ConnectorAPI |
| `ExecuteRequestContext` | `core/types/connector.types.ts` | Passed through sandbox → ConnectorAPI |
| `SandboxError` hierarchy | `core/types/sandbox-error.types.ts` | Error codes clients may receive |
| Tool name constants | `core/constants.ts` | String values used in MCP tool registration |
| Env var name constants | `core/constants.ts` | Names used in `process.env` and config docs |

---

### External Registration API

```typescript
// runtime/gateway/strategy-builders.ts
registerTokenCacheBackend(type: string, factory: TokenCacheFactory): void
registerIdempotencyBackend(type: string, factory: IdempotencyFactory): void
```

These two functions are public API. Their signatures are frozen.
Third-party connectors call these at startup; changing the signature breaks them.

---

### Environment Variables

All variables listed in `docs/configuration.md` are stable.
Adding a new variable is non-breaking. Removing or renaming is breaking.

---

### `ServiceResources` Shape

```typescript
// runtime/registry/service-registry.ts
interface ServiceResources {
  spec: SpecStore
  skills: SkillStore
  auth: AuthStrategy
  circuitBreaker: CircuitBreakerStrategy
  idempotency: IdempotencyStrategy
  permissionGuard: PermissionGuard
  apiClient: ConnectorAPI       // ← typed as interface, not HttpClient
  sandbox: SandboxLimits
}
```

`apiClient` typed as `ConnectorAPI` (not `ApiClient`) is a deliberate stability guarantee.
Callers that inject a custom `ConnectorAPI` will not break when `ApiClient` internals change.

---

### `config.json` Schema

All fields documented in `docs/service-onboarding.md` are stable. Additions are non-breaking. Field removals or type changes require MAJOR.

---

## Experimental APIs

These work in v0.1.0 but may change in a MINOR release. Third parties should not build production dependencies on them.

### `runtime/sandbox/`

| File | Status | Risk |
|------|--------|------|
| `sandbox-core.ts` | 🟡 Experimental | Depends on `isolated-vm` native addon. If `isolated-vm` changes its API or is replaced, the bridge changes. |
| `execute-api-in-sandbox.ts` | 🟡 Experimental | Internal bridge between sandbox and ConnectorAPI — may change shape if sandbox model changes. |
| `skills-search-in-sandbox.ts` | 🟡 Experimental | Relevance filter algorithm may improve — output shape stable, implementation may change. |
| `spec-search-in-sandbox.ts` | 🟡 Experimental | Same as above. |

**Mitigation:** the `api.request()` contract visible to skill authors is stable — only the internal bridge implementation is experimental.

### `MetricsRegistry`

```typescript
// runtime/observability/metrics.ts
```

In-memory counters only. No push endpoint, no Prometheus format yet. Counter names are stable; the registry API (`increment`, `get`) may gain new methods.

### `AuditRecord` shape

Audit records are logged via pino. The JSON field names are not yet frozen — Prometheus/SIEM integrations built on these field names may break in v0.2.0 when the StorageProvider SPI is added.

---

## Internal APIs

Not public API. May change in any release without notice or deprecation period.

| Module | Notes |
|--------|-------|
| `runtime/http/` internals | Session manager TTL, SSE writer, HTTP error format |
| `runtime/gateway/service-resources-factory.ts` | Wiring logic between config and strategies |
| `runtime/spec/service-refresher.ts` | Internal refresh loop — interval API stable, retry logic internal |
| `adapters/infra/` | CouchbaseRestClient, memcache factory — internal singleton management |
| `adapters/auth/strategies/oauth-introspection.strategy.ts` | Internal HTTP logic may change |
| `examples/` | Not API — demo code, may change freely |

---

## Future Extension Points (Not Yet Implemented)

These are planned interfaces, not yet shipped. Do not build against them.

| Interface | Planned for | Notes |
|-----------|-------------|-------|
| `ProtocolAdapter` | v1.1 | Pluggable MCP transport — HTTP, stdio, WebSocket |
| `SkillProvider` | v1.1 | Load skills from database or remote CMS |
| `ToolResolver` | v1.x | Dynamic tool registration beyond the five defaults |
| `StorageProvider` | v1.x | Structured audit export to S3, GCS, SIEM |

See `docs/architecture.md` section 5 for proposed interface shapes.

---

## Breaking Change Risk Matrix

| Change type | Breaking? | Mitigation |
|-------------|-----------|------------|
| Add field to `spi/` interface | ✅ Yes | Add with a default value; bump MAJOR |
| Remove field from `spi/` interface | ✅ Yes | Deprecate one MINOR first; bump MAJOR |
| Rename env var | ✅ Yes | Support old name for one MINOR via alias |
| Rename MCP tool | ✅ Yes | No alias possible in MCP — avoid |
| Add optional field to `config.json` | No | Additive; no action needed |
| Remove optional `config.json` field | ✅ Yes | Deprecate in CHANGELOG one MINOR first |
| Change `registerTokenCacheBackend` signature | ✅ Yes | Bump MAJOR |
| Change internal sandbox implementation | No | Not public API |
| Add new env var | No | Additive |
| Change pino log format | Potentially | Note in CHANGELOG if field names change |

---

## Recommendations for Stability Markers in Code

Add `@public` and `@experimental` JSDoc tags to all exported interfaces before v1.0.0:

```typescript
/**
 * Outbound transport contract. Implement this to replace HTTP/axios with gRPC, GraphQL, or a mock.
 * @public — part of the stable SPI surface. Changes require a MAJOR version bump.
 */
export interface ConnectorAPI { ... }

/**
 * @experimental — implementation depends on isolated-vm native addon.
 * The api.request() contract visible to skill authors is stable; this bridge may change.
 */
export async function runApiInSandbox(...) { ... }
```

This makes stability intent machine-readable and surfaceable in generated API docs.
