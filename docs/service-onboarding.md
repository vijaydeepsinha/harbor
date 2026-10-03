# Service Onboarding Guide

This guide covers everything needed to register a backend API with the MCP gateway — from a minimal dev setup to a production-grade configuration with OAuth, spec refresh, and skills.

---

## How the Gateway Discovers Services

At startup, the gateway scans the directory set by `SERVICES_DIR`. Unset, that is the `services/` folder at the install root (beside `src/` or `dist/`), whatever the working directory; a set value is resolved against the working directory (`src/index.ts`). Every subdirectory that contains a `spec.json`, `spec.yaml` or `spec.yml` is a candidate service (`src/runtime/registry/filesystem-scanner.ts`).

```
services/
  my-service/           ← folder name becomes the service key
    spec.yaml           ← required
    config.json         ← required — must contain an `auth` block
    skills/
      my-skill.md       ← optional; zero or many
```

A service is skipped — with a log line naming why — when its `config.json` is missing or has no `auth` block (`config.auth is required`), when it sets `"enabled": false`, or when anything in it fails to load. The other services still load; if none do, the gateway exits.

Zero code changes needed. Drop the folder, restart the gateway.

---

## Minimum Required Files

### `spec.yaml`

Must be a valid OpenAPI 3.x spec; it is dereferenced at startup, and relative `$ref`s resolve beside the spec file. When an `api` block is present in `config.json`, the gateway uses it as the upstream base URL. When `api` is absent, the gateway uses `servers[0].url` from the spec — a URL without a port means 80 for `http` and 443 for `https`; a URL that does not parse skips the service. With neither, the gateway warns and uses `http://localhost:8080`.

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

**Tip:** The AI uses the spec to write `search_code` and `api_execute` calls, and Governance Rules name its `operationId`s and paths. Good `summary`, `description` and `operationId` fields help both.

### `config.json`

The smallest working file names an auth strategy:

```json
{ "auth": { "type": "static-token", "token": "dev-fallback-token" } }
```

---

## `config.json` — Full Reference

`config.json` is not schema-validated (a known limitation): a wrong type is not caught at startup. For example, `"enabled": "false"` (a string) does **not** disable the service, and a `tls` block missing one of its three paths is silently dropped. Check field types against the tables below.

### Top-level fields

The service key is the folder name; there is no `name` field.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | spec `info.description`, else `Service: <folder>` | What this service does — shown to the AI in `discover_services` |
| `enabled` | boolean | `true` | Set `false` to skip at startup |
| `auth` | object | **required** | See [`auth`](#auth) |
| `api` | object | from `servers[0].url` | See [`api`](#api) |
| `circuitBreaker` | object | no breaker | See [`circuitBreaker`](#circuitbreaker) |
| `idempotency` | object | gateway default (`IDEMPOTENCY_TYPE`, `noop` unless set) | See [`idempotency`](#idempotency) |
| `spec` | object | `{ "source": "file" }` | See [`spec`](#spec) |
| `sandbox` | object | gateway `SANDBOX_*` defaults | See [`sandbox`](#sandbox) |
| `serviceRefreshIntervalMs` | number | `0` | Spec + skills reload interval (ms). `0` = never; otherwise an integer from `1000` to `2147483647`, or the service is skipped |
| `serviceRefreshTimeoutMs` | number | `10000` | Timeout for each spec reload attempt; a positive integer ≤ `2147483647`, or the service is skipped |

### `api`

```json
{
  "api": {
    "protocol": "http",
    "host": "my-api.internal",
    "port": 8080,
    "basePath": "",
    "requestTimeoutMs": 30000,
    "maxRetries": 1,
    "tls": {
      "certPath": "/path/to/client.crt",
      "keyPath":  "/path/to/client.key",
      "caPath":   "/path/to/ca.crt"
    }
  }
}
```

When `api` is present, each field it leaves out takes the default below. When it is absent, everything comes from `servers[0].url`, with a 30000 ms timeout and 1 retry.

| Field | Default | Description |
|-------|---------|-------------|
| `protocol` | `"http"` | `"http"` or `"https"` |
| `host` | `"localhost"` | Backend hostname |
| `port` | `8080` | Backend port |
| `basePath` | `""` | Path prefix prepended to all requests |
| `requestTimeoutMs` | `30000` | Per-attempt HTTP timeout |
| `maxRetries` | `1` | Extra attempts for a GET, PUT or DELETE that got a 5xx or a transport error, backing off 500·2ⁿ ms plus up to 500 ms of jitter. POST and PATCH are sent once — a repeat could act twice |
| `tls` | — | Mutual TLS config (all three paths required when present) |

### `auth`

Every service needs one of four strategies.

**Static token** (dev/POC):

```json
{
  "auth": {
    "type": "static-token",
    "token": "my-dev-token"
  }
}
```

The gateway forwards the client's bearer token as-is and contacts no auth server: any well-formed bearer is accepted, and the backend is the only judge. `token` is required, but it is only a fallback for a call without a bearer, which the transports never let through (HTTP answers 401; stdio always presents `MCP_TOKEN`).

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
| `method` | `GET` | `GET` or `POST`. `GET` always sends the token as a query parameter |
| `tokenPassMode` | `query` | With `POST`: `query`, `body` (JSON), or `header` (`Authorization: Bearer`) |
| `tokenParamName` | `token` | Query/body param name for the token |
| `refreshPath` | — | Path for token refresh. Omit to disable proactive refresh |
| `tokenRefreshBufferSec` | `300` | Refresh when the backend token expires within this window (seconds) |
| `authTimeoutMs` | `5000` | HTTP timeout for auth calls |
| `responseMapping` | `{}` | Dot-path map from auth response → `TokenPayload` fields |
| `metadataMapping` | `{}` | Dot-path map for extra fields (e.g. `userId`, `accountId`). Map `userId`: it names the owner of Code Mode executions |
| `audience` | — | Optional, best-effort: compared with the response's `aud` only when the response carries one |

**Dot-path mapping:** `"access_token": "tokenResponse.token"` means the value at `response.tokenResponse.token` is used as `access_token`.

The default (`GET` with the token in the query string) puts the caller's token in a URL, and Harbor sends no client credentials to the introspection endpoint — both are open items; prefer `POST` with `body` or `header`. How `active`, `exp` and refresh are read: [`oauth-2.1-guide.md`](oauth-2.1-guide.md#oauth-introspection--token-introspection-rfc-7662).

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
| `audience` | required | Expected `aud` claim value (RFC 8707 resource binding). Missing or blank ⇒ the service is skipped |
| `clockToleranceSec` | `30` | Seconds of clock skew to allow |
| `scopeClaim` | `"scope"` | JWT claim name holding the scope string or array |
| `metadataMapping` | `{}` | Map JWT payload claims into `TokenPayload.metadata` |

Tokens must carry `exp` and be signed with an asymmetric algorithm (`RS*`, `PS*`, `ES*` or `EdDSA`).

**OAuth 2.1** (AS auto-discovery + JWT verification):

Harbor discovers the JWKS URI automatically by fetching `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server` from the `authorizationServer` base URL.

The `billing` service (`services/billing/`) is the concrete reference implementation — it ships disabled. `examples/demo/start-oauth-mode.sh` enables it (with `billing-jwt` and `billing-introspection`), starts the mock AS and sets `HARBOR_RESOURCE_URI` + `HARBOR_AUTH_SERVERS` to test end-to-end.

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
| `authorizationServer` | required | Base URL of the AS (no trailing slash); also the expected `iss`. Harbor fetches `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server` |
| `audience` | required | Expected `aud` claim value (RFC 8707 resource binding). Missing or blank ⇒ the service is skipped |
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

Entries are keyed by service **and** bearer, so each service validates a given bearer once per entry lifetime — `min(token lifetime, AUTH_TOKEN_CACHE_TTL_MS)`, default 300000 ms — even when several services share one auth server.

See [`adapter-guide.md`](adapter-guide.md) for custom cache backends (Redis, Postgres, etc.).

### `idempotency`

```json
{ "idempotency": { "type": "noop" } }
{ "idempotency": { "type": "in-memory", "idempotencyKeyTtlMs": 600000 } }
{ "idempotency": { "type": "memcache", "host": "localhost", "port": 11211, "kvTimeoutMs": 2000 } }
{ "idempotency": { "type": "couchbase", "host": "localhost", "port": 8093, "bucket": "default", "username": "", "password": "", "kvTimeoutMs": 3000 } }
```

Idempotency is **per-service** — each service gets its own strategy instance. The remote examples show the defaults each key takes when left out; `idempotencyKeyTtlMs` defaults to `600000`. `type` may also name a backend registered with `registerIdempotencyBackend` — the whole block is handed to its factory. An unknown type skips the service.

A service without an `idempotency` block uses the gateway default, `IDEMPOTENCY_TYPE` (`noop` unless set; its connection variables are in [`configuration.md`](configuration.md)).

Keys are per execution and per call — `mcp-{service}-{executionId}-{sequence}` — so a strategy deduplicates a repeated delivery of one activity, never two executions of the same program. `noop` is the right default for read-heavy services; `in-memory` deduplicates within one gateway process only.

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

No block (or `noop`) means no breaker. Set both `count-based` fields; one left out falls back to 5 or 30000.

State machine: `CLOSED → (failureThreshold consecutive failed calls) → OPEN → (recoveryTimeMs) → HALF_OPEN → (probe succeeds) → CLOSED`, or `(probe fails) → OPEN`.

- A failed call is a 5xx or transport error after its retries — it counts once, however many attempts it took. A 4xx counts as a success.
- While `OPEN`, calls fail with `CIRCUIT_OPEN` (retryable; the execution is `INTERRUPTED`).
- `HALF_OPEN` admits one probe at a time; other calls get `CIRCUIT_OPEN` until the probe reports or `recoveryTimeMs` passes.
- Circuits are per endpoint path (not per method), keyed by the OpenAPI template the call resolved to — `/orders/{orderId}` for every order id. A path not in the spec is keyed by its digit-normalised form (`/orders/123` → `/orders/{id}`). State is per gateway process.

### `spec`

```json
{ "spec": { "source": "file" } }
{ "spec": { "source": "url", "url": "http://my-api.internal:8090/openapi.json" } }
{ "spec": { "source": "url-with-fallback", "url": "http://my-api.internal:8090/openapi.json" } }
```

| Source | Behavior |
|--------|----------|
| `file` (default) | Reads `spec.yaml` / `spec.json` from the service directory |
| `url` | Startup still reads the local spec file; the URL is fetched on each refresh cycle |
| `url-with-fallback` | Startup reads the local spec file; each refresh tries the URL first and falls back to the local file |

The URL is never fetched at startup (a known limitation): a service needs a local spec file to load, and with `serviceRefreshIntervalMs: 0` the URL is never fetched at all. A fetched spec is capped at 20 MB, may use only internal `#/…` `$ref`s, and its URL is redacted in logs: query parameter names and multiplicity are kept, but **every value** is replaced with `REDACTED`, including values under arbitrary names such as `code` or `session`. Userinfo and fragments are removed (`redactUrl` in `src/core/utils/url.ts`). The origin and path remain visible; do not embed credentials there or in parameter names. `url-with-fallback` with a refresh interval is the recommended production setting — the service stays up when the remote API is unavailable.

### `sandbox`

Per-service overrides of the gateway's sandbox limits; each field left out takes the global default.

| Field | Global default (env var) | Meaning |
|-------|--------------------------|---------|
| `memoryLimitMb` | 64 (`SANDBOX_MEMORY_MB`) | Isolate heap limit |
| `executeTimeoutMs` | 8000 (`SANDBOX_EXECUTE_TIMEOUT_MS`) | Wall-clock budget of one `api_execute` run, awaits included |
| `searchTimeoutMs` | 3000 (`SANDBOX_SEARCH_TIMEOUT_MS`) | Wall-clock budget of `search_code` / `discover_skills` |
| `maxApiCalls` | 50 (`SANDBOX_MAX_API_CALLS`) | `api.request()` calls per run |
| `maxConcurrentCalls` | 5 (`SANDBOX_MAX_CONCURRENT_CALLS`) | Calls in flight at once |

```json
{ "sandbox": { "executeTimeoutMs": 10000, "maxApiCalls": 20, "maxConcurrentCalls": 3 } }
```

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

**Frontmatter** is optional; when present it is parsed:

```markdown
---
title: Create, update, and close tasks with proper field validation
tags: [task, create, update, close, validation]
---
```

| Field | Effect |
|-------|--------|
| `title` | The skill's title. Absent ⇒ the first `# ` heading, then the filename with hyphens as spaces |
| `tags` | A list; exposed as `tags` to `discover_skills` programs |
| `id` | Ignored — the skill id is always the **filename without `.md`**; it is what `get_skill_details` takes as `skill_id` |

`discover_skills` programs see each skill as `{ id, filename, title, tags, content }`, where `content` is the whole file, frontmatter included. A file that cannot be read or whose frontmatter does not parse is skipped with a warning (`Skipping skill "<file>" — it cannot be read or parsed`); the service and its other skills still load.

**Body — what to include** (an illustrative skill, not one that ships):

````markdown
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
````

**Skills are reloaded** with the spec on each refresh cycle (controlled by `serviceRefreshIntervalMs`). Changes to `.md` files are picked up without a gateway restart.

For a full walkthrough of frontmatter fields, `api.request()` patterns, error handling, and worked examples, see [`docs/skill-authoring.md`](skill-authoring.md).

---

## Service Refresh

When `serviceRefreshIntervalMs > 0`, one timer per service reloads both the OpenAPI spec and all skill files (`src/runtime/spec/service-refresher.ts`):

- The spec loads first, within `serviceRefreshTimeoutMs`, then the skills; both are swapped in together. The live service is never in a partially updated state.
- If the spec reload fails (URL unreachable, parse error, timeout), a `warn` log is emitted and **both** the existing spec and the existing skills stay in use.
- A tick that arrives while a reload is still running is skipped, so a slow load never lands after a newer one; nothing is swapped after shutdown.
- Skills are read from disk and don't have a timeout.

```json
{
  "serviceRefreshIntervalMs": 60000,
  "serviceRefreshTimeoutMs": 10000
}
```

A refresh can rename an `operationId` or drop a path. Governance Rules are not re-checked against the new spec, so a rule that named the old one silently stops applying (a known limitation) — review rules when the spec changes.

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
  "description": "Tasks service — temporarily disabled for maintenance",
  "auth": { "type": "static-token", "token": "demo-token-123" }
}
```

Re-enable: set `"enabled": true` or remove the field, then restart. `enabled` must be the boolean `false`, not the string `"false"`.

---

## Minimal Example (`services/tasks/`)

This is the `config.json` that ships with the demo:

```json
{
  "description": "Task management service — create, update, and track tasks. Use this service to list tasks, filter by status or project, create new tasks, update task status or assignee, and delete tasks.",
  "api": {
    "protocol": "http",
    "host": "localhost",
    "port": 3003,
    "basePath": "",
    "requestTimeoutMs": 10000,
    "maxRetries": 1
  },
  "enabled": true,
  "auth": {
    "type": "static-token",
    "token": "demo-token-123"
  },
  "spec": {
    "source": "file"
  },
  "serviceRefreshIntervalMs": 0,
  "circuitBreaker": {
    "type": "noop"
  },
  "idempotency": {
    "type": "noop"
  },
  "sandbox": {
    "executeTimeoutMs": 10000,
    "maxApiCalls": 20,
    "maxConcurrentCalls": 3
  }
}
```

and the start of its one skill, `services/tasks/skills/manage-tasks.md` (abridged):

```markdown
---
id: manage-tasks
title: Create, update, and track tasks
tags: [task, todo, project, assign, status, priority]
---

# Manage Tasks

Use this skill when the user wants to create tasks, check what's pending, update task status, reassign work, or delete tasks.

## Listing tasks

1. Call `GET /api/v1/tasks` to retrieve all tasks
2. Use `?status=todo` (or `in_progress`, `done`, `cancelled`) to filter by status
3. Use `?projectId=proj-001` to filter by project
4. Return the `tasks` array and `total` count
```

---

## Troubleshooting

**Service not appearing in `discover_services`**
- Check the folder has `spec.yaml` (or `spec.json` / `spec.yml`) and a `config.json` with an `auth` block
- Check `"enabled": false` is not set
- Check the startup logs:
  - `Service "<name>" is disabled — skipping`
  - `Failed to scan service "<name>" — skipping` — the `error` field says why: `config.auth is required`, a missing `audience`, an invalid refresh interval, an unparseable `servers[0].url`, a spec that does not parse
  - `Failed to build service resources — skipping service` — e.g. an unknown idempotency type, an unreadable TLS file
  - `Cannot read "<entry>" in the services directory — skipping` — e.g. a dangling symlink

**Spec fails to parse**
- Run `npx @redocly/cli lint services/my-service/spec.yaml`
- Common issue: `$ref` paths not resolvable from the spec file's location

**Auth fails immediately**
- For any strategy: the bearer must be a JWT or an opaque token of at least 32 base64url characters, or the transport answers 401 `TOKEN_INVALID` (`weak_credentials`)
- For `static-token`: Harbor accepts any well-formed bearer; a rejection comes from the backend — check what it expects
- For `oauth-introspection`: check `host`/`port`/`introspectionPath` are correct and reachable from the gateway process
- For `jwt-validation` / `oauth-2.1`: check that `audience` matches the JWT's `aud`, that the token carries `exp` and an asymmetric `alg`, and (oauth-2.1) that `authorizationServer` is reachable and exposes `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server`

**Skills not showing up in `discover_skills`**
- Look for `Skipping skill "<file>" — it cannot be read or parsed` in the logs (e.g. frontmatter that is not valid YAML — check indentation, no tab characters)
- Check the `skills` count in the startup log: `{"msg":"Service registered","skills":1}`
