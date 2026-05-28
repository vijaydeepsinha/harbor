# Example 06 — Protocol Extension

Two extension points: stdio transport for AI clients that spawn the gateway as a process, and `ConnectorAPI` for replacing the HTTP transport entirely.

## stdio transport

Set `MCP_TRANSPORT=stdio`. The gateway reads JSON-RPC from stdin and writes to stdout. The AI client manages the process — no port binding needed.

This is how Claude Desktop integrates: it spawns the gateway on demand and communicates over the process stdio pipes. Configure it in `claude_desktop_config.json` with the gateway binary path, `MCP_TRANSPORT=stdio`, and `SERVICES_DIR` pointing at your services folder.

## ConnectorAPI

The `ConnectorAPI` interface in `spi/connector/connector-api.ts` is the outbound transport contract. The built-in `ApiClient` implements it over HTTP/axios. Implement the same interface to replace the transport with gRPC, GraphQL, a mock, or anything else.

Your implementation receives the request, the execution context (token payload, idempotency key), and must return `{ data, status, ok }`. Returning `ok: false` signals a 4xx — no circuit failure. Throwing signals a 5xx — circuit failure is recorded and the call is retried.

Full injection via `createMcpGateway` is planned for v1.1. See `docs/architecture.md` for the current `ServiceRegistry` workaround.
