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
1. Does `services/<name>/spec.yaml` (or `spec.json` / `spec.yml`) exist?
2. Does `services/<name>/config.json` exist **with an `auth` block**? Without it the service is skipped (`config.auth is required`).
3. Is the spec valid OpenAPI 3.x? Run: `npx @redocly/cli lint services/<name>/spec.yaml`
4. Is `"enabled": false` set in `config.json`?
5. Is the gateway reading the folder you think? Unset, `SERVICES_DIR` is the `services/` folder of the install, not of the working directory.
6. Check startup logs for `Failed to scan service "<name>" — skipping`, `Failed to build service resources — skipping service` or `Service "<name>" is disabled — skipping` — the `error` field says why.

---

**`node --version` shows 18 or 20, not 22**

Node 22+ is required (`engines` in `package.json`; CI and the Docker image run Node 22).

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

No. `ok: false` means the backend returned a 4xx (`ok` is `true` for 2xx and 3xx). The function returns normally. What throws:

- a 5xx or a transport failure (timeout, reset) — after `maxRetries` extra attempts for `GET`/`PUT`/`DELETE`, at once for `POST`/`PATCH`, which Harbor never re-sends;
- a policy violation — `CIRCUIT_OPEN`, `PERMISSION_DENIED`, `CALL_LIMIT_EXCEEDED`, `CONCURRENT_LIMIT_EXCEEDED`, `INVALID_API_REQUEST` (e.g. an absolute URL, `..` segments, a malformed path, non-object `params`). Headers Harbor owns (`Authorization`, `X-Correlation-ID`, …) are not an error — the program's copies are dropped;
- a governance stop — `GOVERNANCE_DENIED`, an approval pause, `REPLAY_DIVERGED`, `ACTIVITY_OUTCOME_UNKNOWN` (see [Governance and approvals](#governance-and-approvals)).

Catching a policy violation or governance stop does not help: the run still ends with that error, and later `api.request()` calls in the same run are refused.

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

Increase `SANDBOX_EXECUTE_TIMEOUT_MS` (default: 8000ms) for `api_execute`, or `SANDBOX_SEARCH_TIMEOUT_MS` (default: 3000ms) for `search_code` — or the service's `sandbox` block in `config.json`.

Or reduce the work your code does — avoid loading large objects unnecessarily.

`SANDBOX_TIMEOUT` means the run's own wall-clock budget ran out. A slow backend looks different:
`api.request()` rejects with the HTTP client's timeout. For a governed non-GET call, Harbor marks
the execution `FAILED` with `ACTIVITY_OUTCOME_UNKNOWN`, whether or not user code caught the
bridge error; a governed GET or legacy call that escapes can end as `SANDBOX_RUNTIME`. To allow
more backend time, raise `api.requestTimeoutMs` in the service's `config.json`.

---

## Authentication

**HTTP 401 / `MISSING_TOKEN` / `TOKEN_INVALID` — I'm sending the token**

The header name and the `Bearer` scheme are case-insensitive. What matters:
1. The value is `Bearer <token>` with a single token after the scheme.
2. The token is a JWT, or an opaque token of at least 32 base64url characters (`A–Z a–z 0–9 - _`). A shorter or otherwise-shaped token is refused (`reason: weak_credentials`) — `openssl rand -hex 32` produces a usable demo token.
3. Exactly one `Authorization` header — two are refused (`duplicate_authorization_header`), even if a proxy added the second.

For stdio the same rule applies to `MCP_TOKEN`, checked once at boot.

---

**`TOKEN_EXPIRED` — token just issued**

For `oauth-introspection`, the auth server's response may not map correctly to `TokenPayload.expires_in`. Harbor reads the mapped field, else `expiresIn` / `expires_in`, else RFC 7662's absolute `exp`; a value above 10⁹ is taken as an epoch timestamp. Check `responseMapping` in `config.json`:

```json
{
  "responseMapping": {
    "expires_in": "tokenResponse.expiresIn"
  }
}
```

If no usable lifetime is found, or it is ≤ 0, the token is reported as expired immediately. (A response with `active` set to anything but `true` is `TOKEN_INVALID` instead.)

---

**`SESSION_EXPIRED` after a few hours**

Both the access token and refresh token have expired (~12 hours typically). The user must provide a new `Authorization: Bearer <token>`.

This is intentional — the gateway cannot refresh without a valid refresh token. Prompt the user to re-authenticate.

---

**`INTROSPECTION_FAILED` — intermittent**

The auth server was unreachable (or answered 5xx) during the introspection call. This is marked `retryable: true`. The AI client should retry the tool call. The error carries only the failure code (e.g. `ECONNREFUSED`), never the auth server's address.

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

The `count-based` circuit breaker opened because `failureThreshold` consecutive calls to that endpoint (default 5) failed with a 5xx or a transport error — each logical call counts once, however many retries it took. Wait `recoveryTimeMs` (default 30 seconds); then one probe call is let through, and its success closes the circuit. The error is `retryable: true`; under Code Mode the execution is `INTERRUPTED` and can be resumed.

To check which endpoint opened: the error message names it, and the audit record's `outcome` is `circuit_open`.

To disable per service: `"circuitBreaker": { "type": "noop" }` in `config.json`.

---

**Circuit breaker opens for one URL but not another**

Correct behavior. Circuit state is kept per endpoint: the OpenAPI path template the call resolved to (`/orders/{orderId}`), or, for a path the spec does not describe, the path with id-like segments collapsed (`/orders/123` → `/orders/{id}`). One endpoint failing doesn't affect others. State is per gateway process.

---

## Governance and approvals

**Which calls are governed?**

The product and task demos have no active service policy, so their calls are
allowed as `NO_GOVERNANCE`. The order demo includes a service-owned rule:
`amountInr <= 5000` is allowed and `amountInr > 5000` requires approval. Put
YAML/JSON policy under a service's `governance/rules/` directory, or configure
its URL/custom source and refresh interval in `config.json`. The service's
rules are loaded independently and evaluated by Harbor centrally; a disabled
service does not load policy. An invalid initial rule stops boot. A call some
rule targets but no rule matches gets `GOVERNANCE_DEFAULT_DECISION` (default
`DENY`). A call no rule targets is allowed — including a path the spec does
not describe, unless a `*` or `/**` rule covers it.

Harbor's active gateway-owned `deny-all-delete.yaml` is an exception to the
un-governed default: every `DELETE` is targeted and denied by a `final` rule.
That is why an agent sees `GOVERNANCE_DENIED` for delete operations. To allow
deletes, configure a reviewed gateway policy directory that does not contain
the rule.

---

**`GOVERNANCE_DENIED`**

A rule denied the call (or the default did, for a targeted call), or a human rejected the approval. Nothing was sent, the execution is `DENIED`, and the error is not retryable; the message names the matched rules. Change the request or the rule.

---

**The call paused for approval — what now?**

If the client declares the `elicitation` capability, `api_execute` returns `input_required` with an approval form (`approve: boolean`, `comment`) and a sealed `requestState`. The client shows it to a human and retries the **same** `tools/call` with the answer and the echoed `requestState`. Harbor records the decision once and resumes the persisted program in a fresh isolate: completed calls are replayed from the journal, not re-sent. `accept` approves only with `approve: true`.

Without elicitation the tool returns `APPROVAL_REQUIRED` with `harbor/execution-id` and `harbor/approval-id` in `_meta`. Decide with `POST /executions/{id}/approvals/{approvalId}` and a body such as `{"action":"accept","approve":true}` (or `decline` / `cancel`; `approve` also takes the words `yes`, `sure`, `proceed`, `approved`, and `no` / `rejected` to reject), then call `api_execute` again with `_meta["harbor/execution-id"]` set. Both steps need a bearer of the principal that started the execution — there is no separate approver role. The `requestState` expires after `GOVERNANCE_APPROVAL_TTL_SEC` (600 s).

---

**`REPLAY_DIVERGED`**

On resume, the program issued a different request (method or path — and, for a call awaiting or holding approval, its query or body) at a step that is already journaled. Nothing ran and the execution is `FAILED`. The usual cause is a program that depends on something that changes between runs, such as the clock or `Math.random()`. Resume always runs the originally submitted program, whatever code the retry carries. Start a new execution.

---

**`ACTIVITY_OUTCOME_UNKNOWN`**

An earlier call's outcome is unknown — a `POST` that timed out or got a 5xx, or a gateway that died mid-call — and Harbor will not send it again. Inspect `GET /executions/{id}` and the backend, then start a new execution.

---

**`EXECUTION_LOCKED`, `EXECUTION_NOT_RESUMABLE`, `APPROVAL_ALREADY_DECIDED`**

`EXECUTION_LOCKED`: another run or decision on the same execution is in progress; retry. `EXECUTION_NOT_RESUMABLE`: the execution has finished, or the approval you answered is no longer the one it waits on. `APPROVAL_ALREADY_DECIDED`: your answer conflicts with the decision already recorded; repeating the recorded decision simply resumes.

More: [`code-mode-governance.md`](code-mode-governance.md).

---

## Services and Skills

**Service doesn't appear in `discover_services`**

1. Check the service folder exists under `services/`
2. Check `spec.yaml` / `spec.json` exists and parses cleanly
3. Check `"enabled": false` is not set
4. Check startup logs for the service name

---

**Skills not showing up in `discover_skills`**

1. Frontmatter is required and must use the Agent Skills fields. The `name`
   must match the filename, and `description` must be present:
   ```markdown
   ---
   name: my-skill
   description: What this skill does and when to use it.
   metadata:
     tags: "keyword1, keyword2"
   ---
   ```
   A file with invalid frontmatter is skipped with a warning (`Skipping skill
   "<file>"`) while the other skills still load.
2. Check startup log: `{…,"service":"my-service","skills":N,"msg":"Service registered"}` — N should be > 0
3. No subdirectories — skill files must be directly in `skills/`, not nested

---

**Spec refresh not picking up new endpoints**

Check `serviceRefreshIntervalMs` in `config.json`. `0` means load once at startup. Set it to an interval of at least 1000 ms (spec and skills reload together; a failed spec load keeps both as they were):

```json
{ "serviceRefreshIntervalMs": 60000 }
```

Or restart the gateway — it always loads the latest spec on startup.

---

## Transport and Protocol

**Can I use stdio instead of HTTP?**

Yes. Set `MCP_TRANSPORT=stdio` and `MCP_TOKEN`. The process reads JSON-RPC from stdin and writes to stdout. Logs go to stderr.

`MCP_TOKEN` is the bearer every stdio call presents. It is required and must be a JWT or at least 32 base64url characters; otherwise the gateway exits at boot.

```bash
MCP_TRANSPORT=stdio MCP_TOKEN="$(openssl rand -hex 32)" node dist/index.js
```

In `claude_desktop_config.json`:
```json
{
  "command": "node",
  "args": ["/path/to/dist/index.js"],
  "env": { "MCP_TRANSPORT": "stdio", "MCP_TOKEN": "<YOUR_BEARER_TOKEN>" }
}
```

---

**Can multiple AI clients connect at the same time?**

Yes. HTTP mode is stateless — each request is independent. Multiple clients (or concurrent requests from one client) can hit the gateway simultaneously. The service registry is shared and read-only; sandbox execution is scoped to the individual request.

---

**Can I run several gateway pods behind a load balancer?**

Yes, with two settings. Executions, approvals and the run lock must be shared: set `EXECUTION_STORE_TYPE=memcache` (with `EXECUTION_STORE_MEMCACHE_HOST` / `_PORT`). And every pod must seal and open the approval `requestState` with the same key: set one `GOVERNANCE_REQUEST_STATE_KEY` (≥ 32 characters) on all of them — unset, each pod uses its own random key and refuses the others' state. Give every pod the same Governance Rules. The token cache and idempotency backends can be shared the same way (`TOKEN_CACHE_TYPE=memcache`, a `memcache` idempotency block). See [`configuration.md`](configuration.md#code-mode-governance-layer).

---

## Connectors and Extensibility

**Can I add Redis support without modifying the framework?**

Yes. Register the backend in your own entry point, before `createMcpGateway` runs, with the registration API in `src/wiring/strategy-builders.ts`:

```typescript
// Your entry file under src/ (next to src/index.ts), which then boots the gateway
import { registerTokenCacheBackend } from './wiring/strategy-builders.js'
registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs, logger))
```

Then set `TOKEN_CACHE_TYPE=redis` in your environment (token cache is global, not per-service). Any lower-case kebab-case name works; one nothing registered stops boot. The factory receives only `{ type }`, so the backend reads its own connection settings. `registerIdempotencyBackend` (`IDEMPOTENCY_TYPE`, or `"type"` in a service's `idempotency` block), `registerExecutionStoreBackend` (`EXECUTION_STORE_TYPE`), and `registerAuditSinkBackend` (`AUDIT_SINKS`) work the same way. `registerGovernanceRuleSourceBackend` registers a source selected per service with `config.json`'s `governance.rulesSource`.

See [`adapter-guide.md`](adapter-guide.md) for complete walkthroughs.

---

**Can I replace the HTTP client with gRPC?**

Yes. Implement `ConnectorAPI` from `src/spi/connector/connector-api.ts` and use it as `ServiceResources.apiClient` (built in `src/runtime/gateway/service-resources-factory.ts`; `createMcpGateway` has no injection option yet). Your connector replaces `ApiClient` wholesale: retries, idempotency, circuit-breaker failure recording and the Harbor-owned outbound headers (`X-Correlation-ID`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `X-Harbor-Execution-ID`, …) are `ApiClient`'s, so provide what your transport needs. The correlation ID is request-scoped; the optional execution ID links governed approval turns. A connector that throws fails the call; it is not retried.

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

`ENABLE_AUDIT` takes `true`, `false`, `1` or `0` exactly; any other value stops boot. Off means no `api_execute` audit records and no execution-state events.

**Log output is numeric levels (30, 40, 50) instead of info/warn/error**

The gateway configures pino with `formatters: { level: (label) => ({ level: label }) }` for human-readable levels. If you're seeing numeric levels, you may be running a custom build without this config. Check `src/runtime/observability/logger.ts`.

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

**How do I run the governance E2E suite?**

```bash
npm run test:governance              # Docker: builds the production image, runs E2E + Postman
npm run test:governance -- --local   # same suite with the gateway and mock backend as host processes
```

It drives real MCP 2026-07-28 calls through the gateway, the rules engine and the V8 isolate against a deterministic mock backend. `npm test` does not include it (`tests/e2e/` is excluded). Details: [`TESTING.md`](../TESTING.md).

**A test fails in `tests/unit/doc-paths.test.ts`**

Every repository path a Markdown file cites in backticks or a link must exist in git, and every `#anchor` link must land on a heading. Fix the path in the doc (sources live under `src/`), or, for a file the reader is meant to create, add it to the test's allow-list with the reason.

**`python3 tests/demo_e2e.py` — Python 3.9 union type error**

The demo_e2e.py is Python 3.9 compatible. If you see `TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'`, you may have a custom modification using `str | None` syntax (Python 3.10+). Use `Optional[str]` from `typing` instead.

---

## Contributing

**Where do I find good first issues?**

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) → Section 10: Good First Contributions.

**Do new files need an SPDX header?**

Yes — no CI step checks it, but reviewers do. Every new `.ts` file starts with:
```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
```

**Typecheck fails with "Cannot find module"**

Check:
1. Import path ends with `.js` (even for `.ts` source files) — ESM convention
2. The module is in `tsconfig.json` includes
3. Run `npm run build` to catch any compile-time issues
