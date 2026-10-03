# services/

This is where the gateway looks for service definitions on startup (unless `SERVICES_DIR` points elsewhere).

Seven demo services are included — four enabled so the framework works out of the box, and three `billing` variants, disabled by default, for the OAuth mode:

| Service | Backend port | Auth | Enabled | What it does |
|---------|-------------|------|---------|--------------|
| `product/` | 3001 | static-token | ✅ | Product catalog — browse and search |
| `order/` | 3002 | static-token | ✅ | Order management — place and track |
| `tasks/` | 3003 | static-token | ✅ | Task CRUD — create, assign, complete |
| `irctc/` | 3005 | static-token | ✅ | IRCTC railway booking — search, availability, fare, book, cancel |
| `billing/` | 3004 | oauth-2.1 | — | Billing — demonstrates OAuth 2.1 JWT validation with AS discovery |
| `billing-jwt/` | 3004 | jwt-validation | — | Same billing backend, JWT verified against a JWKS URI |
| `billing-introspection/` | 3004 | oauth-introspection | — | Same billing backend, token checked by the mock introspection server (:3008) |

Start the token-mode demo backends and the gateway: `bash examples/demo/start.sh`. The IRCTC backend is a Python (≥ 3.13) app — create its virtualenv first, as described in [`examples/demo/irctc/README.md`](../examples/demo/irctc/README.md).

OAuth mode — enables the three `billing` variants, disables product/order/tasks, and starts the mock AS (Docker), the billing backend and the introspection server: `bash examples/demo/start-oauth-mode.sh`. Ctrl-C restores the token-mode configs.

OAuth 2.1 end-to-end test (the same switch, automated; requires Docker): `python3 tests/demo_e2e.py --start-services --oauth --oauth-resource-uri "http://127.0.0.1:3333" --oauth-auth-servers "https://auth.example.com" --docker-oauth`

---

## Adding your own service

Drop a folder here. The gateway picks it up on next start — no code changes needed. The folder name is the service name.

```
services/
  my-service/
    spec.yaml        ← OpenAPI 3.x spec for your API (spec.json and spec.yml also work)
    config.json      ← required: at least an "auth" block; host, port, circuit breaker, …
    skills/
      my-skill.md    ← optional guidance the AI reads before calling your API
    governance/
      rules/
        policy.yaml  ← optional host-enforced policy for this service
```

Skills and Governance Rules are both service-owned resources, but serve different roles: Skills guide the agent; Governance Rules are evaluated by Harbor before backend calls. Configure a rule source and its refresh interval in the service's `config.json` `governance` block. Disabled services do not load their policies.

See `docs/service-onboarding.md`, `docs/configuration.md` and `governance/rules/README.md` for the full `config.json` and rule format references.

## Removing the demo services

Delete any of the demo folders you don't need. The gateway registers a folder only when it has a spec file and a `config.json` with an `auth` block, and skips any folder whose `config.json` has `"enabled": false` (the boolean) — set that instead of deleting if you just want to disable a service temporarily.
