# Example 04 — Multi-Service

One gateway instance serving multiple services. The AI discovers all of them and routes requests independently by service name.

## How it works

Point `SERVICES_DIR` at a directory with multiple service subdirectories. The gateway scans each one on startup and registers them all.

The demo has four services ready under `services/` — product (3001), order (3002), tasks (3003), irctc (3005). `bash examples/demo/start.sh` starts the backends and runs the gateway against that directory (the default `SERVICES_DIR`).

## What the AI sees

```json
[
  { "service": "irctc",   "description": "IRCTC railway booking service — search trains, check seat availability, …" },
  { "service": "order",   "description": "Order management service — place and track orders. …" },
  { "service": "product", "description": "Product catalog service — browse and search available products. …" },
  { "service": "tasks",   "description": "Task management service — create, update, and track tasks. …" }
]
```

The AI targets each service by name. The correct spec, auth token, circuit breaker, and idempotency strategy are applied automatically based on the target service's `config.json`.

## Per-service independence

Each service has its own strategy config. Changing the circuit breaker on `tasks` has no effect on `product` or `order`. See `services/*/config.json` for the demo values. The token cache (`TOKEN_CACHE_TYPE`) and the Code Mode execution store and Governance Rules are gateway-wide; rules can still target one service by name.
