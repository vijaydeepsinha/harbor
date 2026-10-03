# OAuth 2.1 Support in Harbor

Harbor acts as an **OAuth 2.0 Protected Resource** (RFC 9728). It does not issue tokens — it validates them. Clients that already carry a bearer token are unaffected by the OAuth 2.1 settings: they only add discovery metadata and a `WWW-Authenticate` hint. Token validation is chosen per service in `config.json`.

## How it works

```
POST /mcp arrives
        │
        ├── no Authorization header, a malformed or weak bearer, or two Authorization headers
        │         │
        │         ▼
        │     401 + WWW-Authenticate: Bearer resource_metadata="https://harbor.example.com/.well-known/oauth-protected-resource"
        │         │   (the header only when HARBOR_RESOURCE_URI is set)
        │         ▼  (MCP client fetches metadata, discovers the AS, runs the OAuth 2.1 flow)
        │     GET /.well-known/oauth-protected-resource  → RFC 9728 document
        │         │
        │         ▼  (client gets a token from the AS, retries POST /mcp)
        │
        └── a well-formed bearer ──►  MCP handler; each tool validates the token with the service's auth strategy
```

The transport checks only the bearer's **format**: a JWT (header.payload.signature), or an opaque token of at least 32 base64url characters, at most 8192 characters, no control characters, exactly one `Authorization` header (`src/runtime/auth/bearer-header-parser.ts`, `src/runtime/auth/bearer-authorization.ts`).

> **Known limitation (open decision).** A well-formed token that the service's strategy rejects — expired, revoked, wrong audience — is reported as a tool error inside an HTTP 200 response (`TOKEN_EXPIRED`, `TOKEN_INVALID`), not as a 401 with `WWW-Authenticate`. `discover_services` needs no valid token at all, and `/health` lists the service names. MCP 2026-07-28 expects a 401 for an invalid token; closing this needs a decision on validating at the transport, which is per-service today.

## Quick start

Set these environment variables (HTTP transport only):

```bash
HARBOR_RESOURCE_URI=https://harbor.example.com
HARBOR_AUTH_SERVERS=https://auth.example.com
HARBOR_SCOPES_SUPPORTED=api:read,api:write   # optional
```

`HARBOR_RESOURCE_URI` is the switch: without it no metadata is served and no 401 carries `WWW-Authenticate`. `HARBOR_AUTH_SERVERS` is a comma list; unset, `authorization_servers` is `[]`. Neither value is validated. Token validation remains per-service in `config.json`.

## RFC 9728 document

When `HARBOR_RESOURCE_URI` is set, Harbor serves the same document at three paths (`src/runtime/http/http-gateway.ts`, `HTTP_ROUTES` in `src/core/constants.ts`):

```
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp   (RFC 9728 §3.1 path-inserted form for the /mcp resource)
GET /mcp/.well-known/oauth-protected-resource
```

Response:

```json
{
  "resource": "https://harbor.example.com",
  "authorization_servers": ["https://auth.example.com"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["api:read", "api:write"]
}
```

`scopes_supported` is only present when `HARBOR_SCOPES_SUPPORTED` is set. Without `HARBOR_RESOURCE_URI` all three paths answer 404 `NOT_FOUND`. The `WWW-Authenticate` hint always names the root form, `${HARBOR_RESOURCE_URI}/.well-known/oauth-protected-resource`.

## Per-service token validation

Each service chooses its auth strategy independently in `services/<name>/config.json`. Full field reference: [`configuration.md — Auth strategies`](configuration.md#auth-strategies).

### jwt-validation — local JWT verification via JWKS

Best for high-throughput environments. Verifies tokens locally without a round-trip to the AS.

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

Full field reference: [`configuration.md — jwt-validation`](configuration.md#jwt-validation-local-jwt-verification-via-jwks).

What is checked (`src/adapters/auth/strategies/jwt-validation.strategy.ts`):

- signature against the JWKS (keys cached for an hour, refetched at most every 30 s on an unknown `kid`);
- `iss`, `aud` and `exp`, with `clockToleranceSec` (default 30) of skew. **`exp` is required** — a token without it is refused;
- algorithm: only `RS256/384/512`, `PS256/384/512`, `ES256/384/512` and `EdDSA`.

An unknown `kid`, `alg: none`, an `HS*` algorithm, a bad signature, a failed claim or a malformed token is `TOKEN_INVALID` (not retryable); an expired token is `TOKEN_EXPIRED`; an unreachable JWKS is `INTROSPECTION_FAILED` (retryable). JWT strategies have no refresh: a token is used until it expires.

### oauth-2.1 — auto-discovery + JWT verification

Simpler than `jwt-validation` when your AS follows RFC 8414 or OIDC Discovery: Harbor fetches the JWKS URI automatically, then verifies exactly as `jwt-validation` does, with `authorizationServer` as the expected issuer.

The `billing` service (`services/billing/config.json`) ships as a concrete example — disabled by default, enable it to test this strategy end-to-end. `services/billing-jwt/config.json` (jwt-validation) and `services/billing-introspection/config.json` (oauth-introspection) protect the same backend with the other two strategies.

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

Full field reference: [`configuration.md — oauth-2.1`](configuration.md#oauth-21-as-auto-discovery--jwt-verification).

Discovery tries `/.well-known/openid-configuration` first, then `/.well-known/oauth-authorization-server`, each within `discoveryTimeoutMs` (default 10000). The advertised `jwks_uri` must have the AS's scheme and host, or it is refused (SSRF guard). The result is cached per strategy instance; a failed discovery is retried on the next token.

> Note: `services/billing/config.json`'s `audience` (`http://localhost:3333`)
> intentionally does not match this guide's default `HARBOR_RESOURCE_URI`
> example (`http://127.0.0.1:3333`) or the `demo_e2e.py` default — a service's
> `audience` and the gateway's advertised `HARBOR_RESOURCE_URI` are
> independently configured values that happen to often be the same string in
> practice, not the same setting. `mock-oauth2-config.json` mints its
> "correct" demo JWT with `aud: ["http://localhost:3333"]` to match the
> service config, not the resource-metadata default.

> **`audience` is required (MCP 2026-07-28, RFC 8707 resource binding).** Both
> the `oauth-2.1` and `jwt-validation` strategies fail closed if `audience` is
> missing or blank: the service is skipped at startup
> (`src/wiring/service-wiring.ts`). `audience` is the gateway's canonical
> resource identifier — set it to the same value you advertise as `resource`
> in the Protected Resource Metadata (`HARBOR_RESOURCE_URI`). This ensures
> Harbor rejects an access token minted for a *different* resource behind the
> same authorization server, closing the confused-deputy / token pass-through
> gap for both strategies. `oauth-introspection` supports an optional
> `audience` field too, but per RFC 7662 §2.2 the introspection response isn't
> guaranteed to include an `aud` claim — see
> [`configuration.md — oauth-introspection`](configuration.md#oauth-introspection-recommended-for-production)
> for its best-effort (not fail-closed) semantics.

### oauth-introspection — token introspection (RFC 7662)

Use when the AS does not issue JWTs or when you need server-side revocation checks.

```json
{
  "auth": {
    "type": "oauth-introspection",
    "host": "auth.example.com",
    "port": 443,
    "protocol": "https",
    "introspectionPath": "/oauth/introspect",
    "method": "POST",
    "tokenPassMode": "header",
    "metadataMapping": { "userId": "sub" }
  }
}
```

How the call is made and read (`src/adapters/auth/strategies/oauth-introspection.strategy.ts`):

- **Request.** The default is `GET <introspectionPath>?token=<bearer>` (`method: GET`, `tokenPassMode: query`). With `"method": "POST"`, `tokenPassMode` picks a JSON body (`{"token": …}`, not RFC 7662's form encoding), an `Authorization: Bearer` header, or the query string. Harbor sends no client credentials to the introspection endpoint. The GET default puts the caller's token in a URL that proxies may log — prefer `POST` with `header` or `body`. Both points are open items.
- **Response.** 401/403 ⇒ `TOKEN_INVALID`. 5xx or a transport failure ⇒ `INTROSPECTION_FAILED` (retryable); the client sees only the error code (e.g. `ECONNREFUSED`), never the auth server's address. `active` present and not `true` ⇒ `TOKEN_INVALID`. The lifetime comes from `expires_in` / `expiresIn` or a mapped field (relative seconds; a value above 1 000 000 000 is read as an epoch timestamp), else from RFC 7662's absolute `exp`; missing or ≤ 0 ⇒ `TOKEN_EXPIRED`. `aud` is compared only when `audience` is set and the response carries `aud`.
- **Revocation** is seen on the next validation, which happens when the cached entry expires: after `min(token lifetime, AUTH_TOKEN_CACHE_TTL_MS)` (default 300 000 ms). A backend 401 evicts the entry at once.
- **Refresh.** With `refreshPath` set and a `refresh_token` in the response, Harbor refreshes the token it sends to the backend once it is within `tokenRefreshBufferSec` (default 300) of expiry — in the background on a cache hit (one at a time per token, 30 s cooldown after a failure), synchronously on a cache miss. The refresh never extends the caller's own cache entry, so a revoked caller token still stops working when that entry expires, and the refreshed payload keeps the original `metadata.userId` (`src/runtime/auth/auth-middleware.ts`, `src/adapters/auth/abstract-token-cache.ts`).

## Identity binding — who owns an execution

Code Mode executions, their approvals and the `/executions` routes are bound to a principal hash (`src/core/utils/user-id-hash.ts`):

- `sha256(metadata.userId)` when the strategy's `metadataMapping` yields a non-empty string or a finite number;
- otherwise `sha256(<the caller's raw bearer>)`. An object or array claim does not count.

Map `userId` (e.g. `"userId": "sub"`) whenever clients rotate tokens. Without it, a client that comes back with a new token is a different principal: it cannot resume its own paused execution over MCP (`EXECUTION_NOT_RESUMABLE`) or decide its approval over HTTP (403 `AUTH_FAILED`). A token refresh does not change the principal, because the refreshed payload keeps `metadata.userId`. `static-token` has no metadata, so its principal is always the bearer.

`GET /executions/{id}` and `POST /executions/{id}/approvals/{approvalId}` validate the bearer with the execution's service strategy: a missing or malformed bearer is 401 (with `WWW-Authenticate` when `HARBOR_RESOURCE_URI` is set), a rejected token 401, an unreachable auth server 503, another principal 403 `AUTH_FAILED` (`src/runtime/http/execution-routes.ts`).

## Backward compatibility

| Scenario | Behavior |
|----------|----------|
| `HARBOR_RESOURCE_URI` not set | All three metadata paths return 404; no `WWW-Authenticate` on 401 |
| Client sends a well-formed, valid token, `HARBOR_RESOURCE_URI` set | Unchanged — token validation runs as before |
| Client sends a weak token (not a valid JWT and not ≥ 32 base64url chars), any mode | **Rejected** at the transport: 401 `TOKEN_INVALID`, reason `weak_credentials`, regardless of auth mode or `HARBOR_RESOURCE_URI` |
| Client sends two `Authorization` headers | 401, reason `duplicate_authorization_header` |
| Client sends no token, `HARBOR_RESOURCE_URI` not set | Plain 401 `MISSING_TOKEN`, no `WWW-Authenticate` |
| Client sends no token, `HARBOR_RESOURCE_URI` set | 401 with `WWW-Authenticate: Bearer resource_metadata="..."` |
| Client sends a well-formed token the service rejects | HTTP 200 with a tool error (`TOKEN_INVALID`, `TOKEN_EXPIRED`, `INTROSPECTION_FAILED`) — see the known limitation above |
| `stdio` transport | Unaffected by these settings — MCP exempts stdio from OAuth 2.1. `MCP_TOKEN` is required and must pass the same bearer format check, or the gateway exits at boot |
| Existing `oauth-2.1` or `jwt-validation` service config with no `audience` | **Breaking** — the service is skipped at startup (fail-closed, see note above). Set `audience` to the resource identifier your AS mints tokens for — typically the same value as `HARBOR_RESOURCE_URI` if you use RFC 9728 discovery, or the gateway's own base URL if you don't. |

## Running the E2E test suite

`examples/07-oauth/` contains a Docker Compose file that starts a mock OAuth 2.1 authorization server (navikt/mock-oauth2-server on port 8080). `tests/demo_e2e.py` orchestrates the automated run; `examples/demo/start-oauth-mode.sh` sets up the same environment for manual testing.

**Full suite** — MCP tools + OAuth metadata endpoints + real tokens via the Docker mock AS:

```bash
python3 tests/demo_e2e.py --start-services --oauth \
  --oauth-resource-uri "http://127.0.0.1:3333" \
  --oauth-auth-servers "https://auth.example.com" \
  --docker-oauth
```

This command:
1. Starts the product/order/tasks backend services and Harbor
2. Exercises all MCP tools (discover_services, discover_skills, search_code, api_execute)
3. Verifies the OAuth 2.1 metadata endpoints (`/.well-known/oauth-protected-resource`)
4. Spins up the Docker mock AS on port 8080, the billing backend on 3004 and the mock introspection server on 3008
5. Switches Harbor to OAuth mode: enables `billing`, `billing-jwt` and `billing-introspection`, disables product/order/tasks, sets `HARBOR_RESOURCE_URI`
6. Acquires a real JWT via `client_credentials` and checks all three strategies: valid tokens are accepted, wrong-audience and revoked tokens are refused
7. Tears down Docker and restores token mode on exit

**Manual OAuth mode** — `examples/demo/start-oauth-mode.sh` starts the mock AS, the billing backend (:3004), the mock introspection server (:3008) and Harbor with `HARBOR_RESOURCE_URI=http://127.0.0.1:3333`, `HARBOR_AUTH_SERVERS=http://localhost:8080/default` and `HARBOR_SCOPES_SUPPORTED=api:read,api:write`. It flips `enabled` in the tracked `services/*/config.json` files and restores them when you press Ctrl+C.

**Fetch a token manually** (without running the full suite):

```bash
docker compose -f examples/07-oauth/docker-compose.yml up -d

curl -sf -X POST http://localhost:8080/default/token \
  -u "harbor-test-client:test-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  | jq -r '.access_token'
```

Tear down: `docker compose -f examples/07-oauth/docker-compose.yml down`

## See also

- `examples/07-oauth/` — Docker Compose config and mock AS setup for local testing
- [`configuration.md`](configuration.md) — every auth field and environment variable
- RFC 9728 — OAuth 2.0 Protected Resource Metadata
- RFC 8414 — Authorization Server Metadata
- RFC 7662 — OAuth 2.0 Token Introspection
- MCP Authorization spec — `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization`
