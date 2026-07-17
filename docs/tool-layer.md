# Tool Layer

This document covers the MCP protocol implementation, transport options, session lifecycle, the five tools, the V8 sandbox execution model, and the `api.request()` contract.

---

## MCP Protocol

The gateway implements [Model Context Protocol](https://modelcontextprotocol.io) — an open standard for connecting AI clients to tools and data sources. The protocol is JSON-RPC 2.0 over one of two transports.

### Streamable HTTP (default)

The AI client connects via HTTP POST to `http://<host>:<port>/mcp`.

**Headers the client must send on every request:**
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- `Authorization: Bearer <token>` — required on every request
- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <json-rpc-method>` — must match the body's `method` field
- `Mcp-Name: <tool-name>` — required for `tools/call` (must match `params.name`)

**Stateless request flow (2026-07-28):**

Harbor 1.0 serves MCP protocol revision **2026-07-28** only (`legacy: 'reject'`). Each `POST /mcp` request carries a per-request `_meta` envelope and gets a fresh `McpServer` from the SDK v2 `createMcpHandler` entry. The bearer token is validated on every request — no session header is issued or required.

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

The AI client spawns the gateway process and communicates via stdin/stdout.

```bash
# Direct launch
MCP_TRANSPORT=stdio node dist/index.js

# Via claude_desktop_config.json
{
  "command": "node",
  "args": ["/path/to/dist/index.js"],
  "env": { "MCP_TRANSPORT": "stdio" }
}
```

All structured logs go to **stderr**. Stdout is reserved for the MCP protocol stream.

### Per-request lifecycle (HTTP)

Each HTTP request creates a fresh `McpServer` with the client's bearer token bound into the tool handlers. Request-scoped state includes:
- The raw bearer token from the `Authorization` header (via `ctx.authInfo` in the SDK v2 factory)
- A `correlationId` for request tracing (from the MCP request id in `ServerContext`)
- Active sandbox isolates for concurrent calls within that request

When the HTTP response closes, the transport and `McpServer` are torn down.

### Multi-pod deployments

Because HTTP transport is stateless, **any pod can serve any request**. No sticky sessions or session affinity are required. Load balancers can use round-robin freely.

The shared token cache (`TOKEN_CACHE_TYPE=memcache` or `couchbase`) still allows fast auth across pods — validated tokens are cached centrally so each request does not re-hit the auth backend unnecessarily.

---

## The Five Tools

### Tool 1: `discover_services`

**No parameters. No sandbox.**

Harbor validates the `Authorization: Bearer <token>` header on every request — including this one — before any tool logic runs. It checks RFC 6750 format: header presence, Bearer scheme, non-empty token, ≤ 8 KB, no control characters. Malformed or missing tokens receive a 401 immediately. This is Harbor's own protection layer; it does not call any backend auth endpoint.

For `discover_services` specifically, the RFC 6750 check is all that happens. The service catalog is read from the local registry — no introspection call is made. This prevents unauthenticated enumeration of your services while avoiding an unnecessary round-trip to your auth server for a read-only local operation.

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

Runs AI-written code in a V8 sandbox with the service's `skills` array injected. No network access.

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
  title: string    // title from frontmatter or first # heading
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

Direct lookup — no sandbox, no network. Returns full Markdown content.

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

**Response:** Raw Markdown text of the skill file.

---

### Tool 4: `search_code`

**Parameters:** `service` (string), `code` (string — JavaScript function)

Runs AI-written code in a V8 sandbox with the service's OpenAPI `spec` injected. No network access.

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
spec: OpenAPIV3.Document   // fully parsed, dereferenced OpenAPI spec
```

The spec is deep-copied into the sandbox via `ivm.ExternalCopy`. The AI cannot modify the live spec.

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

Every `api.request()` call goes through:
1. Argument validation (method, path required)
2. Permission guard check
3. Circuit breaker check
4. `ConnectorAPI.request()` → idempotency check → outbound HTTP
5. Circuit breaker `recordSuccess` / `recordFailure`
6. Audit collection

---

## V8 Sandbox

The sandbox is the most unusual part of the codebase. It runs untrusted AI-generated code safely in an isolated V8 engine.

### Why V8 isolation?

Normal `eval()` or `new Function()` share the Node.js process context — the AI code could access `process.env`, the filesystem, `require()`, or internal framework objects. `isolated-vm` creates a completely separate V8 engine with its own heap. Nothing leaks across the boundary except what is explicitly injected.

### Execution model

```
Host (Node.js process)
│
├── Creates ivm.Isolate({ memoryLimit: 64 })   ← brand new V8 engine
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
  path:   string                                          // required, non-empty
  params?: Record<string, unknown>   // query string params
  body?:   unknown                   // request body (POST / PUT / PATCH)
  headers?: Record<string, string>   // extra headers merged with default headers
}

// Return value
interface ApiResponse {
  data:   unknown  // parsed response body
  status: number   // HTTP status code
  ok:     boolean  // true for 2xx/3xx; false for 4xx
}
```

**Critical:** `ok: false` for 4xx is NOT an error. The function returns normally. Only 5xx (after retries exhausted) or policy violations throw.

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

### Sandbox limits

Configurable per global env:

| Variable | Default | Applies to |
|----------|---------|-----------|
| `SANDBOX_MEMORY_MB` | `64` | Both search and execute |
| `SANDBOX_EXECUTE_TIMEOUT_MS` | `8000` | `api_execute` only |
| `SANDBOX_SEARCH_TIMEOUT_MS` | `3000` | `search_code` and `discover_skills` |

Per-service overrides via `config.json`:

```json
{
  "sandbox": {
    "memoryLimitMb": 128,
    "executeTimeoutMs": 15000,
    "maxApiCalls": 50,
    "maxConcurrentCalls": 10
  }
}
```

| Limit | What it controls |
|-------|-----------------|
| `memoryLimitMb` | V8 isolate memory; isolate is disposed on OOM |
| `executeTimeoutMs` | Wall-clock timeout; `SandboxTimeoutError` thrown |
| `maxApiCalls` | Total `api.request()` calls per execution |
| `maxConcurrentCalls` | Simultaneous in-flight `api.request()` calls |

### What sandbox code can and cannot do

**Can:**
- Call `api.request()` (execute sandbox only)
- Read `spec` (search sandbox only)
- Read `skills` (discover_skills sandbox only)
- Use standard JavaScript (objects, arrays, async/await, promises)
- Use built-in globals (`JSON`, `Math`, `Date`, `console`)

**Cannot:**
- Access `process`, `require`, `import`, `fetch`, `XMLHttpRequest`
- Access the Node.js event loop, timers, or I/O
- Access other services' specs, skills, or API clients
- Access framework internals or configuration
- Capture references across the V8 boundary

---

## Error Codes

Errors from the sandbox and bridge are returned as structured objects in the tool response:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "retryable": true
}
```

| Code | Retryable | When thrown |
|------|-----------|-------------|
| `SANDBOX_TIMEOUT` | Yes | Code exceeded the time limit |
| `SANDBOX_SYNTAX` | No | JavaScript syntax error in submitted code |
| `SANDBOX_MEMORY` | Yes | Isolate hit memory limit |
| `SANDBOX_EXECUTION` | No | Code threw an uncaught exception |
| `CALL_LIMIT_EXCEEDED` | No | Too many `api.request()` calls |
| `CONCURRENT_LIMIT_EXCEEDED` | No | Too many concurrent `api.request()` calls |
| `INVALID_API_REQUEST` | No | Bad method/path in `api.request()` argument |
| `CIRCUIT_OPEN` | Yes | Circuit breaker open for the endpoint |
| `PERMISSION_DENIED` | No | Token lacks permission for the endpoint |
| `API_ERROR` | No | Backend returned 5xx after retries |

---

## Audit Logging

Every `api_execute` call produces a structured audit record at `info` level:

```json
{
  "level": "info",
  "type": "audit",
  "auditId": "a1b2c3d4-...",
  "service": "tasks",
  "tool": "api_execute",
  "authStrategy": "oauth-introspection",
  "codeSubmitted": "async () => { const { data } = await api.request(...); return data; }",
  "endpointsAccessed": ["GET /api/v1/tasks", "POST /api/v1/tasks"],
  "apiCallCount": 2,
  "durationMs": 312,
  "outcome": "success",
  "correlationId": "abc-123"
}
```

Disable in development: `ENABLE_AUDIT=false`

Audit records are written to stderr as structured JSON and can be forwarded to any log aggregator (ELK, Splunk, CloudWatch, etc.).

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

`MetricsCollector` tracks counters per service:
- Tool call counts by tool name and outcome
- Sandbox error counts by error type
- Circuit breaker open events

The `MetricsCollector` interface is pluggable — implement it to export to Prometheus, StatsD, or any backend.

### Non-production caller info

In non-production environments (`ENVIRONMENT` not set to `prod`), every log line includes a `caller` field:

```json
{ "level":"warn", "caller":"auth-middleware.ts:84", "msg":"Auth validation failed" }
```

Powered by `pino-caller`. Automatically disabled in production.
