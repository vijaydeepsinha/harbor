# Example 03 — Local REST Backend

Connect the gateway to a backend running on localhost.

## Demo backends

The `examples/demo/` folder already has three local Node.js backends:

| Backend | Port | What it serves |
|---------|------|---------------|
| `product-service.js` | 3001 | Product catalog |
| `order-service.js` | 3002 | Order management |
| `task-service.js` | 3003 | Task CRUD with 4 seeded tasks |

Start all three: `bash examples/demo/start.sh`

## How to connect your own backend

Point `config.json` at your local server's host and port. The gateway and your backend run as separate processes — start the backend first, then start the gateway.

The gateway injects the auth token from `config.json` into every outbound request automatically. Your backend only needs to validate the `Authorization` header.

## What a successful API call returns

```json
{ "data": { "id": "task-1", "title": "...", "status": "open" }, "status": 200, "ok": true }
```

`data` is the parsed response body. `ok` is `true` for 2xx/3xx, `false` for 4xx. 5xx throws after retries — see [`docs/skill-authoring.md`](../../docs/skill-authoring.md#error-handling) for full error handling patterns.
