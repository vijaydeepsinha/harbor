# Contributing to Harbor

Thank you for your interest in contributing. This guide covers setup, development workflow, how to extend the framework, and how to get changes merged.

---

## Table of Contents

1. [Setup](#1-setup)
2. [Running the Examples](#2-running-the-examples)
3. [Project Layout](#3-project-layout)
4. [How to Add a Connector](#4-how-to-add-a-connector)
5. [How to Add a Service](#5-how-to-add-a-service)
6. [Coding Guidelines](#6-coding-guidelines)
7. [Pull Request Process](#7-pull-request-process)
8. [Review Process](#8-review-process)
9. [Issue Labels](#9-issue-labels)
10. [Good First Contributions](#10-good-first-contributions)

---

## 1. Setup

**Prerequisites**

| Tool | Version |
|------|---------|
| Node.js | 22+ |
| npm | 10+ |
| Native build tools | Xcode CLT (macOS): `xcode-select --install`; `build-essential` (Debian/Ubuntu) |
| Python | 3.13+ for the demo IRCTC backend; 3.9+ for `tests/demo_e2e.py` |
| Docker | only for the governance E2E suite's default mode and the OAuth E2E |

> Native build tools are required by `isolated-vm` (V8 sandbox).

**Clone and install**

```bash
git clone https://github.com/vijaydeepsinha/harbor
cd harbor
npm install
```

**Verify everything works**

```bash
npm run typecheck     # TypeScript strict — must be clean
npm run lint          # eslint — unused imports fail it
npm test              # unit + integration: 743 passing, 1 skipped — none may fail
```

---

## 2. Running the Examples

The demo runs four local services (product on 3001, order on 3002, tasks on 3003, IRCTC on 3005) plus the MCP gateway on 3333. IRCTC is a Python FastAPI app; create its virtualenv once (see [`examples/demo/irctc/README.md`](examples/demo/irctc/README.md)):

```bash
cd examples/demo/irctc && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd -
```

```bash
# One-command start (kills old backend processes, starts all services + gateway, registers cleanup trap)
bash examples/demo/start.sh
```

**Manual steps (if you prefer)**

```bash
# Terminal 1 — demo services
node examples/demo/product-service.js &
node examples/demo/order-service.js &
node examples/demo/task-service.js &
(cd examples/demo/irctc && .venv/bin/python3 -m app.main) &

# Terminal 2 — gateway
npm run dev
```

OAuth mode (billing services behind `oauth-2.1`, `jwt-validation` and `oauth-introspection`; needs Docker): `bash examples/demo/start-oauth-mode.sh`.

**Smoke test (61 assertions)**

```bash
python3 tests/demo_e2e.py --start-services
```

**Talk to the gateway**

The gateway speaks MCP **2026-07-28** only: no `initialize`, no session. Every request carries `MCP-Protocol-Version` and `Mcp-Method` headers (plus `Mcp-Name` for `tools/call`), its own bearer, and the `_meta` envelope in `params`; a request in an older protocol shape is rejected. The bearer must be a JWT or an opaque token of at least 32 base64url characters (`openssl rand -hex 32` works for the demo).

```bash
# Discover registered services
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

More requests (`server/discover`, `search_code`, `api_execute`): [`docs/getting-started.md`](docs/getting-started.md#step-3--try-it-from-the-terminal).

**Expected response shape from `api.request()`:** `{ data, status, ok }` — never `{ body }`. Full contract and error handling: [`docs/skill-authoring.md`](docs/skill-authoring.md#apirequest-contract).

---

## 3. Project Layout

```
src/              All gateway source; tsconfig rootDir, compiled to dist/.
  index.ts        Process entry — validates config, boots the gateway.
  core/           Types, constants, config schema (zod), shared utilities. Imports nothing else in src/.
  spi/            Contracts: ConnectorAPI, AuthMiddleware, PermissionGuard, SpecLoader, CodeModeStore,
                  GovernanceRuleSource, AuditSink, …
  adapters/       Concrete implementations: token caches, idempotency, circuit breaker, auth strategies,
                  execution stores (in-memory, file, memcache), console audit sink
  wiring/         Composition root — strategy builders, register*Backend, service auth/circuit-breaker resolver.
  runtime/        Gateway boot, HTTP/stdio transports, service registry, sandbox + host bridge, API client,
                  execution (journal, replay, approvals), governance (resolver, rules, evaluator).
  tools/          The five MCP tool handlers (discover_services … api_execute).
services/         Service definitions — spec + config.json + skills/*.md (add yours here)
governance/rules/ Governance Rule files (README.md = format; examples/ is documentation, not loaded)
examples/
  demo/           Runnable local backends (Node + the Python IRCTC app), start.sh, start-oauth-mode.sh
  01-07/          Scenario guides (07-oauth also holds the mock AS docker-compose)
tests/
  unit/, integration/   Vitest (npm test)
  e2e/            Governance E2E suite: client, mock API, fixtures, runner (npm run test:governance)
  postman/        Builds and runs the Postman collections
  demo_e2e.py     Python smoke test against the demo
postman/          Postman collections (Harbor, mcp-governance) + environments
docker/governance-e2e/  Compose file for the governance suite
docs/             Architecture, request lifecycle, tool layer, configuration, governance, guides
```

**Key layering rule:** `src/runtime/` must never import from `src/adapters/` directly — it uses `src/spi/` interfaces and gets concrete strategies from `src/wiring/`. `src/wiring/` is the only layer that imports both `src/adapters/` and `src/spi/` — it is the composition root. `src/core/` has zero upward dependencies.

---

## 4. How to Add a Connector

Connectors are concrete implementations of SPI interfaces. The common extension points:

### 4a. Token Cache Backend

**Base class:** `src/spi/auth/abstract-token-cache.ts` → `AbstractTokenCache`

Extend `AbstractTokenCache` — do not implement `TokenCacheStrategy` directly. The base class handles hashing, TTL, and all protocol methods; subclasses implement three storage primitives.

1. Create `src/adapters/auth/strategies/redis-token-cache.strategy.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { AbstractTokenCache, type CacheEntry } from '../../../spi/auth/abstract-token-cache.js'
import type { Logger } from '../../../core/types/logger.types.js'

export class RedisTokenCache extends AbstractTokenCache {
  readonly name = 'redis'
  // private client: Redis

  constructor(config: Record<string, unknown>, ttlMs: number, logger?: Logger) {
    super(ttlMs, logger)
    // this.client = new Redis(config.url as string)
  }

  protected async readEntry(key: string): Promise<CacheEntry | undefined> {
    // const raw = await this.client.get(key)
    // return raw ? JSON.parse(raw) : undefined
  }

  protected async writeEntry(key: string, entry: CacheEntry): Promise<void> {
    // const ttl = entry.expiresAt - Date.now()
    // await this.client.set(key, JSON.stringify(entry), 'PX', ttl)
  }

  protected async deleteEntry(key: string): Promise<void> {
    // await this.client.del(key)
  }

  destroy(): void {
    // this.client.quit()
  }
}
```

2. Register it at startup, before `createMcpGateway` runs — in your own entry file next to `src/index.ts` — **no framework changes required**:

```typescript
import { registerTokenCacheBackend } from './wiring/strategy-builders.js'
import { RedisTokenCache } from './adapters/auth/strategies/redis-token-cache.strategy.js'

registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs, logger))
```

3. Activate by setting `TOKEN_CACHE_TYPE=redis` in your environment (or `.env`). The config loader accepts any lower-case kebab-case name; the builder resolves it from the registry at startup and refuses a name nothing registered. The factory receives `{ type }` only — the `TOKEN_CACHE_MEMCACHE_*` / `_CB_*` variables belong to the built-in backends — so read your connection settings yourself. No `config.json` change needed.

### 4b. Idempotency Backend

**Interface:** `src/core/types/idempotency.types.ts` → `IdempotencyStrategy`

Same pattern — create under `src/adapters/idempotency/strategies/`, register with `registerIdempotencyBackend('postgres', ...)`. Select it gateway-wide with `IDEMPOTENCY_TYPE=postgres`, or per service with `"idempotency": { "type": "postgres", … }` in `config.json` (the factory receives that whole block). An unregistered type skips the service.

### 4c. Execution Store, Audit Sink, Rule Source

The Code Mode governance layer has three more registries in `src/wiring/strategy-builders.ts`: `registerExecutionStoreBackend` (`EXECUTION_STORE_TYPE`; run the contract suite in `tests/unit/execution-store.test.ts` against your store), `registerAuditSinkBackend` (`AUDIT_SINKS`) and `registerGovernanceRuleSourceBackend` (`GOVERNANCE_RULES_SOURCE`). See [`docs/code-mode-governance.md`](docs/code-mode-governance.md).

### 4d. Outbound Transport (ConnectorAPI)

**Interface:** `src/spi/connector/connector-api.ts` → `ConnectorAPI`

Replace HTTP/axios with gRPC, GraphQL, or a mock:

```typescript
// SPDX-License-Identifier: Apache-2.0
import type { ConnectorAPI, ApiRequest, ApiResponse, ExecuteRequestContext } from './spi/connector/connector-api.js'

export class GrpcConnector implements ConnectorAPI {
  async request(req: ApiRequest, ctx: ExecuteRequestContext): Promise<ApiResponse> {
    // call gRPC backend, wrap response
    // access ctx.idempotencyKeyTtlMs, ctx.correlationId etc. from ctx
    return { data: { ... }, status: 200, ok: true }
  }
}
```

The `ApiClient` is built per service in `src/runtime/gateway/service-resources-factory.ts`; swap your connector in there. A custom connector replaces `ApiClient`'s retries, idempotency, circuit-failure recording and Harbor-owned outbound headers, so provide what your transport needs.

---

## 5. How to Add a Service

A service = an OpenAPI-described backend + optional skills (AI instruction files).

**Minimum files**

```
services/my-service/
  spec.yaml       ← OpenAPI 3.x spec for the backend
  config.json     ← gateway config for this service
  skills/
    my-skill.md   ← skill definition (optional)
```

**`config.json` skeleton** — required, and it must contain `auth`; the folder name is the service name:

```json
{
  "description": "What this service does",
  "api": {
    "host": "localhost",
    "port": 4000,
    "requestTimeoutMs": 10000,
    "maxRetries": 1
  },
  "auth": {
    "type": "static-token",
    "token": "your-token-here"
  },
  "idempotency": { "type": "noop" },
  "circuitBreaker": { "type": "noop" },
  "serviceRefreshIntervalMs": 60000
}
```

**`spec.yaml` requirements**

- Valid OpenAPI 3.x
- `servers[0].url` is used as the upstream base URL when no `api` block is present; when `api` is set, the scanner uses `api.host`/`api.port`/`api.basePath`
- At least one path defined

**Skill file (`skills/my-skill.md`) skeleton** — the file name is the skill id; frontmatter is optional (`title`, else the first `#` heading; `tags`):

```markdown
---
title: One-line description shown to the AI
tags: [keyword1, keyword2]
---

# My Skill

Describe what this skill does and when to use it.

## Steps

1. Call `POST /api/v1/resource` with `{ field: value }`
2. Return the `id` from the response

## Example

api.request({ method: 'POST', path: '/api/v1/resource', body: { name: 'test' } })
```

**Gateway auto-discovers services** at startup by scanning `services/*/`. No code changes needed — just add the directory.

**Test your service**

```bash
npm run dev
# In another terminal:
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: discover_services" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"discover_services","arguments":{},
    "_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
      "io.modelcontextprotocol/clientCapabilities":{}
    }
  }}'
```

---

## 6. Coding Guidelines

**TypeScript**

- Strict mode is on — no `any` without an explicit suppression comment explaining why
- ESM throughout — all imports use `.js` extensions (even for `.ts` source files)
- Apache-2.0 SPDX header required on every new source file:
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 Contributors to the Harbor project.
  ```

**Comments**

- Write no comments by default
- Add one only when the **why** is non-obvious: a hidden constraint, a subtle invariant, a workaround for a known bug
- Never explain what the code does — good names do that

**Layer discipline**

- `src/core/` → no imports from anything else in this repo
- `src/spi/` → may import `src/core/` only
- `src/adapters/` → may import `src/core/` and `src/spi/` only
- `src/runtime/` → may import `src/core/`, `src/spi/`, `src/wiring/` (never `src/adapters/` directly); the MCP server factory also registers the handlers from `src/tools/`
- `src/wiring/` → may import `src/core/`, `src/spi/`, `src/adapters/` (composition root — this is the only layer that wires concrete adapters)
- `src/tools/` → may import `src/core/`, `src/spi/`, `src/runtime/`

Violations get caught in review. When in doubt, check `docs/architecture.md`.

**Tests**

- Every non-trivial change needs test coverage
- Unit tests under `tests/unit/`, integration tests under `tests/integration/`; governance behaviour end to end under `tests/e2e/` (run with `npm run test:governance`, or `-- --local` without Docker)
- Do not mock the database/cache layers in integration tests — use real in-memory strategies
- `npm run typecheck`, `npm run lint` and `npm test` must be clean
- Docs are tested too: `tests/unit/doc-paths.test.ts` fails when a Markdown file cites a repository path that does not exist or an `#anchor` with no heading

**Scope**

- Fix the bug — don't refactor unrelated code in the same PR
- Don't add abstractions for hypothetical future use cases
- Three similar lines is better than a premature abstraction

---

## 7. Pull Request Process

1. Fork the repo; create a branch from `main` named `<type>/<short-description>`:
   - `feat/redis-connector`
   - `fix/circuit-breaker-count`
   - `docs/skill-authoring-guide`

2. Make your changes; write/update tests; run:
   ```bash
   npm run lint && npm run typecheck && npm test
   ```

3. Open a PR against `main`. Use the PR template — fill in **Summary**, **Test plan**, and the checklist.

4. Ensure CI passes. Two workflows run:
   - `.github/workflows/ci.yml` — every push and PR: `npm audit --audit-level=high`, typecheck, lint, `npm test`, and the Python E2E (`tests/demo_e2e.py`) including OAuth mode with a real JWT via Docker.
   - `.github/workflows/governance-e2e.yml` — pushes and PRs that touch `src/`, `governance/`, the package or Docker files, `docker/governance-e2e/`, `tests/e2e/`, `tests/postman/` or the governance Postman collection: typechecks and lints the E2E suite, builds the production image and runs `npm run test:governance` (E2E + Postman).

5. Address review feedback — push to the same branch; do not force-push after a review starts.

6. Once approved, a maintainer merges.

**Commit message format**

```
<type>(<scope>): <short summary in present tense>

Optional body — explain the why, not the what: the old behaviour, the new
behaviour, and any pinned test the change had to update.
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. The scope is optional and names the area (`governance`, `http`, `auth`, `sandbox`, `config`, …), e.g. `fix(api-client): never re-send a POST after a timeout`.

Commit messages carry **no attribution trailers** — no `Co-authored-by:`, `Signed-off-by:`, `Generated with …` or other tool signatures, even if a tool adds them by default ([`AGENTS.md`](AGENTS.md) §7).

---

## 8. Review Process

**What reviewers check**

| Area | Questions |
|------|-----------|
| Layer discipline | Does the change respect `core → spi → adapters / runtime → tools`? |
| SPI contract | New connectors implement the interface fully? |
| Test coverage | Is the new path exercised? |
| Apache headers | Every new `.ts` file has the SPDX header? |
| No internal refs | No company names, internal hostnames, or K8s overlay paths? |
| Breaking changes | Does this change a public type, config shape, or tool response format? |

**SLA**

Maintainers aim to leave a first review within 5 business days. Complex PRs (new connectors, protocol changes) may take longer.

**If your PR is stale**

Ping in the issue or PR comments after 7 days with no activity. Do not open a duplicate PR.

---

## 9. Issue Labels

| Label | Meaning |
|-------|---------|
| `good-first-issue` | Isolated, well-scoped; no deep framework knowledge needed |
| `help-wanted` | We want community input but it requires some familiarity with the codebase |
| `connector` | Adds or changes a storage/auth/transport backend |
| `service` | Adds or changes an example service or skill |
| `docs` | Documentation-only change |
| `bug` | Something is broken |
| `enhancement` | Additive improvement to existing behavior |
| `breaking-change` | Changes a public API, config shape, or tool response format |
| `wontfix` | Out of scope for this project |
| `needs-repro` | Bug report lacks a reproducible example |

---

## 10. Good First Contributions

These are isolated, well-scoped tasks with clear acceptance criteria. Each links to the relevant code area.

### Connectors

**Redis token-cache connector** (`good-first-issue`, `connector`)
Implement `src/adapters/auth/strategies/redis-token-cache.strategy.ts` by extending `AbstractTokenCache` (`src/spi/auth/abstract-token-cache.ts`).
`ioredis` would be a new production dependency — ask in the issue before adding it.
Register via `registerTokenCacheBackend('redis', ...)`.
Include tests under `tests/unit/adapters/`.

**Redis idempotency connector** (`good-first-issue`, `connector`)
Same pattern as above but for `IdempotencyStrategy` (`src/core/types/idempotency.types.ts`).
File: `src/adapters/idempotency/strategies/redis-idempotency.strategy.ts`.
Register via `registerIdempotencyBackend('redis', ...)`.

**Filesystem idempotency connector** (`good-first-issue`, `connector`)
Persist idempotency keys to a local JSON file — useful for development without an external store.
File: `src/adapters/idempotency/strategies/filesystem-idempotency.strategy.ts`.
Uses Node.js `fs/promises`. No external dependencies.

### Services and Skills

**Weather service example** (`good-first-issue`, `service`)
Add `services/weather/` with an OpenAPI spec pointing at `api.open-meteo.com` (free, no key).
Include a skill that fetches current temperature for a given city.
No gateway code changes — spec + config + skill only.

**Extended tasks-service skills** (`good-first-issue`, `service`, `docs`)
Add a second skill to the existing `services/tasks/skills/` directory.
Example: a `bulk-task-reporter` skill that calls `GET /api/v1/tasks` and summarizes by status.

### Docker / Infrastructure

**`docker-compose.yml` for one-command demo** (`good-first-issue`, `enhancement`)
Create `examples/demo/docker-compose.yml` that starts the four demo services (including the Python IRCTC app) + the gateway.
Acceptance: `docker compose up` from the repo root starts a working demo accessible on port 3333.

**Node version guard in `start.sh`** (`good-first-issue`, `enhancement`)
`examples/demo/start.sh` silently no-ops if `nvm` is not installed. Add an explicit check:
if `node --version` is not 22+, print a clear error message and exit 1.

### Documentation

**`api.request` return shape in README** (`good-first-issue`, `docs`)
Add a prominent section to `README.md` documenting that `api.request()` returns `{ data, status, ok }` — not `{ body }`.
Include a working skill snippet showing correct destructuring.

**Architecture diagram in README** (`good-first-issue`, `docs`)
Add the ASCII layer diagram from `docs/architecture.md` (the system diagram section) to `README.md` so readers see the project structure before diving into docs.

---

## License

By contributing you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
