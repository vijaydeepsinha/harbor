# Service Onboarding Guide

This guide covers everything needed to register a backend API with the MCP gateway — from a minimal dev setup to a production-grade configuration with OAuth, spec refresh, and skills.

---

## How the Gateway Discovers Services

At startup, the gateway scans the directory set by `SERVICES_DIR` (default: `services/`). Every subdirectory that contains a `spec.yaml` (or `spec.json` / `spec.yml`) becomes a registered service.

```
services/
  my-service/           ← folder name becomes the service key
    spec.yaml           ← required
    config.json         ← optional (defaults apply if absent)
    skills/
      my-skill.md       ← optional; zero or many
```

The gateway also watches for `"enabled": false` in `config.json` — disabled services are skipped at startup.

Zero code changes needed. Drop the folder, restart the gateway.

---

## Minimum Required File: `spec.yaml`

Must be a valid OpenAPI 3.x spec. When an `api` block is present in `config.json`, the gateway uses `api.host`/`api.port`/`api.basePath` as the upstream base URL. When `api` is absent, the gateway falls back to `servers[0].url` from the spec.

```yaml
openapi: "3.0.0"
info:
  title: My Service
  version: "1.0.0"
servers:
  - url: http://my-api.internal:8080
paths:
  /api/v1/items:
    get:
      summary: List items
      parameters:
        - name: status
          in: query
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: string }
                    name: { type: string }
```

**Tip:** The AI uses the spec to write `search_code` and `api_execute` calls. Good `summary` and `description` fields in the spec help it choose the right endpoints.

---

## `config.json` — Full Reference

### Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | folder name | Service key used in tool parameters |
| `description` | string | `""` | What this service does — shown to the AI in `discover_services` |
| `enabled` | boolean | `true` | Set `false` to skip at startup |
| `serviceRefreshIntervalMs` | number | `0` | Spec + skills reload interval (ms). `0` = load once at startup |
| `serviceRefreshTimeoutMs` | number | `10000` | Timeout for each spec reload attempt |

### `api`

```json
{
  "api": {
    "protocol": "http",
    "host": "my-api.internal",
    "port": 8080,
    "basePath": "",
    "requestTimeoutMs": 30000,
    "maxRetries": 2,
    "tls": {
      "certPath": "/path/to/client.crt",
      "keyPath":  "/path/to/client.key",
      "caPath":   "/path/to/ca.crt"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `protocol` | `"http"` | `"http"` or `"https"` |
| `host` | `"localhost"` | Backend hostname |
| `port` | `8080` | Backend port |
| `basePath` | `""` | Path prefix prepended to all requests |
| `requestTimeoutMs` | `30000` | Per-request HTTP timeout |
| `maxRetries` | `2` | Number of retries on 5xx / network error |
| `tls` | — | Mutual TLS config (all three paths required when present) |

### `auth`

**Static token** (dev/POC):

```json
{
  "auth": {
    "type": "static-token",
    "token": "my-dev-token"
  }
}
```

The gateway forwards the client's bearer token as-is. Falls back to `token` only when the client provides no bearer header.

**OAuth introspection** (production):

```json
{
  "auth": {
    "type": "oauth-introspection",
    "host": "auth-server.example.com",
    "port": 8083,
    "introspectionPath": "/oauth/introspect",
    "method": "POST",
    "tokenPassMode": "body",
    "tokenParamName": "token",
    "refreshPath": "/oauth/token",
    "tokenRefreshBufferSec": 300,
    "authTimeoutMs": 5000,
    "responseMapping": {
      "access_token": "tokenResponse.token",
      "expires_in":   "tokenResponse.expiresIn",
      "refresh_token": "tokenResponse.refreshToken"
    },
    "metadataMapping": {
      "userId":    "userId",
      "accountId": "accountId"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `host` | required | Auth server hostname |
| `port` | required | Auth server port |
| `introspectionPath` | required | Path for token introspection (e.g. `/oauth/introspect`) |
| `protocol` | `"http"` | `"http"` or `"https"` |
| `method` | `GET` | `GET` or `POST` |
| `tokenPassMode` | `query` | How to pass token: `query`, `body`, or `header` |
| `tokenParamName` | `token` | Query/body param name for the token |
| `refreshPath` | — | Path for token refresh. Omit to disable proactive refresh |
| `tokenRefreshBufferSec` | `300` | Refresh when token expires within this window (seconds) |
| `authTimeoutMs` | `5000` | HTTP timeout for auth calls |
| `responseMapping` | `{}` | Dot-path map from auth response → `TokenPayload` fields |
| `metadataMapping` | `{}` | Dot-path map for extra fields (e.g. `userId`, `accountId`) |

**Dot-path mapping:** `"access_token": "tokenResponse.token"` means the value at `response.tokenResponse.token` is used as `access_token`.

**JWT validation** (local verification, no introspection round-trip):

```json
{
  "auth": {
    "type": "jwt-validation",
    "jwksUri": "https://auth.example.com/.well-known/jwks.json",
    "issuer": "https://auth.example.com",
    "audience": "https://harbor.example.com",
    "clockToleranceSec": 30,
    "scopeClaim": "scope",
    "metadataMapping": {
      "userId": "sub"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `jwksUri` | required | JWKS endpoint URL |
| `issuer` | required | Expected `iss` claim value |
| `audience` | not checked | Expected `aud` claim value |
| `clockToleranceSec` | `30` | Seconds of clock skew to allow |
| `scopeClaim` | `"scope"` | JWT claim name holding the scope string or array |
| `metadataMapping` | `{}` | Map JWT payload claims into `TokenPayload.metadata` |

**OAuth 2.1** (AS auto-discovery + JWT verification):

Harbor discovers the JWKS URI automatically by fetching `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server` from the `authorizationServer` base URL.

The `billing` service (`services/billing/`) is the concrete reference implementation — it ships disabled. Enable it and set `HARBOR_RESOURCE_URI` + `HARBOR_AUTH_SERVERS` to test end-to-end.

```json
{
  "auth": {
    "type": "oauth-2.1",
    "authorizationServer": "http://localhost:8080/default",
    "audience": "http://localhost:3333",
    "clockToleranceSec": 30,
    "metadataMapping": {
      "userId": "sub",
      "clientId": "client_id"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `authorizationServer` | required | Base URL of the AS (no trailing slash). Harbor fetches `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server` |
| `audience` | not checked | Expected `aud` claim value |
| `clockToleranceSec` | `30` | Seconds of clock skew to allow |
| `scopeClaim` | `"scope"` | JWT claim name for the scope |
| `metadataMapping` | `{}` | Map JWT payload claims into `TokenPayload.metadata` |
| `discoveryTimeoutMs` | `10000` | Timeout for the AS discovery HTTP call |

### Token cache

The token cache is **global** — not a per-service `config.json` field. Configure it via the `TOKEN_CACHE_TYPE` environment variable (or `.env`):

```bash
TOKEN_CACHE_TYPE=in-memory   # default
TOKEN_CACHE_TYPE=memcache
TOKEN_CACHE_TYPE=couchbase
TOKEN_CACHE_TYPE=redis        # custom — requires registerTokenCacheBackend('redis', ...)
```

**All services share the same auth server?** Set the same `host`/`port`/`introspectionPath` in each service's `auth` block. The global token cache ensures Harbor introspects only once per unique bearer token — subsequent calls across any service are cache hits.

See [`adapter-guide.md`](adapter-guide.md) for custom cache backends (Redis, Postgres, etc.).

### `idempotency`

```json
{ "idempotency": { "type": "noop" } }
{ "idempotency": { "type": "in-memory" } }
```

Idempotency is **per-service** — each service has its own strategy and key namespace.

`noop` is the right default for read-heavy services. Use `in-memory` for services with important write operations, or a gateway-wide remote backend (Memcache, Couchbase) configured via env vars — see [`configuration.md`](configuration.md).

### `circuitBreaker`

```json
{ "circuitBreaker": { "type": "noop" } }
{
  "circuitBreaker": {
    "type": "count-based",
    "failureThreshold": 5,
    "recoveryTimeMs": 30000
  }
}
```

State machine: `CLOSED → (N consecutive failures) → OPEN → (recoveryTimeMs) → HALF_OPEN → (first success) → CLOSED`

Paths are normalized before circuit state is tracked — `/orders/123` and `/orders/456` share the same circuit for `/orders/{id}`.

### `spec`

```json
{ "spec": { "source": "file" } }
{ "spec": { "source": "url", "url": "http://my-api.internal:8090/openapi.json" } }
{ "spec": { "source": "url-with-fallback", "url": "http://my-api.internal:8090/openapi.json" } }
```

| Source | Behavior |
|--------|----------|
| `file` (default) | Reads `spec.yaml` / `spec.json` from the service directory |
| `url` | Fetches spec from a URL at startup (and on each refresh cycle) |
| `url-with-fallback` | Tries URL first; falls back to local file if unreachable |

`url-with-fallback` is the recommended production setting — local dev works even when the remote API is unavailable.

---

## Writing Good Descriptions

The `description` in `config.json` is what the AI reads to pick the right service. Write it as if explaining to a colleague:

| Good | Bad |
|------|-----|
| `"Tasks service — task and project management. Manages tasks, projects, assignees, and priorities. Use for anything related to work items, backlogs, or sprint planning."` | `"Tasks API adapter"` |
| `"Billing service — invoicing, payments, and financial operations. Manages invoices, payment methods, billing cycles, credits, and subscription plans."` | `"Billing"` |

Include:
- **Domain** — what the service covers
- **Key entities** — what data it manages
- **Typical operations** — what actions are common
- **Disambiguation** — if two services overlap, note when to use each

---

## Writing Skills

Skills are Markdown files the AI reads before making API calls. They document business rules, required fields, validation constraints, and multi-step workflows.

Place them in `services/<name>/skills/` with `.md` extension.

**Frontmatter fields:**

```markdown
---
id: manage-tasks
title: Create, update, and close tasks with proper field validation
tags: [task, create, update, close, validation]
---
```

| Field | Description |
|-------|-------------|
| `id` | Informational — skill ID shown to the AI is the **filename without extension** |
| `title` | Informational — title shown to the AI is the **first `#` heading** in the file |
| `tags` | Keywords the AI can match when searching skills via `discover_skills` |

Frontmatter is included in the skill's `content` field — the AI can filter on it. The framework does not parse frontmatter fields directly.

**Body — what to include:**

```markdown
# Manage Tasks

Use this skill when creating or updating tasks.

## Required Fields for Task Creation

POST /api/v1/tasks requires:
- `title` (string, required) — task title
- `assigneeId` (string, required) — must be a valid user ID
- `priority` (string) — one of: "low", "medium", "high" (default: "medium")
- `dueDate` (ISO 8601 date, optional)

## Example

```javascript
const { data: task } = await api.request({
  method: 'POST',
  path: '/api/v1/tasks',
  body: { title: 'Fix login bug', assigneeId: 'user-123', priority: 'high' }
})
return task.id
```

## Status Transitions

Tasks follow: draft → active → in-progress → done | cancelled
Do not set status directly — use PATCH /api/v1/tasks/{id}/status with `{ nextStatus }`.

## Validation Rules

- Title must be 3–200 characters
- Cannot assign to a deactivated user
- Closed tasks cannot be reopened directly — create a new task instead
```

**Skills are reloaded** on each refresh cycle (controlled by `serviceRefreshIntervalMs`). Changes to `.md` files are picked up without gateway restart.

For a full walkthrough of frontmatter fields, `api.request()` patterns, error handling, and worked examples, see [`docs/skill-authoring.md`](skill-authoring.md).

---

## Service Refresh

When `serviceRefreshIntervalMs > 0`, the gateway reloads both the OpenAPI spec and all skill files on each tick. Both reload atomically — the live service is never in a partially updated state.

```json
{
  "serviceRefreshIntervalMs": 60000,
  "serviceRefreshTimeoutMs": 10000
}
```

If spec reload fails (URL unreachable, parse error), a `warn` log is emitted and the existing spec remains in use. Skills are read from disk and don't have a timeout.

**When to set what:**

| Service type | Suggested interval |
|--------------|-------------------|
| Fast-changing API (new endpoints regularly) | `60000` (1 min) |
| Stable production API | `300000` (5 min) |
| Static / no refresh needed | `0` (disabled) |

---

## Disabling a Service

Temporarily remove a service from the registry without deleting its files:

```json
{
  "enabled": false,
  "description": "Tasks service — temporarily disabled for maintenance"
}
```

Re-enable: set `"enabled": true` or remove the field, then restart.

---

## Minimal Example (`services/tasks/`)

This is the example that ships with the demo.

**`config.json`:**
```json
{
  "name": "tasks",
  "description": "Task management service — manages tasks, projects, and assignments.",
  "api": {
    "host": "localhost",
    "port": 3003,
    "requestTimeoutMs": 30000,
    "maxRetries": 1
  },
  "auth": { "type": "static-token", "token": "<YOUR_STATIC_TOKEN>" },
  "idempotency": { "type": "noop" },
  "circuitBreaker": { "type": "noop" },
  "serviceRefreshIntervalMs": 0
}
```

**`skills/manage-tasks.md`:**
```markdown
---
id: manage-tasks
title: Create, list, update, and close tasks
tags: [task, create, update, close]
---

# Manage Tasks

Use api.request() with:
- GET  /api/v1/tasks        — list all tasks
- POST /api/v1/tasks        — create a task (body: { title, assigneeId, priority })
- PATCH /api/v1/tasks/{id}  — update a task
- DELETE /api/v1/tasks/{id} — delete a task

api.request() returns { data, status, ok } — not { body }.
```

---

## Troubleshooting

**Service not appearing in `discover_services`**
- Check the folder has `spec.yaml` (or `spec.json` / `spec.yml`)
- Check `"enabled": false` is not set
- Check startup logs for `"Skipping service"` with reason

**Spec fails to parse**
- Run `npx @redocly/cli lint services/my-service/spec.yaml`
- Common issue: `$ref` paths not resolvable from the file location

**Auth fails immediately**
- For `static-token`: verify the `token` field matches what the client sends
- For `oauth-introspection`: check `host`/`port`/`introspectionPath` are correct and reachable from the gateway process
- For `oauth-2.1`: check that `authorizationServer` is reachable and exposes `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server`; check that `audience` matches the `aud` claim in the JWT

**Skills not showing up in `discover_skills`**
- Verify frontmatter is valid YAML (check indentation, no tab characters)
- Verify the file has a top-level `# Heading` — that is the title the gateway and AI use
- Check startup log for `"skills"` count: `{"msg":"Service registered","skills":1}`
