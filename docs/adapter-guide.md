# Adapter Guide

Adapters are concrete implementations of SPI (Service Provider Interface) contracts. This guide covers the three extension points, where to place your implementation, and how to register it.

---

## Concepts

The framework uses a layered architecture:

```
runtime/ → spi/ (interfaces)
               ↑
           adapters/ (implementations)
```

`runtime/` never imports from `adapters/` directly — only from `spi/` interfaces. This means you can swap any adapter without touching the gateway.

**Three extension points are stable:**

| Extension Point | SPI Interface | Purpose |
|----------------|---------------|---------|
| Token cache backend | `core/types/auth.types.ts → TokenCacheStrategy` | Persist validated tokens across requests/instances |
| Idempotency backend | `core/types/idempotency.types.ts → IdempotencyStrategy` | Dedup replayed API calls |
| Outbound transport | `spi/connector/connector-api.ts → ConnectorAPI` | Replace HTTP/axios with gRPC, GraphQL, mock |

---

## Registration API

Register custom backends at startup — before `createMcpGateway` runs:

```typescript
import { registerTokenCacheBackend, registerIdempotencyBackend } from './runtime/gateway/strategy-builders.js'
```

```typescript
// Token cache
registerTokenCacheBackend(
  'redis',                          // type string — matches TOKEN_CACHE_TYPE env var
  (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs, logger)
)

// Idempotency
registerIdempotencyBackend(
  'postgres',
  (config, logger) => new PostgresIdempotency(config, logger)
)
```

Activate token cache via environment variable (global, not per-service):
```bash
TOKEN_CACHE_TYPE=redis
```

Activate idempotency per service in `config.json`:
```json
{ "idempotency": { "type": "postgres", "connectionString": "postgres://..." } }
```

Built-in types (`in-memory`, `memcache`, `couchbase`, `noop`) are checked after the registry — custom registrations take precedence.

> **Required:** add your type string to the `allowedTypes` array in `core/config/config.ts` at the `TOKEN_CACHE_TYPE` / `IDEMPOTENCY_TYPE` call site. Without this, `resolveStoreTypeConfig` rejects the env var at startup.

---

## Writing a Token Cache Adapter

**File location:** `adapters/auth/strategies/<name>-token-cache.strategy.ts`

Extend `AbstractTokenCache` from `spi/auth/abstract-token-cache.ts`. The base class handles key hashing, TTL computation, and all `TokenCacheStrategy` method implementations. You implement three storage operations:

```typescript
// spi/auth/abstract-token-cache.ts
export abstract class AbstractTokenCache implements TokenCacheStrategy {
  abstract readonly name: string

  constructor(protected readonly configTtlMs: number, protected readonly logger?: Logger) {}

  protected abstract readEntry(key: string): Promise<CacheEntry | undefined>
  protected abstract writeEntry(key: string, entry: CacheEntry): Promise<void>
  protected abstract deleteEntry(key: string): Promise<void>
  abstract destroy(): void
}
```

`CacheEntry` is `{ payload: TokenPayload; expiresAt: number }`. The base class provides `getOrValidate`, `get`, `update`, and `invalidate` — do not implement these directly.

**Key rules:**
- Never throw from `readEntry` or `deleteEntry` — failures are non-fatal; the gateway falls back to direct auth server validation
- `writeEntry` receives a pre-built `CacheEntry`; compute TTL as `entry.expiresAt - Date.now()`
- Call `super(ttlMs, logger)` in your constructor

See `adapters/auth/strategies/memcache-token-cache.strategy.ts` for a complete reference implementation.

---

## Writing an Idempotency Adapter

**File location:** `adapters/idempotency/strategies/<name>-idempotency.strategy.ts`

Implement `IdempotencyStrategy` from `core/types/idempotency.types.ts` directly — no base class required:

```typescript
// core/types/idempotency.types.ts
export interface IdempotencyStrategy {
  checkAndExecute<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs: number
  ): Promise<T>
}
```

The `key` is generated per request from `sessionId + correlationId + method + path`.

**Key rules:**
- If the cache read fails, always call `fn()` — idempotency is best-effort in degraded mode
- If the cache write fails, still return the result — non-fatal
- Let `fn()` errors propagate; do not cache error results

See `adapters/idempotency/strategies/memcache-idempotency.strategy.ts` for a reference implementation.

---

## Writing a Custom Outbound Transport (ConnectorAPI)

**File location:** `adapters/connector/strategies/<name>-connector.strategy.ts`

Implement `ConnectorAPI` from `spi/connector/connector-api.ts`:

```typescript
// spi/connector/connector-api.ts
export interface ConnectorAPI {
  request(
    apiRequest: ApiRequest,
    ctx: ExecuteRequestContext  // includes idempotencyKeyTtlMs, correlationId, sessionId
  ): Promise<ApiResponse>
}
```

**Return value contract:**
- `ok: true` — 2xx/3xx; no circuit failure recorded
- `ok: false` — 4xx; no circuit failure, no retry
- `throw` — 5xx equivalent; circuit failure recorded, retried per `maxRetries`, eventually `ApiError` thrown

Pass your implementation to `ServiceResources.apiClient` in `runtime/gateway/service-resources-factory.ts`.

---

## Testing

Place tests under `tests/unit/adapters/`. Look at `tests/unit/token-cache.test.ts` and `tests/unit/idempotency.test.ts` for the test patterns used by the built-in adapters.

```bash
npm test -- tests/unit/adapters/
```

---

## Built-in Adapters Reference

| Adapter | File | Type string |
|---------|------|-------------|
| In-memory token cache | `adapters/auth/strategies/in-memory-token-cache.strategy.ts` | `in-memory` |
| Memcache token cache | `adapters/auth/strategies/memcache-token-cache.strategy.ts` | `memcache` |
| Couchbase token cache | `adapters/auth/strategies/couchbase-token-cache.strategy.ts` | `couchbase` |
| In-memory idempotency | `adapters/idempotency/strategies/in-memory-idempotency.strategy.ts` | `in-memory` |
| Memcache idempotency | `adapters/idempotency/strategies/memcache-idempotency.strategy.ts` | `memcache` |
| Couchbase idempotency | `adapters/idempotency/strategies/couchbase-idempotency.strategy.ts` | `couchbase` |
| Count-based circuit breaker | `adapters/resilience/strategies/count-based-circuit-breaker.strategy.ts` | `count-based` |
| Static token auth | `adapters/auth/strategies/static-token.strategy.ts` | `static-token` |
| OAuth introspection auth | `adapters/auth/strategies/oauth-introspection.strategy.ts` | `oauth-introspection` |
| JWT validation auth | `adapters/auth/strategies/jwt-validation.strategy.ts` | `jwt-validation` |
| OAuth 2.1 discovery auth | `adapters/auth/strategies/oauth-discovery.strategy.ts` | `oauth-2.1` |

All built-in adapters implement the corresponding `spi/` interface. Follow the same pattern for your custom adapters.

---

## Apache Header Requirement

Every new `.ts` source file requires the SPDX header:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
```

CI checks will fail without it.
