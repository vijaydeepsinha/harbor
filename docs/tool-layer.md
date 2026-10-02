# Tool Layer

This document covers the MCP protocol implementation, transport options, the per-request lifecycle, the five tools, the V8 sandbox execution model, and the `api.request()` contract.

---

## MCP Protocol

The gateway implements [Model Context Protocol](https://modelcontextprotocol.io) — an open standard for connecting AI clients to tools and data sources. The protocol is JSON-RPC 2.0 over one of two transports.

### Streamable HTTP (default)

The AI client connects via HTTP POST to `http://<host>:<port>/mcp`.

**Headers the client must send on every request:**
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- `Authorization: Bearer <token>` — required on every request, exactly once. The token must be a JWT or an opaque token of at least 32 base64url characters (≤ 8192 characters, no control characters)
- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <json-rpc-method>` — must match the body's `method` field
- `Mcp-Name: <tool-name>` — required for `tools/call` (must match `params.name`)

**Stateless request flow (2026-07-28):**

Harbor 1.0 serves MCP protocol revision **2026-07-28** only (`legacy: 'reject'`). Each `POST /mcp` request carries a per-request `_meta` envelope and gets a fresh `McpServer` from the SDK v2 `createMcpHandler` entry. No session header is issued or required.

Every request body's `params` must include:

```json
"_meta": {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "...", "version": "..." },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

```
1. POST /mcp   { method: "server/discover", params: { _meta: {...} } }
   → Response includes serverInfo and supportedVersions

2. POST /mcp   { method: "tools/list", params: { _meta: {...} } }         ← optional discovery
   → Returns the 5 tool definitions with input schemas

3. POST /mcp   { method: "tools/call", params: { name: "...", arguments: {...}, _meta: {...} } }
   Mcp-Name: <tool-name>
   → Returns tool result (SSE stream or JSON, depending on Accept)
```

Each step is an independent HTTP request with `Authorization: Bearer <token>`.

**Response format:**

The gateway returns SSE (`text/event-stream`) when the client includes it in `Accept`. Each tool call returns one SSE event:

```
data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}

```

When the client accepts only `application/json`, the response is plain JSON.

### stdio

The AI client spawns the gateway process and communicates via stdin/stdout. There is no `Authorization` header on stdio: every tool call presents `MCP_TOKEN` as its bearer, so it is **required**. Boot exits when it is unset, or when it would fail the bearer format check above (a JWT, or ≥ 32 base64url characters) — see `src/runtime/server-factory.ts`.

```bash
# Direct launch
MCP_TRANSPORT=stdio MCP_TOKEN=<token> node dist/index.js

# Via claude_desktop_config.json
{
  "command": "node",
  "args": ["/path/to/dist/index.js"],
  "env": { "MCP_TRANSPORT": "stdio", "MCP_TOKEN": "<token>" }
}
```

All structured logs go to **stderr**. Stdout is reserved for the MCP protocol stream.

### Per-request lifecycle (HTTP)

Nothing is kept between requests. For each `POST /mcp` (`src/runtime/http/http-gateway.ts`):

1. **Bearer format.** The `Authorization` header is parsed (`src/spi/auth/bearer-authorization.ts`): missing, duplicated, malformed, too long, or too weak ⇒ HTTP 401 (`MISSING_TOKEN` or `TOKEN_INVALID`, with a machine-readable `reason`, plus `WWW-Authenticate: Bearer resource_metadata="…"` when `HARBOR_RESOURCE_URI` is set). This checks the format only — it does not ask the auth server whether the token is valid.
2. **Bounded body.** Harbor reads the body itself, up to `MCP_MAX_BODY_BYTES` (default 4 MiB). A larger declared or streamed body ⇒ HTTP 413 `PAYLOAD_TOO_LARGE` with `Connection: close`; a body that is not JSON ⇒ HTTP 400 with JSON-RPC error `-32700`.
3. **Fresh server.** The SDK calls the factory in `src/runtime/http/mcp-server-factory.ts`, which builds a new `McpServer` with the five tools registered and the request's bearer (`ctx.authInfo.token`) bound into their handlers.
4. **Token validation per tool.** Every tool except `discover_services` validates the bearer against the named service's auth strategy (token cache, then introspection / JWT verification). An invalid or expired token is a tool error (`isError`, `TOKEN_INVALID` / `TOKEN_EXPIRED`) inside an HTTP 200 response, not a 401 — see [`mcp-2026-07-28-compatibility.md`](mcp-2026-07-28-compatibility.md).

Request-scoped state:
- The raw bearer token (via `ctx.authInfo` in the SDK v2 factory)
- A `correlationId` for Harbor's own logs (the MCP request id); backend calls carry the execution id as `X-Correlation-ID` instead, so every call of one script correlates across approval resumes
- The caller's optional `X-Harbor-Client-ID` request header, forwarded to backend calls when it is a safe header value
- The sandbox isolates of the tool calls running in that request

When the HTTP response closes, the transport and `McpServer` are torn down.

### Multi-pod deployments

Because HTTP transport is stateless, **any pod can serve any request**. No sticky sessions or session affinity are required. Load balancers can use round-robin freely.

The shared token cache (`TOKEN_CACHE_TYPE=memcache` or `couchbase`) still allows fast auth across pods — validated tokens are cached centrally so each request does not re-hit the auth backend unnecessarily.

Code Mode executions are the exception: a paused `api_execute` run lives in the execution store. With `EXECUTION_STORE_TYPE=memcache` (and the same `GOVERNANCE_REQUEST_STATE_KEY` on every pod) any pod can resume it; with the default `in-memory` or `file` store only the pod that paused it can.

---

## The Five Tools

### Tool 1: `discover_services`

**No parameters. No sandbox.**

Over HTTP the bearer format check above runs on every request, including this one. For `discover_services` it is all that happens: the catalog is read from the local registry, and the token is never validated against any auth server. Any well-formed bearer can list the services (and `GET /health` lists their names without one) — an open item recorded in [`mcp-2026-07-28-compatibility.md`](mcp-2026-07-28-compatibility.md).

```json
{
  "name": "discover_services",
  "description": "List all registered backend services and their descriptions.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

**Response:**
```json
[
  { "service": "tasks",   "description": "Task management service — manages tasks..." },
  { "service": "product", "description": "Product catalog — browsing, search..." }
]
```

The AI reads descriptions and maps the user's intent to the right service.

---

### Tool 2: `discover_skills`

**Parameters:** `service` (string), `code` (string — JavaScript function)

Validates the bearer against the service's auth strategy, then runs AI-written code in a V8 sandbox with the service's `skills` array injected. The sandbox has no network access.

```json
{
  "name": "discover_skills",
  "inputSchema": {
    "type": "object",
    "required": ["service", "code"],
    "properties": {
      "service": { "type": "string" },
      "code": { "type": "string", "description": "async () => { ... }" }
    }
  }
}
```

**What's injected into the sandbox:**

```typescript
skills: Array<{
  id: string       // filename without extension — used as skill_id in get_skill_details
  filename: string // full filename
  title: string    // frontmatter title, else first # heading, else the filename
  tags: string[]   // tags array from frontmatter (empty array if none)
  content: string  // full markdown text including frontmatter
}>
```

**Example code:**
```javascript
async () => {
  return skills
    .filter(s => s.content.toLowerCase().includes('task'))
    .map(s => ({ skill_id: s.id, title: s.title }))
}
```

---

### Tool 3: `get_skill_details`

**Parameters:** `service` (string), `skill_id` (string)

Direct lookup — no sandbox, no backend call. The bearer is validated against the service's auth strategy first (which may reach the auth server on a token-cache miss). An unknown `skill_id` returns `UNKNOWN_SKILL` with the available ids.

```json
{
  "name": "get_skill_details",
  "inputSchema": {
    "type": "object",
    "required": ["service", "skill_id"],
    "properties": {
      "service":  { "type": "string" },
      "skill_id": { "type": "string" }
    }
  }
}
```

**Response:** Raw Markdown text of the skill file, frontmatter included.

---

### Tool 4: `search_code`

**Parameters:** `service` (string), `code` (string — JavaScript function)

Validates the bearer, then runs AI-written code in a V8 sandbox with the service's OpenAPI `spec` injected. The sandbox has no network access.

```json
{
  "name": "search_code",
  "inputSchema": {
    "type": "object",
    "required": ["service", "code"],
    "properties": {
      "service": { "type": "string" },
      "code":    { "type": "string" }
    }
  }
}
```

**What's injected:**

```typescript
spec: OpenAPIV3.Document   // parsed, dereferenced OpenAPI spec, after the permission guard's filterSpec
```

The spec first passes through the service's `PermissionGuard.filterSpec` (the default `forward-token` guard returns it unchanged), then is deep-copied into the sandbox via `ivm.ExternalCopy`. The AI cannot modify the live spec.

**Example code:**
```javascript
async () => {
  return Object.entries(spec.paths)
    .filter(([path]) => path.includes('task'))
    .map(([path, methods]) => ({
      path,
      methods: Object.keys(methods).filter(m => m !== 'parameters')
    }))
}
```

**Security property:** The search sandbox has no `api.request()`, no network capability. It is a read-only computation over a JSON object.

---

### Tool 5: `api_execute`

**Parameters:** `service` (string), `code` (string — JavaScript function)

Runs AI-written code in a V8 sandbox with `api.request()` injected. `api.request()` is the only outbound surface.

```json
{
  "name": "api_execute",
  "inputSchema": {
    "type": "object",
    "required": ["service", "code"],
    "properties": {
      "service": { "type": "string" },
      "code":    { "type": "string" }
    }
  }
}
```

**Per tool call** (`src/tools/execute-api.tool.ts`): resolve the service → validate the bearer → create a durable execution, or resume one (an MCP retry carrying `requestState`, or `_meta["harbor/execution-id"]`) → take the execution's run lock → run the program — the persisted original on a resume — in a fresh isolate → wait for the calls it started to finish → record the run's outcome → return the result, an `input_required` approval request, or an error. Once the execution exists, every result carries `harbor/execution-id` and `harbor/execution-status` in `_meta`.

**Per `api.request()` call** (`src/runtime/sandbox/bridge-request-handler.ts`), in this order:

1. **Limits.** Refused if the run has already stopped (paused, denied, diverged, cancelled, outcome unknown — the refusal carries that code), if it would exceed `maxApiCalls`, or if `maxConcurrentCalls` are already in flight.
2. **Validate and canonicalise.** `method` must be one of GET, POST, PUT, PATCH, DELETE; `path` a non-empty string; `params` an object. The path is canonicalised once (`src/runtime/sandbox/request-path.ts`): URLs, `//`, `.`/`..` segments, backslashes, fragments, encoded `/` or control characters, malformed escapes and repeated query keys are refused; a query string in the path moves into `params`. Governance, the journal and the connector all see this one spelling. Any refusal is `INVALID_API_REQUEST` — nothing is sent or journaled.
3. **Resolve.** The endpoint identity is the OpenAPI template the path matches (`src/runtime/governance/operation-resolver.ts`); a path the spec does not have falls back to the digit-collapsing heuristic.
4. **Admit — one call at a time per run.** Concurrent calls (`Promise.all`) are admitted in arrival order under the run's admission lock; their HTTP calls still overlap. Inside it: the stop check again → `ActivityGate.admit` (`src/runtime/execution/activity-gate.ts`) looks the call up in the journal (a completed activity is **replayed** from its stored response with no external call; one waiting, denied, cancelled or failed stops the run) and asks governance about a new activity (ALLOW / DENY / REQUIRE_APPROVAL) → the permission guard → the circuit breaker check → the activity is journaled `EXECUTING`.
5. **Execute.** `ConnectorAPI.request()` → idempotency strategy → outbound HTTP (`src/runtime/api-client/api-client.ts`).
6. **Record.** The response (any status) is journaled `COMPLETED`, then `circuitBreaker.recordSuccess`. A thrown error journals the activity `FAILED` with an unknown outcome and reaches the program as a bridge error.

Limit, permission, invalid-request, circuit-open and run-stopping violations are promoted to the tool's error after the isolate settles, even if the program caught the bridge error. Calls the program started without awaiting get the rest of the run's time budget and are then aborted; after the program returns, no new call is accepted.

With no Code Mode runtime wired (an embedding without an execution store), step 4 is only the permission guard and circuit breaker, and nothing is journaled. The gateway always wires one.

---

## V8 Sandbox

The sandbox is the most unusual part of the codebase. It runs untrusted AI-generated code safely in an isolated V8 engine.

### Why V8 isolation?

Normal `eval()` or `new Function()` share the Node.js process context — the AI code could access `process.env`, the filesystem, `require()`, or internal framework objects. `isolated-vm` creates a completely separate V8 engine with its own heap. Nothing leaks across the boundary except what is explicitly injected.

### Execution model

```
Host (Node.js process)
│
├── Creates ivm.Isolate({ memoryLimit })        ← brand new V8 engine (SANDBOX_MEMORY_MB, default 64)
│
├── Creates context (empty global)              ← no fetch, no require, nothing
│
├── Injects one thing via the bridge:
│     search_code:     spec (ExternalCopy)
│     discover_skills: skills (ExternalCopy)
│     api_execute:     __makeRequest (Reference to host function)
│                      + bootstrap script defining api.request()
│
├── Compiles + runs user code                   ← runs in isolate
│
├── Result returned as JSON string across boundary
│
└── isolate.dispose()                           ← engine destroyed, all memory freed
```

### The `api.request()` bridge

For `api_execute`, the sandbox exposes exactly one function:

```javascript
// Inside the sandbox (injected by bootstrap script):
const api = {
  request: async (apiRequest) => {
    const raw = await __makeRequest.apply(
      undefined,
      [JSON.stringify(apiRequest)],
      { arguments: { copy: true }, result: { promise: true, copy: true } }
    )
    const parsed = JSON.parse(raw)
    if (parsed.__bridgeError) {
      throw new Error(parsed.code + ': ' + parsed.message)
    }
    return parsed
  }
}
```

`__makeRequest` is a `ivm.Reference` to a host-side async function. Arguments cross the V8 boundary as JSON strings — no object references leak between contexts.

### `api.request()` contract

```typescript
// Arguments
interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'  // required
  path:   string                                          // required, non-empty, a path on the service (never a URL)
  params?: Record<string, unknown>   // query string params
  body?:   unknown                   // request body (POST / PUT / PATCH)
  headers?: Record<string, string>   // extra headers — see below
}

// Return value
interface ApiResponse {
  data:   unknown  // parsed response body
  status: number   // HTTP status code
  ok:     boolean  // true for 2xx/3xx; false for 4xx
}
```

**Critical:** `ok: false` for 4xx is NOT an error. The function returns normally (a 401 also evicts the caller's cached token). What throws:
- a 5xx or a transport error (timeout, connection failure). GET, PUT and DELETE are retried first, up to the service's `api.maxRetries` (default 1) with backoff `500·2^n ms` + jitter; POST and PATCH are sent once and never retried, since the first attempt may have taken effect. The activity is journaled `FAILED` (outcome unknown), so a resume stops with `ACTIVITY_OUTCOME_UNKNOWN` rather than repeat it;
- a policy or limit refusal (governance, permission, circuit breaker, call limits, invalid request).

A bridge error the program does not catch ends the run as `SANDBOX_RUNTIME`.

```javascript
// Correct pattern
const { data, status, ok } = await api.request({ method: 'GET', path: '/items' })
if (!ok) {
  return { error: `API returned ${status}`, data }
}
return data

// Common mistake — body does not exist
const { body } = await api.request(...)   // undefined!
```

**Headers.** A program may add its own headers (`Accept`, `Content-Type`, custom `X-…`), but the following are dropped in any letter case, and Harbor's own headers are applied after the program's:

- Harbor's own: `Authorization`, `X-Request-Source`, `X-MCP-Tool`, `X-MCP-Service`, `X-MCP-Version`, `X-MCP-Session-ID`, `X-Idempotency-Key`, `X-Correlation-ID`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`;
- routing and framing: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`, `Trailer`, `Proxy-Authorization`, `Proxy-Connection`, `Cookie`, `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`, `X-Forwarded-Prefix`, `X-Real-IP`, `X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Original-URL`, `X-Rewrite-URL`, `X-Original-Method`.

The list is `PROGRAM_FORBIDDEN_HEADERS` in `src/runtime/api-client/api-client.ts`.

### Sandbox limits

Configurable per global env:

| Variable | Default | Applies to |
|----------|---------|-----------|
| `SANDBOX_MEMORY_MB` | `64` | All three sandboxes |
| `SANDBOX_EXECUTE_TIMEOUT_MS` | `8000` | `api_execute` only |
| `SANDBOX_SEARCH_TIMEOUT_MS` | `3000` | `search_code` and `discover_skills` |
| `SANDBOX_MAX_API_CALLS` | `50` | `api.request()` calls per `api_execute` run |
| `SANDBOX_MAX_CONCURRENT_CALLS` | `5` | Simultaneous in-flight `api.request()` calls |

Per-service overrides via `config.json` (any subset; unset fields keep the global value):

```json
{
  "sandbox": {
    "memoryLimitMb": 128,
    "executeTimeoutMs": 15000,
    "searchTimeoutMs": 5000,
    "maxApiCalls": 50,
    "maxConcurrentCalls": 10
  }
}
```

| Limit | What it controls |
|-------|-----------------|
| `memoryLimitMb` | V8 isolate memory; exceeding it ⇒ `SANDBOX_MEMORY` |
| `executeTimeoutMs` | Wall-clock budget of an `api_execute` run, CPU and awaits alike; the isolate is disposed ⇒ `SANDBOX_TIMEOUT` |
| `searchTimeoutMs` | The same for `search_code` and `discover_skills` |
| `maxApiCalls` | Total `api.request()` calls per run ⇒ `CALL_LIMIT_EXCEEDED` |
| `maxConcurrentCalls` | Simultaneous in-flight `api.request()` calls ⇒ `CONCURRENT_LIMIT_EXCEEDED` |

### What sandbox code can and cannot do

**Can:**
- Call `api.request()` (execute sandbox only)
- Read `spec` (search sandbox only)
- Read `skills` (discover_skills sandbox only)
- Use standard JavaScript (objects, arrays, async/await, promises)
- Use the ECMAScript built-ins (`JSON`, `Math`, `Date`, …)

**Cannot:**
- Access `process`, `require`, `import`, `fetch`, `XMLHttpRequest`
- Access the Node.js event loop, timers, or I/O
- Access other services' specs, skills, or API clients
- Access framework internals or configuration
- Capture references across the V8 boundary

---

## Error Codes

Tool errors are returned as structured objects in the tool response (`isError: true`); `api_execute` errors may add `progress` and `executionId`:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "retryable": true
}
```

| Code | Retryable | When |
|------|-----------|------|
| `UNKNOWN_SERVICE` | No | `service` names no registered service |
| `UNKNOWN_SKILL` | No | `get_skill_details`: no skill with that `skill_id` |
| `MISSING_TOKEN` | No | No bearer (over HTTP this is a 401 before any tool runs) |
| `TOKEN_INVALID` | No | The auth strategy rejected the token (inactive, bad signature or claims, wrong audience, unverifiable) |
| `TOKEN_EXPIRED` | No | The token has expired |
| `SESSION_EXPIRED` | No | Both the access token and its refresh token are exhausted |
| `INTROSPECTION_FAILED` | Yes | The auth server is unreachable or answered 5xx |
| `AUTH_FAILED` | Per cause | An auth failure that carries no code of its own |
| `SANDBOX_SYNTAX` | No | JavaScript syntax error in submitted code |
| `SANDBOX_TIMEOUT` | Yes | The run exceeded its wall-clock budget |
| `SANDBOX_MEMORY` | No | The isolate hit its memory limit |
| `SANDBOX_RUNTIME` | No | The code threw an uncaught exception — including an `api.request()` error it did not catch (`API_ERROR`, a backend timeout) |
| `SANDBOX_INTERNAL_ERROR` | Yes | Unexpected host-side failure (details logged, not returned) |
| `CALL_LIMIT_EXCEEDED` | No | Too many `api.request()` calls |
| `CONCURRENT_LIMIT_EXCEEDED` | No | Too many concurrent `api.request()` calls |
| `INVALID_API_REQUEST` | No | Bad `api.request()` argument, or a path refused by canonicalisation |
| `CIRCUIT_OPEN` | Yes | Circuit breaker open for the endpoint |
| `PERMISSION_DENIED` | No | The permission guard refused the endpoint |

`API_ERROR` (a 5xx or transport failure after retries) is what the *program* sees from `api.request()`; it never reaches the client as a top-level code. The governance codes are listed under [Code Mode governance](#code-mode-governance-durable-executions-approvals). A retryable error leaves the execution `INTERRUPTED` (resumable); a non-retryable one ends it `FAILED`.

---

## Audit Logging

Every `api_execute` call produces one audit record (`AuditRecord`, `src/core/types/audit.types.ts`). With the default `console` sink it is one structured `info` line on the service's logger:

```json
{
  "level": "info",
  "time": "2026-09-27T10:15:02.114Z",
  "service": "tasks",
  "environment": "dev",
  "auditId": "a1b2c3d4-...",
  "timestamp": "2026-09-27T10:15:02.114Z",
  "userIdHash": "3f9a...",
  "sessionId": "5d1e...",
  "correlationId": "7",
  "tool": "api_execute",
  "authStrategy": "oauth-introspection",
  "idempotencyStrategy": "noop",
  "circuitBreakerStrategy": "count-based",
  "codeSubmitted": "async () => { const { data } = await api.request(...); return data; }",
  "endpointsAccessed": ["GET /api/v1/tasks", "POST /api/v1/tasks"],
  "apiCallCount": 2,
  "durationMs": 312,
  "outcome": "success",
  "executionId": "0b6c2f4e-...",
  "msg": "audit"
}
```

- `endpointsAccessed` / `apiCallCount` count the calls that went out in this run; replayed activities are not counted.
- `codeSubmitted` is the program that ran — the persisted original on a resume.
- Failed calls add `errorType` and `errorCode`; `outcome` is one of `success`, `error`, `circuit_open`, `permission_denied`, `call_limit_exceeded`, `concurrent_limit_exceeded`, `approval_required`, `governance_denied`, `replay_diverged`, `execution_cancelled`. Error-path records carry `userIdHash: "unknown"` (a known limitation).

`ENABLE_AUDIT` accepts `true`, `false`, `1` or `0` (default `true`; any other value stops boot). `false` or `0` turns off every audit record and execution-state event.

Records go to every sink listed in `AUDIT_SINKS` (default `console`: the line above, written to stderr as structured JSON for any log aggregator — ELK, Splunk, CloudWatch, etc.). With audit on, an empty `AUDIT_SINKS` or an unknown sink name stops boot. Each execution state change is published too (`execution-state`: statuses, approvals, decisions; no request or response bodies). Other destinations — S3, a SIEM — plug in with `registerAuditSinkBackend` (see `src/spi/observability/audit-sink.ts`).

---

## Observability

### Log markers

| Marker | Meaning |
|--------|---------|
| `[MCP ▶ IN]` | Code/request received from AI |
| `[MCP ◀ OUT]` | Response sent to AI |
| `[MCP → API]` | Outbound request to backend |
| `[MCP ← API]` | Response from backend |

### Metrics

`MetricsRegistry` (`src/runtime/observability/metrics.ts`) keeps in-process counters — one registry per service plus one for the gateway:
- Tool call counts by tool and outcome (`tool_calls_total`; a `service` argument naming no registered service is counted as `service="unknown"`, never under the caller's string)
- Sandbox error counts by error type (`sandbox_errors_total`)
- Circuit breaker open events (`circuit_breaker_opens_total`)
- Token cache hits/misses and refresh attempts (`auth_cache_total`, `auth_refresh_*`)

Counters are flushed as one `metrics_flush` log line every 60 s and on shutdown. They are not pluggable: the gateway constructs `MetricsRegistry` directly and there is no hook to substitute an exporter (Prometheus, StatsD) without changing the code.

### Non-production caller info

In non-production environments (`ENVIRONMENT` not set to `prod`), every log line includes a `caller` field when the optional `pino-caller` dev dependency is installed:

```json
{ "level":"warn", "caller":"auth-middleware.ts:84", "msg":"Auth validation failed" }
```

Automatically disabled in production.

## Code Mode governance (durable executions, approvals)

`api_execute` runs under the Code Mode governance layer when the gateway is
started with an execution store (always, since `EXECUTION_STORE_TYPE` defaults
to `in-memory`):

- every call creates a **durable execution** (`_meta["harbor/execution-id"]`
  on the result) whose original program is persisted;
- every `api.request()` is a journaled **activity**; on resume, completed
  activities are replayed from their stored responses and never re-executed;
- **Governance Rules** (`governance/rules/`) decide `ALLOW` / `DENY` /
  `REQUIRE_APPROVAL` per activity before the external call;
- `REQUIRE_APPROVAL` returns an MCP 2026-07-28 `input_required` result with a
  form elicitation and a sealed `requestState` when the client advertises
  `elicitation`; the client retries the same call with `inputResponses` after
  the human decides, and Harbor resumes the program in a fresh isolate. Clients
  without elicitation get `APPROVAL_REQUIRED`, decide over
  `POST /executions/{id}/approvals/{approvalId}`, then call `api_execute`
  again with `_meta["harbor/execution-id"]`.

Additional error codes:

| Code | Retryable | When |
|------|-----------|------|
| `APPROVAL_REQUIRED` | No | Paused for a human decision (clients without elicitation) |
| `GOVERNANCE_DENIED` | No | A rule denied the activity, or the human rejected it |
| `REPLAY_DIVERGED` | No | On resume the program issued a different request at a journaled position |
| `EXECUTION_LOCKED` | Yes | Another run of the execution is in progress |
| `EXECUTION_NOT_FOUND` | No | Unknown execution id |
| `EXECUTION_NOT_RESUMABLE` | No | Finished, owned by another principal, or bound to another service |
| `EXECUTION_CANCELLED` | No | The human cancelled the approval |
| `ACTIVITY_OUTCOME_UNKNOWN` | No | A previous run's call to this activity failed or was cut off; Harbor will not repeat it |
| `APPROVAL_NOT_FOUND` | No | Unknown approval, or one of another execution |
| `APPROVAL_ALREADY_DECIDED` | No | A different answer was already recorded |

### `/executions` (HTTP)

`GET /executions/{id}` returns the execution, its activities, approvals, decisions and history; `POST /executions/{id}/approvals/{approvalId}` takes `{ "action": "accept" | "decline" | "cancel", "approve"?: boolean | word, "comment"?: string }` (`accept` needs `approve: true` — or `yes`, `sure`, `proceed`, `approve`, `approved` — to approve; `approve: false`, or `no`, `reject`, `rejected`, `deny`, `denied`, `decline`, `declined`, rejects) and returns `{ approval, outcome, executionStatus }`. Both validate the bearer against the execution's service and require the execution's owner (`src/runtime/http/execution-routes.ts`):

| Status | Code | When |
|--------|------|------|
| 401 | `MISSING_TOKEN` / `TOKEN_INVALID` / `TOKEN_EXPIRED` | Missing, malformed or rejected bearer |
| 403 | `AUTH_FAILED` | A valid bearer of another principal |
| 503 | `INTROSPECTION_FAILED` | The auth service is unreachable |
| 400 | `INVALID_API_REQUEST` / `EXECUTION_NOT_RESUMABLE` | Body not a JSON object, bad `action`, `accept` whose `approve` is missing or not a recognised answer; an approval that can no longer be decided |
| 404 | `EXECUTION_NOT_FOUND` / `APPROVAL_NOT_FOUND` | Unknown execution; unknown approval, or one belonging to another execution |
| 409 | `EXECUTION_LOCKED` / `APPROVAL_ALREADY_DECIDED` | The execution is running or another decision holds its lock; already decided |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KiB |

The principal is `sha256(metadata.userId)` when the auth strategy maps a scalar `userId`, else `sha256` of the raw bearer. The approver is the requester's own principal; there is no separate approver role.

Full description: [`code-mode-governance.md`](code-mode-governance.md).
