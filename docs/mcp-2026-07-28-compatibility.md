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
(`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, both `2.0.0`)
whose `createMcpHandler` / `serveStdio` entry points are stateless and speak
2026-07-28 only (`legacy: 'reject'`). The SDK owns the protocol wire layer
(HTTP header validation, version negotiation, request-envelope lifting,
cache-field emission, `server/discover`, `tools/list`, `requestState`
sealing). Harbor's own changes are confined to the application-facing seams
the SDK leaves to the server:

- response `_meta` carrying `io.modelcontextprotocol/serverInfo` (spec §10,
  recommended), plus a clean application-metadata channel;
- an advisory reader for request `_meta` and for the normalized MCP HTTP headers
  (routing/observability only, never authorization);
- explicit `server/discover` options — real capabilities, instructions, and
  conservative cache hints;
- OAuth 2.1 authorization hardening — required token resource binding;
- human approval of governed `api_execute` calls over the multi-round-trip
  pattern (`input_required` + form elicitation + sealed `requestState`);
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
| `serverInfo` | none | `io.modelcontextprotocol/serverInfo` on every tool result; `input_required` results carry only the `harbor/*` keys | RECOMMENDED (SHOULD) — done, except `input_required` |
| `ttlMs` / `cacheScope` | none | conservative hints for `tools/list`, `server/discover` | REQUIRED — done |
| MRTR — `input_required`, form elicitation, `requestState` | none | governance approvals pause `api_execute` and resume on the retry (§E) | done for approvals |
| OAuth 2.1 | present, `audience` optional | present, resource binding required | REQUIRED — hardened |
| RFC 9728 Protected Resource Metadata | none | served at `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` (RFC 9728 path-inserted) and `/mcp/.well-known/oauth-protected-resource`, when `HARBOR_RESOURCE_URI` is set | REQUIRED — done |
| RFC 8414 AS metadata | none | consumed via discovery | REQUIRED — done |
| Issuer validation | enforced (jose) | enforced (jose) | ALREADY COMPATIBLE |
| Token audience / resource binding | optional | required on `oauth-2.1` and `jwt-validation`; best-effort on `oauth-introspection` | REQUIRED — hardened |
| Issuer mix-up protection | — | per-AS issuer pinned + `jwks_uri` origin (SSRF) guard | REQUIRED — done |
| `WWW-Authenticate` | none | `Bearer resource_metadata="…"` on a transport 401 | REQUIRED — done |
| 401 for an invalid or expired token | — | transport returns 401 only for a missing or malformed bearer; a token the auth server rejects is an HTTP 200 tool error (§C) | PARTIAL — open |
| `Origin` validation (DNS rebinding) | none | none | OPEN |
| Version negotiation | implicit | single version, legacy rejected, surfaced on `/health` | REQUIRED — done |
| stdio transport | present | preserved (`legacy: 'reject'`) | ALREADY COMPATIBLE |
| CIMD / Dynamic Client Registration | none | N/A — Harbor is a resource server, not an AS/client | NOT APPLICABLE |
| Tasks | none | none | OPTIONAL — not implemented |
| MCP Apps | none | none | OPTIONAL — not implemented |
| sampling | none | none | OPTIONAL — not implemented |
| roots / logging / subscriptions / prompts / resources | none | none | OPTIONAL — not implemented |

---

## C. Authentication Changes

Harbor's four pluggable auth providers — `static-token`, `oauth-introspection`,
`jwt-validation`, `oauth-2.1` — are all preserved.

- **Token resource binding (RFC 8707) — required on `oauth-2.1` and
  `jwt-validation`.** Under MCP 2026-07-28 the resource server MUST reject
  tokens not bound to it, so `audience` (the gateway's canonical resource
  identifier) is required and validated on both JWT-based providers. A
  missing or blank `audience` fails closed at strategy construction and at
  config wiring (`src/wiring/service-wiring.ts`, the service is skipped). This
  closes a confused-deputy / token pass-through gap where a token minted for
  another resource behind the same authorization server would be accepted.
  `oauth-introspection` accepts an optional `audience`, checked only when the
  introspection response carries `aud` (RFC 7662 makes it optional).
- **JWT validation** — `exp` is required, and only asymmetric algorithms are
  accepted (RS/PS/ES 256–512, EdDSA). A token that cannot be verified with the
  issuer's keys (unknown `kid`, `alg: none`, HS*) is `TOKEN_INVALID`.
- **Introspection** — a response with `active` present and not `true` is
  `TOKEN_INVALID`; RFC 7662's absolute `exp` is honoured.
- **Issuer validation** — unchanged; `jose` enforces `iss` on every JWT.
- **Issuer mix-up / SSRF** — discovery rejects a `jwks_uri` whose origin differs
  from the authorization server.
- **`WWW-Authenticate` + RFC 9728 Protected Resource Metadata** — when
  `HARBOR_RESOURCE_URI` is set, a transport 401 carries
  `WWW-Authenticate: Bearer resource_metadata="<HARBOR_RESOURCE_URI>/.well-known/oauth-protected-resource"`,
  and Harbor serves the PRM document at the three paths above so clients can
  discover the AS (`authorization_servers` lists `HARBOR_AUTH_SERVERS`).
- **Where the token is checked.** The `/mcp` transport checks the bearer's
  *format* only: missing, duplicated (two `Authorization` headers), malformed
  scheme, over 8192 characters, control characters, or neither a JWT nor ≥ 32
  base64url characters ⇒ HTTP 401 (`MISSING_TOKEN` / `TOKEN_INVALID`). Whether
  the token is *valid* is decided per tool call by the service's auth strategy;
  a rejected or expired token comes back as an HTTP 200 tool error
  (`isError`, `TOKEN_INVALID` / `TOKEN_EXPIRED`), without `WWW-Authenticate`,
  and `discover_services` never validates it. The authorization spec expects a
  401 there — an open decision (see §J).

See [`oauth-2.1-guide.md`](oauth-2.1-guide.md).

---

## D. `_meta` Changes

- **Request `_meta`** — an advisory reader lifts the reserved namespace
  (`io.modelcontextprotocol/protocolVersion`, `clientInfo`,
  `clientCapabilities`), preferring the SDK-lifted request envelope and falling
  back to `params._meta`. It is used for observability/routing — and to see
  whether the client advertises `elicitation` — and is **never** consulted for
  authentication or authorization (spec §9, §19).
- **Response `_meta`** — every tool result carries `_meta`, built by a single
  helper so metadata never mixes into model-visible `content`.
- **`serverInfo`** — `io.modelcontextprotocol/serverInfo` (`{ name, version }`)
  is emitted on every tool result and cannot be overridden by application
  metadata (serverInfo is written last). Spec §10, recommended (SHOULD, not
  mandatory). The `input_required` result is built separately and carries only
  Harbor's own keys.
- **Application metadata** — `api_execute` results carry
  `harbor/execution-id`, `harbor/execution-status` and, while paused,
  `harbor/approval-id`. A client without elicitation resumes by sending
  `_meta["harbor/execution-id"]` on the request; Harbor treats it as a claim
  and re-checks that the caller owns that execution. `harbor/` is a placeholder
  vendor prefix (`META_PREFIX` in `src/core/constants.ts`).

---

## E. Human Approval over MCP (MRTR)

A governed `api_execute` call whose activity a Governance Rule marks
`REQUIRE_APPROVAL` pauses before the external call. No custom MCP method is
involved; the approval rides the 2026-07-28 multi-round-trip pattern:

1. **Pause.** When the request advertises `elicitation` in its client
   capabilities, the tool returns an `input_required` result
   (`approvalResult` / `buildInputRequired` in `src/tools/execute-api.tool.ts`)
   with one input request, `approval` — a form elicitation whose message
   describes the operation and whose schema asks for `approve` (boolean,
   required) and an optional `comment` (`buildElicitation` in
   `src/runtime/execution/approval-service.ts`) — and a `requestState`.
2. **Sealed state.** `requestState` holds the execution id, approval id,
   activity sequence and the caller's principal hash. The SDK codec seals it
   with HMAC-SHA256 (`GOVERNANCE_REQUEST_STATE_KEY`; a per-process random key
   when unset), a TTL (`GOVERNANCE_APPROVAL_TTL_SEC`) and a binding to the
   JSON-RPC method (`src/runtime/execution/request-state.ts`).
3. **Retry.** The client retries the same `tools/call` with the echoed
   `requestState` and `inputResponses.approval`. The SDK verifies the state
   before the handler runs (`requestState.verify` in
   `src/runtime/http/mcp-server-factory.ts`); a tampered or expired state is a
   JSON-RPC `-32602` error. The handler then re-checks the principal against
   the bearer it just authenticated, records the decision once (`accept` with
   `approve: true` approves; `approve: false` or `decline` rejects; `cancel`
   cancels), and resumes the persisted program in a fresh isolate — completed
   calls are replayed, never repeated. A retry without an answer is asked
   again.
4. **Fallback.** A client without `elicitation` gets an `APPROVAL_REQUIRED`
   tool error carrying the ids, decides over
   `POST /executions/{id}/approvals/{approvalId}`, and resumes with
   `_meta["harbor/execution-id"]`.

`ctx.mcpReq.elicitInput` (a server-initiated elicitation request) is not used;
it throws on 2026-07-28. Full description:
[`code-mode-governance.md`](code-mode-governance.md).

---

## F. Transport Hardening

- **Request body limit** — `/mcp` reads the body itself, up to
  `MCP_MAX_BODY_BYTES` (default 4 MiB), before handing the parsed value to the
  SDK. A larger declared or streamed body ⇒ HTTP 413 `PAYLOAD_TOO_LARGE` with
  `Connection: close`; a body that is not JSON ⇒ HTTP 400 with JSON-RPC
  `-32700` (`src/runtime/http/read-body.ts`).
- **Duplicate `Authorization`** — Node keeps only the first header; Harbor
  counts them on the raw header list and refuses two with 401
  (`duplicate_authorization_header`).

---

## G. Intentionally NOT Implemented

Excluded from scope because they are not required to keep an existing Harbor
capability compliant:

- **Tasks**
- **MCP Apps**
- **elicitation beyond governance approvals** — no URL-mode elicitation, no
  server-initiated `elicitation/create` requests
- **sampling, roots, logging, subscriptions**
- **new resources / prompts / tools**, dynamic tool generation
- **Dynamic Client Registration / CIMD** — Harbor is a resource server, not an
  authorization server or client.

---

## H. Files Changed (protocol upgrade)

Application-facing changes owned by Harbor:

- `src/core/constants.ts` — gateway version, reserved `_meta` key names, MCP HTTP
  header names, single `MCP_PROTOCOL_VERSION`, `harbor/*` meta keys, PRM routes.
- `src/tools/tool-helpers.ts` — response `_meta` builder, `serverInfo`,
  application-metadata channel, advisory request-`_meta` reader.
- `src/runtime/http/mcp-server-factory.ts` — `server/discover` options
  (capabilities, instructions, cache hints) and the `requestState.verify` hook.
- `src/runtime/http/mcp-request-identity.ts` — advisory MCP HTTP header reader.
- `src/runtime/http/http-gateway.ts`, `src/runtime/http/read-body.ts` —
  request-identity logging, the bounded body read; `/health` advertises the
  supported protocol version.
- `src/runtime/transport/stdio-gateway.ts` — SDK v2 `serveStdio`, `legacy: 'reject'`.
- `src/spi/auth/bearer-authorization.ts`, `src/runtime/http/oauth-metadata-handler.ts`,
  `src/core/types/oauth.types.ts` — `WWW-Authenticate` + RFC 9728 PRM.
- `src/adapters/auth/strategies/oauth-discovery.strategy.ts`,
  `src/adapters/auth/strategies/jwt-validation.strategy.ts`,
  `src/adapters/auth/strategies/resource-binding.ts`,
  `src/wiring/service-wiring.ts` — required token resource binding.
- `src/tools/execute-api.tool.ts`, `src/runtime/execution/request-state.ts`,
  `src/runtime/execution/approval-service.ts` — `input_required`, the approval
  elicitation, and the sealed `requestState`.

Each area has matching unit/integration tests under `tests/`.

---

## I. Tests

```bash
npm test
npm run typecheck
npm run build   # tsc
```

Protocol coverage: response `_meta`/serverInfo and request-`_meta` reader
(`tests/unit/tool-helpers.test.ts`), `server/discover` options
(`tests/unit/mcp-server-factory.test.ts`), MCP HTTP headers
(`tests/unit/mcp-request-identity.test.ts`), protocol-version surface and body
limits (`tests/unit/http-gateway.test.ts`), PRM
(`tests/unit/oauth-metadata-handler.test.ts`), OAuth resource binding
(`tests/unit/oauth-discovery.test.ts`, `tests/unit/jwt-validation.test.ts`,
`tests/unit/resource-binding.test.ts`, `tests/unit/service-wiring.test.ts`,
`tests/integration/oauth-jwt-auth.test.ts`), MRTR approval over the wire
(`tests/integration/mcp-approval-wire.test.ts`) and the `requestState` codec
(`tests/unit/request-state.test.ts`).

---

## J. Remaining Concerns

- **401 for invalid tokens.** `/mcp` answers 401 only for a missing or
  malformed bearer. A token the auth server rejects, or one that has expired,
  is an HTTP 200 tool error without `WWW-Authenticate`; `discover_services`
  never validates the token, and `/health` lists service names without one.
  Needs an owner decision.
- **`Origin` / `Host` validation.** Not implemented; the transport's DNS
  rebinding guidance asks servers to validate `Origin`. The SDK's host/origin
  validation helpers are not wired in.
- **`serverInfo` on `input_required`.** The approval pause result carries only
  the `harbor/*` keys in `_meta`.
- **Introspection transport.** The `oauth-introspection` default is GET with
  the token in the query string, and Harbor does not authenticate itself to
  the introspection endpoint.
- **Cancellation.** An MCP request cancellation is not propagated into a
  running `api_execute` sandbox; the run ends at its own time budget.
- The wire behaviors Harbor depends on (header validation, envelope lifting,
  cache-field emission, `server/discover`, `requestState` sealing) are treated
  as SDK-owned. If an SDK release changes those semantics, revisit the advisory
  readers, discovery options and the approval flow.
