# Example 07 — OAuth 2.1

Docker configuration for the mock OAuth 2.1 authorization server used by Harbor's E2E test suite.

Contains `docker-compose.yml` and the mock AS config — no shell scripts.
All testing is handled by `tests/demo_e2e.py`.

## Run the full E2E suite

```bash
python3 tests/demo_e2e.py --start-services --oauth \
  --oauth-resource-uri "http://127.0.0.1:3333" \
  --oauth-auth-servers "https://auth.example.com" \
  --docker-oauth
```

This starts Docker, switches Harbor to OAuth mode, acquires a real JWT, runs all assertions, and tears everything down.

## Get a Cursor token manually

Start the mock AS, then fetch a token:

```bash
docker compose -f examples/07-oauth/docker-compose.yml up -d

curl -sf -X POST http://localhost:8080/default/token \
  -u "harbor-test-client:test-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  | jq -r '.access_token'
```

Paste the token into `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "harbor-local": {
      "url": "http://localhost:3333/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Token expires in ~1h. Re-run the curl to refresh.

## Switch modes manually

Modes control which services Harbor loads. Edit `enabled` in `services/*/config.json`:

| Mode | `billing` | `product` / `order` / `tasks` |
|------|-----------|-------------------------------|
| oauth | `true` | `false` |
| token | `false` | `true` |

Harbor must be restarted after switching.

## Service config reference — `oauth-2.1` auth type

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

Full field reference: `docs/service-onboarding.md` → **oauth-2.1** section.

## OAuth env vars (set when starting Harbor in OAuth mode)

| Var | Value |
|-----|-------|
| `HARBOR_RESOURCE_URI` | `http://localhost:3333` |
| `HARBOR_AUTH_SERVERS` | `http://localhost:8080/default` |
| `HARBOR_SCOPES_SUPPORTED` | `api:read,api:write` |

## Teardown

```bash
docker compose -f examples/07-oauth/docker-compose.yml down
```
