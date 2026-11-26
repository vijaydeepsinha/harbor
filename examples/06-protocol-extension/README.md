# Example 06 — Protocol Extension

Two extension points: stdio transport for AI clients that spawn the gateway as a process, and `ConnectorAPI` for replacing the HTTP transport entirely.

## stdio transport

Set `MCP_TRANSPORT=stdio`. The gateway reads JSON-RPC from stdin and writes to stdout. The AI client manages the process — no port binding needed.

This is how Claude Desktop integrates: it spawns the gateway on demand and communicates over the process stdio pipes. Configure it in `claude_desktop_config.json` with the gateway binary path, `MCP_TRANSPORT=stdio`, `MCP_TOKEN` (required: the bearer every stdio call presents — a JWT or at least 32 base64url characters, else the gateway exits at boot), and optionally `SERVICES_DIR` pointing at your services folder. See [`docs/getting-started.md`](../../docs/getting-started.md#stdio-mode-claude-desktop-spawns-the-process).

## ConnectorAPI

The `ConnectorAPI` interface in `src/spi/connector/connector-api.ts` is the outbound transport contract. The built-in `ApiClient` implements it over HTTP/axios. Implement the same interface to replace the transport with gRPC, GraphQL, a mock, or anything else.

Your implementation receives the request, the execution context (token payload, idempotency key, correlation id, abort signal), and must return `{ data, status, ok }`. Returning `ok: false` signals a 4xx. Throwing fails the call: the activity is journaled as failed and nothing retries it. Retries, idempotency, circuit-breaker failure recording and the Harbor-owned outbound headers all live in the built-in `ApiClient`, so a replacement connector must provide whatever of that it needs.

`createMcpGateway` has no option to inject a connector yet; the `ApiClient` is built per service in `src/runtime/gateway/service-resources-factory.ts`, which is where to swap yours in.
