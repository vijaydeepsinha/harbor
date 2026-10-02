# Example 03 — Local REST Backend

Connect the gateway to a backend running on localhost.

## Demo backends

The `examples/demo/` folder already has four local backends:

| Backend | Port | What it serves |
|---------|------|---------------|
| `product-service.js` | 3001 | Product catalog |
| `order-service.js` | 3002 | Order management |
| `task-service.js` | 3003 | Task CRUD with 4 seeded tasks |
| `irctc/` (Python FastAPI) | 3005 | Railway booking — needs its `.venv`, see [`irctc/README.md`](../demo/irctc/README.md) |

Start all four with the gateway: `bash examples/demo/start.sh`

## How to connect your own backend

Point `config.json` at your local server's host and port. The gateway and your backend run as separate processes — start the backend first, then start the gateway.

With the demo's `static-token` auth, the gateway forwards the caller's bearer in the `Authorization` header of every outbound request (the `token` in `config.json` is only a fallback). With the OAuth strategies it forwards the validated access token. Your backend only needs to validate the `Authorization` header.

## What a successful API call returns

```json
{ "data": { "id": "task-0001", "title": "...", "status": "done" }, "status": 200, "ok": true }
```

`data` is the parsed response body. `ok` is `true` for 2xx/3xx, `false` for 4xx. A 5xx or transport error throws — after `maxRetries` extra attempts for `GET`/`PUT`/`DELETE`, at once for `POST`/`PATCH` — see [`docs/skill-authoring.md`](../../docs/skill-authoring.md#error-handling) for full error handling patterns.
