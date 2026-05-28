# OAuth 2.1 Support in Harbor

Harbor acts as an **OAuth 2.0 Protected Resource** (RFC 9728). It does not issue tokens — it validates them. Clients that already carry a bearer token are completely unaffected by OAuth 2.1 configuration.

## How it works

```
POST /mcp arrives
        │
        ├── Authorization: Bearer <token>  ──►  existing validation path (unchanged)
        │
        └── no token
                │
                ▼
            401 + WWW-Authenticate: Bearer resource_metadata="https://harbor.example.com/.well-known/oauth-protected-resource"
                │
                ▼  (MCP client fetches metadata, discovers AS, runs OAuth 2.1 flow)
                │
            GET /.well-known/oauth-protected-resource  → RFC 9728 document
                │
                ▼  (client gets token from AS, retries POST /mcp)
                │
            existing validation path  ↑
```

## Quick start

Set three environment variables:

```bash
HARBOR_RESOURCE_URI=https://harbor.example.com
HARBOR_AUTH_SERVERS=https://auth.example.com
HARBOR_SCOPES_SUPPORTED=api:read,api:write   # optional
```

That is all Harbor needs to emit the `WWW-Authenticate` header and serve the discovery document. Token validation remains per-service in `config.json`.

## RFC 9728 document

When `HARBOR_RESOURCE_URI` is set, Harbor serves:

```
GET /.well-known/oauth-protected-resource
GET /mcp/.well-known/oauth-protected-resource  (MCP-specific sub-path)
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

`scopes_supported` is only present when `HARBOR_SCOPES_SUPPORTED` is set.

## Per-service token validation

Each service chooses its auth strategy independently in `services/<name>/config.json`.

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

### oauth-2.1 — auto-discovery + JWT verification

Simpler than `jwt-validation` when your AS follows RFC 8414 or OIDC Discovery: Harbor fetches the JWKS URI automatically.

The `billing` service (`services/billing/config.json`) ships as a concrete example — disabled by default, enable it to test this strategy end-to-end.

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

Discovery tries `/.well-known/openid-configuration` first, then `/.well-known/oauth-authorization-server`. The result is cached per strategy instance; Harbor does not re-fetch on every token.

### oauth-introspection — token introspection (RFC 7662)

Use when the AS does not issue JWTs or when you need server-side revocation checks.

```json
{
  "auth": {
    "type": "oauth-introspection",
    "host": "auth.example.com",
    "port": 443,
    "protocol": "https",
    "introspectionPath": "/oauth/introspect"
  }
}
```

## Backward compatibility

| Scenario | Behavior |
|----------|----------|
| `HARBOR_RESOURCE_URI` not set | No change anywhere — `/.well-known/oauth-protected-resource` returns 404, no `WWW-Authenticate` on 401 |
| Client sends a well-formed token, `HARBOR_RESOURCE_URI` set | Unchanged — token validation runs as before |
| Client sends a weak token (not a valid JWT and not ≥ 32 base64url chars), any mode | **Rejected** at parse layer with `WeakCredentials` regardless of auth mode or `HARBOR_RESOURCE_URI` setting |
| Client sends no token, `HARBOR_RESOURCE_URI` not set | Unchanged — plain 401, no `WWW-Authenticate` |
| Client sends no token, `HARBOR_RESOURCE_URI` set | **New** — 401 with `WWW-Authenticate: Bearer resource_metadata="..."` |
| `stdio` transport | Completely unaffected — MCP spec exempts stdio from OAuth 2.1 |

## Running the E2E test suite

`examples/07-oauth/` contains a Docker Compose file that starts a mock OAuth 2.1 authorization server (navikt/mock-oauth2-server on port 8080). No shell scripts — all orchestration is done by `tests/demo_e2e.py`.

**Full suite** — MCP tools + OAuth metadata endpoints + real JWT via Docker mock AS:

```bash
python3 tests/demo_e2e.py --start-services --oauth \
  --oauth-resource-uri "http://127.0.0.1:3333" \
  --oauth-auth-servers "https://auth.example.com" \
  --docker-oauth
```

This command:
1. Starts the product/order/tasks backend services and Harbor
2. Exercises all MCP tools (discover_services, discover_skills, search_code, api_execute)
3. Verifies OAuth 2.1 metadata endpoints (`/.well-known/oauth-protected-resource`)
4. Spins up the Docker mock AS on port 8080
5. Switches Harbor to OAuth mode (enables billing service, sets `HARBOR_RESOURCE_URI`)
6. Acquires a real JWT via `client_credentials` and verifies Harbor accepts it through full JWT validation
7. Tears down Docker and restores token mode on exit

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
- RFC 9728 — OAuth 2.0 Protected Resource Metadata
- RFC 8414 — Authorization Server Metadata
- MCP Authorization spec — `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
