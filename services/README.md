# services/

This is where the gateway looks for service definitions on startup.

Four demo services are included so the framework works out of the box:

| Service | Backend port | Auth | What it does |
|---------|-------------|------|--------------|
| `product/` | 3001 | static-token | Product catalog — browse and search |
| `order/` | 3002 | static-token | Order management — place and track |
| `tasks/` | 3003 | static-token | Task CRUD — create, assign, complete |
| `billing/` | 3004 | oauth-2.1 | Billing — demonstrates OAuth 2.1 JWT validation (disabled by default) |

Start the token-mode demo backends: `bash examples/demo/start.sh`

OAuth 2.1 end-to-end test (enables `billing/`, requires Docker): `python3 tests/demo_e2e.py --start-services --oauth --oauth-resource-uri "http://127.0.0.1:3333" --oauth-auth-servers "https://auth.example.com" --docker-oauth`

---

## Adding your own service

Drop a folder here. The gateway picks it up on next start — no code changes needed.

```
services/
  my-service/
    spec.yaml        ← OpenAPI 3.x spec for your API
    config.json      ← host, port, auth, circuit breaker
    skills/
      my-skill.md    ← optional guidance the AI reads before calling your API
```

See `docs/service-onboarding.md` for the full `config.json` reference.

## Removing the demo services

Delete any of the `product/`, `order/`, `tasks/`, or `billing/` folders you don't need. The gateway only registers folders that contain a valid `spec.yaml` + `config.json`.
