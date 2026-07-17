# FAQ

Common questions and troubleshooting.

---

## Setup and Installation

**`npm install` fails with a native build error**

`isolated-vm` requires native compilation. Install build tools:

```bash
# macOS
xcode-select --install

# Debian / Ubuntu
sudo apt install -y build-essential python3

# Alpine (Docker)
apk add --no-cache python3 make g++ libc6-compat
```

Then run `npm install` again.

---

**Gateway starts but no services register**

Check:
1. Does `services/<name>/spec.yaml` (or `spec.json`) exist?
2. Is the spec valid OpenAPI 3.x? Run: `npx @redocly/cli lint services/<name>/spec.yaml`
3. Is `"enabled": false` set in `config.json`?
4. Check startup logs for `"Skipping service"` or spec parse errors

---

**`node --version` shows 18 or 20, not 22**

Node 22+ is required (for `using` / `Symbol.dispose` and performance improvements in V8).

```bash
# With nvm:
nvm install 22
nvm use 22

# Verify:
node --version  # must be v22.x.x or higher
```

---

## Tools and Usage

**What order should the AI call the tools?**

```
discover_services()
  → (optional) discover_skills() + get_skill_details()
    → search_code()
      → api_execute()
```

`discover_services` first — always. Then `search_code` to find endpoints. Then `api_execute` to act. Skills are optional but recommended for complex workflows.

---

**`api.request()` returns `undefined` for `body` / `data` is missing**

The return shape is `{ data, status, ok }` — not `{ body }`.

```javascript
// Correct
const { data, status, ok } = await api.request({ method: 'GET', path: '/api/v1/items' })

// Wrong — body does not exist
const { body } = await api.request(...)  // undefined!
```

---

**`api.request()` with `ok: false` — is that an error?**

No. `ok: false` means the backend returned a 4xx. The function returns normally. Only 5xx (after retries exhausted), policy violations (circuit open, permission denied, call limit), or sandbox errors throw.

```javascript
const { data, status, ok } = await api.request({ method: 'POST', path: '/api/v1/items', body: { name: '' } })
if (!ok) {
  // 400 Bad Request — handle validation error
  return { error: data.message, status }
}
return data
```

---

**Can I use `fetch`, `require`, or `import` in sandbox code?**

No. The V8 sandbox has no access to the Node.js context — no `fetch`, `require`, `import`, `process`, `fs`, or any I/O. Only what's explicitly injected is available:
- `api.request()` in `api_execute`
- `spec` in `search_code`
- `skills` in `discover_skills`

This is intentional. The sandbox model guarantees AI-generated code cannot exfiltrate data or access system resources.

---

**Can I call `api.request()` from `search_code`?**

No. `search_code` only injects `spec`. `api.request()` is not available. Use `api_execute` for network calls.

---

**My sandbox code times out**

Increase `SANDBOX_EXECUTE_TIMEOUT_MS` (default: 8000ms) for `api_execute`, or `SANDBOX_SEARCH_TIMEOUT_MS` (default: 3000ms) for `search_code`.

Or reduce the work your code does — avoid loading large objects unnecessarily.

---

## Authentication

**`MISSING_TOKEN` error — I'm sending the token**

Check:
1. Header name: must be `Authorization` (capital A)
2. Scheme: must be `Bearer` (capital B)
3. No extra spaces: `Authorization: Bearer <token>` (one space between Bearer and token)

---

**`TOKEN_EXPIRED` — token just issued**

For `oauth-introspection`, the auth server's response may not map correctly to `TokenPayload.expires_in`. Check `responseMapping` in `config.json`:

```json
{
  "responseMapping": {
    "expires_in": "tokenResponse.expiresIn"
  }
}
```

If the mapping is wrong, `expires_in` defaults to `0` and the token appears expired immediately.

---

**`SESSION_EXPIRED` after a few hours**

Both the access token and refresh token have expired (~12 hours typically). The user must provide a new `Authorization: Bearer <token>`.

This is intentional — the gateway cannot refresh without a valid refresh token. Prompt the user to re-authenticate.

---

**`INTROSPECTION_FAILED` — intermittent**

The auth server was unreachable during the introspection call. This is marked `retryable: true`. The AI client should retry the tool call.

If it happens frequently, check:
- Auth server host/port in `config.json`
- Network connectivity from the gateway process
- `authTimeoutMs` — may be too low for a slow auth server

---

**Token cache down — will the gateway crash?**

No. All token cache failures are `warn`-logged and non-fatal. The gateway falls through to the auth server for every request (slower, but operational).

---

## Circuit Breaker

**`CIRCUIT_OPEN` error**

The circuit breaker opened because the backend returned too many 5xx errors (default: 5 consecutive failures). Wait `recoveryTimeMs` (default: 30 seconds) before retrying.

To check which endpoint opened: look for `"circuit-open"` in logs with the `endpoint` field.

To disable per service: `"circuitBreaker": { "type": "noop" }` in `config.json`.

---

**Circuit breaker opens for one URL but not another**

Correct behavior. Paths are normalized before circuit state is tracked (`/orders/123` → `/orders/{id}`). Each normalized path has its own circuit state. One endpoint failing doesn't affect others.

---

## Services and Skills

**Service doesn't appear in `discover_services`**

1. Check the service folder exists under `services/`
2. Check `spec.yaml` / `spec.json` exists and parses cleanly
3. Check `"enabled": false` is not set
4. Check startup logs for the service name

---

**Skills not showing up in `discover_skills`**

1. Verify the `.md` file has valid YAML frontmatter with `id` and `title` fields:
   ```markdown
   ---
   id: my-skill
   title: What this skill does
   tags: [keyword1, keyword2]
   ---
   ```
2. Check startup log: `{"msg":"Service registered","service":"my-service","skills":N}` — N should be > 0
3. No subdirectories — skill files must be directly in `skills/`, not nested

---

**Spec refresh not picking up new endpoints**

Check `serviceRefreshIntervalMs` in `config.json`. `0` means load once at startup. Set to a non-zero value:

```json
{ "serviceRefreshIntervalMs": 60000 }
```

Or restart the gateway — it always loads the latest spec on startup.

---

## Transport and Protocol

**Can I use stdio instead of HTTP?**

Yes. Set `MCP_TRANSPORT=stdio`. The process reads JSON-RPC from stdin and writes to stdout. Logs go to stderr.

```bash
MCP_TRANSPORT=stdio node dist/index.js
```

In `claude_desktop_config.json`:
```json
{
  "command": "node",
  "args": ["/path/to/dist/index.js"],
  "env": { "MCP_TRANSPORT": "stdio" }
}
```

---

**Can multiple AI clients connect at the same time?**

Yes. HTTP mode is stateless — each request is independent. Multiple clients (or concurrent requests from one client) can hit the gateway simultaneously. The service registry is shared and read-only; sandbox execution is scoped to the individual request.

---

## Connectors and Extensibility

**Can I add Redis support without modifying the framework?**

Yes. Use the registration API:

```typescript
import { registerTokenCacheBackend } from './runtime/gateway/strategy-builders.js'
registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs))
```

Then set `TOKEN_CACHE_TYPE=redis` in your environment (token cache is global, not per-service).

See [`adapter-guide.md`](adapter-guide.md) for complete walkthroughs.

---

**Can I replace the HTTP client with gRPC?**

Yes. Implement `ConnectorAPI` from `spi/connector/connector-api.ts` and pass your implementation to `ServiceResources.apiClient`.

See `adapter-guide.md → Writing a Custom Outbound Transport`.

---

## Logging and Debugging

**How do I enable debug logs?**

```bash
LOG_LEVEL=debug npm run dev
```

Or in `.env`: `LOG_LEVEL=debug`

`trace` is the most verbose level — shows every sandbox step.

**How do I suppress audit logs in dev?**

```bash
ENABLE_AUDIT=false npm run dev
```

**Log output is numeric levels (30, 40, 50) instead of info/warn/error**

The gateway configures pino with `formatters: { level: (label) => ({ level: label }) }` for human-readable levels. If you're seeing numeric levels, you may be running a custom build without this config. Check `runtime/observability/logger.ts`.

---

## Tests

**How do I run only one test file?**

```bash
npm test -- tests/unit/sandbox.test.ts
```

**Tests pass but the E2E smoke test fails**

The smoke test requires running services. Start them first:

```bash
bash examples/demo/start.sh &
sleep 3
python3 tests/demo_e2e.py  # without --start-services (already running)
```

Or use `--start-services` to let the test script manage startup.

**`python3 tests/demo_e2e.py` — Python 3.9 union type error**

The demo_e2e.py is Python 3.9 compatible. If you see `TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'`, you may have a custom modification using `str | None` syntax (Python 3.10+). Use `Optional[str]` from `typing` instead.

---

## Contributing

**Where do I find good first issues?**

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) → Section 10: Good First Contributions.

**CI fails on my PR with "SPDX header missing"**

Every new `.ts` file requires:
```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
```

**Typecheck fails with "Cannot find module"**

Check:
1. Import path ends with `.js` (even for `.ts` source files) — ESM convention
2. The module is in `tsconfig.json` includes
3. Run `npm run build` to catch any compile-time issues
