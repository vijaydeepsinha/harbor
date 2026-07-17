# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed
- **Breaking:** HTTP transport is now stateless. Each `/mcp` request creates a fresh MCP server and transport (`sessionIdGenerator: undefined`). No `mcp-session-id` header is issued or required.
- **Breaking:** Removed `SESSION_IDLE_TTL_MS` and `SESSION_SWEEP_INTERVAL_MS` environment variables.
- **Breaking:** `/health` no longer returns `activeSessions`.
- Renamed internal factory `createSessionServer` → `createMcpServer`.

### Removed
- `SessionManager`, idle session sweep, session resume routing, and `ERR.UNKNOWN_SESSION`.

---

## [0.1.0] — 2026-05-27

Initial open-source release under Apache License 2.0.

### MCP Tools
- `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`

### Auth
- `static-token` — pre-shared opaque token forwarded to backend APIs
- `oauth-introspection` — delegates validation to a token introspection endpoint
- `jwt-validation` — local RS256/ES256 JWT verification via `jose` against a JWKS endpoint
- `oauth-2.1` — AS auto-discovery (RFC 8414 / OIDC) followed by local JWT verification
- RFC 9728 protected resource metadata endpoint (`/.well-known/oauth-protected-resource`); enabled via `HARBOR_RESOURCE_URI`
- Bearer tokens must be a structurally valid JWT or a high-entropy opaque token (≥ 32 base64url chars)

### Infrastructure
- Token cache backends: `in-memory`, `memcache`, `couchbase`
- Idempotency backends: `noop`, `in-memory`, `memcache`, `couchbase`
- Circuit breaker strategies: `count-based`, `noop`
- Spec loading strategies: `file`, `url`, `url-with-fallback`
- Service-level spec + skills refresh on configurable interval
- V8 sandbox isolation via `isolated-vm`
- Streamable HTTP and stdio transports
- Structured JSON logging (pino)
- Audit logging for `api_execute`
- Pluggable metrics registry
