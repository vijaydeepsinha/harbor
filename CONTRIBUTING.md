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

> Native build tools are required by `isolated-vm` (V8 sandbox).

**Clone and install**

```bash
git clone https://github.com/vdssinha/harbor
cd harbor
npm install
```

**Verify everything works**

```bash
npm run typecheck     # TypeScript strict — must be clean
npm test              # 312 unit + integration tests — must all pass
```

---

## 2. Running the Examples

The demo runs three local services (product on 3001, order on 3002, tasks on 3003) plus the MCP gateway on 3333.

```bash
# One-command start (kills old processes, starts all services + gateway, registers cleanup trap)
bash examples/demo/start.sh
```

**Manual steps (if you prefer)**

```bash
# Terminal 1 — demo services
node examples/demo/product-service.js &
node examples/demo/order-service.js &
node examples/demo/task-service.js &

# Terminal 2 — gateway
npm run dev
```

**Smoke test (61 assertions)**

```bash
python3 tests/demo_e2e.py --start-services
```

**Talk to the gateway**

```bash
# Initialize session
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# Discover registered services
curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_BEARER_TOKEN>" \
  -H "mcp-session-id: <session-id-from-above>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discover_services","arguments":{}}}'
```

**Expected response shape from `api.request()`:** `{ data, status, ok }` — never `{ body }`. Full contract and error handling: [`docs/skill-authoring.md`](docs/skill-authoring.md#apirequest-contract).

---

## 3. Project Layout

```
core/           Pure types, constants, config schema, shared utilities. No runtime deps.
runtime/        Gateway server, service registry, sandbox executor, API client. Imports spi/ only.
tools/          MCP tool handlers (discover_services, api_execute, …). Imports runtime/ + spi/.
spi/            Abstract contracts: ConnectorAPI, AuthMiddleware, PermissionGuard, SpecLoader, …
adapters/       Concrete implementations: in-memory, Memcache, Couchbase, static-token, oauth-introspection
wiring/         Composition root — strategy factories + service auth/circuit-breaker resolver.
                Imports adapters/ + spi/ to wire concrete strategies; runtime/ re-exports from here.
services/       Your service definitions — spec.yaml + config.json + skills/*.md (add yours here)
examples/
  demo/         Runnable local backends + start.sh
  01-06/        Scenario guides (README only)
tests/          Vitest unit + integration tests; demo_e2e.py smoke test
docs/           architecture.md, request-lifecycle.md
```

**Key layering rule:** `runtime/` must never import from `adapters/` directly — only from `spi/` interfaces. `wiring/` is the only layer that imports both `adapters/` and `spi/` — it is the composition root. `core/` has zero upward dependencies.

---

## 4. How to Add a Connector

Connectors are concrete implementations of SPI interfaces. Two common extension points:

### 4a. Token Cache Backend

**Base class:** `spi/auth/abstract-token-cache.ts` → `AbstractTokenCache`

Extend `AbstractTokenCache` — do not implement `TokenCacheStrategy` directly. The base class handles hashing, TTL, and all protocol methods; subclasses implement three storage primitives.

1. Create `adapters/auth/strategies/redis-token-cache.strategy.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { AbstractTokenCache, type CacheEntry } from '../../../spi/auth/abstract-token-cache.js'
import type { Logger } from '../../../runtime/observability/logger.js'

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

2. Register it at startup — **no framework changes required**:

```typescript
import { registerTokenCacheBackend } from './runtime/gateway/strategy-builders.js'
import { RedisTokenCache } from './adapters/auth/strategies/redis-token-cache.strategy.js'

registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs, logger))
```

3. Add `'redis'` to the `allowedTypes` array in `core/config/config.ts` at the `TOKEN_CACHE_TYPE` call site — `resolveStoreTypeConfig` validates against this list on startup and exits if the type is unrecognized.

4. Activate by setting `TOKEN_CACHE_TYPE=redis` in your environment (or `.env`). The registered factory is resolved at gateway startup — no `config.json` change needed.

### 4b. Idempotency Backend

**Interface:** `core/types/idempotency.types.ts` → `IdempotencyStrategy`

Same pattern — create under `adapters/idempotency/strategies/`, register with `registerIdempotencyBackend('postgres', ...)`.

### 4c. Outbound Transport (ConnectorAPI)

**Interface:** `spi/connector/connector-api.ts` → `ConnectorAPI`

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

Pass your connector instance when building service resources (see `runtime/server-factory.ts`).

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

**`config.json` skeleton**

```json
{
  "name": "my-service",
  "description": "What this service does",
  "api": {
    "host": "localhost",
    "port": 4000,
    "requestTimeoutMs": 10000,
    "maxRetries": 2
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

**Skill file (`skills/my-skill.md`) skeleton**

```markdown
---
id: my-skill
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
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_services","arguments":{}}}'
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

- `core/` → no imports from anything else in this repo
- `spi/` → may import `core/` only
- `adapters/` → may import `core/` and `spi/` only
- `runtime/` → may import `core/`, `spi/` only (not `adapters/` directly)
- `wiring/` → may import `core/`, `spi/`, `adapters/` (composition root — this is the only layer that wires concrete adapters)
- `tools/` → may import `core/`, `spi/`, `runtime/`

Violations get caught in review. When in doubt, check `docs/architecture.md`.

**Tests**

- Every non-trivial change needs test coverage
- Unit tests under `tests/unit/`, integration tests under `tests/integration/`
- Do not mock the database/cache layers in integration tests — use real in-memory strategies
- `npm test` must pass; `npm run typecheck` must be clean

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

4. Ensure CI passes (`.github/workflows/ci.yml` runs typecheck + tests on every push).

5. Address review feedback — push to the same branch; do not force-push after a review starts.

6. Once approved, a maintainer squash-merges.

**Commit message format**

```
<type>: <short summary in present tense>

Optional body — explain the why, not the what.
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

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
Implement `adapters/auth/strategies/redis-token-cache.strategy.ts` using `ioredis`.
Interface: `core/types/auth.types.ts → TokenCacheStrategy`.
Register via `registerTokenCacheBackend('redis', ...)`.
Include tests under `tests/unit/adapters/`.

**Redis idempotency connector** (`good-first-issue`, `connector`)
Same pattern as above but for `IdempotencyStrategy` (`core/types/idempotency.types.ts`).
File: `adapters/idempotency/strategies/redis-idempotency.strategy.ts`.
Register via `registerIdempotencyBackend('redis', ...)`.

**Filesystem idempotency connector** (`good-first-issue`, `connector`)
Persist idempotency keys to a local JSON file — useful for development without an external store.
File: `adapters/idempotency/strategies/filesystem-idempotency.strategy.ts`.
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
Create `examples/demo/docker-compose.yml` that starts all three demo services + the gateway.
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
