# Example 02 — Custom Connector

Register custom token-cache, idempotency, execution-store, audit-sink or rule-source backends without modifying the framework.

## How it works

The framework ships with built-in backends — token cache: `in-memory`, `memcache`, `couchbase`; idempotency: `noop`, `in-memory`, `memcache`, `couchbase`. To add your own (Redis, filesystem, Postgres), call the matching `register*Backend` function from `src/wiring/strategy-builders.ts` in your own entry point, before `createMcpGateway` is called, then select it by name (lower-case kebab-case). A name nothing registered is refused at startup.

| Backend | Register with | Select with |
|---|---|---|
| Token cache (one per gateway) | `registerTokenCacheBackend` | `TOKEN_CACHE_TYPE=redis` (env only — there is no per-service token cache) |
| Idempotency | `registerIdempotencyBackend` | `IDEMPOTENCY_TYPE=redis` (default for every service), or `"type"` in a service's `idempotency` block |
| Execution store | `registerExecutionStoreBackend` | `EXECUTION_STORE_TYPE=…` |
| Audit sink | `registerAuditSinkBackend` | `AUDIT_SINKS=console,…` |
| Governance Rule source | `registerGovernanceRuleSourceBackend` | `GOVERNANCE_RULES_SOURCE=…` |

## What changes in config.json

Only idempotency is per service. Its block is handed to your factory whole, so it can carry your backend's own settings:

```json
{ "idempotency": { "type": "redis", "url": "redis://localhost:6379" } }
```

A token-cache, idempotency or execution-store backend selected by env var receives only `{ type }` and reads its own settings; an audit-sink factory receives a per-service logger lookup, a rule-source factory the governance settings. Built-in types are unaffected.

## Reference

See `docs/adapter-guide.md` for the full `TokenCacheStrategy` and `IdempotencyStrategy` interfaces, plus Redis and gRPC examples, and `docs/configuration.md` for how the names are resolved.
