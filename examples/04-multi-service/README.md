# Example 04 — Multi-Service

One gateway instance serving multiple services. The AI discovers all of them and routes requests independently by service name.

## How it works

Point `SERVICES_DIR` at a directory with multiple service subdirectories. The gateway scans each one on startup and registers them all.

The demo has three services ready under `services/` — product (3001), order (3002), tasks (3003). Start the demo backends and run the gateway against that directory.

## What the AI sees

```json
[
  { "service": "product", "description": "Product catalog — browse and search." },
  { "service": "order",   "description": "Order management — place and track orders." },
  { "service": "tasks",   "description": "Task management — create, assign, complete." }
]
```

The AI targets each service by name. The correct spec, auth token, circuit breaker, and idempotency strategy are applied automatically based on the target service's `config.json`.

## Per-service independence

Each service has its own strategy config. Changing the circuit breaker on `tasks` has no effect on `product` or `order`. See `services/*/config.json` for the demo values.
