# Harbor — MCP 2026-07-28 Compatibility

Harbor implements the MCP 2026-07-28 protocol requirements **applicable to its
supported MCP surface** — the fixed five-tool gateway (`discover_services`,
`discover_skills`, `get_skill_details`, `search_code`, `api_execute`) over
Streamable HTTP and stdio. It is **not** a full implementation of the MCP
2026-07-28 specification, by design.

This document is the compatibility audit and the record of what changed.

---

## A. Summary

The upgrade moves Harbor onto the MCP SDK v2 packages
(`@modelcontextprotocol/server`, `@modelcontextprotocol/node`) whose
`createMcpHandler` / `serveStdio` entry points are stateless and speak
2026-07-28 only (`legacy: 'reject'`). The SDK owns the protocol wire layer
(HTTP header validation, version negotiation, request-envelope lifting,
cache-field emission, `server/discover`, `tools/list`). Harbor's own changes are
confined to the application-facing seams the SDK leaves to the server:

- response `_meta` carrying `io.modelcontextprotocol/serverInfo` (spec §10,
  recommended), plus a clean application-metadata channel;
- an advisory reader for request `_meta` and for the normalized MCP HTTP headers
  (routing/observability only, never authorization);
- explicit `server/discover` options — real capabilities, instructions, and
  conservative cache hints;
- OAuth 2.1 authorization hardening — required token resource binding;
- an explicit single supported protocol version.

Harbor's architecture, five-tool surface, and pluggable per-service
authentication are unchanged.

---

## B. Compatibility Matrix

| MCP 2026-07-28 area | Harbor before | Harbor after | Status |
| --- | --- | --- | --- |
| Stateless protocol core | SDK v1 session model | SDK v2 `createMcpHandler`/`serveStdio`, stateless | REQUIRED — done (SDK) |
| `initialize` / `initialized` | handshake via old SDK | removed; SDK owns lifecycle | NOT APPLICABLE |
| `Mcp-Session-Id` | old session id | not used; stateless | NOT APPLICABLE |
| `MCP-Protocol-Version` header | none | SDK validates; Harbor reads advisory | ALREADY (SDK) + advisory reader |
| `Mcp-Method` header | none | SDK validates; Harbor reads advisory | ALREADY (SDK) + advisory reader |
| `Mcp-Name` header | none | SDK validates; Harbor reads advisory | ALREADY (SDK) + advisory reader |
| `server/discover` | implicit | explicit capabilities + instructions + cache hints | REQUIRED — done |
| Request `_meta` | none | advisory reader (protocol version, clientInfo, clientCapabilities) | REQUIRED — done |
| Response `_meta` | none | attached to every tool result | REQUIRED — done |
| `serverInfo` | none | `io.modelcontextprotocol/serverInfo` on every response | RECOMMENDED (SHOULD) — done |
| `ttlMs` / `cacheScope` | none | conservative hints for `tools/list`, `server/discover` | REQUIRED — done |
| OAuth 2.1 | present, `audience` optional | present, resource binding required | REQUIRED — hardened |
| RFC 9728 Protected Resource Metadata | none | served at `/.well-known/oauth-protected-resource` | REQUIRED — done |
| RFC 8414 AS metadata | none | consumed via discovery | REQUIRED — done |
| Issuer validation | enforced (jose) | enforced (jose) | ALREADY COMPATIBLE |
| Token audience / resource binding | optional | required on `oauth-2.1` path | REQUIRED — hardened |
| Issuer mix-up protection | — | per-AS issuer pinned + `jwks_uri` origin (SSRF) guard | REQUIRED — done |
| `WWW-Authenticate` | none | `Bearer resource_metadata="…"` on 401 | REQUIRED — done |
| Version negotiation | implicit | single version, legacy rejected, surfaced on `/health` | REQUIRED — done |
| stdio transport | present | preserved (`legacy: 'reject'`) | ALREADY COMPATIBLE |
| CIMD / Dynamic Client Registration | none | N/A — Harbor is a resource server, not an AS/client | NOT APPLICABLE |
| Tasks | none | none | OPTIONAL — not implemented |
| MCP Apps | none | none | OPTIONAL — not implemented |
| MRTR / HITL / elicitation / sampling | none | none | OPTIONAL — not implemented |
| roots / logging / subscriptions / prompts / resources | none | none | OPTIONAL — not implemented |

---

## C. Authentication Changes

Harbor's four pluggable auth providers — `static-token`, `oauth-introspection`,
`jwt-validation`, `oauth-2.1` — are all preserved. No provider was removed or
weakened.

- **Token resource binding (RFC 8707) — new, required on the `oauth-2.1`
  path.** The OAuth 2.1 discovery strategy previously accepted any `aud` when
  `audience` was unset. Under MCP 2026-07-28 the resource server MUST reject
  tokens not bound to it, so `audience` (the gateway's canonical resource
  identifier) is now required and validated. Missing/blank `audience` fails
  closed at both strategy construction and config wiring. This closes a
  confused-deputy / token pass-through gap where a token minted for another
  resource behind the same authorization server would be accepted.
- **Issuer validation** — unchanged; `jose` enforces `iss` on every JWT.
- **Issuer mix-up / SSRF** — discovery rejects a `jwks_uri` whose origin differs
  from the authorization server.
- **`WWW-Authenticate` + RFC 9728 Protected Resource Metadata** — a tokenless
  request receives `401` with `WWW-Authenticate: Bearer resource_metadata="…"`,
  and Harbor serves the PRM document so clients can discover the AS.
- The lower-level `jwt-validation` provider keeps `audience` optional for
  standalone use; the protocol-facing `oauth-2.1` path is the one 2026-07-28
  governs.

See [`oauth-2.1-guide.md`](oauth-2.1-guide.md).

---

## D. `_meta` Changes

- **Request `_meta`** — an advisory reader lifts the reserved namespace
  (`io.modelcontextprotocol/protocolVersion`, `clientInfo`,
  `clientCapabilities`), preferring the SDK-lifted request envelope and falling
  back to `params._meta`. It is used for observability/routing only and is
  **never** consulted for authentication or authorization (spec §9, §19).
- **Response `_meta`** — every tool result carries `_meta`, built by a single
  helper so metadata never mixes into model-visible `content`.
- **`serverInfo`** — `io.modelcontextprotocol/serverInfo` (`{ name, version }`)
  is emitted on every response and cannot be overridden by application
  metadata (serverInfo is written last). Spec §10, recommended (SHOULD, not
  mandatory).
- **Application metadata** — the same `_meta` helper accepts an optional
  application-metadata object, establishing a clean client-facing channel
  (correlation/audit/workflow ids in future) without contaminating content.
  This is **plumbing only** — no HITL, approval, elicitation, or Tasks state
  machine is implemented (spec §11, §12).

---

## E. Intentionally NOT Implemented

Excluded from scope because they are not required to keep an existing Harbor
capability compliant:

- **Tasks**
- **MCP Apps**
- **full MRTR / Human-in-the-Loop**, elicitation, `input_required`, approval
  workflows (only the `_meta` transport that could later carry such state)
- **sampling, roots, logging, subscriptions**
- **new resources / prompts / tools**, dynamic tool generation
- **Dynamic Client Registration / CIMD** — Harbor is a resource server, not an
  authorization server or client.

---

## F. Files Changed (protocol upgrade)

Application-facing changes owned by Harbor:

- `core/constants.ts` — gateway version, reserved `_meta` key names, MCP HTTP
  header names, single `MCP_PROTOCOL_VERSION`.
- `tools/tool-helpers.ts` — response `_meta` builder, `serverInfo`,
  application-metadata channel, advisory request-`_meta` reader.
- `runtime/http/mcp-server-factory.ts` — `server/discover` options
  (capabilities, instructions, cache hints).
- `runtime/http/mcp-request-identity.ts` — advisory MCP HTTP header reader.
- `runtime/http/http-gateway.ts` — request-identity logging; `/health`
  advertises the supported protocol version.
- `runtime/transport/stdio-gateway.ts` — SDK v2 `serveStdio`, `legacy: 'reject'`.
- `spi/auth/bearer-authorization.ts`, `runtime/http/oauth-metadata-handler.ts`,
  `core/types/oauth.types.ts` — `WWW-Authenticate` + RFC 9728 PRM.
- `adapters/auth/strategies/oauth-discovery.strategy.ts`,
  `wiring/service-wiring.ts`, `core/types/config.types.ts` — required token
  resource binding on `oauth-2.1`.

Each area has matching unit/integration tests under `tests/`.

---

## G. Tests

```bash
npm test        # vitest run — 345 passing
npm run typecheck
npm run build   # tsc
```

New/updated protocol coverage: response `_meta`/serverInfo and request-`_meta`
reader (`tests/unit/tool-helpers.test.ts`), `server/discover` options
(`tests/unit/mcp-server-factory.test.ts`), MCP HTTP headers
(`tests/unit/mcp-request-identity.test.ts`), protocol-version surface
(`tests/unit/http-gateway.test.ts`), OAuth resource binding
(`tests/unit/oauth-discovery.test.ts`, `tests/unit/service-wiring.test.ts`,
`tests/integration/oauth-jwt-auth.test.ts`).

---

## H. Remaining Concerns

- The SDK v2 packages are pre-1.0 (`2.0.0-beta.4`); the wire behaviors Harbor
  depends on (header validation, envelope lifting, cache-field emission,
  `server/discover`) are treated as SDK-owned. If the SDK's final release
  changes those semantics, revisit the advisory readers and discovery options.
- Token resource binding is enforced on the `oauth-2.1` path by requiring
  `audience`. Operators using `jwt-validation` standalone should set `audience`
  themselves if they want the same guarantee; it is intentionally left optional
  there to preserve that provider's existing behavior.
</content>
