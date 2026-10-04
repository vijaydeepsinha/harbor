# Adapter Guide

Adapters are concrete implementations of Harbor's extension contracts. This guide covers the six extension points, where to place your implementation, and how to select it.

---

## Concepts

The framework uses a layered architecture:

```
src/runtime/ ──► src/spi/   (provider contracts), src/core/   (data/errors/config)
     │
     └──► src/wiring/   (type name → implementation) ──► src/adapters/   (implementations)
```

Runtime orchestration uses provider contracts from `src/spi/` and shared data/errors from `src/core/`; concrete provider selection belongs in `src/wiring/strategy-builders.ts` and `src/wiring/service-wiring.ts`, including the default permission guard. The wiring layer also exposes synchronous directory loading and its missing-directory error for the existing runtime convenience API. Runtime and tools do not import adapter modules directly.

All concrete strategies (including no-op defaults, file/HTTP spec loaders and rule sources) live in `src/adapters/`. Auth orchestration and bearer parsing live in `src/runtime/auth/`. All provider interfaces live in `src/spi/`. Old implementation/core-contract paths are removed, not re-exported: use the canonical locations.

`tests/unit/layer-boundaries.test.ts` enforces declarative SPI files, inward core/adapter dependencies, no direct runtime/tool adapter imports and exactly one SPI declaration per provider interface.

**Six extension points:**

| Extension point | Contract | Selected by | Register with |
|----------------|----------|-------------|---------------|
| Token cache | `src/spi/auth/token-cache.ts → TokenCacheStrategy` (base class: `src/adapters/auth/abstract-token-cache.ts`) | `TOKEN_CACHE_TYPE` — one cache for the whole gateway | `registerTokenCacheBackend` |
| Idempotency | `src/spi/idempotency/idempotency-strategy.ts → IdempotencyStrategy` | `idempotency.type` in a service's `config.json`; `IDEMPOTENCY_TYPE` for services without an `idempotency` block | `registerIdempotencyBackend` |
| Execution store | `src/spi/execution/execution-store.ts → ExecutionPersistence` | `EXECUTION_STORE_TYPE` | `registerExecutionStoreBackend` |
| Audit sink | `src/spi/observability/audit-sink.ts → AuditSink` | `AUDIT_SINKS` — a comma list; every sink receives every event | `registerAuditSinkBackend` |
| Governance Rule source | `src/spi/governance/rule-source.ts → GovernanceRuleSource` | each service's `config.json` `governance.rulesSource` | `registerGovernanceRuleSourceBackend` |
| Outbound connector | `src/spi/connector/connector-api.ts → ConnectorAPI` | — built per service in `src/runtime/gateway/service-resources-factory.ts` | none (see [below](#writing-a-custom-outbound-connector-connectorapi)) |

Auth strategies and circuit breakers are chosen from a fixed set in `src/wiring/service-wiring.ts` (`auth.type`, `circuitBreaker.type`); they have no registration hook.

---

## Registration API

The five `register*Backend` functions live in `src/wiring/strategy-builders.ts`. Call them once, in your own entry point, before `createMcpGateway` runs (`src/index.ts` is the default entry point: it validates the config, then calls `createMcpGateway`).

```typescript
// An entry point in src/, like src/index.ts. The register functions are in src/wiring/strategy-builders.ts.
import { validateGlobalConfig } from './core/config/config.js'
import { createMcpGateway } from './runtime/server-factory.js'
import {
  registerTokenCacheBackend,
  registerIdempotencyBackend,
  registerExecutionStoreBackend,
  registerAuditSinkBackend,
  registerGovernanceRuleSourceBackend
} from './wiring/strategy-builders.js'

registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(ttlMs, logger))
registerIdempotencyBackend('postgres', (config, logger) => new PostgresIdempotency(String(config['connectionString']), logger))
registerExecutionStoreBackend('dynamo-db', (config, logger) => new DynamoExecutionStore(logger))
registerAuditSinkBackend('siem', ({ loggerFor }) => new SiemAuditSink(loggerFor))
registerGovernanceRuleSourceBackend('config-service', (governance, logger) => new ConfigServiceRuleSource(logger))

await createMcpGateway(servicesDir, validateGlobalConfig())
```

Then select them by name:

```bash
TOKEN_CACHE_TYPE=redis
IDEMPOTENCY_TYPE=postgres              # default for services without an idempotency block
EXECUTION_STORE_TYPE=dynamo-db
AUDIT_SINKS=console,siem
```

To fetch a service's Governance Rules from a URL, configure its `config.json`:

```json
{
  "governance": {
    "rulesSource": "url",
    "rulesUrl": "https://config.example/orders/rules.yaml",
    "rulesUrlTimeoutMs": 5000,
    "rulesRefreshSec": 60
  }
}
```

Idempotency can also be selected per service:

```json
{ "idempotency": { "type": "postgres", "connectionString": "postgres://...", "idempotencyKeyTtlMs": 600000 } }
```

**Names and failures.**
- `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE` and `EXECUTION_STORE_TYPE` accept a built-in type or a kebab-case name (`^[a-z][a-z0-9-]*$`); anything else stops boot at config validation (`src/core/config/config.ts`). No enum needs editing.
- A well-formed name that nothing registered is refused by the builder (`Unknown … type`). For the token cache and the execution store that stops boot. For idempotency the services using that name are skipped, and the gateway exits if none are left.
- `AUDIT_SINKS` takes any string; an unknown sink stops boot. An unknown service-selected Governance Rule source or invalid initial policy stops boot.
- The registry is consulted before the built-ins, so registering a built-in name (`memcache`) replaces that implementation.

**What each factory receives:**

| Factory | Arguments |
|---------|-----------|
| `TokenCacheFactory` | `(config, tokenCacheTtlMs, logger)`. For a registered name `config` is just `{ type }` — read your own connection settings (env vars, closure). |
| `IdempotencyFactory` | `(config, logger)`. From `config.json`, the service's whole `idempotency` block, extra keys included; from `IDEMPOTENCY_TYPE`, `{ type }`. Called once per service. |
| `ExecutionStoreFactory` | `(config, logger)` with `config` = `{ type }`. |
| `AuditSinkFactory` | `({ loggerFor })` — `loggerFor(service)` returns that service's logger. |
| `GovernanceRuleSourceFactory` | `(governance, logger)` — that service's source config (`rulesDir`, `rulesUrl`, `rulesRefreshSec`, …). |

---

## Writing a Token Cache Adapter

**File location:** `src/adapters/auth/strategies/<name>-token-cache.strategy.ts`

Extend `AbstractTokenCache` from `src/adapters/auth/abstract-token-cache.ts`. The base class implements every `TokenCacheStrategy` method (`hashToken`, `getOrValidate`, `get`, `update`, `invalidate`); you implement the storage:

```typescript
// src/adapters/auth/abstract-token-cache.ts
export abstract class AbstractTokenCache implements TokenCacheStrategy {
  abstract readonly name: string

  constructor(protected readonly configTtlMs: number, protected readonly logger?: Logger) {}

  protected abstract readEntry(key: string): Promise<CacheEntry | undefined>
  protected abstract writeEntry(key: string, entry: CacheEntry): Promise<void>
  protected abstract deleteEntry(key: string): Promise<void>
  abstract destroy(): void
}
```

`CacheEntry` is `{ payload: TokenPayload; expiresAt: number; tokenExpiresAt?: number }` — `expiresAt` is when the entry stops being served, `tokenExpiresAt` when the backend token expires (it drives proactive refresh). Store the entry whole.

What the base class guarantees, and a direct `TokenCacheStrategy` implementation must too:
- keys are per service **and** bearer (`sha256("<service>:<bearer>")`), so each service validates a bearer once per entry lifetime;
- an entry lives `min(token lifetime, AUTH_TOKEN_CACHE_TTL_MS)`;
- `update` (a refreshed payload) never extends a live entry's `expiresAt`, so a revoked caller token still stops working when its entry expires.

**Key rules:**
- Never throw from `readEntry` or `deleteEntry` — log and return `undefined`; the caller is then validated against the auth server. A throw fails the caller's request.
- `writeEntry` receives a pre-built `CacheEntry`; compute the storage TTL as `entry.expiresAt - Date.now()`. A failed write should be logged, not thrown.
- Call `super(ttlMs, logger)` in your constructor.

See `src/adapters/auth/strategies/memcache-token-cache.strategy.ts` for a complete reference implementation.

---

## Writing an Idempotency Adapter

**File location:** `src/adapters/idempotency/strategies/<name>-idempotency.strategy.ts`

Implement `IdempotencyStrategy` from `src/spi/idempotency/idempotency-strategy.ts` directly — no base class required:

```typescript
// src/spi/idempotency/idempotency-strategy.ts
export interface IdempotencyStrategy {
  readonly name: string
  checkAndExecute<T>(key: string, fn: () => Promise<T>, idempotencyKeyTtlMs: number): Promise<T>
  generateKey(userIdHash: string): string
}
```

`generateKey` is part of the contract, but nothing in the request path calls it; the built-ins delegate to `src/adapters/idempotency/strategies/keygen.ts`.

The `key` is chosen by the tool and the bridge, and is also sent to the backend as `X-Idempotency-Key`:

| Run | Key |
|-----|-----|
| Governed (the gateway always builds the Code Mode runtime) | `mcp-{service}-{executionId}-{sequence}` — `sequence` is the call's activity number in the execution journal |
| Legacy (no Code Mode runtime — embedders and tests) | `mcp-{service}-{userIdHash[0..12]}-{sha256(program)[0..16]}-c{n}` — `n` is the call's arrival index in the run |

Two executions never share a key, and a resume of one execution keeps its keys (`src/tools/execute-api.tool.ts`, `src/runtime/sandbox/bridge-request-handler.ts`).

**Key rules:**
- If the cache read fails, still call `fn()` — idempotency is best-effort in degraded mode
- If the cache write fails, still return the result — non-fatal
- Let `fn()` errors propagate and do not cache them (a 5xx or transport failure throws). A 4xx comes back as a value (`ok: false`); the built-in strategies cache it for the TTL like any other response — a known limitation.
- If you can, let concurrent callers with the same key wait for the first one (the in-memory strategy does)

See `src/adapters/idempotency/strategies/memcache-idempotency.strategy.ts` for a reference implementation.

---

## Writing an Execution Store

**File location:** `src/adapters/execution/<name>-execution-store.ts`

Implement `ExecutionPersistence` from `src/spi/execution/execution-store.ts` — one object that is all of:

`ExecutionRecordStore` covers execution records; `ExecutionPersistence` combines it
with the related stores and run locking. One adapter implements the combined contract.

The runtime exposes this contract as `GovernanceRuntime.persistence`.
Its settings are in `GlobalConfig.execution`; the `store` setting selects the
storage adapter and is configuration, not an `ExecutionPersistence` instance.

| Part | Methods |
|------|---------|
| `ExecutionRecordStore` | `createExecution`, `getExecution`, `updateExecution`, `deleteExecution`, `listExpiredExecutions(now, limit)` |
| `ActivityStore` | `putActivity`, `getActivity`, `listActivities` (ascending by sequence) |
| `ApprovalStore` | `putApproval`, `getApproval`, `listApprovals` (ascending by `createdAt`) |
| `GovernanceDecisionStore` | `putDecision`, `listDecisions` (ascending by `evaluatedAt`) |
| `ExecutionLockStore` | `acquireLock` (returns `false` when held — never waits), `releaseLock` |

plus `readonly name` and an optional `destroy()`.

**Key rules:**
- Return detached copies; callers mutate what they get back.
- The lock must exclude every gateway instance that shares the store. The in-memory and file stores lock in-process only; the memcache store uses `add` with a TTL that must outlive the longest run.
- `deleteExecution` removes the execution and everything recorded for it, lock included; `listExpiredExecutions` returns the oldest first, at most `limit`.

Run the contract suite the three built-ins pass: add a `contractSuite('<name>', () => new YourStore())` call to `tests/unit/execution-store.test.ts`. See `src/adapters/execution/memcache-execution-store.ts` for a shared-store reference.

---

## Writing an Audit Sink

**File location:** `src/adapters/observability/<name>-audit-sink.ts`

```typescript
// src/spi/observability/audit-sink.ts
export interface AuditSink {
  readonly name: string
  write(event: AuditEvent): Promise<void> | void
  close?(): Promise<void> | void
}
```

`AuditEvent` is `{ kind: 'audit', record: AuditRecord }` — one per `api_execute` call — or `{ kind: 'execution', state: ExecutionStateSnapshot }` — after each run ends and after each human decision; statuses, approvals and decisions, no request bodies and no program text.

A sink may throw: the pipeline logs the failure and still delivers the event to the other sinks, and nothing in the request path waits on it. With `ENABLE_AUDIT=false` no sink receives anything. Reference: `src/adapters/observability/console-audit-sink.ts`; tests: `tests/unit/audit-pipeline.test.ts`.

---

## Writing a Governance Rule Source

**File location:** `src/adapters/governance/strategies/<name>-rule-source.strategy.ts`, next to the built-ins, or under `src/adapters/`

```typescript
// src/spi/governance/rule-source.ts
export interface GovernanceRuleSource {
  readonly name: string
  load(): Promise<GovernanceRuleDocument[]>   // { name, format: 'yaml' | 'json', text }
}
```

**Key rules:**
- Return the whole set or throw — never part of it. A missing document must not read as "that rule no longer exists".
- Document order breaks precedence ties (file order for the file source's directory).
- Every enabled service's source is loaded before startup completes; a URL source is fetched immediately rather than waiting for its first timer. At boot, a throw stops the gateway (a missing file-source directory is the one tolerated case). On a service's refresh interval (`governance.rulesRefreshSec` > 0), a throw keeps that service's last valid set, and a set that would replace non-empty rules with none is refused.

References: `src/adapters/governance/strategies/directory-rule-source.strategy.ts`, `src/adapters/governance/strategies/url-rule-source.strategy.ts`; tests: `tests/unit/governance-rule-sources.test.ts`.

---

## Writing a Custom Outbound Connector (ConnectorAPI)

Implement `ConnectorAPI` from `src/spi/connector/connector-api.ts`:

```typescript
// src/spi/connector/connector-api.ts
export interface ConnectorAPI {
  request(apiRequest: ApiRequest, ctx: ExecuteRequestContext): Promise<ApiResponse>
}
```

`ExecuteRequestContext` (`src/core/types/connector.types.ts`) carries `tokenPayload`, `invalidate`, `idempotencyKey`, `idempotencyKeyTtlMs`, `correlationId` (the MCP request id, shared by all API calls in that sandbox run; an approval resume has a new one), optional `executionId` (the durable ID across governed approval turns), `clientId?` (the forwarded caller ID), `endpoint?` (the OpenAPI template the bridge used for this call) and `signal?`.

**There is no registration function.** `createMcpGateway` builds an `ApiClient` for every service in `src/runtime/gateway/service-resources-factory.ts`. To use another transport, change that construction, or assemble a `ServiceRegistry` yourself and hand it to `buildMcpServerFactory` / `startHttpGateway` — `tests/unit/code-mode-harness.ts` does this with a counting fake connector.

Before it calls you, the bridge has canonicalised the path, run governance, checked the permission guard and the circuit breaker, and journaled the call as `EXECUTING`. After you return, it records the response and credits the breaker. Everything else `ApiClient` (`src/runtime/api-client/api-client.ts`) does is yours to do:
- **Idempotency** — run the call through the service's `IdempotencyStrategy` with `ctx.idempotencyKey`.
- **Headers** — drop the program's forbidden headers (`PROGRAM_FORBIDDEN_HEADERS`: `Authorization`, Harbor's own `X-MCP-*` / `X-Harbor-*` / correlation / idempotency headers, and routing or framing headers such as `Host` and `X-Forwarded-*`). Then set `Authorization` from `ctx.tokenPayload.access_token`, `X-Correlation-ID`, `X-Idempotency-Key`, `X-Harbor-Server-ID`, and, when present, `X-Harbor-Client-ID` and `X-Harbor-Execution-ID`.
- **Retries** — only GET, PUT and DELETE, on 5xx or transport errors; never re-send a POST or PATCH.
- **Circuit breaker** — call `recordFailure(ctx.endpoint)` once per failed call. The bridge checks and credits the breaker under that key; any other key and the circuit never opens.
- **401** — call `ctx.invalidate()` so the caller's cached token is validated again.
- **Abort** — honour `ctx.signal`; it fires when the run times out or its drain grace ends, and a connector that ignores it is abandoned after one second.
- **Host** — keep requests on the service (`ApiClient` sets axios `allowAbsoluteUrls: false`).

**Return value contract:**
- `ok: true` — 2xx/3xx; `ok: false` — 4xx. Both go back to the program, are journaled `COMPLETED` and replayed on resume.
- `throw` — 5xx or transport failure. The activity is journaled `FAILED` with an unknown outcome, the program sees `<code>: <message>`, and a later resume stops with `ACTIVITY_OUTCOME_UNKNOWN`. The bridge does not retry a throw.

---

## Testing

Look at these for the patterns the built-ins use:

| Test | Covers |
|------|--------|
| `tests/unit/token-cache.test.ts` | token caches |
| `tests/unit/idempotency.test.ts` | idempotency strategies |
| `tests/unit/strategy-builders.test.ts` | registration, precedence, unknown names |
| `tests/unit/execution-store.test.ts` | the `ExecutionPersistence` contract suite |
| `tests/unit/audit-pipeline.test.ts` | audit sinks |
| `tests/unit/governance-rule-sources.test.ts` | rule sources, boot and refresh failures |

```bash
npx vitest run tests/unit/token-cache.test.ts
```

---

## Built-in Adapters Reference

| Adapter | File | Type string |
|---------|------|-------------|
| In-memory token cache | `src/adapters/auth/strategies/in-memory-token-cache.strategy.ts` | `in-memory` |
| Memcache token cache | `src/adapters/auth/strategies/memcache-token-cache.strategy.ts` | `memcache` |
| Couchbase token cache | `src/adapters/auth/strategies/couchbase-token-cache.strategy.ts` | `couchbase` |
| No-op idempotency | `src/adapters/idempotency/strategies/noop-idempotency.strategy.ts` | `noop` |
| In-memory idempotency | `src/adapters/idempotency/strategies/in-memory-idempotency.strategy.ts` | `in-memory` |
| Memcache idempotency | `src/adapters/idempotency/strategies/memcache-idempotency.strategy.ts` | `memcache` |
| Couchbase idempotency | `src/adapters/idempotency/strategies/couchbase-idempotency.strategy.ts` | `couchbase` |
| In-memory execution store | `src/adapters/execution/in-memory-execution-store.ts` | `in-memory` |
| File execution store | `src/adapters/execution/file-execution-store.ts` | `file` |
| Memcache execution store | `src/adapters/execution/memcache-execution-store.ts` | `memcache` |
| Console audit sink | `src/adapters/observability/console-audit-sink.ts` | `console` |
| File rule source | `src/adapters/governance/strategies/directory-rule-source.strategy.ts` | `file` |
| URL rule source | `src/adapters/governance/strategies/url-rule-source.strategy.ts` | `url` |
| No-op circuit breaker | `src/adapters/resilience/strategies/noop-circuit-breaker.strategy.ts` | `noop` |
| Count-based circuit breaker | `src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.ts` | `count-based` |
| Static token auth | `src/adapters/auth/strategies/static-token.strategy.ts` | `static-token` |
| OAuth introspection auth | `src/adapters/auth/strategies/oauth-introspection.strategy.ts` | `oauth-introspection` |
| JWT validation auth | `src/adapters/auth/strategies/jwt-validation.strategy.ts` | `jwt-validation` |
| OAuth 2.1 discovery auth | `src/adapters/auth/strategies/oauth-discovery.strategy.ts` | `oauth-2.1` |
| HTTP connector | `src/runtime/api-client/api-client.ts` | — |

All provider contracts are in `src/spi/`; shared payloads, records and errors are in `src/core/types/`. Follow the same separation for custom adapters.

---

## Apache Header Requirement

By project convention (`AGENTS.md` §4), every `.ts` source file starts with the two SPDX lines:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
```

No lint rule or CI step checks this; reviewers do.
