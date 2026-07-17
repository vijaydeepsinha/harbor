# Harbor configuration

Configuration is split into **server (process) level** — environment variables validated once at startup — and **per-service** JSON beside each service's OpenAPI file. Code: `core/config/config.ts` (global) and `runtime/registry/filesystem-scanner.ts` (`ServiceConfig`).

The OpenAPI file is always `spec.json` | `spec.yaml` | `spec.yml` in the service folder. There is no `spec.path` in code.

---

## Server-level configuration (environment variables)

These apply to the **whole gateway process**: bind address, shared token cache, default sandbox limits, logging, etc. Set them in your orchestrator (Kubernetes `env` / Secret, systemd, etc.). A commented template with defaults is in **`.env.example`**.

### Complete index (grep-friendly)

Read at process entry (`index.ts`): `SERVICES_DIR`.

Parsed on every startup (`GlobalConfigSchema` in `config.ts`):  
`MCP_HOST`, `MCP_PORT`, `MCP_TRANSPORT`, `MCP_TOKEN` (optional unless `MCP_TRANSPORT=stdio`), `AUTH_TOKEN_CACHE_TTL_MS`, `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE`, `SANDBOX_MEMORY_MB`, `SANDBOX_EXECUTE_TIMEOUT_MS`, `SANDBOX_SEARCH_TIMEOUT_MS`, `SANDBOX_MAX_API_CALLS`, `SANDBOX_MAX_CONCURRENT_CALLS`, `LOG_LEVEL`, `SERVICE_NAME`, `MCP_AGENT_NAME`, `ENVIRONMENT`, `ENABLE_AUDIT`, `HARBOR_RESOURCE_URI`, `HARBOR_AUTH_SERVERS`, `HARBOR_SCOPES_SUPPORTED`.

Read only when the matching backend is active:

| If … | Then also set … |
|------|-----------------|
| `TOKEN_CACHE_TYPE=memcache` | `TOKEN_CACHE_MEMCACHE_HOST`, `TOKEN_CACHE_MEMCACHE_PORT`; optional `TOKEN_CACHE_MEMCACHE_TIMEOUT_MS` |
| `TOKEN_CACHE_TYPE=couchbase` | `TOKEN_CACHE_CB_HOST`, `TOKEN_CACHE_CB_PORT`, `TOKEN_CACHE_CB_BUCKET`, `TOKEN_CACHE_CB_USERNAME`, `TOKEN_CACHE_CB_PASSWORD`; optional `TOKEN_CACHE_CB_TIMEOUT_MS` |
| `IDEMPOTENCY_TYPE=memcache` | `IDEMPOTENCY_MEMCACHE_HOST`, `IDEMPOTENCY_MEMCACHE_PORT`; optional `IDEMPOTENCY_MEMCACHE_TIMEOUT_MS` |
| `IDEMPOTENCY_TYPE=couchbase` | `IDEMPOTENCY_CB_HOST`, `IDEMPOTENCY_CB_PORT`, `IDEMPOTENCY_CB_BUCKET`, `IDEMPOTENCY_CB_USERNAME`, `IDEMPOTENCY_CB_PASSWORD`; optional `IDEMPOTENCY_CB_TIMEOUT_MS` |

**Kubernetes/other orchestrators:** ConfigMaps or environment files may contain extra keys for other tooling. The MCP gateway **ignores** any env var not listed above.

### Config file loader (optional)

On startup the gateway tries to read a config file before Zod validation runs. Entries in the file are merged into `process.env`; existing vars (e.g. from Kubernetes Secrets injected via `envFrom`) take precedence.

| Variable | Default | Role |
| -------- | ------- | ---- |
| `MCP_CONFIG_FILE` | `/etc/harbor-config/config.yaml` | Path to a YAML config file. Each line is `KEY: value`. File absence is silently ignored. |

**Typical Kubernetes usage:** mount a `ConfigMap` to `/etc/harbor-config/config.yaml` for non-sensitive defaults; inject sensitive values (credentials, tokens) via a `secretRef` so they take precedence over the file.

In local development the file path does not exist; `dotenv` populates `process.env` from `.env` instead.

### Service directory

| Variable       | Default      | Role                                                               |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `SERVICES_DIR` | `./services` | Path to the services directory scanned at startup. Resolved relative to `process.cwd()`. |

### MCP HTTP / stdio server

| Variable        | Default     | Role                                                                         |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `MCP_HOST`      | `127.0.0.1` | Host the gateway listens on.                                                 |
| `MCP_PORT`      | `3333`      | TCP port for Streamable HTTP.                                                |
| `MCP_TRANSPORT` | `http`      | `http` (default) or `stdio`.                                                 |
| `MCP_TOKEN`     | —           | Required when `MCP_TRANSPORT=stdio` — static bearer for the stdio transport. |

### Token cache (shared by **all** services)

One backend for the entire gateway. Token entries are keyed per-service internally so services never see each other's tokens.

| Variable                  | Default     | Role                                                                                    |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_CACHE_TTL_MS` | `300000`    | Upper bound on cached token lifetime in ms. Actual TTL = min(token `expires_in`, this). |
| `TOKEN_CACHE_TYPE`        | `in-memory` | `in-memory` (default), `memcache`, or `couchbase`.                                      |

**When `TOKEN_CACHE_TYPE=memcache`** — Memcached cluster for token entries:

| Variable                          | Required | Default | Role                  |
| --------------------------------- | -------- | ------- | --------------------- |
| `TOKEN_CACHE_MEMCACHE_HOST`       | ✅       | —       | Memcached host.       |
| `TOKEN_CACHE_MEMCACHE_PORT`       | ✅       | —       | Memcached port.       |
| `TOKEN_CACHE_MEMCACHE_TIMEOUT_MS` |          | `2000`  | Client op timeout ms. |

**When `TOKEN_CACHE_TYPE=couchbase`** — Couchbase REST (per-bucket doc API). Credentials are **only** under this prefix (independent from idempotency’s `IDEMPOTENCY_CB_*`).

| Variable                      | Required | Default | Role                                                                                                      |
| ----------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `TOKEN_CACHE_CB_HOST`         | ✅       | —       | Couchbase host.                                                                                           |
| `TOKEN_CACHE_CB_PORT`         | ✅       | —       | Couchbase port (REST/KV per your deployment).                                                           |
| `TOKEN_CACHE_CB_BUCKET`       | ✅       | —       | Bucket name for token documents. Create the bucket before deploying. Recommended name: `mcp-token-cache`. |
| `TOKEN_CACHE_CB_USERNAME`     | ✅       | —       | Couchbase user for this bucket (Vault: `TOKEN_CACHE_CB_USERNAME`).                                      |
| `TOKEN_CACHE_CB_PASSWORD`     | ✅       | —       | Couchbase password (Vault: `TOKEN_CACHE_CB_PASSWORD`).                                                     |
| `TOKEN_CACHE_CB_TIMEOUT_MS`   |          | `3000`  | HTTP timeout ms.                                                                                          |

### Sandbox defaults (per-isolate; services can override in `config.json`)

| Variable                       | Default | Role                                                                |
| ------------------------------ | ------- | ------------------------------------------------------------------- |
| `SANDBOX_MEMORY_MB`            | `64`    | V8 isolate memory cap (MB).                                         |
| `SANDBOX_EXECUTE_TIMEOUT_MS`   | `8000`  | Wall-clock cap for `api_execute` sandbox (ms; covers CPU + awaits). |
| `SANDBOX_SEARCH_TIMEOUT_MS`    | `3000`  | Wall-clock cap for `search_code` / `discover_skills` (ms).          |
| `SANDBOX_MAX_API_CALLS`        | `50`    | Max `api.request()` per run.                                        |
| `SANDBOX_MAX_CONCURRENT_CALLS` | `5`     | Max concurrent in-flight API calls per run.                         |

### Default idempotency (gateway-level; services can override type + TTL in config.json)

`IDEMPOTENCY_TYPE` plus connection vars are parsed into `GlobalConfig.defaultIdempotency`. Per-service `config.json` may override `type` and `idempotencyKeyTtlMs` — see [Per-service idempotency](#per-service-idempotency) below.

| Variable           | Default | Role                                                          |
| ------------------ | ------- | ------------------------------------------------------------- |
| `IDEMPOTENCY_TYPE` | `noop`  | `noop` (default) \| `in-memory` \| `memcache` \| `couchbase`. |

**When `IDEMPOTENCY_TYPE=memcache`** — prefix `IDEMPOTENCY_MEMCACHE_`:

| Variable                          | Required | Default | Role                  |
| --------------------------------- | -------- | ------- | --------------------- |
| `IDEMPOTENCY_MEMCACHE_HOST`       | ✅       | —       | Memcached host.       |
| `IDEMPOTENCY_MEMCACHE_PORT`       | ✅       | —       | Memcached port.       |
| `IDEMPOTENCY_MEMCACHE_TIMEOUT_MS` |          | `2000`  | Client op timeout ms. |

**When `IDEMPOTENCY_TYPE=couchbase`** — prefix `IDEMPOTENCY_CB_`:

| Variable                    | Required | Default | Role                                                                                  |
| --------------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `IDEMPOTENCY_CB_HOST`       | ✅       | —       | Couchbase host.                                                                       |
| `IDEMPOTENCY_CB_PORT`       | ✅       | —       | Couchbase port.                                                                       |
| `IDEMPOTENCY_CB_BUCKET`     | ✅       | —       | Bucket name. Create the bucket before deploying. Recommended name: `mcp-idempotency`. |
| `IDEMPOTENCY_CB_USERNAME`   | ✅       | —       | Couchbase user (Vault: `IDEMPOTENCY_CB_USERNAME`).                                    |
| `IDEMPOTENCY_CB_PASSWORD`   | ✅       | —       | Couchbase password (Vault: `IDEMPOTENCY_CB_PASSWORD`).                                 |
| `IDEMPOTENCY_CB_TIMEOUT_MS` |          | `3000`  | HTTP timeout ms.                                                                      |

### Observability

| Variable         | Default         | Role                                                                                                     |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`      | `info`          | `fatal` … `trace`.                                                                                       |
| `SERVICE_NAME`   | `harbor-gateway` | Service label in logs.                                                                                   |
| `MCP_AGENT_NAME` | `mcp-agent`     | Sent as `X-Request-Source` header to backends.                                                           |
| `ENVIRONMENT`    | `dev`           | `dev`, `staging`, `staging-secondary`, `canary`, `prod`. Non-prod includes caller file:line in logs. |
| `ENABLE_AUDIT`   | `true`          | Audit records for `api_execute`. Set `false` in dev to reduce noise.                                     |

### OAuth 2.1 resource server (HTTP transport only)

All three variables are optional. Set `HARBOR_RESOURCE_URI` to enable OAuth 2.1 protected-resource mode.

| Variable | Default | Role |
| -------- | ------- | ---- |
| `HARBOR_RESOURCE_URI` | — | Canonical URI of this Harbor instance. Enables `/.well-known/oauth-protected-resource` and `WWW-Authenticate` on 401. |
| `HARBOR_AUTH_SERVERS` | — | Comma-separated Authorization Server base URLs included in the RFC 9728 discovery document. |
| `HARBOR_SCOPES_SUPPORTED` | — | Optional comma-separated scope strings included in the discovery document. |

When `HARBOR_RESOURCE_URI` is not set the gateway behaves identically to before — the metadata endpoint returns 404 and 401 responses carry no `WWW-Authenticate` header.

## Per-service `config.json` (under `services/<name>/`)

Optional file next to `spec.yaml` / `spec.json`. All fields have defaults; omit what you don't need.

---

## Baseline `config.json` (all fields shown with defaults)

```json
{
  "enabled": true,
  "description": "Short summary for discover_services. Omit to use spec info.description.",
  "api": {
    "protocol": "http",
    "host": "localhost",
    "port": 8080,
    "basePath": "",
    "requestTimeoutMs": 30000,
    "maxRetries": 1
  },
  "auth": {
    "type": "oauth-introspection",
    "protocol": "http",
    "host": "auth-server",
    "port": 8083,
    "introspectionPath": "/oauth/introspect",
    "authTimeoutMs": 5000,
    "method": "POST",
    "tokenPassMode": "query",
    "tokenParamName": "token",
    "refreshPath": "/oauth/token",
    "tokenRefreshBufferSec": 300,
    "responseMapping": {
      "access_token": "tokenResponse.token",
      "expires_in": "tokenResponse.expiresIn",
      "refresh_token": "tokenResponse.refreshToken",
      "scope": "tokenResponse.scope"
    },
    "metadataMapping": {
      "userId": "userId",
      "accountId": "accountId"
    }
  },
  "circuitBreaker": { "type": "noop" },
  "idempotency": {
    "type": "noop",
    "idempotencyKeyTtlMs": 600000
  },
  "spec": { "source": "file" },
  "serviceRefreshIntervalMs": 0,
  "serviceRefreshTimeoutMs": 10000,
  "sandbox": {
    "memoryLimitMb": 64,
    "executeTimeoutMs": 8000,
    "searchTimeoutMs": 3000,
    "maxApiCalls": 50,
    "maxConcurrentCalls": 5
  }
}
```

---

## Auth strategies

### `oauth-introspection` (recommended for production)

All fields and their roles:

| Field                   | Required | Default    | Role                                                                                                                                                |
| ----------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                  | ✅       | —          | Must be `"oauth-introspection"`.                                                                                                                    |
| `host`                  | ✅       | —          | Auth server hostname.                                                                                                                               |
| `port`                  | ✅       | —          | Auth server port.                                                                                                                                   |
| `introspectionPath`     | ✅       | —          | Path the gateway POSTs/GETs to validate a token.                                                                                                    |
| `protocol`              |          | `"http"`   | `"http"` or `"https"`.                                                                                                                              |
| `authTimeoutMs`         |          | `5000`     | Auth request timeout ms.                                                                                                                            |
| `method`                |          | `"POST"`   | `"GET"` or `"POST"`.                                                                                                                                |
| `tokenPassMode`         |          | `"query"` | How the token is sent: `"header"` (Authorization), `"query"` (param), or `"body"` (JSON body).                                                      |
| `tokenParamName`        |          | `"token"`  | Query/body param name when `tokenPassMode` is `"query"` or `"body"`.                                                                                |
| `refreshPath`           |          | —          | Path to call for proactive token refresh (optional).                                                                                                |
| `tokenRefreshBufferSec` |          | —          | Seconds before expiry to trigger proactive refresh.                                                                                                 |
| `responseMapping`       |          | —          | Dot-path mapping from introspection response fields to `TokenPayload` fields (`access_token`, `expires_in`, `refresh_token`, `scope`).              |
| `metadataMapping`       |          | —          | Dot-path mapping from introspection response to `TokenPayload.metadata` (arbitrary key/value; available to tools, e.g. `userId` for audit hashing). |

### `static-token` (local dev / POC only)

No network validation. The client's bearer token is used as-is. Falls back to the configured `token` value when no client bearer is present.

```json
{
  "auth": {
    "type": "static-token",
    "token": "dev-only-token"
  }
}
```

### `jwt-validation` (local JWT verification via JWKS)

Verifies JWTs locally against a JWKS endpoint. No round-trip to the AS per token after the initial JWKS fetch. Best for high-throughput environments.

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
      "userId": "sub",
      "clientId": "client_id"
    }
  }
}
```

| Field | Required | Default | Role |
| ----- | -------- | ------- | ---- |
| `type` | ✅ | — | Must be `"jwt-validation"`. |
| `jwksUri` | ✅ | — | JWKS endpoint URL. |
| `issuer` | ✅ | — | Expected `iss` claim value. |
| `audience` | | not checked | Expected `aud` claim value. |
| `clockToleranceSec` | | `30` | Seconds of clock skew to allow. |
| `scopeClaim` | | `"scope"` | JWT claim name holding the scope string or array. |
| `metadataMapping` | | `{}` | Dot-path map from JWT payload claims into `TokenPayload.metadata`. |

### `oauth-2.1` (AS auto-discovery + JWT verification)

Simpler than `jwt-validation` when your AS follows RFC 8414 or OIDC Discovery: Harbor fetches the JWKS URI automatically from the AS metadata document.

```json
{
  "auth": {
    "type": "oauth-2.1",
    "authorizationServer": "https://auth.example.com",
    "audience": "https://harbor.example.com",
    "clockToleranceSec": 30,
    "scopeClaim": "scope",
    "discoveryTimeoutMs": 10000,
    "metadataMapping": {
      "userId": "sub"
    }
  }
}
```

| Field | Required | Default | Role |
| ----- | -------- | ------- | ---- |
| `type` | ✅ | — | Must be `"oauth-2.1"`. |
| `authorizationServer` | ✅ | — | Base URL of the AS (no trailing slash). Harbor tries `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server`. |
| `audience` | | not checked | Expected `aud` claim value. |
| `clockToleranceSec` | | `30` | Seconds of clock skew to allow. |
| `scopeClaim` | | `"scope"` | JWT claim name for the scope. |
| `metadataMapping` | | `{}` | Map JWT payload claims into `TokenPayload.metadata`. |
| `discoveryTimeoutMs` | | `10000` | Timeout for the AS discovery HTTP call. |

Discovery is performed once and cached per strategy instance; Harbor does not re-fetch on every token.

---

## If you use **mTLS** to the backend API

Add under `api` (all three paths required when `tls` is present):

```json
{
  "api": {
    "tls": {
      "certPath": "/path/to/client.crt",
      "keyPath": "/path/to/client.key",
      "caPath": "/path/to/ca.pem"
    }
  }
}
```

---

## Circuit breaker

Default when `circuitBreaker` is omitted from `config.json` is **noop** (pass-through).

### `noop` (default — explicit form)

```json
{
  "circuitBreaker": { "type": "noop" }
}
```

### `count-based`

Opens after `failureThreshold` consecutive failures (5xx or network errors). Rejects calls while open. After `recoveryTimeMs` ms, allows one probe; if it succeeds the breaker closes.

```json
{
  "circuitBreaker": {
    "type": "count-based",
    "failureThreshold": 5,
    "recoveryTimeMs": 30000
  }
}
```

---

## Spec loading

Default when `spec` is omitted is **file**.

### `file` (default)

Local disk — `spec.yaml` / `spec.json` / `spec.yml` in the service folder. Good for static specs and local dev.

```json
{
  "spec": { "source": "file" }
}
```

### `url`

Fetched from an HTTP/HTTPS URL on every refresh. If unreachable, the startup load fails and the service is skipped.

```json
{
  "spec": {
    "source": "url",
    "url": "https://my-service.example.com/v3/api-docs"
  }
}
```

### `url-with-fallback`

Tries the URL first; if unreachable (on startup or during refresh) falls back to the local `spec.yaml` / `spec.json`. Best for production services where the spec is also served live but you want resilience.

```json
{
  "spec": {
    "source": "url-with-fallback",
    "url": "https://my-service.example.com/v3/api-docs"
  }
}
```

> `spec.url` is required for both `url` and `url-with-fallback`. Omitting it throws at startup.

---

## Service refresh

Controls how often the gateway reloads both the OpenAPI spec **and** the `skills/*.md` files for a service. They always refresh together so spec and skills stay in sync.

| Field                      | Default | Role                                                                                     |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `serviceRefreshIntervalMs` | `0`     | How often to reload (ms). `0` = load once at startup, never refresh.                     |
| `serviceRefreshTimeoutMs`  | `10000` | Timeout for each spec reload attempt (ms). Skills are read from disk and don't time out. |

```json
{
  "serviceRefreshIntervalMs": 60000,
  "serviceRefreshTimeoutMs": 10000
}
```

---

## Sandbox overrides (per-service)

Any field omitted inherits the gateway-level env var default.

| Field                        | Env default                         | Role                                                       |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `sandbox.memoryLimitMb`      | `SANDBOX_MEMORY_MB` (64)            | V8 isolate memory cap (MB).                                |
| `sandbox.executeTimeoutMs`   | `SANDBOX_EXECUTE_TIMEOUT_MS` (8000) | Wall-clock cap for `api_execute` (ms).                     |
| `sandbox.searchTimeoutMs`    | `SANDBOX_SEARCH_TIMEOUT_MS` (3000)  | Wall-clock cap for `search_code` / `discover_skills` (ms). |
| `sandbox.maxApiCalls`        | `SANDBOX_MAX_API_CALLS` (50)        | Max `api.request()` calls per run.                         |
| `sandbox.maxConcurrentCalls` | `SANDBOX_MAX_CONCURRENT_CALLS` (5)  | Max concurrent in-flight requests per run.                 |

---

## Per-service idempotency

The `idempotency` block in `services/<name>/config.json` supports two local backends only:

- `type` — `noop` (default) or `in-memory`. Remote backends (`memcache`, `couchbase`) are configured at gateway level via env vars and are not selectable per-service.
- `idempotencyKeyTtlMs` — optional; defaults to `600_000` (10 minutes).

### Common shapes

**No deduplication (default)** — omit `idempotency` or set type explicitly:

```json
{
  "idempotency": { "type": "noop" }
}
```

**Single-pod in-memory deduplication** (suitable for dev / single-replica deployments):

```json
{
  "idempotency": {
    "type": "in-memory",
    "idempotencyKeyTtlMs": 600000
  }
}
```

**Shorter TTL with in-memory**:

```json
{
  "idempotency": { "type": "in-memory", "idempotencyKeyTtlMs": 120000 }
}
```

---

## Copy-paste env template

**`.env.example`** lists every variable above with comments and safe defaults — use it when bootstrapping a new environment.
