# Harbor configuration

Configuration is split into **server (process) level** — environment variables validated once at startup — and **per-service** JSON beside each service's OpenAPI file. Code: `src/core/config/config.ts` (global), `src/index.ts` (`SERVICES_DIR`), `src/runtime/registry/filesystem-scanner.ts` (per-service `config.json`) and `src/wiring/` (strategy wiring).

The OpenAPI file is always `spec.json` | `spec.yaml` | `spec.yml` in the service folder (first found, in that order). There is no `spec.path` in code.

---

## Server-level configuration (environment variables)

These apply to the **whole gateway process**: bind address, shared token cache, default sandbox limits, logging, the Code Mode governance layer. Set them in your orchestrator (Kubernetes `env` / Secret, systemd, etc.) or in `.env` for local runs. A commented template with defaults is in **`.env.example`**.

Every value is validated at boot. A bad value (an unknown enum member, a non-integer where a number is expected, a missing required connection variable) prints `Configuration validation failed` or `Missing required environment variables` and exits — nothing is silently defaulted.

### Complete index (grep-friendly)

Read at process entry (`src/index.ts`): `SERVICES_DIR`.

Read before validation, to locate the optional config file: `MCP_CONFIG_FILE`.

Parsed on every startup (`validateGlobalConfig` in `config.ts`):  
`MCP_HOST`, `MCP_PORT`, `MCP_MAX_BODY_BYTES`, `MCP_TRANSPORT`, `MCP_TOKEN` (required when `MCP_TRANSPORT=stdio`), `AUTH_TOKEN_CACHE_TTL_MS`, `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE`, `SANDBOX_MEMORY_MB`, `SANDBOX_EXECUTE_TIMEOUT_MS`, `SANDBOX_SEARCH_TIMEOUT_MS`, `SANDBOX_MAX_API_CALLS`, `SANDBOX_MAX_CONCURRENT_CALLS`, `LOG_LEVEL`, `SERVICE_NAME`, `MCP_AGENT_NAME`, `HARBOR_SERVER_ID`, `ENVIRONMENT`, `ENABLE_AUDIT`, `AUDIT_SINKS`, `HARBOR_RESOURCE_URI`, `HARBOR_AUTH_SERVERS`, `HARBOR_SCOPES_SUPPORTED`, `EXECUTION_STORE_TYPE`, `EXECUTION_STORE_DIR`, `EXECUTION_STORE_MEMCACHE_KEY_PREFIX`, `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC`, `EXECUTION_CODE_RETENTION`, `EXECUTION_RETENTION_SEC`, `GOVERNANCE_RULES_SOURCE`, `GOVERNANCE_RULES_DIR`, `GOVERNANCE_RULES_URL`, `GOVERNANCE_RULES_URL_TIMEOUT_MS`, `GOVERNANCE_RULES_REFRESH_SEC`, `GOVERNANCE_DEFAULT_DECISION`, `GOVERNANCE_REQUEST_STATE_KEY`, `GOVERNANCE_APPROVAL_TTL_SEC`.

Read only when the matching backend is active:

| If … | Then also set … |
|------|-----------------|
| `TOKEN_CACHE_TYPE=memcache` | `TOKEN_CACHE_MEMCACHE_HOST`, `TOKEN_CACHE_MEMCACHE_PORT`; optional `TOKEN_CACHE_MEMCACHE_TIMEOUT_MS` |
| `TOKEN_CACHE_TYPE=couchbase` | `TOKEN_CACHE_CB_HOST`, `TOKEN_CACHE_CB_PORT`, `TOKEN_CACHE_CB_BUCKET`, `TOKEN_CACHE_CB_USERNAME`, `TOKEN_CACHE_CB_PASSWORD`; optional `TOKEN_CACHE_CB_TIMEOUT_MS` |
| `IDEMPOTENCY_TYPE=memcache` | `IDEMPOTENCY_MEMCACHE_HOST`, `IDEMPOTENCY_MEMCACHE_PORT`; optional `IDEMPOTENCY_MEMCACHE_TIMEOUT_MS` |
| `IDEMPOTENCY_TYPE=couchbase` | `IDEMPOTENCY_CB_HOST`, `IDEMPOTENCY_CB_PORT`, `IDEMPOTENCY_CB_BUCKET`, `IDEMPOTENCY_CB_USERNAME`, `IDEMPOTENCY_CB_PASSWORD`; optional `IDEMPOTENCY_CB_TIMEOUT_MS` |
| `EXECUTION_STORE_TYPE=memcache` | `EXECUTION_STORE_MEMCACHE_HOST`, `EXECUTION_STORE_MEMCACHE_PORT`; optional `EXECUTION_STORE_MEMCACHE_TIMEOUT_MS`, `EXECUTION_STORE_MEMCACHE_KEY_PREFIX`, `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC` |
| `EXECUTION_STORE_TYPE=file` | optional `EXECUTION_STORE_DIR` |
| `GOVERNANCE_RULES_SOURCE=dir` (default) | optional `GOVERNANCE_RULES_DIR` |
| `GOVERNANCE_RULES_SOURCE=url` | `GOVERNANCE_RULES_URL`; optional `GOVERNANCE_RULES_URL_TIMEOUT_MS` |

Connection ports must be positive integers ≤ 65535 and `*_TIMEOUT_MS` values positive integers; anything else stops boot.

**Kubernetes/other orchestrators:** ConfigMaps or environment files may contain extra keys for other tooling. The gateway **ignores** any env var not listed above.

### Registered backends

`TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE` and `EXECUTION_STORE_TYPE` accept, besides their built-in names, the name of a backend your own entry point registered before calling `createMcpGateway` — with `registerTokenCacheBackend`, `registerIdempotencyBackend` or `registerExecutionStoreBackend` from `src/wiring/strategy-builders.ts`. The name must be lower-case kebab-case (`^[a-z][a-z0-9-]*$`). The builder resolves it; a name nothing registered is refused (for `TOKEN_CACHE_TYPE` and `EXECUTION_STORE_TYPE` the gateway exits; for `IDEMPOTENCY_TYPE` every service that relies on the default fails to build and is skipped). A registered factory receives `{ type }` only — the `*_MEMCACHE_*` / `*_CB_*` connection variables belong to the built-in backends, so a custom backend reads its own settings.

`AUDIT_SINKS` and `GOVERNANCE_RULES_SOURCE` work the same way with `registerAuditSinkBackend` and `registerGovernanceRuleSourceBackend`. See [`adapter-guide.md`](adapter-guide.md).

### Config file loader (optional)

On startup the gateway tries to read a config file before validation runs. Entries in the file are merged into `process.env`; a variable that is already set wins.

| Variable | Default | Role |
| -------- | ------- | ---- |
| `MCP_CONFIG_FILE` | `/etc/harbor-config/config.yaml` | Path to a **line-oriented `KEY: value` file** — not full YAML. File absence is silently ignored. |

The format, exactly: each non-blank line that does not start with `#` is split at its first `:`; the key and value are trimmed, and one pair of matching surrounding quotes (`"…"` or `'…'`) is removed from the value. There is no nesting, no lists, no multi-line values and no inline comments — `LOG_LEVEL: debug # verbose` sets `LOG_LEVEL` to `debug # verbose`, which then fails validation. A line without `:` is skipped.

Precedence, highest first: the real process environment, then `.env` (loaded by `dotenv` in `src/index.ts` before the config file is read), then the config file. `MCP_CONFIG_FILE` itself must therefore come from the environment or `.env`.

**Typical Kubernetes usage:** mount a `ConfigMap` to `/etc/harbor-config/config.yaml` for non-sensitive defaults; inject sensitive values (credentials, tokens) via a `secretRef` so they take precedence over the file.

In local development the file path does not exist; `dotenv` populates `process.env` from `.env` instead.

### Service directory

| Variable       | Default      | Role                                                               |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `SERVICES_DIR` | `<install root>/services` | Directory scanned at startup. Unset ⇒ the `services/` folder beside `src/` (under `tsx`) or `dist/` (built) — the repo or image root — whatever the working directory. A set value is resolved relative to `process.cwd()`. The Docker image sets `/app/services`. |

Each sub-folder that contains a spec file is a service; it loads only if it also has a `config.json` with an `auth` block (see the per-service `config.json` section below). Entries that are not folders are ignored, an entry that cannot be read (e.g. a dangling symlink) is skipped with a warning, and one broken service is skipped without stopping the others. If no service loads, the gateway exits.

### MCP HTTP / stdio server

| Variable        | Default     | Role                                                                         |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `MCP_HOST`      | `127.0.0.1` | Host the gateway listens on.                                                 |
| `MCP_PORT`      | `3333`      | TCP port for Streamable HTTP.                                                |
| `MCP_MAX_BODY_BYTES` | `4194304` (4 MiB) | Largest `/mcp` request body the gateway reads (HTTP only). A declared or streamed overrun is answered with HTTP 413 `PAYLOAD_TOO_LARGE` and `Connection: close`. `/executions` bodies have a fixed 64 KiB cap. |
| `MCP_TRANSPORT` | `http`      | `http` (default) or `stdio`.                                                 |
| `MCP_TOKEN`     | —           | Required when `MCP_TRANSPORT=stdio`: the bearer every stdio call presents. It must pass the same format check as an HTTP bearer, or boot exits. Ignored for `http`. |

**Bearer format.** Every HTTP `/mcp` request carries its own `Authorization: Bearer <token>`, and the token must be a JWT or an opaque token of at least 32 base64url characters (`A–Z a–z 0–9 - _`). A missing, malformed or weak bearer — or two `Authorization` headers — is refused with HTTP 401 before any tool runs. The transport checks only the format; the service's auth strategy validates the token itself when a tool uses it.

### Token cache (shared by **all** services)

One backend for the entire gateway. Token entries are keyed per-service internally so services never see each other's tokens.

| Variable                  | Default     | Role                                                                                    |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_CACHE_TTL_MS` | `300000`    | Upper bound on cached token lifetime in ms. Actual TTL = min(token `expires_in`, this). |
| `TOKEN_CACHE_TYPE`        | `in-memory` | `in-memory` (default), `memcache`, `couchbase`, or a [registered backend](#registered-backends). |

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
| `SANDBOX_EXECUTE_TIMEOUT_MS`   | `8000`  | Wall-clock cap for an `api_execute` run (ms; covers CPU + awaits). Calls the program started without awaiting get the rest of this budget after it returns, then are aborted. |
| `SANDBOX_SEARCH_TIMEOUT_MS`    | `3000`  | Wall-clock cap for `search_code` / `discover_skills` (ms).          |
| `SANDBOX_MAX_API_CALLS`        | `50`    | Max `api.request()` per run.                                        |
| `SANDBOX_MAX_CONCURRENT_CALLS` | `5`     | Max concurrent in-flight API calls per run.                         |

### Default idempotency (gateway-level)

`IDEMPOTENCY_TYPE` plus its connection vars is the idempotency backend for every service whose `config.json` has **no** `idempotency` block. A service with its own block uses that block alone — nothing is merged from `IDEMPOTENCY_*`, including connection settings (see [Per-service idempotency](#per-service-idempotency)).

| Variable           | Default | Role                                                          |
| ------------------ | ------- | ------------------------------------------------------------- |
| `IDEMPOTENCY_TYPE` | `noop`  | `noop` (default), `in-memory`, `memcache`, `couchbase`, or a [registered backend](#registered-backends). |

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

Every backend call carries an `X-Idempotency-Key`: `mcp-{service}-{executionId}-{sequence}` for a governed run, so two executions of the same program never share a key and a resume keeps its keys. A non-`noop` backend stores the response under that key for the service's `idempotencyKeyTtlMs` and returns it for a repeat of the key. Non-2xx responses are stored too.

### Observability

| Variable         | Default         | Role                                                                                                     |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`      | `info`          | `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                                                      |
| `SERVICE_NAME`   | `harbor-gateway` | Service label in logs.                                                                                   |
| `MCP_AGENT_NAME` | `mcp-agent`     | Sent as `X-Request-Source` header to backends.                                                           |
| `HARBOR_SERVER_ID` | `HARBOR_GATEWAY` | Harbor's stamp on every backend call, sent as `X-Harbor-Server-ID`. Printable ASCII, ≤128 characters; anything else fails boot. |
| `ENVIRONMENT`    | `dev`           | `dev`, `staging`, `staging-secondary`, `canary`, `prod`. Non-prod includes caller file:line in logs. |
| `ENABLE_AUDIT`   | `true`          | `true`, `false`, `1` or `0`, exactly. `false`/`0` turns the audit trail off: no `api_execute` audit records and no execution-state events reach any sink. Any other value — including an empty one — fails boot. |
| `AUDIT_SINKS`    | `console`       | Comma list of audit sinks every record and execution-state event goes to: `console` (built in) or types registered with `registerAuditSinkBackend`. An unknown name fails boot, and so does a list that names no sink while audit is on. Ignored when `ENABLE_AUDIT` is off. |

Logs are structured JSON on stderr (stdout belongs to the stdio transport).

### OAuth 2.1 resource server (HTTP transport only)

All three variables are optional. Set `HARBOR_RESOURCE_URI` to enable OAuth 2.1 protected-resource mode.

| Variable | Default | Role |
| -------- | ------- | ---- |
| `HARBOR_RESOURCE_URI` | — | Canonical URI of this Harbor instance. Enables the RFC 9728 metadata document — served at `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` and `/mcp/.well-known/oauth-protected-resource` — and `WWW-Authenticate` on 401. |
| `HARBOR_AUTH_SERVERS` | — | Comma-separated Authorization Server base URLs included in the RFC 9728 discovery document. |
| `HARBOR_SCOPES_SUPPORTED` | — | Optional comma-separated scope strings included in the discovery document. |

When `HARBOR_RESOURCE_URI` is not set the metadata endpoints return 404 and 401 responses carry no `WWW-Authenticate` header.

## Code Mode governance layer

| Variable | Default | Description |
|---|---|---|
| `EXECUTION_STORE_TYPE` | `in-memory` | Where executions, activities, approvals, decisions and the run lock live: `in-memory` (lost on restart; lock is process-local), `file` (survives a restart; single instance), `memcache` (shared across pods), or a [registered backend](#registered-backends) |
| `EXECUTION_STORE_MEMCACHE_HOST` / `EXECUTION_STORE_MEMCACHE_PORT` | — | Memcached for `EXECUTION_STORE_TYPE=memcache` (required with it); `EXECUTION_STORE_MEMCACHE_TIMEOUT_MS` optional, default `2000` |
| `EXECUTION_STORE_MEMCACHE_KEY_PREFIX` | `harbor:exec:` | Key namespace, so several gateways or environments can share one memcache |
| `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC` | `300` | How long the run lock of a pod that died mid-run survives; must exceed the longest `SANDBOX_EXECUTE_TIMEOUT_MS` |
| `EXECUTION_STORE_DIR` | `./var/executions` | Directory for the `file` store (one JSON document per execution), relative to the working directory |
| `EXECUTION_CODE_RETENTION` | `DROP` | `DROP`: remove a terminal execution's program text · `KEEP`: keep it stored against the `executionId` |
| `EXECUTION_RETENTION_SEC` | `86400` | Seconds a finished execution and all its records (activities, approvals, decisions) are kept before deletion; `0` = keep forever. Paused and interrupted executions are never deleted |
| `GOVERNANCE_RULES_SOURCE` | `dir` | Where Governance Rules come from: `dir`, `url`, or a type registered with `registerGovernanceRuleSourceBackend` |
| `GOVERNANCE_RULES_DIR` | `<install root>/governance/rules` | Rule files for the `dir` source (`*.yaml`/`*.yml`/`*.json`, top level only — `examples/` beneath it is not read). Unset ⇒ the `governance/rules` folder at the repo or image root, whatever the working directory; a set value is relative to the working directory. An invalid file fails boot |
| `GOVERNANCE_RULES_URL` | — | Rule document for the `url` source (required with it) |
| `GOVERNANCE_RULES_URL_TIMEOUT_MS` | `5000` | Fetch timeout for the `url` source |
| `GOVERNANCE_RULES_REFRESH_SEC` | `0` | Re-read the rule source every N seconds (`0` = once, at boot). An unreachable source, a vanished directory or an invalid set keeps the last valid set; so does a refresh that would replace a non-empty set with an empty one — clearing every rule takes a restart |
| `GOVERNANCE_DEFAULT_DECISION` | `DENY` | Decision for a call that some rule targets but no rule matches: `ALLOW`, `DENY`, `REQUIRE_APPROVAL`. A call no rule targets is always allowed (`NO_GOVERNANCE`) — including a path the spec does not describe, unless a `*` or `/**` rule covers it |
| `GOVERNANCE_REQUEST_STATE_KEY` | *(random per process)* | ≥32-character HMAC key sealing the MRTR `requestState`. Unset, a restart invalidates every outstanding `requestState`; set one shared key for multi-instance deployments |
| `GOVERNANCE_APPROVAL_TTL_SEC` | `600` | Seconds a paused execution's `requestState` stays redeemable. Stored approvals themselves do not expire |

**No rules ship active.** The repository's `governance/rules/` holds only its README and `examples/`, so out of the box every call is `NO_GOVERNANCE`. If the rules directory does not exist at boot, the gateway starts with no rules and logs a WARN saying every call is ungoverned; a later refresh picks the directory up once it appears. The production Docker image ships no `governance/rules` folder — mount one or point `GOVERNANCE_RULES_DIR` at it.

**Several pods:** use `EXECUTION_STORE_TYPE=memcache`, one shared `GOVERNANCE_REQUEST_STATE_KEY`, and the same rule set on every pod.

See [`code-mode-governance.md`](code-mode-governance.md) and [`../governance/rules/README.md`](../governance/rules/README.md).

---

## Per-service `config.json` (under `services/<name>/`)

**Required** next to the spec file, and it must contain an `auth` block: a service without `config.json`, or whose `config.json` has no `auth`, is skipped at boot (`config.auth is required`). Every other field has a default. The folder name is the service name — there is no `name` field.

`config.json` is plain JSON, read without schema validation, so types matter: only the boolean `false` disables a service (`"enabled": "false"` does not), and a malformed `tls` block is dropped silently (see [mTLS](#if-you-use-mtls-to-the-backend-api)).

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | `false` skips the service before its spec is parsed |
| `description` | spec `info.description`, else `Service: <folder>` | What `discover_services` shows |
| `api` | from the spec's `servers[0].url` | See [Upstream API](#upstream-api-api) |
| `auth` | — (**required**) | See [Auth strategies](#auth-strategies) |
| `circuitBreaker` | `noop` | See [Circuit breaker](#circuit-breaker) |
| `idempotency` | the gateway default (`IDEMPOTENCY_TYPE`) | See [Per-service idempotency](#per-service-idempotency) |
| `spec.source` / `spec.url` | `file` | See [Spec loading](#spec-loading) |
| `serviceRefreshIntervalMs` | `0` | See [Service refresh](#service-refresh) |
| `serviceRefreshTimeoutMs` | `10000` | See [Service refresh](#service-refresh) |
| `sandbox.*` | the `SANDBOX_*` env values | See [Sandbox overrides](#sandbox-overrides-per-service) |

---

## Example `config.json`

An example, **not** a list of defaults. The required parts are `auth` and, for `oauth-introspection`, its `host`, `port` and `introspectionPath`.

```json
{
  "enabled": true,
  "description": "Short summary for discover_services. Omit to use spec info.description.",
  "api": {
    "protocol": "http",
    "host": "orders.internal",
    "port": 8080,
    "basePath": "",
    "requestTimeoutMs": 10000,
    "maxRetries": 1
  },
  "auth": {
    "type": "oauth-introspection",
    "protocol": "https",
    "host": "auth-server",
    "port": 443,
    "introspectionPath": "/oauth/introspect",
    "authTimeoutMs": 5000,
    "method": "POST",
    "tokenPassMode": "body",
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
  "circuitBreaker": { "type": "count-based", "failureThreshold": 5, "recoveryTimeMs": 30000 },
  "idempotency": {
    "type": "in-memory",
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

## Upstream API (`api`)

With an `api` block, each omitted field takes the default below and the spec's `servers` is not consulted. Without one, the upstream comes from the spec's `servers[0].url` — protocol, host, port (the scheme's own, 80 or 443, when the URL names none) and path as `basePath`, with `requestTimeoutMs` 30000 and `maxRetries` 1. A `servers[0].url` that is not an absolute URL skips the service; a spec with no `servers` falls back to `http://localhost:8080` with a warning.

| Field | Default | Role |
|---|---|---|
| `api.protocol` | `"http"` | `"http"` or `"https"`. |
| `api.host` | `"localhost"` | Backend host. |
| `api.port` | `8080` | Backend port. |
| `api.basePath` | `""` | Prefix for every request path. |
| `api.requestTimeoutMs` | `30000` | Timeout per HTTP attempt (ms). |
| `api.maxRetries` | `1` | Extra attempts after a 5xx or a transport error (timeout, reset), with backoff `500 · 2^n` ms plus up to 500 ms jitter. **Only `GET`, `PUT` and `DELETE` are retried.** A `POST` or `PATCH` is sent once: a 5xx or transport error fails the call with an unknown outcome, since it may already have taken effect. A 4xx is never retried; the program receives it as `{ ok: false, status }`. |
| `api.tls` | — | mTLS client certificate; see [below](#if-you-use-mtls-to-the-backend-api). |

---

## Auth strategies

### `oauth-introspection` (recommended for production)

All fields and their roles:

| Field                   | Required | Default    | Role                                                                                                                                                |
| ----------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                  | ✅       | —          | Must be `"oauth-introspection"`.                                                                                                                    |
| `host`                  | ✅       | —          | Auth server hostname.                                                                                                                               |
| `port`                  | ✅       | —          | Auth server port.                                                                                                                                   |
| `introspectionPath`     | ✅       | —          | Path the gateway calls to validate a token.                                                                                                          |
| `protocol`              |          | `"http"`   | `"http"` or `"https"`.                                                                                                                              |
| `authTimeoutMs`         |          | `5000`     | Auth request timeout ms.                                                                                                                            |
| `method`                |          | `"GET"`    | `"GET"` or `"POST"`. With `GET` the token always travels as the `tokenParamName` query parameter, whatever `tokenPassMode` says.                    |
| `tokenPassMode`         |          | `"query"`  | `POST` only — how the token is sent: `"query"` (param), `"body"` (JSON body) or `"header"` (Authorization).                                        |
| `tokenParamName`        |          | `"token"`  | Query/body param name when the token is sent as a parameter.                                                                                        |
| `refreshPath`           |          | —          | Path for proactive token refresh (a form-encoded `grant_type=refresh_token` POST). Without it no refresh happens.                                   |
| `tokenRefreshBufferSec` |          | `300`      | Seconds before the token's expiry at which a cached token is refreshed in the background.                                                          |
| `responseMapping`       |          | —          | Dot-path mapping from introspection response fields to `TokenPayload` fields (`access_token`, `expires_in`, `refresh_token`, `scope`). Unmapped, Harbor reads `token`/`access_token`, `expiresIn`/`expires_in` (else the RFC 7662 `exp`), `refresh_token`/`refreshToken` and `scope`. |
| `metadataMapping`       |          | —          | Dot-path mapping from introspection response to `TokenPayload.metadata`. `userId` matters: it is the principal that owns executions and approvals (else the raw bearer is). |
| `audience`              |          | not checked | Expected `aud` claim value (resource binding, RFC 8707). **Best-effort, not fail-closed**: RFC 7662 §2.2 makes `aud` an optional introspection response member, so if configured but the AS's response omits `aud`, the token is still accepted. When both `audience` is configured and the response includes `aud`, a mismatch is rejected. |

How a response is read: a 401/403 is `TOKEN_INVALID`; a 5xx or an unreachable server is `INTROSPECTION_FAILED` (retryable; the client sees only the error code, never the server's address). A response carrying `active` with any value but `true` is `TOKEN_INVALID`. The lifetime is the mapped or conventional `expires_in` (relative seconds; a value above 10⁹ is read as an epoch timestamp), else RFC 7662's absolute `exp`; no usable lifetime, or one ≤ 0, is `TOKEN_EXPIRED`.

### `static-token` (local dev / POC only)

No network validation. The caller's bearer is forwarded to the backend as-is; the configured `token` (required) is only a fallback for a call that reaches the strategy with no bearer.

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
| `audience` | ✅ | — | Expected `aud` claim value (resource binding, RFC 8707). Required and fail-closed — Harbor rejects tokens not bound to this resource; a missing value skips the service. |
| `clockToleranceSec` | | `30` | Seconds of clock skew to allow. |
| `scopeClaim` | | `"scope"` | JWT claim name holding the scope string or array. |
| `metadataMapping` | | `{}` | Dot-path map from JWT payload claims into `TokenPayload.metadata`. |

A token must carry `exp` and be signed with an asymmetric algorithm — RS256/384/512, PS256/384/512, ES256/384/512 or EdDSA. `alg: none`, HS*, an unknown `kid` or a malformed token is `TOKEN_INVALID` (not retryable); an expired one is `TOKEN_EXPIRED`.

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
| `authorizationServer` | ✅ | — | Base URL of the AS (no trailing slash); also the expected `iss`. Harbor tries `/.well-known/openid-configuration` then `/.well-known/oauth-authorization-server`, and refuses a `jwks_uri` on another scheme or host. |
| `audience` | ✅ | — | Expected `aud` claim value (resource binding, RFC 8707). Required and fail-closed — Harbor rejects tokens not bound to this resource; a missing value skips the service. |
| `clockToleranceSec` | | `30` | Seconds of clock skew to allow. |
| `scopeClaim` | | `"scope"` | JWT claim name for the scope. |
| `metadataMapping` | | `{}` | Map JWT payload claims into `TokenPayload.metadata`. |
| `discoveryTimeoutMs` | | `10000` | Timeout for the AS discovery HTTP call. |

Discovery is performed once and cached per strategy instance (a failed discovery is retried on the next token); Harbor does not re-fetch on every token. Token checks are those of `jwt-validation`.

---

## If you use **mTLS** to the backend API

Add under `api`. All three paths must be present — a `tls` block missing any of them is ignored (no mTLS, no error). A path that cannot be read skips the service.

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

Opens after `failureThreshold` consecutive failed calls (default `5`) and refuses calls to that endpoint with `CIRCUIT_OPEN` (retryable) for `recoveryTimeMs` (default `30000`). Then it lets **one** probe through at a time: a success closes it, a failure reopens it.

- A failure is one logical call that ended in a 5xx or a transport error — however many retry attempts it took. A 4xx is not a failure; a success resets the count.
- State is kept per endpoint: the OpenAPI path template the call resolved to (`/orders/{orderId}`), or, for a path the spec does not describe, the path with id-like segments collapsed (`/orders/123` → `/orders/{id}`).
- State lives in the gateway process — it is not shared across pods.

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

Default when `spec` is omitted is **file**. Whatever the source, **boot always loads the local spec file**, and a service without one is skipped; the source decides what a [refresh](#service-refresh) reads.

### `file` (default)

Local disk — `spec.json` / `spec.yaml` / `spec.yml` in the service folder. Relative `$ref`s resolve against the spec file. Good for static specs and local dev.

```json
{
  "spec": { "source": "file" }
}
```

### `url`

Fetched from an HTTP/HTTPS URL on each refresh (only when `serviceRefreshIntervalMs` > 0; the URL is not fetched at boot). A failed fetch keeps the current spec and skills. Internal `#/…` references are resolved; external `$ref`s in a fetched document are not, a response over 20 MB is refused, and logged URLs omit userinfo and fragments. Query parameter names remain, but every value is `REDACTED`. The origin and path remain visible: keep credentials out of paths and parameter names.

```json
{
  "spec": {
    "source": "url",
    "url": "https://my-service.example.com/v3/api-docs"
  }
}
```

### `url-with-fallback`

On each refresh, tries the URL first and falls back to the local spec file when it is unreachable. Best for production services where the spec is also served live but you want resilience.

```json
{
  "spec": {
    "source": "url-with-fallback",
    "url": "https://my-service.example.com/v3/api-docs"
  }
}
```

> `spec.url` is required for both `url` and `url-with-fallback`. Omitting it skips the service at startup.

---

## Service refresh

Controls how often the gateway reloads both the OpenAPI spec **and** the `skills/*.md` files for a service. They are swapped together: a refresh whose spec load fails keeps both the old spec and the old skills, and a slow refresh is never overtaken by the next one.

| Field                      | Default | Role                                                                                     |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `serviceRefreshIntervalMs` | `0`     | How often to reload (ms). `0` = load once at startup, never refresh. Otherwise an integer from `1000` to `2147483647`; any other value skips the service. |
| `serviceRefreshTimeoutMs`  | `10000` | Timeout for each spec reload attempt (ms): a positive integer ≤ `2147483647`, else the service is skipped. Skills are read from disk and don't time out. |

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

An `idempotency` block replaces the gateway default ([`IDEMPOTENCY_TYPE`](#default-idempotency-gateway-level)) for this service; nothing is merged from the `IDEMPOTENCY_*` env vars.

| Field | Default | Role |
|---|---|---|
| `type` | — | `noop`, `in-memory`, `memcache`, `couchbase`, or a name registered with `registerIdempotencyBackend` (the factory receives the whole block). Any other name skips the service. |
| `idempotencyKeyTtlMs` | `600000` | How long a stored response answers a repeated key (10 minutes). Applies whether or not the block is present. |
| `host`, `port`, `kvTimeoutMs` | `localhost`, `11211`, `2000` | `memcache` connection. |
| `host`, `port`, `bucket`, `username`, `password`, `kvTimeoutMs` | `localhost`, `8093`, `default`, `""`, `""`, `3000` | `couchbase` connection. |

### Common shapes

**No deduplication** — omit `idempotency` (and leave `IDEMPOTENCY_TYPE` at `noop`) or set type explicitly:

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

**Shared Memcached for several pods** — connection settings live in the block:

```json
{
  "idempotency": { "type": "memcache", "host": "memcache.svc.cluster.local", "port": 11211, "idempotencyKeyTtlMs": 120000 }
}
```

---

## Copy-paste env template

**`.env.example`** lists every variable above with comments and safe defaults — use it when bootstrapping a new environment.
