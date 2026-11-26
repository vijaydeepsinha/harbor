# Example 01 — Basic Service

Minimum configuration to expose a backend API to an AI client.

## What you need

Each service is a folder under `SERVICES_DIR` (default: the repo's `services/`); the folder name is the service name:

- `spec.yaml` (or `spec.json` / `spec.yml`) — OpenAPI 3.x description of your API
- `config.json` — required, with at least an `auth` block; also host, port, circuit breaker, idempotency settings
- `skills/<name>.md` — optional guidance the AI reads before making calls

The demo already has complete examples of this pattern under `services/`: three enabled (product, order, tasks) and three `billing` variants disabled for the OAuth mode. Start there.

## What the AI sees after discovery

```json
[
  { "service": "tasks", "description": "Task management service — create, update, and track tasks. …" }
]
```

The AI then calls `discover_skills()` to read the skill files, `search_code()` to explore the spec, and `api_execute()` to make real HTTP calls.

## Reference

See `services/tasks/` for a working spec + config + skill that runs against the demo backend on port 3003.
