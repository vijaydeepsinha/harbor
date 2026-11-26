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
git clone https://github.com/vijaydeepsinha/harbor
cd harbor
npm install
```

Verify everything compiles:

```bash
npm run typecheck    # must exit 0
npm test             # 838 passing, 1 skipped — none may fail
```

---

## Step 2 — Run the Demo

The demo ships three local backends and a fully configured gateway. It's the
fastest way to see the system working.

Start everything:

```bash
bash examples/demo/start.sh
```

This script:
1. Kills anything on ports 3001–3003 (the backend ports)
2. Starts `product-service` (3001), `order-service` (3002) and `task-service` (3003)
3. Starts the MCP gateway (`npm run dev`) on `http://127.0.0.1:3333/mcp`
4. Registers a cleanup trap (Ctrl-C stops everything cleanly)

**Expected startup output** (abridged — the gateway's JSON log lines go to stderr and interleave with the script's):

```
=== MCP Demo: Product + Order + Task services ===

Starting product-service on :3001 ...
Starting order-service on :3002 ...
Starting task-service on :3003 ...
Starting Harbor on :3333 ...
  Bearer token for client: configure a JWT or a >=32-char opaque token in your MCP client

=== All services running ===
…
{"level":"info",…,"service":"order","skills":1,"msg":"Service registered"}
{"level":"info",…,"service":"product","skills":1,"msg":"Service registered"}
{"level":"info",…,"service":"tasks","skills":1,"msg":"Service registered"}
{"level":"info",…,"msg":"Code Mode governance layer ready"}
{"level":"info",…,"endpoint":"http://127.0.0.1:3333/mcp",…,"msg":"🚀 Harbor ready (Streamable HTTP, MCP 2026-07-28) — waiting for Clients to connect"}
```

The `billing*` services are disabled (`"enabled": false`) and are skipped; they belong to the OAuth mode (`examples/demo/start-oauth-mode.sh`, see [`examples/07-oauth/README.md`](../examples/07-oauth/README.md)).

The order service demonstrates service-owned governance. It reads the current
INR price from the product service and requires the request's `amountInr` to
equal price times quantity. The policy in
`services/order/governance/rules/10-purchase-approval.yaml` allows totals up to
₹5,000 and returns `REQUIRE_APPROVAL` above that amount.

**Run the smoke test** (requires Python 3.9+; `--start-services` boots the product, order and task backends and the gateway itself, so stop `start.sh` first):

```bash
python3 tests/demo_e2e.py --start-services
```

---

## Step 3 — Try It from the Terminal

The gateway speaks MCP protocol revision **2026-07-28** over HTTP. There is no `initialize` handshake and no session: every request carries the `MCP-Protocol-Version` and `Mcp-Method` headers (plus `Mcp-Name` for `tools/call`), its own bearer, and the `_meta` envelope in `params`. Probe with `server/discover`, then call tools.

**The bearer.** Replace `<YOUR_BEARER_TOKEN>` with a JWT or an opaque token of at least 32 base64url characters (`A–Z a–z 0–9 - _`) — for the demo, `openssl rand -hex 32` will do; the demo backends accept any bearer the gateway forwards. A missing, malformed or shorter token is refused with HTTP 401 before any tool runs.

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

Expected response (JSON, or the same object in a single SSE `data:` event):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{
      "type": "text",
      "text": "[{\"service\":\"order\",\"description\":\"...\"},{\"service\":\"product\",...},{\"service\":\"tasks\",...}]"
    }],
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "harbor", "version": "1.0.0" } }
  }
}
```

**Search for endpoints:**

```bash
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: search_code" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
    "name":"search_code",
    "arguments":{
      "service":"tasks",
      "code":"async () => Object.entries(spec.paths).map(([p,m]) => ({ path: p, methods: Object.keys(m) }))"
    },
    "_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }
  }}'
```

**Execute an API call:**

```bash
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: api_execute" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
    "name":"api_execute",
    "arguments":{
      "service":"tasks",
      "code":"async () => { const { data } = await api.request({ method: \"GET\", path: \"/api/v1/tasks\" }); return data; }"
    },
    "_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }
  }}'
```

Each `api_execute` call is a durable execution: its result `_meta` carries `harbor/execution-id` and `harbor/execution-status`. With no Governance Rules installed (the default) every call is allowed — see [Govern what the AI may do](#govern-what-the-ai-may-do) below.

---

## Step 4 — Connect Your AI Client

The bearer in each config below follows the same rule as in Step 3: a JWT, or an opaque token of at least 32 base64url characters.

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
        "MCP_TOKEN": "<YOUR_BEARER_TOKEN>",
        "SERVICES_DIR": "/path/to/harbor/services"
      }
    }
  }
}
```

`MCP_TOKEN` is required: it is the bearer every stdio call presents, and it must be a JWT or at least 32 base64url characters — otherwise the gateway exits at boot. `SERVICES_DIR` is optional here; unset, it is the `services/` folder of the install.

Build first: `npm run build`

---

## Step 5 — Add Your First Real Service

1. Create `services/my-service/`:

```bash
mkdir -p services/my-service/skills
```

2. Add a local `spec.yaml`, or configure `spec.source: "url"` to fetch the
   OpenAPI 3.x document at startup:

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

3. Add `config.json` — required, and it must have an `auth` block. The folder name is the service name:

```json
{
  "description": "My Service — manages items, projects, and assignments.",
  "api": {
    "host": "my-api.internal",
    "port": 8080,
    "requestTimeoutMs": 10000,
    "maxRetries": 1
  },
  "auth": { "type": "static-token", "token": "my-dev-token" },
  "idempotency": { "type": "noop" },
  "circuitBreaker": { "type": "noop" }
}
```

`maxRetries` applies to `GET`, `PUT` and `DELETE` only; a `POST` or `PATCH` is never re-sent.

4. Restart the gateway — it auto-discovers the new service:

```bash
npm run dev
```

You should see: `{"level":"info",…,"service":"my-service","skills":0,"msg":"Service registered"}`. If the folder is skipped instead, the log says why (`Failed to scan service "my-service" — skipping`, with the error).

Full configuration reference → [`service-onboarding.md`](service-onboarding.md) and [`configuration.md`](configuration.md)

---

## Govern what the AI may do

Skills tell the AI *how* to use a service; **Governance Rules** decide *whether* a call may go out. Rules can be gateway-owned (file-only policies in the root `governance/rules/` directory, shared across enabled services) or service-owned (source selected by that service's `config.json` `governance` block). Harbor ships an active gateway-owned `final` rule that blocks every `DELETE`; `GOVERNANCE_DENIED` on a delete is therefore expected unless the deployment supplies a reviewed policy directory without that rule. The demo `order` service also includes a service-owned INR purchase limit. Both scopes are evaluated centrally before each backend call: `ALLOW`, `DENY`, or `REQUIRE_APPROVAL`, which pauses the run and asks a human over MCP. A gateway `final` rule can override service and endpoint rules. Start with [`../governance/rules/README.md`](../governance/rules/README.md) for the format and [`code-mode-governance.md`](code-mode-governance.md) for executions, replay and approvals.

---

## Development Workflow

```bash
npm run dev          # gateway in watch mode (tsx, auto-restarts on file changes)
npm test             # run all tests once
npm run test:watch   # re-run tests on save
npm run typecheck    # strict TypeScript check
npm run lint         # eslint
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
| Govern calls with rules and human approval | [`code-mode-governance.md`](code-mode-governance.md), [`../governance/rules/README.md`](../governance/rules/README.md) |
| Look up an environment variable or `config.json` field | [`configuration.md`](configuration.md) |
| Write a custom adapter (token cache, outbound transport) | [`adapter-guide.md`](adapter-guide.md) |
| Understand the 5 tools and sandbox model | [`tool-layer.md`](tool-layer.md) |
| Trace a request end-to-end | [`request-lifecycle.md`](request-lifecycle.md) |
| Contribute a connector or doc | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Common problems and fixes | [`faq.md`](faq.md) |
