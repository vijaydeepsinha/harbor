# Getting Started

This guide walks you from zero to a running MCP gateway connected to your AI client.

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js 22+ | `node --version` |
| npm 10+ | `npm --version` |
| Native build tools | Xcode CLT on macOS: `xcode-select --install`; `build-essential` on Debian/Ubuntu |

> Native build tools are required by `isolated-vm` (V8 sandbox). The install fails silently without them.

---

## Step 1 — Install

```bash
git clone https://github.com/vdssinha/harbor
cd harbor
npm install
```

Verify everything compiles:

```bash
npm run typecheck    # must exit 0
npm test             # 312 tests — must all pass
```

---

## Step 2 — Run the Demo

The demo ships three local backends and a fully configured gateway. It's the fastest way to see the system working.

```bash
bash examples/demo/start.sh
```

This script:
1. Kills anything on ports 3001–3003 and 3333
2. Starts `product-service` (3001), `order-service` (3002), `task-service` (3003)
3. Starts the MCP gateway on `http://127.0.0.1:3333/mcp`
4. Registers a cleanup trap (Ctrl-C stops everything cleanly)

**Expected startup output:**

```
[demo] product-service started on :3001
[demo] order-service started on :3002
[demo] task-service started on :3003
{"level":"info","msg":"Service registered","service":"product","skills":1}
{"level":"info","msg":"Service registered","service":"order","skills":1}
{"level":"info","msg":"Service registered","service":"tasks","skills":1}
{"level":"info","msg":"MCP gateway ready (Streamable HTTP)","host":"127.0.0.1","port":3333}
```

**Run the smoke test** (61 assertions, requires Python 3.9+):

```bash
python3 tests/demo_e2e.py --start-services
```

---

## Step 3 — Try It from the Terminal

The gateway speaks MCP protocol revision **2026-07-28** over HTTP. Probe with `server/discover`, then call tools.

```bash
# server/discover (connection probe)
curl -si -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: server/discover" \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{
    "_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }
  }}'

# Discover services (bearer + 2026 headers on every request)
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: discover_services" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"discover_services","arguments":{},
    "_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }
  }}'
```

Expected response:
```json
{
  "result": {
    "content": [{
      "type": "text",
      "text": "[{\"service\":\"product\",\"description\":\"...\"},{\"service\":\"order\",...},{\"service\":\"tasks\",...}]"
    }]
  }
}
```

**Search for endpoints:**

```bash
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{
      "name":"search_code",
      "arguments":{
        "service":"tasks",
        "code":"async () => Object.entries(spec.paths).map(([p,m]) => ({ path: p, methods: Object.keys(m) }))"
      }
    }
  }'
```

**Execute an API call:**

```bash
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params":{
      "name":"api_execute",
      "arguments":{
        "service":"tasks",
        "code":"async () => { const { data } = await api.request({ method: \"GET\", path: \"/api/v1/tasks\" }); return data; }"
      }
    }
  }'
```

---

## Step 4 — Connect Your AI Client

### Cursor

Create or update `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (workspace):

```json
{
  "mcpServers": {
    "harbor": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_BEARER_TOKEN>"
      }
    }
  }
}
```

Restart Cursor. The gateway tools appear in the MCP panel.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "harbor": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_BEARER_TOKEN>"
      }
    }
  }
}
```

Restart Claude Desktop.

### stdio mode (Claude Desktop spawns the process)

```json
{
  "mcpServers": {
    "harbor": {
      "command": "node",
      "args": ["/path/to/harbor/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "SERVICES_DIR": "/path/to/harbor/services"
      }
    }
  }
}
```

Build first: `npm run build`

---

## Step 5 — Add Your First Real Service

1. Create `services/my-service/`:

```bash
mkdir -p services/my-service/skills
```

2. Add `spec.yaml` — your OpenAPI 3.x spec (or point `spec.source` at a URL):

```yaml
openapi: "3.0.0"
info:
  title: My Service
  version: "1.0.0"
servers:
  - url: http://my-api.internal:8080
paths:
  /api/v1/items:
    get:
      summary: List items
      responses:
        "200":
          description: OK
```

3. Add `config.json`:

```json
{
  "name": "my-service",
  "description": "My Service — manages items, projects, and assignments.",
  "api": {
    "host": "my-api.internal",
    "port": 8080,
    "requestTimeoutMs": 10000,
    "maxRetries": 2
  },
  "auth": { "type": "static-token", "token": "my-dev-token" },
  "idempotency": { "type": "noop" },
  "circuitBreaker": { "type": "noop" }
}
```

4. Restart the gateway — it auto-discovers the new service:

```bash
npm run dev
```

You should see: `{"level":"info","msg":"Service registered","service":"my-service"}`

Full configuration reference → [`service-onboarding.md`](service-onboarding.md)

---

## Development Workflow

```bash
npm run dev          # gateway in watch mode (tsx, auto-restarts on file changes)
npm test             # run all tests once
npm run test:watch   # re-run tests on save
npm run typecheck    # strict TypeScript check
npm run build        # compile → dist/
```

**Logs:** All gateway output is structured JSON on stderr. In non-production environments each line includes `caller` (file + line number). Key prefixes:

| Marker | Meaning |
|--------|---------|
| `[MCP ▶ IN]` | Code received from AI client |
| `[MCP ◀ OUT]` | Response sent to AI client |
| `[MCP → API]` | HTTP request sent to backend |
| `[MCP ← API]` | HTTP response from backend |

---

## What's Next

| Goal | Guide |
|------|-------|
| Add a service for a real API | [`service-onboarding.md`](service-onboarding.md) |
| Write skills (AI instruction files) | [`skill-authoring.md`](skill-authoring.md) |
| Write a custom adapter (token cache, outbound transport) | [`adapter-guide.md`](adapter-guide.md) |
| Understand the 5 tools and sandbox model | [`tool-layer.md`](tool-layer.md) |
| Trace a request end-to-end | [`request-lifecycle.md`](request-lifecycle.md) |
| Contribute a connector or doc | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Common problems and fixes | [`faq.md`](faq.md) |
