# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — Unreleased

> Everything below is pending the first `1.0.0` tag/release of this project (previous published version: `0.1.0`). No `0.2.0` version was ever published to `package.json` — the stateless-HTTP change originally drafted under a `[0.2.0]` heading is folded in here since it ships as part of this same `1.0.0` release.

### Added
- **Code Mode governance layer** (`docs/code-mode-governance.md`): durable executions with a persisted original program and `executionId` (`_meta["harbor/execution-id"]`); an activity journal at the sandbox bridge with replay of completed calls, `REPLAY_DIVERGED` detection and crash-safe outcome handling; declarative **Governance Rules** (`governance/rules/*.yaml`, OpenAPI-operation targeting, request-value conditions as an `allOf` / `anyOf` / `not` tree with `ratio`, `percent_of` and `days_between` operands — the flat condition map stays valid as shorthand — advisory-only actions, three rule levels — gateway < service < endpoint, derived from `match`, with `final: true` to pin a broader level — `/prefix/**` subtree paths, method lists, `DENY > REQUIRE_APPROVAL > ALLOW` within a level); human approval through the MCP 2026-07-28 multi-round-trip pattern (form elicitation + HMAC-sealed `requestState`) with multiple approval rounds and resume in a fresh isolate; an HTTP fallback for clients without elicitation (`POST /executions/{id}/approvals/{approvalId}`) and inspection (`GET /executions/{id}`); pluggable execution store (`in-memory`, `file`, `memcache` — shared journal, approvals and run lock across pods — and `registerExecutionStoreBackend`); a terminal execution's program text is dropped (`EXECUTION_CODE_RETENTION`) and the execution with all its records is deleted after `EXECUTION_RETENTION_SEC`. Rules come from a pluggable source — a directory (default), a URL, or `registerGovernanceRuleSourceBackend` — optionally re-read every `GOVERNANCE_RULES_REFRESH_SEC` seconds, keeping the last valid set when a refresh fails. New env: `EXECUTION_STORE_TYPE`, `EXECUTION_STORE_DIR`, `EXECUTION_STORE_MEMCACHE_HOST`, `EXECUTION_STORE_MEMCACHE_PORT`, `EXECUTION_STORE_MEMCACHE_TIMEOUT_MS`, `EXECUTION_STORE_MEMCACHE_KEY_PREFIX`, `EXECUTION_STORE_MEMCACHE_LOCK_TTL_SEC`, `EXECUTION_CODE_RETENTION`, `EXECUTION_RETENTION_SEC`, `GOVERNANCE_RULES_SOURCE`, `GOVERNANCE_RULES_DIR`, `GOVERNANCE_RULES_URL`, `GOVERNANCE_RULES_URL_TIMEOUT_MS`, `GOVERNANCE_RULES_REFRESH_SEC`, `GOVERNANCE_DEFAULT_DECISION`, `GOVERNANCE_REQUEST_STATE_KEY`, `GOVERNANCE_APPROVAL_TTL_SEC`. A call no rule targets is ungoverned and allowed (`NO_GOVERNANCE`), so behaviour without rules is unchanged; a call some rule targets but none matches gets `GOVERNANCE_DEFAULT_DECISION`, default `DENY`.
- **Audit sinks** (`src/spi/observability/audit-sink.ts`): every `api_execute` audit record and every Code Mode execution state change (statuses, approvals, decisions — no bodies) goes to each sink in `AUDIT_SINKS` (default `console`, the existing log line); `registerAuditSinkBackend` adds destinations such as S3. New env: `AUDIT_SINKS`.
- **Outbound Harbor headers** on every backend call: `X-Harbor-Server-ID` (Harbor's stamp, `HARBOR_SERVER_ID`, default `HARBOR_GATEWAY`), `X-Harbor-Client-ID` (forwarded from the caller's request when present), and `X-Correlation-ID` carrying the execution id under Code Mode governance so every call of one script correlates across approval resumes. The sandboxed program can no longer set these three. New env: `HARBOR_SERVER_ID`.
- `AGENTS.md` — repository guide for AI coding agents.
- **Governance E2E test harness** (`TESTING.md`, `TEST_ARCHITECTURE.md`, `tests/REQUIREMENT_COVERAGE.md`): `npm run test:governance` boots the production image with Docker Compose (or host processes with `--local`) next to a deterministic mock backend and drives the gateway through real MCP 2026-07-28 calls — allow / deny / approval-required, MRTR approve + resume, the HTTP fallback channel, multi-step workflows with two approval points, denial at each point, fresh-isolate resume, replay, `REPLAY_DIVERGED`, unknown-outcome fail-closed, restart survival (file store), crash mid-call, requestState integrity/TTL, principal binding, fail-closed default, boot refusal on invalid rules, malformed protocol input, concurrency — with per-test diagnostics, JUnit/JSON reports and a `governance-test-summary.json`. Includes a generated Postman collection (`postman/mcp-governance.postman_collection.json`) with assertions and variable chaining, a dependency-free Newman-compatible runner, and the `governance-e2e.yml` GitHub Actions workflow.
- `server/discover` as the connection probe (replaces `initialize`).
- Shared `buildMcpServerFactory` for HTTP and stdio transports.
- Live E2E coverage for OAuth 2.1 resource binding via `api_execute` on the billing service (`tests/demo_e2e.py --docker-oauth`): a correct-audience JWT reaches the backend; a same-issuer, same-signature, wrong-audience JWT is rejected (`TOKEN_INVALID`, no data leak).

### Changed
- **Source layout:** all gateway code lives under `src/` (`src/core`, `src/runtime`, `src/tools`, `src/spi`, `src/adapters`, `src/wiring`, `src/index.ts`); tests stay in `tests/`. The build output is unchanged (`dist/index.js`). Deep imports of the published package resolve as before (`dist/<module>/…`), but anyone importing the TypeScript sources by path must add `src/`. Without `SERVICES_DIR`, the gateway now finds `services/` at the repo (or image) root from both `tsx src/index.ts` and `node dist/index.js`; previously the built entry looked in `dist/services`. `tests/unit/doc-paths.test.ts` fails when a tracked Markdown file names a repository path that does not exist.
- **Breaking:** Harbor 1.0 implements MCP protocol revision **2026-07-28** only (`legacy: 'reject'`). The 2025 `initialize` / `notifications/initialized` handshake is no longer supported.
- **Breaking:** HTTP clients must send `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name` on every POST, plus the per-request `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`).
- **Breaking:** Replaced `@modelcontextprotocol/sdk` v1 with `@modelcontextprotocol/server` and `@modelcontextprotocol/node` v2 (`createMcpHandler`, `serveStdio`).
- **Breaking:** HTTP transport is now stateless. Each `/mcp` request creates a fresh MCP server and transport. No `mcp-session-id` header is issued or required.
- **Breaking:** Removed `SESSION_IDLE_TTL_MS` and `SESSION_SWEEP_INTERVAL_MS` environment variables.
- **Breaking:** `/health` no longer returns `activeSessions`.
- **Breaking (`oauth-2.1` and `jwt-validation` auth):** access tokens must now be resource-bound (RFC 8707, MCP 2026-07-28 §17). `audience` is **required** on both the `oauth-2.1` and `jwt-validation` auth configs and validated against the token's `aud`; a missing/blank `audience` now fails closed at strategy construction and config wiring. Closes the confused-deputy / token pass-through gap where a token minted for another resource behind the same authorization server was accepted. `oauth-introspection` gains an optional `audience` check too, but it is **best-effort, not fail-closed** — RFC 7662 §2.2 makes `aud` an optional introspection response field, so a response that omits it is still accepted.
- Upgraded `zod` to v4 (required by MCP SDK v2 tool schema registration).
- Renamed internal factory `createSessionServer` → `createMcpServer`.

### Removed
- `SessionManager`, idle session sweep, session resume routing, and `ERR.UNKNOWN_SESSION`.

### Security
- Bumped `axios` and `js-yaml` to non-vulnerable versions via `npm audit fix`. No remaining high-severity `npm audit` advisories; `npm audit --audit-level=high` CI gate passes. Two moderate (`vitest`/`@vitest/mocker`) and one low (`esbuild`, Windows-only dev-server path) advisories remain — all three are dev-only dependencies (test runner / build tool), not shipped in the published package, and below the CI gate's `high` threshold.

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
