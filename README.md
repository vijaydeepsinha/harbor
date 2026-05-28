# Harbor

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) gateway that connects AI clients to your existing backend APIs — without modifying those APIs.

[![CI](https://github.com/vdssinha/harbor/actions/workflows/ci.yml/badge.svg)](https://github.com/vdssinha/harbor/actions/workflows/ci.yml)
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
                    └── Audit logging
```

---

## Features

- **Five MCP tools** — `discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`
- **V8 sandbox isolation** — AI-written JavaScript cannot access the network, filesystem, or framework internals
- **Pluggable auth** — `static-token`, `oauth-introspection`, `jwt-validation` (local JWKS, no AS round-trip), `oauth-2.1` (RFC 8414/OIDC auto-discovery)
- **OAuth 2.1 Protected Resource** — RFC 9728 discovery metadata, `WWW-Authenticate` on 401, full MCP auth flow
- **Pluggable backends** — register custom token-cache backends without forking the codebase
- **Per-service configuration** — each service declares its own auth, circuit breaker, and spec source
- **Zero API changes** — your backend never changes; Harbor is a pure adapter
- **Service skills** — Markdown SOP files the AI reads before making API calls
- **Circuit breaker** — count-based, per endpoint, per service
- **Structured audit logging** — every `api_execute` call logged with code, endpoints, duration, outcome
- **Streamable HTTP + stdio** — both MCP transports supported

---

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+, native build tools (Xcode CLT on macOS / `build-essential` on Linux)

```bash
git clone https://github.com/vdssinha/harbor
cd harbor
npm install
```

**Run the demo** (three local backends + MCP gateway):

```bash
bash examples/demo/start.sh
```

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

Full setup guide → [`docs/getting-started.md`](docs/getting-started.md)

---

## Documentation

| Guide | What it covers |
|-------|----------------|
| [`docs/getting-started.md`](docs/getting-started.md) | Full setup, demo walkthrough, Cursor integration |
| [`docs/service-onboarding.md`](docs/service-onboarding.md) | Adding services, full `config.json` reference |
| [`docs/skill-authoring.md`](docs/skill-authoring.md) | Writing skills — frontmatter, `api.request()` patterns, error handling |
| [`docs/configuration.md`](docs/configuration.md) | All environment variables |
| [`docs/adapter-guide.md`](docs/adapter-guide.md) | Custom connectors — Redis, gRPC, GraphQL |
| [`docs/oauth-2.1-guide.md`](docs/oauth-2.1-guide.md) | OAuth 2.1 setup and auth strategies |
| [`docs/architecture.md`](docs/architecture.md) | System design, layers, extension points |
| [`docs/tool-layer.md`](docs/tool-layer.md) | MCP protocol, sandbox model, tool contracts |
| [`docs/request-lifecycle.md`](docs/request-lifecycle.md) | End-to-end request trace |
| [`docs/faq.md`](docs/faq.md) | Troubleshooting and common questions |
| [`ROADMAP.md`](ROADMAP.md) | Planned features and milestones |

---

## Development

```bash
npm run dev          # tsx watch — live reload
npm test             # vitest — 312 unit + integration tests
npm run typecheck    # tsc --noEmit (strict)
npm run build        # tsc → dist/
```

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, coding guidelines, PR process, and good first issues.

---

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

By contributing you agree your contributions will be licensed under Apache 2.0.
