# Example 05 — Runtime Routing

Different gateway strategies for different operation types — all pointing at the same backend.

## The pattern

Register the same backend twice as two different services: one with strict write-path settings (low circuit breaker threshold, long idempotency TTL), one with relaxed read-path settings (no circuit breaker, no idempotency).

The AI targets `tasks-write` for mutations and `tasks-read` for queries. The backend is the same; only the gateway behavior differs.

## Write-path vs read-path

| Setting | Write path | Read path |
|---------|-----------|-----------|
| Circuit breaker | 3 failures → open, 60s recovery | disabled |
| Idempotency | 10-minute deduplication window | disabled |
| Retries | 1 retry | 2 retries |

## When to use this pattern

- Keep mutations safe from cascading failures without blocking read traffic
- Prevent duplicate charges or order submissions on write endpoints
- Allow reads to retry freely without idempotency overhead
- Apply tighter sandbox limits to sensitive operations
