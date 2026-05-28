# Request Lifecycle — End-to-End Trace

> **Orientation:** For the layer diagram, SPI contracts, and system design context, see [`architecture.md`](architecture.md). This document focuses on the runtime call sequence only.

This document traces exactly what happens from the moment a user asks a question to the final
response. It covers all five tools: `discover_services`, `discover_skills`, `get_skill_details`,
`search_code`, and `api_execute`.

---

## The cast of characters

| Class / Function | File | Role |
|---|---|---|
| `createMcpGateway` | `server-factory.ts` | Builds service registry and starts the gateway |
| `ServiceRegistry` | `registry/service-registry.ts` | Maps service names to their resources |
| `registerDiscoverServicesTool` | `tools/discover-services.tool.ts` | Defines what happens when `discover_services()` is called |
| `registerDiscoverSkillsTool` | `tools/discover-skills.tool.ts` | Defines what happens when `discover_skills()` is called |
| `registerGetSkillDetailsTool` | `tools/get-skill-details.tool.ts` | Defines what happens when `get_skill_details()` is called |
| `registerSearchCodeTool` | `tools/search-code.tool.ts` | Defines what happens when `search_code()` is called |
| `registerExecuteApiTool` | `tools/execute-api.tool.ts` | Defines what happens when `api_execute()` is called |
| `AuthMiddleware` | `auth/auth-middleware.ts` | Parses bearer token, validates via auth strategy, cache-first lookup, proactive refresh, session expiry detection |
| `AbstractTokenCache` | `auth/abstract-token-cache.ts` | Base class for all token cache backends — provides hash, TTL, get/validate/update orchestration |
| `InMemoryTokenCache` | `auth/strategies/in-memory-token-cache.strategy.ts` | Default in-memory implementation of `AbstractTokenCache` |
| `MemcacheTokenCache` | `auth/strategies/memcache-token-cache.strategy.ts` | Memcache-backed implementation of `AbstractTokenCache` |
| `CouchbaseTokenCache` | `auth/strategies/couchbase-token-cache.strategy.ts` | Couchbase-backed implementation of `AbstractTokenCache` |
| `OAuthIntrospectionStrategy` | `auth/strategies/oauth-introspection.strategy.ts` | Configurable auth call (GET/POST, flexible token passing, dot-path response/metadata mapping, proactive refresh via separate endpoint) |
| `StaticTokenAuthStrategy` | `auth/strategies/static-token.strategy.ts` | Client-first: uses client's token as primary; falls back to the configured static token when none provided |
| `toolHelpers` | `tools/tool-helpers.ts` | Shared utilities — `mcpError`, `mcpSuccess`, `resolveService`, `validateAuth`, `extractCorrelationId`, `extractSessionId`, `runSandboxTool` |
| `AuditCollector` | `observability/audit.ts` | Collects which endpoints were called during a request |
| `runInSandbox` | `sandbox/sandbox-core.ts` | Shared base — creates V8 isolate, calls `setupContext` to inject data, runs user code, disposes isolate |
| `runSpecSearchInSandbox` | `sandbox/spec-search-in-sandbox.ts` | Delegates to `runInSandbox`, injects `spec` |
| `runSkillsSearchInSandbox` | `sandbox/skills-search-in-sandbox.ts` | Delegates to `runInSandbox`, injects `skills` array |
| `runApiInSandbox` | `sandbox/execute-api-in-sandbox.ts` | Delegates to `runInSandbox`, injects `api.request()` bridge |
| `ApiClient.executeRequest` | `api-client/api-client.ts` | Makes the actual HTTP call to the backend API |
| `CircuitBreakerStrategy` | `resilience/strategies/*.ts` | Tracks failures and opens/closes the circuit |
| `IdempotencyStrategy` | `idempotency/strategies/*.ts` | Caches results to prevent duplicate writes |
| `writeAuditRecord` | `observability/audit.ts` | Writes the final audit log entry |
| `MetricsRegistry` | `observability/metrics.ts` | Increments counters |

---

## Phase 1 — Startup (runs once, not per request)

**File: `index.ts`**
```typescript
const servicesDir = resolve(__dirname, 'services')
const globalConfig = validateGlobalConfig()
await createMcpGateway(servicesDir, globalConfig)
```

**File: `server-factory.ts` — `createMcpGateway()`**

The gateway factory runs these steps once at startup:

1. **Auto-scans the `services/` directory** via `filesystem-scanner.ts`. Each subdirectory with a
   spec file (`spec.json`, `spec.yaml`, or `spec.yml`) becomes a service. Services with
   `"enabled": false` in their `config.json` are skipped. Failed scans log an error and skip
   that directory — other services still load.

2. **Creates the `ServiceRegistry`** — an empty `Map<string, ServiceResources>`.

3. **For each scanned service:**

   a. **Stores the spec and skills** — the parsed spec goes into a `SpecStore`, the scanned
      skills go into a `SkillStore`. Both support atomic `swap()`.

   b. **Starts service refresh scheduler** — `ServiceRefresher.start()` calls `setInterval` with
      the service-level `serviceRefreshIntervalMs`. On each tick it reloads both the spec (via the
      configured loader) and the skills (re-scans `skills/*.md` from disk). If either reload
      fails, it logs a warning and keeps the existing data.

   c. **Builds the global token cache** — one `TokenCacheStrategy` instance shared by all services.
      Backend type is determined by `TOKEN_CACHE_TYPE` env var (`in-memory` | `memcache` | `couchbase`).
      `InMemoryTokenCache` is the default for development; `MemcacheTokenCache` and
      `CouchbaseTokenCache` use shared infrastructure clients from `infra/`.

   d. **Creates auth middleware** — `AuthMiddleware` using the global token cache and the service's own
      `AuthStrategy` (derived from `config.json` or defaults). Supports proactive token refresh
      for tokens near expiry.

   e. **Resolves idempotency strategy** — from the service's `config.json` or the global default.

   f. **Creates `ApiClient`** — pointed at this service's host:port with its own circuit breaker
      and idempotency.

   g. **Registers all resources** into the `ServiceRegistry` keyed by the folder name.

4. **Creates a per-session `McpServer` factory** with five tools wired to the shared registry:
   `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`.
   The client's `Authorization` header is extracted at session creation and stored with the session.

5. **Registers `SIGTERM` handler** to destroy the global token cache and shut down gracefully.

6. **Starts the Streamable HTTP (or stdio) transport.** The gateway now listens for client connections.
   Connections without a valid `Authorization: Bearer` header are rejected at this stage.

---

## Phase 2 — The tool flow

### Tool 1: `discover_services()`

This is the simplest tool. No sandbox, no auth, no network.

**File: `tools/discover-services.tool.ts`**

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

**File: `tools/discover-skills.tool.ts`**

1. AI calls `discover_skills` with `service: "tasks"` and a JavaScript function as `code`.
2. **Service lookup** — via `resolveService()` helper. If the service doesn't exist, returns an error listing available services.
3. **Auth validation** — via `validateAuth()` helper. Validates the client token against the service's auth strategy. If auth fails, returns a structured error immediately.
4. **V8 sandbox** — `runSkillsSearchInSandbox(code, skills, globalConfig)`:
   - Delegates to `runInSandbox` with a `setupContext` that injects the `skills` array
   - `skills` is an array of `{ id, filename, title, content }` — all `.md` files from `services/<name>/skills/`
   - The AI's JavaScript filters/searches this array
5. Returns matching skill IDs and titles. No network calls from within the sandbox.

If no relevant skills are found, the AI proceeds directly to `search_code` without calling
`get_skill_details`.

---

### Tool 3: `get_skill_details({ service, skill_id })` — optional, follows discover_skills

Only used when `discover_skills` returned a relevant skill. Provides the full business SOP
with workflow steps, required fields, and constraints.

**File: `tools/get-skill-details.tool.ts`**

1. AI calls `get_skill_details` with `service` and `skill_id` (from `discover_skills` results).
2. **Service lookup** — via `resolveService()` helper.
3. **Auth validation** — via `validateAuth()` helper. Validates the client token.
4. **Skill lookup** — `skills.find(s => s.id === skill_id)`.
5. Returns the full Markdown content of the skill document. No sandbox, no network.

---

### Tool 4: `search_code({ service, code })`

**File: `tools/search-code.tool.ts`**

1. AI calls `search_code` with `service: "tasks"` and a JavaScript function as `code`.

2. **Service lookup** — via `resolveService()` helper. If the service doesn't exist, returns an
   error listing all available services.

3. **Auth validation** — via `validateAuth()` helper. Validates the client token against the service's auth strategy.

4. **Spec retrieval** — `svcResources.specStore.getSpec()` returns the fully dereferenced
   OpenAPI spec for the requested service.

5. **V8 sandbox** — `runSpecSearchInSandbox(code, spec, globalConfig)`:
   - Creates a new `ivm.Isolate` with memory limit from config
   - Deep-copies the spec into the sandbox via `ivm.ExternalCopy`
   - Sets `spec` on the sandbox's global object — this is the ONLY thing available
   - Compiles and runs the AI's JavaScript function
   - Returns the result as JSON
   - Disposes the isolate in `finally`

6. The result is returned to the AI. No circuit breaker, no audit record.

Key security property: the search sandbox has no `api.request()`, no `__makeRequest`, no
network capability whatsoever. It is a read-only computation over a JSON object.

---

### Tool 5: `api_execute({ service, code })`

This is the full pipeline. Every step is described below.

**File: `tools/execute-api.tool.ts`**

---

#### Step 1 — Service lookup

```typescript
const svcResources = registry.get(service)
```

Retrieves the correct `apiClient`, `authMiddleware`, `circuitBreaker`, etc. for the target
service. If the service doesn't exist, returns an error.

---

#### Step 2 — Auth validation

**File: `auth/auth-middleware.ts`**

```typescript
const tokenPayload = await svcResources.authMiddleware.validateRequest(authHeader, correlationId)
```

Uses the service's own auth strategy (resolved via `resolveService()` and `validateAuth()` tool helpers):
- **OAuth introspection**: Calls the configured auth server endpoint (GET or POST, configurable token passing mode). Caches the result in the global token cache. Supports proactive token refresh — if a cached token is within `tokenRefreshBufferSec` of expiry and the strategy supports `refresh()`, the middleware refreshes it and updates the cache. Auth response fields are mapped to `TokenPayload` via configurable `responseMapping` and `metadataMapping` dot-paths.
- **Static token**: Uses the client's token (from the `Authorization` header) as primary; falls back to the configured static token only when no client token is present. No network call, no refresh capability.

Token cache and refresh flow (all async to support remote backends):

```
1. tokenCache.get(rawToken)
   │
   ├─ Cache HIT  → refreshIfNeeded(payload, expiresAt)
   │               └─ Near expiry? → strategy.refresh() → tokenCache.update()
   │               └─ Not near expiry? → return cached payload
   │
   └─ Cache MISS → tokenCache.getOrValidate(rawToken, strategy.validate)
                   └─ Validate against auth server, cache result
                   └─ refreshIfNeeded() — also runs on fresh validations
                      (covers cache-down scenario where every request is a miss
                       but the token may still need refresh)
```

**Cache resilience**: If the external cache (Memcache/Couchbase) is down, all cache reads
return `undefined` (miss) and writes are silently absorbed. A `warn`-level log is emitted for
each failure. The gateway continues to function by hitting the auth server directly — slower
but operational.

**Session expiry**: If `refreshIfNeeded()` detects that both the access token and refresh token
have expired (typically after ~12 hours), it throws `SessionExpiredError` with a clear user-facing
message. This is surfaced to the AI client as a non-retryable error prompting the user to update
their Bearer token.

If auth fails, the tool returns a structured error immediately — no sandbox runs.

---

#### Step 3 — V8 sandbox execution

**File: `sandbox/execute-api-in-sandbox.ts` — `runApiInSandbox()`**

Delegates to `runInSandbox()` (shared with search and skills sandboxes). The `setupContext`
callback does the execute-specific work:

```
runInSandbox() — shared V8 lifecycle
  |
  new ivm.Isolate({ memoryLimit: 64 })    ← brand new V8 engine, 64 MB limit
  |
  createContext()                          ← empty global scope (no fetch, no require, nothing)
  |
  setupContext(jail, context, isolate)     ← execute-specific injection:
  |   jail.set('__makeRequest', ...)        ← bridge to outer Node.js (auth, CB, API client)
  |   isolate.compileScript(bootstrap)      ← defines `api = { request: ... }` inside sandbox
  |
  compile and run wrappedUserCode          ← user's async arrow function runs; can only call api.request()
  |
  result returned as JSON string           ← sandbox returns result
  |
  isolate.dispose()                        ← engine destroyed, all memory freed (in finally)
```

Key: no `spec` is injected into the execute sandbox. The AI cannot access the OpenAPI spec here.

---

#### Step 4 — API call (inside the bridge, outer context)

For each `api.request()` call the AI's code makes:

**File: `sandbox/execute-api-in-sandbox.ts` — the bridge function**

```typescript
async (configJson: string): Promise<string> => {
  const config = JSON.parse(configJson)
  const normalizedPath = normalizeEndpointPath(config.path)  // /orders/123 → /orders/{id}

  circuitBreaker.check(normalizedPath)          // ← throws CircuitOpenError if OPEN

  const result = await apiClient.executeRequest(config, tokenPayload, ...)

  circuitBreaker.recordSuccess(normalizedPath)  // ← only called on 2xx/3xx
  auditCollector.record(config.method, normalizedPath)

  return JSON.stringify(result)
}
```

**File: `api-client/api-client.ts` — `executeRequest()`**

- Sets headers: `Authorization`, `X-Correlation-ID`, `X-Request-Source: mcp-agent`, `X-MCP-Session-ID`, `X-Idempotency-Key`
- Retries on 5xx with fixed 500ms backoff
- Returns `{ data, status, ok: true }` for 2xx/3xx
- Returns `{ data, status, ok: false }` for 4xx — never retries, never records circuit failure
- Calls `circuitBreaker.recordFailure()` on 5xx and network errors

---

#### Step 5 — Circuit breaker state machine

**File: `resilience/strategies/count-based-circuit-breaker.strategy.ts`**

State per normalised endpoint path (e.g. `/orders/{id}`):

```
CLOSED  ─── 5 consecutive 5xx/network ──→  OPEN
  ↑                                           │
  │                                   after recoveryTimeMs
HALF_OPEN ←───────────────────────────────────┘
  │
  ├── next call succeeds → CLOSED (reset failures)
  └── next call fails    → OPEN   (reset timer)
```

`/orders/123` and `/orders/456` map to the same circuit — `/orders/{id}`.
Each service has its own circuit breaker instance — one service's failures don't affect others.

---

#### Step 6 — Multiple API calls

Steps 3-5 repeat for every `api.request()` call inside the user's function. The sandbox
continues running until the function returns, throws, or times out.

---

#### Step 7 — Audit and metrics

**File: `tools/execute-api.tool.ts`**

When the sandbox function returns:

```typescript
writeAuditRecord({
  auditId: uuidv4(),
  service: 'tasks-service',         // which backend was called
  tool: 'api_execute',
  authStrategy: 'static-token',
  codeSubmitted: code,                    // exact JS the AI submitted
  endpointsAccessed: ['GET /api/v1/tasks'],
  apiCallCount: 1,
  durationMs: 312,
  outcome: 'success'
}, logger, globalConfig)
```

Logged as structured JSON at `info` level. Skipped if `ENABLE_AUDIT=false`.

---

#### Step 8 — Result returned to AI client

The tool handler returns:
```typescript
{
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
}
```

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

| What fails | What is thrown | How it is handled |
|---|---|---|
| Unknown service name | — | Returns `{ error: "Unknown service ...", code: 'UNKNOWN_SERVICE', retryable: true }` |
| Missing auth header | `MissingTokenError` | Returns `{ error, code: 'MISSING_TOKEN', retryable: false }`. Context appended: `[header absent]` or `[malformed Bearer scheme]` |
| Token expired | `TokenExpiredError` | Returns `{ error, code: 'TOKEN_EXPIRED', retryable: false }` |
| Token invalid/revoked | `TokenInvalidError` | Returns `{ error, code: 'TOKEN_INVALID', retryable: false }` |
| Session fully expired | `SessionExpiredError` | Both access + refresh tokens exhausted (~12h). Returns `{ error, code: 'SESSION_EXPIRED', retryable: false }` with a message asking the user to update their token |
| Auth server down | `TokenIntrospectionError` | Returns `{ error, code: 'INTROSPECTION_FAILED', retryable: true }`. Context includes the HTTP status or network error detail |
| Proactive refresh fails | — | Logs `warn`, continues with existing (still-valid) token. No error returned to client unless session is fully expired |
| Token cache down | — | Logs `warn` per operation (read/write/delete). Falls through to auth server for validation. Service stays operational but slower |
| Circuit open | `CircuitOpenError` | Returns `{ error, code: 'CIRCUIT_OPEN', retryable: true }`, increments metric |
| Sandbox timeout | `SandboxTimeoutError` | Returns `{ error, code: 'SANDBOX_TIMEOUT', retryable: true }` |
| Sandbox syntax error | `SandboxSyntaxError` | Returns `{ error, code: 'SANDBOX_SYNTAX', retryable: false }` |
| backend API 4xx | — | Returns `{ data, status, ok: false }` — not an error, not retried |
| backend API 5xx | `ApiError` after retries | Returns `{ error, code: 'API_ERROR', retryable: false }` |
| Idempotency cache down | — | Falls through silently, executes fn() directly |
| Spec refresh fails | — | Logs warn, keeps old spec, never throws |

---

## The `search_code` path (abbreviated)

`search_code` goes through:

1. Service lookup via `resolveService()` tool helper
2. Auth validation via `validateAuth()` tool helper
3. Gets spec from `svcResources.specStore.getSpec()`
4. Creates a `runSpecSearchInSandbox` — same isolate pattern but injects `spec` instead of `api`
5. No circuit breaker, no idempotency, no audit record, no API calls
6. Returns the function's return value as JSON to the AI client

---

## Full flow summary

### Minimal flow (simple read — skills skipped)

```
User: "Show me all my tasks"

  Step 0: Client connects with Authorization: Bearer <token>
          → Gateway extracts and stores token for the session.
            Connection rejected if no token present.

  Step 1: discover_services()
          → [{ service: "tasks", description: "Task and project management..." }]
          MCP client picks "tasks"
          (No auth required — returns the service catalog only)

  Step 2: search_code({ service: "tasks", code: "async () => ..." })
          → Auth: validates token via the service's auth strategy
          → Injects the service's OpenAPI spec into sandbox
          → Returns: [{ path: "/api/v1/tasks", methods: ["GET","POST","PUT"] }]

  Step 3: api_execute({ service: "tasks", code: "async () => ..." })
          → Auth: validates token (proactive refresh if near expiry)
          → Sandbox: runs code with api.request() routed to the service's ApiClient
          → Returns task data to sandbox → to tool → to MCP client

  Step 4: MCP client tells user: "Here are your tasks: ..."
```

### Full flow (complex workflow — skills consulted)

```
User: "Create a new task assigned to Alice with high priority"

  Step 0: Client connects with Authorization: Bearer <token>
          → Gateway extracts and stores token for the session.
            Connection rejected if no token present.

  Step 1: discover_services()
          → [{ service: "tasks", description: "Task and project management..." }]
          MCP client picks "tasks"
          (No auth required — returns the service catalog only)

  Step 2: discover_skills({ service: "tasks", code: "async () => ..." })
          → Auth: validates token via the service's auth strategy (cached in global token cache)
          → Finds relevant business SOPs (e.g. "manage-tasks")
          → Returns: [{ skill_id: "manage-tasks", title: "Manage Tasks" }]

  Step 3: get_skill_details({ service: "tasks", skill_id: "manage-tasks" })
          → Auth: validates token via the service's auth strategy
          → Returns full Markdown SOP with business rules, required fields, constraints
          → MCP client learns: budget must be > 0, 5 required fields, specific status transitions

  Step 4: search_code({ service: "tasks", code: "async () => ..." })
          → Auth: validates token via the service's auth strategy
          → Injects the service's OpenAPI spec into sandbox
          → Returns: [{ path: "/api/v1/tasks", methods: ["GET","POST","PUT"] }]

  Step 5: api_execute({ service: "tasks", code: "async () => ..." })
          → Auth: validates token (proactive refresh if near expiry)
          → Sandbox: runs code with api.request() routed to the service's ApiClient
          → Creates task following the business rules from the skill
          → Returns created task data to MCP client

  Step 6: MCP client tells user: "Created your task and assigned it to Alice..."
```
