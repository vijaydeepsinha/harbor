# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — Unreleased

> Everything below is pending the first `1.0.0` tag/release of this project (previous published version: `0.1.0`). No `0.2.0` version was ever published to `package.json` — the stateless-HTTP change originally drafted under a `[0.2.0]` heading is folded in here since it ships as part of this same `1.0.0` release.

### Added
- **Code Mode governance layer** (`docs/code-mode-governance.md`): durable executions with a persisted original program and `executionId` (`_meta["harbor/execution-id"]`); an activity journal at the sandbox bridge with replay of completed calls, `REPLAY_DIVERGED` detection and crash-safe outcome handling; declarative **Governance Rules** with OpenAPI-operation targeting, request-value conditions, and `ALLOW` / `DENY` / `REQUIRE_APPROVAL`; human approval through the MCP 2026-07-28 multi-round-trip pattern with resume in a fresh isolate; an HTTP fallback for clients without elicitation and execution inspection; pluggable execution stores, terminal code retention and execution-record retention. Governance rule sources and refresh schedules are configured independently in each service's `config.json`, while evaluation, approvals, execution persistence and the activity journal remain centrally controlled. Each service's rule set is isolated; disabled services do not load policy. The central `GOVERNANCE_DEFAULT_DECISION`, `GOVERNANCE_REQUEST_STATE_KEY` and `GOVERNANCE_APPROVAL_TTL_SEC` environment settings remain process-wide. A call no rule targets is ungoverned and allowed (`NO_GOVERNANCE`); a call some rule targets but none matches gets the configured default decision.
- **Audit sinks** (`src/spi/observability/audit-sink.ts`): every `api_execute` audit record and every Code Mode execution state change (statuses, approvals, decisions — no bodies) goes to each sink in `AUDIT_SINKS` (default `console`, the existing log line); `registerAuditSinkBackend` adds destinations such as S3. New env: `AUDIT_SINKS`.
- **Outbound Harbor headers** on every backend call: `X-Harbor-Server-ID` (Harbor's gateway stamp), optional `X-Harbor-Client-ID` forwarded from the caller, `X-Correlation-ID` carrying the MCP request id for that sandbox run, and optional `X-Harbor-Execution-ID` carrying the durable governed execution id across approval turns. The sandboxed program cannot set these (nor, since the 2026-09-27 review, any other identity, Harbor-owned or routing header). New env: `HARBOR_SERVER_ID`, `MCP_MAX_BODY_BYTES`.
- `AGENTS.md` — repository guide for AI coding agents.
- **Governance E2E test harness** (`TESTING.md`, `TEST_ARCHITECTURE.md`, `tests/REQUIREMENT_COVERAGE.md`): `npm run test:governance` boots the production image with Docker Compose (or host processes with `--local`) next to a deterministic mock backend and drives the gateway through real MCP 2026-07-28 calls — allow / deny / approval-required, MRTR approve + resume, the HTTP fallback channel, multi-step workflows with two approval points, denial at each point, fresh-isolate resume, replay, `REPLAY_DIVERGED`, unknown-outcome fail-closed, restart survival (file store), crash mid-call, requestState integrity/TTL, principal binding, fail-closed default, boot refusal on invalid rules, malformed protocol input, concurrency — with per-test diagnostics, JUnit/JSON reports and a `governance-test-summary.json`. Includes a generated Postman collection (`postman/mcp-governance.postman_collection.json`) with assertions and variable chaining, a dependency-free Newman-compatible runner, and the `governance-e2e.yml` GitHub Actions workflow.
- `server/discover` as the connection probe (replaces `initialize`).
- Shared `buildMcpServerFactory` for HTTP and stdio transports.
- Live E2E coverage for OAuth 2.1 resource binding via `api_execute` on the billing service (`tests/demo_e2e.py --docker-oauth`): a correct-audience JWT reaches the backend; a same-issuer, same-signature, wrong-audience JWT is rejected (`TOKEN_INVALID`, no data leak).

### Changed
- **Pre-release source/deep-import change:** all provider interfaces now live in SPI; concrete governance/spec/no-op/permission strategies live in adapters; auth orchestration and bearer parsing live in runtime; the token-cache base lives in adapter support. Core retains data types, configuration and errors. Former implementation paths and the runtime wiring re-export were removed rather than kept as compatibility aliases. Update development-build imports to canonical paths. Lint and architectural tests guard the separation; interface members, tool schemas and runtime behaviour are unchanged.
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
- **Breaking:** the last session id. With MCP 2026-07-28 there is no session, so `api_execute` was inventing a fresh random id per tool call and passing it on as if it named one. Gone: the outbound `X-MCP-Session-ID` header (the name stays reserved — a program still cannot set it), `sessionId` on the audit record, on `ExecuteRequestContext` (the `ConnectorAPI` context) and on the sandbox context, and `extractSessionId`. Correlate with `correlationId` (the MCP request id, shared across one sandbox run) and `executionId` (the durable governed workflow id across resumes).

### Fixed — owner review on main (before the 2026-09-27 review)
- `GET /executions/{id}` and `POST /executions/{id}/approvals/{approvalId}` validate the bearer against the execution's service and require the execution's owner; another principal gets `403 AUTH_FAILED` (3cbc9df). Before, any accepted bearer could inspect or decide any execution.
- Concurrent decisions on one approval serialize on the execution lock; the loser gets `409 EXECUTION_LOCKED` or `APPROVAL_ALREADY_DECIDED` (ee3ff86).
- **Behaviour change:** the principal an execution belongs to (`userIdHash`) is `sha256(metadata.userId)`, else `sha256(raw inbound bearer)` — no longer the `access_token` the middleware rotates on refresh, which locked owners out of their own paused executions (b52354b).
- `ApprovalService.decide()` requires `executionId` and refuses an approval that belongs to another execution (`APPROVAL_NOT_FOUND`) before anything is locked or changed (12ca119, 29cba50); E2E pins owner-bound approvals and cross-principal cases (ae27c7b).

### Fixed — follow-up to the owner's PR #7 review
- **Approvals.** `approve` may be answered in words (`yes`, `sure`, `proceed`, `approved` / `no`, `rejected`, …) on both channels; anything else is still refused.
- **Audit.** Refused, paused and failed calls are audited under the authenticated principal (they read `userIdHash: "unknown"`).
- **URLs in logs** keep query parameter names and multiplicity; every value is replaced (`REDACTED`), since credentials can use arbitrary names. Userinfo and fragments are removed.
- **Replay.** Calls started together could be handed each other's responses on resume when they raced differently; a concurrently admitted call now binds its query and body, and such a resume stops with `REPLAY_DIVERGED`.
- **Persistence.** Completed work is never marked `FAILED` merely because settlement threw. Read-back distinguishes an unapplied completion from an applied write whose acknowledgement or lock release failed: confirmed `COMPLETED` returns its recorded result; otherwise the client gets retryable `RUN_OUTCOME_NOT_RECORDED` and the observed status (omitted if unreadable), with conditional resume guidance. Failed stopped-run settlement also preserves the primary error while reporting observed status. Lock release is attempted, not assumed successful. A decision cut short between its writes (approval decided, activity still waiting) left the execution pausing forever; the next decide or resume now completes it. Secondary store failures are reported (`event: persistence_failure`, `execution_persistence_failures_total`) instead of being swallowed. Guarantees per adapter: `docs/code-mode-governance.md` §12.
- **Rules.** `path.*` conditions compare as the segment travels (`equals: 42` matches `42`); the flat condition form obeys the 64-node limit; the `bid-jump` example reviews omitted, non-numeric, zero or negative `currentBid` claims as well as increases over 30%.

### Fixed — 2026-09-27 review of main
- **Security — governance bypasses.** The `api.request` path is canonicalized once, before governance, and that one spelling is what the rules judge, the journal records and the connector sends (`src/runtime/sandbox/request-path.ts`). Equivalent spellings (`/%6frders/1`, `/Orders/1`) reach the same rule; aliasing spellings (`.`/`..` segments, encoded `/`, backslashes, fragments, empty segments) and absolute or protocol-relative URLs are refused with `INVALID_API_REQUEST` — before, `DELETE /orders/./1` went out as ALLOW (`NO_GOVERNANCE`) and an absolute URL sent the caller's bearer to any host. A query written into the path moves into `params` so `query.*` rules see it. The resolver matches decoded, case-insensitive literals and mixed segments (`{name}.json`).
- **Security — outbound headers.** A program can no longer set `Authorization`, Harbor's `X-MCP-*` / `X-Request-Source` / `X-Idempotency-Key` stamps, `Host`, `Cookie`, hop-by-hop or method/URL-override headers (`X-HTTP-Method-Override`, `X-Original-URL`, `X-Forwarded-*` …); Harbor's own headers are applied last.
- **Security — approvals.** An approval binds the request the human saw: a resumed program that reaches an approved (or waiting, or in-flight) activity with another resource, query or body stops with `REPLAY_DIVERGED` instead of executing it; replayed responses must match the concrete resource. `accept` approves only with `approve: true` (a missing or non-boolean value is refused, `400` over HTTP); a decision on a finished execution, or on an approval whose activity was re-asked, changes nothing; a conflicting MRTR answer after an HTTP decision gets `APPROVAL_ALREADY_DECIDED` and runs nothing.
- **Security — front door.** `/mcp` reads request bodies under `MCP_MAX_BODY_BYTES` (default 4 MiB; `413 PAYLOAD_TOO_LARGE`) before the SDK buffers them; `/executions` answers an over-limit body with a readable 413. JWTs need `exp` and an asymmetric algorithm; tokens the issuer's keys cannot verify are `TOKEN_INVALID`, not a retryable "auth server unreachable". Introspection honours RFC 7662 `active` and `exp`. Two `Authorization` headers are refused. Introspection errors no longer reveal the auth server's address.
- **Security — specs.** A fetched (URL) spec's external `$ref`s are not resolved (they could read gateway-local files or internal URLs into the served spec); fetched specs are capped at 20 MB and their URL is redacted in logs (userinfo and fragments removed; query parameter names kept, every value replaced by `REDACTED`).
- **Durability.** POST and PATCH are never re-sent after a timeout or 5xx (only GET/PUT/DELETE are retried). Calls a program did not await finish (or are aborted) before the run's outcome is recorded — they no longer journal into, or resurrect, a finished execution. Concurrent calls are admitted one at a time, so a DENY is never overwritten by a sibling's pause. Idempotency keys are per execution and per call (`mcp-{service}-{executionId}-{sequence}`; legacy runs add `-c{n}`), so two executions of one program never share a key.
- **Governance loading.** Each enabled service owns an isolated rule source and refresh schedule in `config.json`; a disappearing directory, invalid refresh or empty refresh replacing active rules keeps that service's last valid set. A missing default service-local directory warns and starts that service with no rules. Rules read a JSON-string body as its object, compare `query.*` values in their wire form, and read only own properties; a rule `path` must start with `/`.
- **Resilience.** The circuit breaker records failures under the key it checks (the OpenAPI template), counts one failure per call, and admits one half-open probe. Background token refresh works (it always threw), never extends how long the caller's own token is trusted, and keeps the caller's identity; a non-scalar `metadata.userId` no longer collapses callers into one principal.
- **Configuration.** `ENABLE_AUDIT=false` disables audit (every non-empty value used to read as true); empty `AUDIT_SINKS` with audit on, and non-numeric cache ports/timeouts, stop boot. `IDEMPOTENCY_TYPE` is the default for services without an `idempotency` block (it was never read). `TOKEN_CACHE_TYPE`, `IDEMPOTENCY_TYPE` and `EXECUTION_STORE_TYPE` accept the name of a registered backend.
- **Registry and tools.** A dangling symlink or one bad skill file no longer takes the gateway or the service down; out-of-range refresh intervals are refused; spec and skills refresh together and never overlap; relative `$ref`s in file specs resolve beside the spec; a `servers` URL without a port means port 80 for http. `UNKNOWN_SERVICE` is not retryable and does not create a metric series per name. Resumed runs are audited with the program that ran, and answers that end a resume are audited. A backend timeout that reaches the program uncaught is `SANDBOX_RUNTIME`, not a retryable `SANDBOX_TIMEOUT`. The RFC 9728 path-inserted metadata URL is served; an unusable stdio `MCP_TOKEN` stops boot.
- **Tests.** Unit and integration: 822 passed, 1 skipped (was 604). Governance E2E: 157 (was 139). Postman: 15 folders, 118 requests, 232 assertions (was 14 / 88 / 183); folder 15 covers the cases above.


### Security
- Updated `@modelcontextprotocol/server` to 2.4.0, `@modelcontextprotocol/node` to 2.1.2 and Zod to 4.6.7, then applied safe transitive lockfile updates. `npm audit --omit=dev` reports no production vulnerabilities.

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
