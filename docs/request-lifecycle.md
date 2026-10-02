# Request Lifecycle — End-to-End Trace

> **Orientation:** For the layer diagram, SPI contracts, and system design context, see [`architecture.md`](architecture.md). This document focuses on the runtime call sequence only. Durable executions, replay and approvals are specified in [`code-mode-governance.md`](code-mode-governance.md).

This document traces exactly what happens from the moment a user asks a question to the final
response. It covers all five tools: `discover_services`, `discover_skills`, `get_skill_details`,
`search_code`, and `api_execute`.

---

## The cast of characters

| Class / Function | File | Role |
|---|---|---|
| `createMcpGateway` | `src/runtime/server-factory.ts` | Boots the gateway: services, token cache, registry, audit pipeline, Code Mode runtime, transport |
| `scanServicesDirectory` | `src/runtime/registry/filesystem-scanner.ts` | Reads `services/*` — `config.json`, the spec, `skills/*.md` |
| `buildServiceResources` | `src/runtime/gateway/service-resources-factory.ts` | Wires one scanned service into its `ServiceResources` |
| `ServiceRegistry` | `src/runtime/registry/service-registry.ts` | Maps service names to their resources |
| `startHttpGateway` | `src/runtime/http/http-gateway.ts` | `/mcp` (bearer format, body limit), `/health`, protected-resource metadata, `/executions` |
| `buildMcpServerFactory` | `src/runtime/http/mcp-server-factory.ts` | A fresh `McpServer` with the five tools for every request |
| `registerDiscoverServicesTool` | `src/tools/discover-services.tool.ts` | Defines what happens when `discover_services()` is called |
| `registerDiscoverSkillsTool` | `src/tools/discover-skills.tool.ts` | Defines what happens when `discover_skills()` is called |
| `registerGetSkillDetailsTool` | `src/tools/get-skill-details.tool.ts` | Defines what happens when `get_skill_details()` is called |
| `registerSearchCodeTool` | `src/tools/search-code.tool.ts` | Defines what happens when `search_code()` is called |
| `registerExecuteApiTool` | `src/tools/execute-api.tool.ts` | Defines what happens when `api_execute()` is called |
| `toolHelpers` | `src/tools/tool-helpers.ts` | Shared utilities — `mcpError`, `mcpSuccess`, `resolveService`, `validateAuth`, `extractCorrelationId`, `extractSessionId`, `runSandboxTool` |
| `AuthMiddleware` | `src/spi/auth/auth-middleware.ts` | Parses the bearer, cache-first validation via the service's auth strategy, proactive refresh, session expiry detection |
| `extractBearerFromHeader` | `src/spi/auth/bearer-authorization.ts` | One `Authorization` header, `Bearer` scheme, a JWT or ≥ 32 base64url characters |
| `AbstractTokenCache` | `src/spi/auth/abstract-token-cache.ts` | Base class for all token cache backends — hash, entry expiry, get/validate/update orchestration |
| `InMemoryTokenCache` | `src/adapters/auth/strategies/in-memory-token-cache.strategy.ts` | Default in-memory implementation of `AbstractTokenCache` |
| `MemcacheTokenCache` | `src/adapters/auth/strategies/memcache-token-cache.strategy.ts` | Memcache-backed implementation of `AbstractTokenCache` |
| `CouchbaseTokenCache` | `src/adapters/auth/strategies/couchbase-token-cache.strategy.ts` | Couchbase-backed implementation of `AbstractTokenCache` |
| `OAuthIntrospectionStrategy` | `src/adapters/auth/strategies/oauth-introspection.strategy.ts` | Configurable auth call (GET/POST, flexible token passing, dot-path response/metadata mapping, refresh via a separate endpoint) |
| `JwtValidationStrategy` / `OAuthDiscoveryStrategy` | `src/adapters/auth/strategies/jwt-validation.strategy.ts`, `oauth-discovery.strategy.ts` | Local JWT verification (JWKS, or JWKS found by AS metadata discovery) |
| `StaticTokenAuthStrategy` | `src/adapters/auth/strategies/static-token.strategy.ts` | Client-first: forwards the client's token; falls back to the configured static token when none is provided |
| `ExecutionManager` | `src/runtime/execution/execution-manager.ts` | Creates, loads, begins and ends runs of a durable execution (run lock) |
| `ApprovalService` | `src/runtime/execution/approval-service.ts` | Opens an approval for one activity; applies the human's decision exactly once |
| `runInSandbox` | `src/runtime/sandbox/sandbox-core.ts` | Shared base — creates the V8 isolate, calls `setupContext`, runs user code, classifies failures, disposes the isolate |
| `runSpecSearchInSandbox` | `src/runtime/sandbox/spec-search-in-sandbox.ts` | Delegates to `runInSandbox`, injects `spec` |
| `runSkillsSearchInSandbox` | `src/runtime/sandbox/skills-search-in-sandbox.ts` | Delegates to `runInSandbox`, injects the `skills` array |
| `runApiInSandbox` | `src/runtime/sandbox/execute-api-in-sandbox.ts` | Delegates to `runInSandbox`, injects the `api.request()` bridge; drains un-awaited calls |
| `BridgeRequestHandler` | `src/runtime/sandbox/bridge-request-handler.ts` | The host side of `api.request()`: the per-call pipeline behind the bridge |
| `canonicalizeRequestPath` | `src/runtime/sandbox/request-path.ts` | The one spelling of the path that governance, the journal and the connector all use |
| `resolveOperation` | `src/runtime/governance/operation-resolver.ts` | Concrete path → OpenAPI template, `operationId`, path params |
| `ActivityGate` | `src/runtime/execution/activity-gate.ts` | Decides replay / execute / pause / stop for each call; asks governance about new activities |
| `evaluateGovernance` | `src/runtime/governance/rule-evaluator.ts` | Pure function: Governance Rules → ALLOW / DENY / REQUIRE_APPROVAL |
| `CallLog` / `ActivityJournal` | `src/runtime/execution/activity-journal.ts` | The single record of each call's outcome (the durable activity record when governed) |
| `ApiClient` | `src/runtime/api-client/api-client.ts` | Implements `ConnectorAPI`: headers, idempotency, the HTTP call, retries, breaker failures |
| `CircuitBreakerStrategy` | `src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.ts`, `src/spi/resilience/strategies/noop-circuit-breaker.strategy.ts` | Tracks failures per endpoint and opens/closes the circuit |
| `IdempotencyStrategy` | `src/adapters/idempotency/strategies/`, `src/spi/idempotency/strategies/noop-idempotency.strategy.ts` | Returns the stored result for a repeated idempotency key |
| `AuditCollector` | `src/runtime/observability/audit.ts` | Projection of the run's call log: which endpoints were called during a request |
| `ProgressCollector` | `src/runtime/observability/progress.ts` | Projection of the run's call log: per-call status and created ids, returned on failure |
| `writeAuditRecord` / `AuditPipeline` | `src/runtime/observability/audit.ts`, `audit-pipeline.ts` | Delivers the audit record (and execution-state events) to every `AUDIT_SINKS` sink |
| `MetricsRegistry` | `src/runtime/observability/metrics.ts` | Increments counters; logs them as `metrics_flush` every 60 s |

---

## Phase 1 — Startup (runs once, not per request)

**File: `src/index.ts`**
```typescript
const servicesDir = process.env['SERVICES_DIR']
  ? resolve(process.cwd(), process.env['SERVICES_DIR'])
  : resolve(__dirname, '..', 'services')      // <install root>/services, whatever the working directory
const globalConfig = validateGlobalConfig()   // Zod; exits on a bad value
await createMcpGateway(servicesDir, globalConfig)
```

Before that, `src/core/config/config.ts` merges `MCP_CONFIG_FILE` (default
`/etc/harbor-config/config.yaml`, `KEY: value` lines) into the environment when the file exists;
variables already set win.

**File: `src/runtime/server-factory.ts` — `createMcpGateway()`**

The gateway factory runs these steps once at startup:

1. **Scans the services directory** via `src/runtime/registry/filesystem-scanner.ts`. Each
   subdirectory with a spec file (`spec.json`, `spec.yaml`, or `spec.yml`) is a candidate
   service. For each one it reads `config.json` (a service with `"enabled": false` is skipped),
   dereferences the spec, derives the API base URL (`config.api`, else the spec's
   `servers[0].url`), builds the auth strategy (`config.auth` is required), the circuit breaker
   and the idempotency config, and reads `skills/*.md` (a skill file that cannot be parsed is
   skipped on its own). A service that fails any of this is logged
   (`Failed to scan service "<name>" — skipping`) and skipped; the others still load. No service
   left ⇒ exit.

2. **Builds the token cache — once, shared by every service.** Backend type comes from
   `TOKEN_CACHE_TYPE` (`in-memory` default, `memcache`, `couchbase`, or a registered backend).

3. **For each scanned service**, `buildServiceResources()`:

   a. **Stores the spec and skills** — the parsed spec goes into a `SpecStore`, the scanned
      skills into a `SkillStore`. Both support atomic `swap()`.

   b. **Creates auth middleware** — `AuthMiddleware` over the shared token cache and the service's
      own `AuthStrategy`.

   c. **Resolves the idempotency strategy** — the `idempotency` block of the service's
      `config.json`, else the gateway default `IDEMPOTENCY_TYPE` (`noop` unless set). An unknown
      type fails the service.

   d. **Merges sandbox limits** — `config.json` `sandbox` overrides over the `SANDBOX_*` defaults.

   e. **Creates `ApiClient`** — pointed at this service's base URL, with its own circuit breaker
      and idempotency strategy.

   f. **Starts the service refresher** — last, so a service that failed above leaves no timer
      behind. With `serviceRefreshIntervalMs` > 0 it reloads the spec (via the configured loader)
      and the skills together on each tick; a failed spec load keeps both, and ticks never
      overlap.

   g. **Registers the resources** in the `ServiceRegistry`, keyed by the folder name. A service
      whose resources fail to build is logged (`Failed to build service resources — skipping
      service`) and skipped.

4. **Builds the audit pipeline** — one sink per `AUDIT_SINKS` entry (`console` by default) when
   `ENABLE_AUDIT` is on (`true`/`1`, the default); none when it is `false`/`0`.

5. **Builds the Code Mode runtime** — the execution store (`EXECUTION_STORE_TYPE`), execution
   manager, approval service, retention sweeper, `requestState` codec, and the Governance Rules
   from `GOVERNANCE_RULES_SOURCE`. An unreadable source or an invalid rule stops boot; a rules
   directory that does not exist boots with no rules and a WARN (every call is then ungoverned).

6. **Creates the per-request `McpServer` factory** with the five tools wired to the shared
   registry: `discover_services`, `discover_skills`, `get_skill_details`, `search_code`,
   `api_execute`.

7. **Starts the transport.** HTTP: the Streamable HTTP listener on `MCP_HOST:MCP_PORT`
   (`127.0.0.1:3333`). stdio: `MCP_TOKEN` is required and must pass the bearer parser (a JWT, or
   ≥ 32 base64url characters), or the process exits.

8. **Registers `SIGTERM` and `SIGINT` handlers**: close the HTTP listener, then shut down the Code
   Mode runtime (retention sweeper, rule refresher, store), close the audit pipeline, destroy the
   token cache, stop every service refresher and the metrics timers.

---

## Phase 2 — The tool flow

Every HTTP request is independent: `POST /mcp` carries its own `Authorization` header and MCP
`_meta` envelope, and gets its own `McpServer`. There are no MCP sessions.

At the transport, `src/runtime/http/http-gateway.ts` checks only the bearer's **format**: exactly
one `Authorization` header, `Bearer` scheme, a JWT or ≥ 32 base64url characters. Missing, malformed
or duplicated ⇒ HTTP 401 (with `WWW-Authenticate: Bearer resource_metadata=…` when
`HARBOR_RESOURCE_URI` is set). Whether the auth server accepts the token is decided later, by each
tool that calls `validateAuth()`. The body is read up to `MCP_MAX_BODY_BYTES` (4 MiB default);
beyond that ⇒ 413 `PAYLOAD_TOO_LARGE`, and a body that is not JSON ⇒ JSON-RPC `-32700`.

### Tool 1: `discover_services()`

This is the simplest tool. No sandbox, no auth, no network.

**File: `src/tools/discover-services.tool.ts`**

1. AI calls `discover_services()` (no parameters).
2. The handler calls `registry.listServices()`.
3. Returns an array of `{ service, description }` objects — one per registered service.

Example return value:
```json
[
  {
    "service": "tasks",
    "description": "Tasks service — task and project management. Manages tasks, projects, assignees, and priorities."
  },
  {
    "service": "billing",
    "description": "Billing service — invoicing, payments, and financial operations. Manages invoices, payment methods, billing cycles, credits, and subscription plans."
  }
]
```

The AI reads the descriptions and matches them against the user's request to decide which
service to target.

---

### Tool 2: `discover_skills({ service, code })` — optional, recommended

Not every scenario has a matching skill. The AI should check for relevant skills before
proceeding, but can skip directly to `search_code` if none are found.

**File: `src/tools/discover-skills.tool.ts`**

1. AI calls `discover_skills` with `service: "tasks"` and a JavaScript function as `code`.
2. **Service lookup** — via `resolveService()`. An unknown service returns `UNKNOWN_SERVICE`
   (not retryable) listing the available services.
3. **Auth validation** — via `validateAuth()`. Validates the client token against the service's
   auth strategy. If auth fails, returns a structured error immediately.
4. **V8 sandbox** — `runSkillsSearchInSandbox(code, skills, sandboxLimits)`:
   - Delegates to `runInSandbox` with a `setupContext` that injects the `skills` array
   - `skills` is an array of `{ id, filename, title, tags, content }` — one per `.md` file in
     `services/<name>/skills/`; `id` is the filename without `.md`
   - The AI's JavaScript filters/searches this array, within `searchTimeoutMs`
5. Returns whatever the function returns. No network calls from within the sandbox.

If no relevant skills are found, the AI proceeds directly to `search_code` without calling
`get_skill_details`.

---

### Tool 3: `get_skill_details({ service, skill_id })` — optional, follows discover_skills

Only used when `discover_skills` returned a relevant skill. Provides the full business SOP
with workflow steps, required fields, and constraints.

**File: `src/tools/get-skill-details.tool.ts`**

1. AI calls `get_skill_details` with `service` and `skill_id` (from `discover_skills` results).
2. **Service lookup** — via `resolveService()`.
3. **Auth validation** — via `validateAuth()`.
4. **Skill lookup** — `skills.find(s => s.id === skill_id)`; not found ⇒ `UNKNOWN_SKILL`.
5. Returns the full Markdown content of the skill document. No sandbox, no network.

---

### Tool 4: `search_code({ service, code })`

**File: `src/tools/search-code.tool.ts`**

1. AI calls `search_code` with `service: "tasks"` and a JavaScript function as `code`.

2. **Service lookup** — via `resolveService()`.

3. **Auth validation** — via `validateAuth()`.

4. **Spec retrieval** — `svcResources.specStore.getSpec()` returns the fully dereferenced
   OpenAPI spec, then `permissionGuard.filterSpec(spec, tokenPayload)` removes what the token may
   not see (the default guard removes nothing).

5. **V8 sandbox** — `runSpecSearchInSandbox(code, filteredSpec, sandboxLimits)`:
   - Creates a new `ivm.Isolate` with the service's memory limit
   - Deep-copies the spec into the sandbox via `ivm.ExternalCopy`
   - Sets `spec` on the sandbox's global object — this is the ONLY thing available
   - Compiles and runs the AI's JavaScript function within `searchTimeoutMs`
   - Returns the result as JSON
   - Disposes the isolate in `finally`

6. The result is returned to the AI. No circuit breaker, no audit record.

Key security property: the search sandbox has no `api.request()`, no `__makeRequest`, no
network capability whatsoever. It is a read-only computation over a JSON object.

---

### Tool 5: `api_execute({ service, code })`

This is the full pipeline. Every step is described below. The booted gateway always has a Code
Mode runtime, so every `api_execute` is a durable, governed execution. (An embedder that registers
the tool without one gets the legacy path: no execution is created or ended, and calls go out
without the journal or governance.)

**File: `src/tools/execute-api.tool.ts`**

---

#### Step 1 — Service lookup

```typescript
const svcResources = resolveService(registry, service, serviceNames)
```

Retrieves the service's `apiClient`, `authMiddleware`, `circuitBreaker`, `permissionGuard`,
idempotency TTL and `sandboxLimits`. An unknown service returns `UNKNOWN_SERVICE`, not retryable:
the registry is fixed at boot, so the same name fails every time.

---

#### Step 2 — Auth validation

**File: `src/spi/auth/auth-middleware.ts`**

```typescript
const { payload: tokenPayload, invalidate } =
  await svcResources.authMiddleware.validateRequest(authHeader, correlationId)
const userIdHash = hashAuthenticatedPrincipal(tokenPayload, clientToken)
```

Uses the service's own auth strategy:
- **OAuth introspection**: calls the configured auth server endpoint (GET with the token in the
  query string by default; POST with the token in the query, body or header is configurable).
  A response whose `active` is present and not `true` is `TOKEN_INVALID`. The lifetime comes from
  `expires_in` (or its mapped field) or RFC 7662's absolute `exp`. Auth response fields are mapped
  to `TokenPayload` via configurable `responseMapping` and `metadataMapping` dot-paths.
- **JWT validation / OAuth 2.1**: verifies the signature against the issuer's JWKS, `iss`, `aud`
  (required) and a required `exp`; only RS/PS/ES 256–512 and EdDSA are accepted.
- **Static token**: forwards the client's token (from the `Authorization` header); falls back to
  the configured static token only when none is present. No network call, no refresh.

`invalidate` evicts this caller's cache entry; `ApiClient` calls it when a backend answers 401.
The principal hash `userIdHash` is sha256 of `metadata.userId` when that is a non-empty string or
a finite number, else of the raw inbound bearer. It owns the execution.

Token cache and refresh flow (all async to support remote backends):

```
1. tokenCache.get(service, rawToken)
   │
   ├─ Cache HIT  → serve the cached payload now
   │               └─ refresh_token present, strategy has refresh(), and the backend token is
   │                  within tokenRefreshBufferSec (default 300 s) of its own expiry
   │                  (tokenExpiresAt, not the cache entry's expiry)?
   │                    → background refresh: single-flight per token, 30 s cooldown after a failure
   │                      → strategy.refresh() → tokenCache.update()
   │
   └─ Cache MISS → tokenCache.getOrValidate(rawToken, strategy.validate)
                   └─ validate against the auth server, cache the result
                   └─ refreshIfNeededSync() — the same window check, but synchronous: there is no
                      cached payload to serve meanwhile
```

A refresh rotates the **backend** token only. `tokenCache.update()` never extends a live entry:
the caller's own token is validated again when the entry would have expired anyway, so a token
revoked at the auth server stops working then. The refreshed payload keeps the original
`metadata.userId`, so the caller's principal hash, and with it access to their own paused
executions, survives the refresh.

A cache entry lives for `min(expires_in, AUTH_TOKEN_CACHE_TTL_MS)` (default 5 minutes).

**Cache resilience**: if the external cache (Memcache/Couchbase) is down, reads return a miss and
writes are absorbed, each with a `warn` log. The gateway keeps working by hitting the auth server
directly — slower but operational.

**Session expiry**: if the synchronous refresh fails with `TokenExpiredError` while the access
token has itself expired, the middleware throws `SessionExpiredError` (`SESSION_EXPIRED`, not
retryable) with a message asking the user to update their Bearer token. Any other refresh failure
logs a warning and serves the still-valid token.

If auth fails, the tool returns a structured error immediately, as a tool result (HTTP 200); no
execution is created and no sandbox runs.

---

#### Step 3 — Create or resume the execution

**Files: `src/tools/execute-api.tool.ts` (`resolveExecution`), `src/runtime/execution/execution-manager.ts`**

- **A new call** (no `requestState`, no `_meta["harbor/execution-id"]`) creates an execution. Its
  `code` is persisted as the authoritative original.
- **A resume** — an MRTR retry carrying the sealed `requestState` (the SDK verified its HMAC, TTL
  and method binding before the handler ran), or a client that decided over HTTP and sends
  `_meta["harbor/execution-id"]` — loads the execution and checks it belongs to the same principal
  and service (else `EXECUTION_NOT_RESUMABLE`). It then applies the human's answer via
  `ApprovalService.decide()`. A reject ends the execution `DENIED` and a cancel ends it
  `CANCELLED`, before anything runs. The incoming `code` is ignored.
- `ExecutionManager.beginRun()` takes the run lock and moves the execution to `RUNNING`. It is
  refused with `EXECUTION_LOCKED` (retryable) while another run holds the lock, with
  `EXECUTION_NOT_RESUMABLE` when the execution is finished, and with the pause again when its
  approval is still undecided.

The idempotency key base for the run is `mcp-{service}-{executionId}`; the bridge appends each
activity's sequence number.

---

#### Step 4 — V8 sandbox execution

**File: `src/runtime/sandbox/execute-api-in-sandbox.ts` — `runApiInSandbox()`**

Delegates to `runInSandbox()` (shared with the search and skills sandboxes). The `setupContext`
callback does the execute-specific work:

```
runInSandbox() — shared V8 lifecycle
  |
  new ivm.Isolate({ memoryLimit })          ← brand new V8 engine, SANDBOX_MEMORY_MB (64 MB default)
  |
  wall-clock timer (executeTimeoutMs)       ← disposes the isolate when it fires; covers every await
  |
  createContext()                           ← empty global scope (no fetch, no require, nothing)
  |
  setupContext(jail, context, isolate)      ← execute-specific injection:
  |   jail.set('__makeRequest', ...)         ← bridge to outer Node.js: BridgeRequestHandler.handle
  |   isolate.compileScript(bootstrap)       ← defines `api = { request: ... }` inside the sandbox
  |
  compile and run the program               ← the persisted async arrow function; it can only call api.request()
  |
  result returned as a JSON string
  |
  isolate.dispose()                         ← engine destroyed, all memory freed (in finally)
```

Key: no `spec` is injected into the execute sandbox. The AI cannot access the OpenAPI spec here.

A failure is classified by what happened, never by the wording of a message:
- `SANDBOX_TIMEOUT` (retryable) — the wall-clock timer disposed the isolate, or V8's own CPU
  timeout fired.
- `SANDBOX_MEMORY` (not retryable) — the isolate was disposed by `isolated-vm` itself.
- `SANDBOX_SYNTAX` (not retryable) — the program does not compile.
- `SANDBOX_RUNTIME` (not retryable) — anything else the program threw, including a backend error it
  did not catch (e.g. a `timeout of 2000ms exceeded` from a slow backend).

---

#### Step 5 — API call (inside the bridge, outer context)

For each `api.request()` call the AI's code makes:

**File: `src/runtime/sandbox/bridge-request-handler.ts` — `BridgeRequestHandler.handle()`**

```
admit()                                   run already stopped? maxApiCalls? maxConcurrentCalls?
validate + canonicalise                   request-path.ts           ⇒ INVALID_API_REQUEST, nothing sent
resolve(method, path)                     OpenAPI template, operationId, path params
exclusive(…)                              per-run admission lock — one call at a time, in arrival order
  ├─ stop check                           a sibling paused / denied / diverged ⇒ refused with that code
  ├─ ActivityGate.admit                   journal lookup:
  │                                         COMPLETED → replay the recorded response (no call)
  │                                         APPROVED / GET left EXECUTING → execute
  │                                         WAITING_APPROVAL, DENIED, CANCELLED, FAILED,
  │                                         non-GET left EXECUTING → stop
  │                                       new activity → evaluateGovernance → ALLOW | DENY | REQUIRE_APPROVAL
  ├─ permissionGuard.canExecute(template) ⇒ PERMISSION_DENIED
  ├─ circuitBreaker.check(template)       ⇒ CIRCUIT_OPEN
  └─ ActivityGate.begin                   activity journaled EXECUTING — before the call goes out
apiClient.request(apiRequest, ctx)        outside the lock: calls of one run still overlap
journal.recordResponse(…)                 COMPLETED with the response, whatever its HTTP status
circuitBreaker.recordSuccess(template)    any returned status (a 5xx has thrown before this)
```

- **Canonicalisation** happens once. A missing leading slash is added, unreserved escapes are
  decoded (`%6f` → `o`), and a query string in the path moves into `params`. Absolute and
  protocol-relative URLs, backslashes, fragments, empty interior segments, `.`/`..` (literal or
  encoded), segments that decode to `/`, `\` or a control character, malformed percent-encoding,
  and a query key repeated or also given in `params` are all refused. Governance, the journal and
  the wire all see the same path.
- **Replay divergence**: a journaled activity binds method, template and concrete path, and, while
  it is APPROVED, WAITING_APPROVAL or EXECUTING, also query and body. A resumed program that asks
  for something else at that sequence gets `REPLAY_DIVERGED` and nothing runs.
- **A throw from the connector** marks the activity FAILED with an unknown outcome. On a resume
  that activity is never re-sent: the run stops with `ACTIVITY_OUTCOME_UNKNOWN`.

**File: `src/runtime/api-client/api-client.ts` — `request()` / `executeRequest()`**

- `request()` runs `executeRequest()` through the service's idempotency strategy, keyed by
  `ctx.idempotencyKey` = `mcp-{service}-{executionId}-{sequence}` (legacy path:
  `mcp-{service}-{userIdHash12}-{codeHash16}-c{n}`, `n` being the call's arrival index).
- Headers: `Content-Type: application/json` (the program may override it), then the program's
  own headers, then Harbor's, which always win:
  - `Authorization: Bearer <access_token>` — the validated payload's token
  - `X-Request-Source` (`MCP_AGENT_NAME`, default `mcp-agent`), `X-MCP-Tool: api_execute`,
    `X-MCP-Service`, `X-MCP-Version`, `X-MCP-Session-ID` (a per-request id)
  - `X-Idempotency-Key`
  - `X-Correlation-ID` — the execution id (the same on every call of one script, across approval
    resumes); the MCP request id on the legacy path
  - `X-Harbor-Server-ID` — the gateway's stamp (`HARBOR_SERVER_ID`, default `HARBOR_GATEWAY`)
  - `X-Harbor-Client-ID` — the caller's own id, forwarded when the `/mcp` request carried a
    safe one
- **What a program may not set**, in any letter case (its copies are dropped): `Authorization`,
  `X-Request-Source`, `X-MCP-Tool`, `X-MCP-Service`, `X-MCP-Version`, `X-MCP-Session-ID`,
  `X-Idempotency-Key`, `X-Correlation-ID`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `Host`,
  `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`, `Trailer`,
  `Proxy-Authorization`, `Proxy-Connection`, `Cookie`, `Forwarded`, `X-Forwarded-For`/`-Host`/
  `-Proto`/`-Port`/`-Prefix`, `X-Real-IP`, `X-HTTP-Method-Override`, `X-HTTP-Method`,
  `X-Method-Override`, `X-Original-URL`, `X-Rewrite-URL`, `X-Original-Method`. It may still set
  `Accept`, `Content-Type` and its own `X-…` headers.
- The request never leaves the service's base URL (axios `allowAbsoluteUrls: false`).
- Returns `{ data, status, ok: true }` for 2xx/3xx.
- Returns `{ data, status, ok: false }` for 4xx — never retried, never a circuit failure. A 401
  also evicts the caller's token cache entry.
- **Retries**: only `GET`, `PUT` and `DELETE`, on a 5xx or a transport error (timeout, refused
  connection), up to the service's `maxRetries` (default 1), waiting `500·2^n` ms plus up to 500 ms
  of jitter. `POST` and `PATCH` are sent exactly once: a 5xx or timeout may already have taken
  effect, and sending again could create a second order.
- When the call finally fails: `circuitBreaker.recordFailure(ctx.endpoint)` — once per logical
  call, however many attempts — and the error is thrown into the program (`API_ERROR: Upstream API
  returned 503`, or the transport's code, e.g. `ECONNREFUSED: …`).

---

#### Step 6 — Circuit breaker state machine

**File: `src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.ts`**

A service without a `circuitBreaker` block (or with `"type": "noop"`) has the no-op breaker: it
never opens. With `"type": "count-based"`, state is kept per endpoint — the OpenAPI template
(e.g. `/orders/{orderId}`), the same key for `check`, `recordSuccess` and `recordFailure`:

```
CLOSED  ─── failureThreshold failed calls in a row ──→  OPEN
  ↑                                                       │
  │                                          after recoveryTimeMs
  │                                                       ▼
  └──── probe succeeds ──── HALF_OPEN (one probe admitted; others get CIRCUIT_OPEN
                               │      until it reports or recoveryTimeMs passes)
                               └── probe fails → OPEN (timer restarts)
```

`/orders/123` and `/orders/456` share one circuit. A 4xx counts as a success. Each service has its
own breaker instance, so one service's failures don't affect others. `CIRCUIT_OPEN` is retryable,
and the execution ends `INTERRUPTED` (resumable).

---

#### Step 7 — Multiple API calls

Steps 5–6 repeat for every `api.request()` call inside the user's function. Concurrent calls
(`Promise.all`) are admitted one at a time but run in parallel, up to `maxConcurrentCalls`. Once a
call pauses or stops the run, every later call is refused with the code that says why
(`APPROVAL_REQUIRED`, `GOVERNANCE_DENIED`, `REPLAY_DIVERGED`, `EXECUTION_CANCELLED`,
`ACTIVITY_OUTCOME_UNKNOWN`), and the first run-stopping outcome stands.

When the function returns, calls it started without awaiting are still its calls. They get the
rest of `executeTimeoutMs` to finish and be journaled. Whatever is still in flight is then aborted
and journaled FAILED; a connector that ignores the abort is abandoned after 1 s. No call is
accepted after that. A violation the program caught and swallowed (a pause, a denial, an invalid
request) still decides the outcome.

---

#### Step 8 — End of run, audit and metrics

**File: `src/tools/execute-api.tool.ts`**

`ExecutionManager.endRun()` records how the run ended and releases the lock:

| Run ended with | Execution status |
|---|---|
| a result | `COMPLETED` |
| `APPROVAL_REQUIRED` | `WAITING_APPROVAL` |
| `GOVERNANCE_DENIED` | `DENIED` |
| `EXECUTION_CANCELLED` | `CANCELLED` |
| `CIRCUIT_OPEN`, or any other retryable error (`SANDBOX_TIMEOUT`, `SANDBOX_INTERNAL_ERROR`) | `INTERRUPTED` (resumable) |
| anything else (`REPLAY_DIVERGED`, `ACTIVITY_OUTCOME_UNKNOWN`, `SANDBOX_RUNTIME`, limits, `PERMISSION_DENIED`, …) | `FAILED` |

The new state is published to the audit sinks as an `execution` event. Then the audit record:

```typescript
writeAuditRecord({
  auditId: uuidv4(),
  timestamp, service: 'tasks', environment, userIdHash, sessionId, correlationId,
  tool: 'api_execute',
  authStrategy: 'static-token', idempotencyStrategy: 'noop', circuitBreakerStrategy: 'noop',
  codeSubmitted: program,               // the program that ran — the persisted original on a resume
  endpointsAccessed: ['GET /api/v1/tasks'],
  apiCallCount: 1,                       // calls that went out in this run; replayed ones don't count
  durationMs: 312,
  outcome: 'success',
  executionId                            // plus errorType / errorCode on failure
}, logger, globalConfig, auditPipeline)
```

It is delivered to every `AUDIT_SINKS` sink — by default `console`, which logs it as structured
JSON (`"msg":"audit"`) at `info` level on the service's logger. Nothing is written when
`ENABLE_AUDIT=false`. On the error and approval-pause paths the record's `userIdHash` is
`"unknown"` (a known limitation; the execution record carries the real one).
`tool_calls_total` is incremented with the outcome.

---

#### Step 9 — Result returned to AI client

- **Completed:** `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` with
  `_meta` carrying `harbor/execution-id`, `harbor/execution-status: COMPLETED` and the server info.
- **Approval required:** if the client declared the `elicitation` capability, an `input_required`
  result with a form elicitation and the sealed `requestState`; the client retries the same call
  with the human's answer. Otherwise an `APPROVAL_REQUIRED` tool error naming
  `POST /executions/{id}/approvals/{approvalId}`, after which the client resumes with
  `_meta["harbor/execution-id"]`.
- **Anything else:** `{ error, code, retryable }` (plus `progress` when calls were recorded, and
  `executionId`), with the `harbor/*` `_meta` keys.

The MCP SDK sends this back over the Streamable HTTP connection to the AI client.

---

## Terminal log markers

When running the gateway in HTTP mode, every tool call produces labeled log lines.
All logs are structured JSON written to stderr with human-readable level names (`info`,
`warn`, `error`). In non-production environments, each line also includes a `caller` field
with the source file and line number (powered by `pino-caller`).

| Marker | Meaning |
|---|---|
| `[MCP ▶ IN]` | Code/request received from the AI client |
| `[MCP ◀ OUT]` | Response sent back to the AI client |
| `[MCP → API]` | HTTP request sent to the backend API |
| `[MCP ← API]` | HTTP response received from the backend API |

---

## What happens when things go wrong

Transport-level failures are HTTP responses; everything after the transport is a tool result
(`isError: true`, HTTP 200) whose text is `{ error, code, retryable }`.

| What fails | Code | Retryable | How it is handled |
|---|---|---|---|
| `/mcp` body over `MCP_MAX_BODY_BYTES` | `PAYLOAD_TOO_LARGE` | — | HTTP 413, `Connection: close`; nothing parsed |
| No, malformed or duplicated `Authorization` header | `MISSING_TOKEN` / `TOKEN_INVALID` | — | HTTP 401 at the transport with a `reason` (`missing_header`, `duplicate_authorization_header`, `malformed_scheme`, `weak_credentials`, …); no tool runs |
| Unknown service name | `UNKNOWN_SERVICE` | no | Lists the available services |
| Unknown skill id | `UNKNOWN_SKILL` | no | Lists the service's skills |
| Token rejected by the auth strategy | `TOKEN_INVALID` / `TOKEN_EXPIRED` | no | Includes a JWT without `exp`, an unknown `kid`, `alg: none`/`HS*`, and introspection `active: false` |
| Session fully expired | `SESSION_EXPIRED` | no | Access and refresh tokens both exhausted; asks the user to update their token |
| Auth server down | `INTROSPECTION_FAILED` | yes | Context names the failure (HTTP status or error code such as `ECONNREFUSED`), never the auth server's address |
| Other auth failure | `AUTH_FAILED` | per cause | Fallback code for an auth error without its own |
| Proactive refresh fails | — | — | Logs `warn`, continues with the existing (still-valid) token; background refreshes back off for 30 s |
| Token cache down | — | — | Logs `warn` per operation; falls through to the auth server |
| Execution already running | `EXECUTION_LOCKED` | yes | Another run holds the lock |
| Resume of an unknown / finished / someone else's execution | `EXECUTION_NOT_FOUND` / `EXECUTION_NOT_RESUMABLE` | no | Nothing runs; when `beginRun` refuses, `harbor/execution-status` reports the stored status |
| Conflicting answer to an already decided approval | `APPROVAL_ALREADY_DECIDED` | no | Nothing runs; repeating the recorded answer resumes. On a finished execution: `EXECUTION_NOT_RESUMABLE` |
| `accept` without a boolean `approve` | `INVALID_API_REQUEST` | no | The approval stays pending |
| Bad `api.request` argument or path | `INVALID_API_REQUEST` | no | Nothing sent or journaled; still reported if the program swallowed it |
| More than `maxApiCalls` / `maxConcurrentCalls` | `CALL_LIMIT_EXCEEDED` / `CONCURRENT_LIMIT_EXCEEDED` | no | Execution `FAILED` |
| Permission guard refuses | `PERMISSION_DENIED` | no | Execution `FAILED` |
| Governance DENY, or a human rejected | `GOVERNANCE_DENIED` | no | Execution `DENIED`; the call was not made |
| Governance REQUIRE_APPROVAL | `input_required`, or `APPROVAL_REQUIRED` | no | Execution `WAITING_APPROVAL` until a human decides |
| A human cancelled | `EXECUTION_CANCELLED` | no | Execution `CANCELLED` |
| Resumed program asks for a different call | `REPLAY_DIVERGED` | no | Execution `FAILED`; nothing runs, an approved request stays approved |
| Resume meets a FAILED activity, or a non-GET left EXECUTING | `ACTIVITY_OUTCOME_UNKNOWN` | no | Execution `FAILED`; the call is never re-sent |
| Circuit open | `CIRCUIT_OPEN` | yes | Execution `INTERRUPTED`; `circuit_breaker_opens_total` incremented |
| Sandbox wall-clock or CPU timeout | `SANDBOX_TIMEOUT` | yes | Execution `INTERRUPTED` |
| Sandbox memory limit | `SANDBOX_MEMORY` | no | Execution `FAILED` |
| Sandbox syntax error | `SANDBOX_SYNTAX` | no | Execution `FAILED` |
| Program threw (including an uncaught backend error) | `SANDBOX_RUNTIME` | no | Execution `FAILED` |
| Unexpected internal sandbox failure | `SANDBOX_INTERNAL_ERROR` | yes | Sanitised message; the cause is logged server-side |
| Backend API 4xx | — | — | `{ data, status, ok: false }` to the program — not an error, not retried; activity `COMPLETED` |
| Backend API 5xx or transport error | `API_ERROR` (or the transport's code) inside the program | — | GET/PUT/DELETE retried first; POST/PATCH never. Activity `FAILED` (outcome unknown), one breaker failure; the program may catch it, otherwise the run ends `SANDBOX_RUNTIME` |
| Idempotency cache down | — | — | Logs `warn`, executes the call directly |
| Spec refresh fails | — | — | Logs `warn`, keeps the old spec and skills, never throws |

---

## The `search_code` path (abbreviated)

`search_code` goes through:

1. Service lookup via `resolveService()`
2. Auth validation via `validateAuth()`
3. Gets the spec from `svcResources.specStore.getSpec()` and filters it with `permissionGuard.filterSpec()`
4. Runs `runSpecSearchInSandbox` — same isolate pattern but injects `spec` instead of `api`
5. No circuit breaker, no idempotency, no audit record, no API calls
6. Returns the function's return value as JSON to the AI client

---

## Full flow summary

### Minimal flow (simple read — skills skipped)

```
User: "Show me all my tasks"

  Step 0: Client sends POST /mcp with Authorization: Bearer <token>
          → Gateway checks the bearer's format and the body size, then creates a fresh
            McpServer for this request. No, malformed or duplicated bearer ⇒ HTTP 401.

  Step 1: discover_services()
          → [{ service: "tasks", description: "Task and project management..." }]
          MCP client picks "tasks"
          (No auth required — returns the service catalog only)

  Step 2: search_code({ service: "tasks", code: "async () => ..." })
          → Auth: validates the token via the service's auth strategy
          → Injects the service's (permission-filtered) OpenAPI spec into the sandbox
          → Returns: [{ path: "/api/v1/tasks", methods: ["GET","POST","PUT"] }]

  Step 3: api_execute({ service: "tasks", code: "async () => ..." })
          → Auth: validates the token (proactive refresh if near expiry)
          → Creates an execution; runs the program with api.request() routed through the
            bridge (governance, journal) to the service's ApiClient
          → Returns task data to sandbox → to tool → to MCP client (with harbor/execution-id)

  Step 4: MCP client tells user: "Here are your tasks: ..."
```

### Full flow (complex workflow — skills consulted)

```
User: "Create a new task assigned to Alice with high priority"

  Step 0: Client sends POST /mcp with Authorization: Bearer <token>
          → Gateway checks the bearer's format and the body size, then creates a fresh
            McpServer for this request. No, malformed or duplicated bearer ⇒ HTTP 401.

  Step 1: discover_services()
          → [{ service: "tasks", description: "Task and project management..." }]
          MCP client picks "tasks"
          (No auth required — returns the service catalog only)

  Step 2: discover_skills({ service: "tasks", code: "async () => ..." })
          → Auth: validates the token via the service's auth strategy (cached in the token cache)
          → Finds relevant business SOPs (e.g. "manage-tasks")
          → Returns: [{ skill_id: "manage-tasks", title: "Manage Tasks" }]

  Step 3: get_skill_details({ service: "tasks", skill_id: "manage-tasks" })
          → Auth: validates the token via the service's auth strategy
          → Returns full Markdown SOP with business rules, required fields, constraints
          → MCP client learns: budget must be > 0, 5 required fields, specific status transitions

  Step 4: search_code({ service: "tasks", code: "async () => ..." })
          → Auth: validates the token via the service's auth strategy
          → Injects the service's (permission-filtered) OpenAPI spec into the sandbox
          → Returns: [{ path: "/api/v1/tasks", methods: ["GET","POST","PUT"] }]

  Step 5: api_execute({ service: "tasks", code: "async () => ..." })
          → Auth: validates the token (proactive refresh if near expiry)
          → Creates an execution; the POST is canonicalised, governed and journaled EXECUTING
            before it goes out
          → A rule requiring approval pauses the run: input_required (or APPROVAL_REQUIRED);
            the client retries with the human's answer and the original program resumes,
            replaying completed calls instead of re-sending them
          → Creates task following the business rules from the skill
          → Returns created task data to MCP client

  Step 6: MCP client tells user: "Created your task and assigned it to Alice..."
```
