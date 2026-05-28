# Example 01 — Basic Service

Minimum configuration to expose a backend API to an AI client.

## What you need

Each service is a folder under `SERVICES_DIR` with three files:

- `spec.yaml` — OpenAPI 3.x description of your API
- `config.json` — host, port, auth strategy, circuit breaker, idempotency settings
- `skills/<name>.md` — optional guidance the AI reads before making calls

The demo already has three complete examples of this pattern under `services/` (product, order, tasks). Start there.

## What the AI sees after discovery

```json
[
  { "service": "tasks", "description": "Task management — create, assign, and complete tasks." }
]
```

The AI then calls `discover_skills()` to read the skill files, `search_code()` to explore the spec, and `api_execute()` to make real HTTP calls.

## Reference

See `services/tasks/` for a working spec + config + skill that runs against the demo backend on port 3003.
