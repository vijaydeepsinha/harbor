# Harbor

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) gateway that connects AI clients to your existing backend APIs — without modifying those APIs.

[![CI](https://github.com/vijaydeepsinha/harbor/actions/workflows/ci.yml/badge.svg)](https://github.com/vijaydeepsinha/harbor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)

[![Harbor — One MCP Gateway, N Services, Zero Integration Code](https://github.com/user-attachments/assets/ff6fdec9-a041-4359-9fef-bf66214af895)](https://medium.com/@vijaydeepsinha18/one-mcp-gateway-n-services-zero-integration-code-c3a136d3b673)

*Read the full article on [Medium →](https://medium.com/@vijaydeepsinha18/one-mcp-gateway-n-services-zero-integration-code-c3a136d3b673)*

[![▶ Watch Demo](https://img.shields.io/badge/▶%20Watch%20Demo-4285F4?style=for-the-badge&logo=googledrive&logoColor=white)](https://drive.google.com/file/d/1FvWRvN0Y9x2Y2KhZ5v4xeOXhcJ_SmdZP/view?usp=sharing)

---

## The Problem

When an AI (Claude, Cursor, GPT) needs to interact with your backend APIs, it has no way to know what endpoints exist, what parameters they take, how to authenticate, or what business rules apply.

The standard fix — generating one MCP tool per endpoint — doesn't scale. A realistic API has hundreds of endpoints that overwhelm any AI context window.

**Harbor takes a different approach: Code Mode.** Instead of one tool per endpoint, the AI gets **five general-purpose tools** and writes JavaScript to interact with your API. The gateway runs that code in an isolated V8 sandbox, validates every call, and forwards it to your backend with proper auth and circuit breaking — all without changing a line of your API code.

```
AI client  →  Harbor  →  Your backend APIs
                    │
                    ├── V8 sandbox isolation
                    ├── Per-service auth (OAuth 2.1 / static token)
                    ├── Circuit breaker + retry
                    ├── Governance Rules + human approval
                    └── Audit logging
```

---

## Harbor Governance: Code Mode With Control

Connecting an agent to an API is only the first step. Once AI-authored code
can perform a write, the gateway must also answer: **may this exact operation
run now, and does a human need to approve it?**

Harbor Governance puts that decision in the host-side gateway, before every
backend call:

```text
Agent program
    ↓
V8 isolate ── api.request() ──► Harbor bridge
                                   ├─ resolve the OpenAPI operation
                                   ├─ evaluate Governance Rules
                                   ├─ journal the activity
                                   └─ ALLOW / DENY / REQUIRE_APPROVAL
```

Governance Rules are declarative policies over services, operations, methods,
paths, and request values. Gateway-owned rules can protect every service;
service-owned rules let an API team define policy beside its own spec. The
decisions are deterministic — `ALLOW`, `DENY`, or `REQUIRE_APPROVAL` — and a
paused execution persists until a human decides.

The key safety property is **durability, not prompt compliance**. Harbor
persists the original program and journals each external call. If an approval
is required, the isolate stops. On resume, Harbor reruns that original program
in a fresh isolate and replays completed activities from the journal, so an
already-completed `POST` is not sent twice. A changed request, divergent replay,
or unknown side-effect outcome fails closed.

For example, the included shopping demo uses a product catalog service and an
order service: orders at or below ₹5,000 execute directly, while orders above
₹5,000 require approval. Harbor's active
gateway-owned [`deny-all-delete.yaml`](governance/rules/deny-all-delete.yaml)
also blocks every `DELETE` by default.

**Skills and Governance Rules solve different problems:** Skills tell an agent
*how* to complete a workflow; Governance Rules decide *whether* a concrete
backend operation may execute. Use the Skill to explain the correct sequence,
and the Governance Rule to enforce the boundary that must not depend on the
model following instructions.

See [`docs/code-mode-governance.md`](docs/code-mode-governance.md) for the
execution lifecycle, replay contract, approval protocol, and threat model.

---

## Features

- **Five MCP tools** — `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`
- **V8 sandbox isolation** — AI-written JavaScript cannot access the network, filesystem, or framework internals
- **Pluggable auth** — `static-token`, `oauth-introspection`, `jwt-validation` (local JWKS, no AS round-trip), `oauth-2.1` (RFC 8414/OIDC auto-discovery)
- **OAuth 2.1 Protected Resource** — RFC 9728 discovery metadata, `WWW-Authenticate` on a 401 for a missing or malformed bearer (an invalid token is refused per tool call; see [`docs/mcp-2026-07-28-compatibility.md`](docs/mcp-2026-07-28-compatibility.md))
- **Code Mode governance** — durable executions, an activity journal with replay, and declarative Governance Rules evaluated before every backend call. Rules can be **gateway-owned** for cross-service policy or **service-owned** for one service; matching rules apply together with gateway/service/endpoint precedence and optional `final` overrides. Decisions support ALLOW / DENY / REQUIRE_APPROVAL and human approval over MCP ([`docs/code-mode-governance.md`](docs/code-mode-governance.md), [rule format and ownership](governance/rules/README.md))
- **Safe DELETE default** — Harbor ships an active gateway-owned `final` rule that blocks every `DELETE` call by default. If an agent receives `GOVERNANCE_DENIED` for a delete, this is the expected source; deployments that allow deletes must provide a reviewed policy directory instead of Harbor's default [`deny-all-delete.yaml`](governance/rules/deny-all-delete.yaml)
- **Pluggable backends** — register token-cache, idempotency, execution-store, audit-sink and rule-source backends in your entry point and select them by name, without forking the codebase
- **Per-service configuration** — each service declares its own auth, circuit breaker, and spec source
- **Zero API changes** — your backend never changes; Harbor is a pure adapter
- **Service skills** — Agent Skills-compatible Markdown SOP files with standard frontmatter that the AI reads before making API calls
- **Circuit breaker + safe retries** — count-based breaker per endpoint, per service; only idempotent methods (`GET`, `PUT`, `DELETE`) are retried, so a `POST` is never sent twice
- **Structured audit logging** — every `api_execute` call recorded with code, endpoints, duration, outcome, and sent to pluggable sinks (`AUDIT_SINKS`, console by default)
- **Streamable HTTP + stdio** — both MCP transports supported

---

## Quick Start

**Prerequisites:** Node.js 24+, npm 10+, native build tools (Xcode CLT on macOS / `build-essential` on Linux)

```bash
git clone https://github.com/vijaydeepsinha/harbor
cd harbor
npm install
```

**Run from an installed package:**

The npm package contains the gateway and its rule directory, but not the
repository demo services. Supply your own service directory:

```bash
SERVICES_DIR=/absolute/path/to/services npx harbor-gateway
```

Each child folder must contain the service `config.json` and OpenAPI spec; see
[`services/README.md`](services/README.md).

**Run the demo** (product, order and task backends plus the MCP gateway):

```bash
bash examples/demo/start.sh
```

The shopping demo uses INR. An agent finds products with the `product`
service, orders them with the `order` service, and has no reason to call the
unrelated `tasks` service. The order service derives the customer from the
caller's bearer token, so agents do not ask for a customer ID. Its
service-owned governance policy lets an order of ₹5,000 or less execute
directly, while an order above ₹5,000 pauses with `REQUIRE_APPROVAL`; the order
backend rejects totals that do not match the product price multiplied by
quantity. A single Code Mode program may contain multiple order calls: each
call is an independent governed activity, so every qualifying order gets its
own approval round while already-completed orders replay without being sent
again.

The governance E2E environment (`npm run governance:up`) also uses port 3333,
but serves test-only `commerce` and `ops` fixtures. Stop it with
`npm run governance:down` before connecting a client to the demo.

**Verify** (E2E smoke test, stdlib only):

```bash
python3 tests/demo_e2e.py --start-services
```

**Connect Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "harbor": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer <YOUR_BEARER_TOKEN>" }
    }
  }
}
```

**Connect Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "harbor": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer <YOUR_BEARER_TOKEN>" }
    }
  }
}
```

`<YOUR_BEARER_TOKEN>` must be a JWT or an opaque token of at least 32 base64url characters (`A–Z a–z 0–9 - _`) — e.g. the output of `openssl rand -hex 32`. Anything else is refused with HTTP 401. The demo services forward whatever bearer you send.

Full setup guide → [`docs/getting-started.md`](docs/getting-started.md)

---

## Documentation

| Guide | What it covers |
|-------|----------------|
| [`docs/getting-started.md`](docs/getting-started.md) | Full setup, demo walkthrough, Cursor integration |
| [`docs/service-onboarding.md`](docs/service-onboarding.md) | Adding services, full `config.json` reference |
| [`docs/skill-authoring.md`](docs/skill-authoring.md) | Writing skills — frontmatter, `api.request()` patterns, error handling |
| [`docs/configuration.md`](docs/configuration.md) | All environment variables and the per-service `config.json` reference |
| [`docs/adapter-guide.md`](docs/adapter-guide.md) | Custom connectors — Redis, gRPC, GraphQL |
| [`docs/oauth-2.1-guide.md`](docs/oauth-2.1-guide.md) | OAuth 2.1 setup and auth strategies |
| [`docs/architecture.md`](docs/architecture.md) | System design, layers, extension points |
| [`docs/tool-layer.md`](docs/tool-layer.md) | MCP protocol, sandbox model, tool contracts |
| [`docs/request-lifecycle.md`](docs/request-lifecycle.md) | End-to-end request trace |
| [`docs/faq.md`](docs/faq.md) | Troubleshooting and common questions |
| [`docs/code-mode-governance.md`](docs/code-mode-governance.md) | Durable executions, replay, Governance Rules, human approval over MCP |
| [`governance/rules/README.md`](governance/rules/README.md) | Governance Rule file format and operators |
| [`docs/mcp-2026-07-28-compatibility.md`](docs/mcp-2026-07-28-compatibility.md) | MCP 2026-07-28 protocol support |
| [`TESTING.md`](TESTING.md) | Test layers and how to run each |
| [`SUPPORT.md`](SUPPORT.md) | Support scope and where to report issues |
| [`ROADMAP.md`](ROADMAP.md) | Planned features and milestones |

---

## Governance test suite

`npm run test:governance` runs the MCP governance suite end to end: real MCP
2026-07-28 calls against the production image (Docker; `npm run test:governance -- --local`
runs the same suite with the gateway and mock as host processes), the real Governance Rules
engine, the real V8 isolate, the file store and a deterministic mock backend —
allow / deny / approval, multi-step workflows with several approvals, resume in
a fresh isolate, replay, restart survival, crash mid-call, security and
protocol edge cases — plus a Postman collection. See [`TESTING.md`](TESTING.md),
[`TEST_ARCHITECTURE.md`](TEST_ARCHITECTURE.md) and
[`tests/REQUIREMENT_COVERAGE.md`](tests/REQUIREMENT_COVERAGE.md).

## Development

```bash
npm run dev          # tsx watch — live reload
npm test             # vitest — unit + integration (839 passing, 1 skipped)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # eslint
npm run build        # tsc → dist/
```

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, coding guidelines, PR process, and good first issues.

---

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

By contributing you agree your contributions will be licensed under Apache 2.0.
