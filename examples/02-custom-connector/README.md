# Example 02 — Custom Connector

Register custom token-cache or idempotency backends without modifying the framework.

## How it works

The framework ships with built-in backends: `noop`, `in-memory`, `memcache`, `couchbase`. To add your own (Redis, filesystem, Postgres), call `registerTokenCacheBackend` or `registerIdempotencyBackend` before starting the gateway. Any service whose `config.json` sets `"type": "your-backend"` will use your implementation.

Registration must happen before `createMcpGateway` is called.

## What changes in config.json

The only difference from a standard service config is the `"type"` field in the `idempotency` or `tokenCache` block:

```json
{ "idempotency": { "type": "redis", "url": "redis://localhost:6379" } }
```

Built-in types are unaffected.

## Reference

See `docs/adapter-guide.md` for the full `TokenCacheStrategy` and `IdempotencyStrategy` interfaces, plus Redis and gRPC examples.
