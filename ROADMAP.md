# Roadmap

This document outlines the planned direction for Harbor.
It is aspirational — timelines depend on contributor activity.

---

## 1.0.0 — Code Mode governance (done)

Design and behaviour: `docs/code-mode-governance.md`; rule format: `governance/rules/README.md`.

- [x] Durable executions: the original program is persisted and authoritative; an `executionId` survives approval rounds and resumes in a fresh isolate
- [x] Activity journal at the sandbox bridge: journal before call, replay of completed calls, `REPLAY_DIVERGED` on a changed program, unknown outcomes fail closed
- [x] Governance Rules: OpenAPI-operation targeting, condition trees, gateway / service / endpoint levels with `final`, `DENY > REQUIRE_APPROVAL > ALLOW`, default decision for targeted-unmatched calls
- [x] Per-service rule sources: directory (default), URL, or `registerGovernanceRuleSourceBackend`; each service refreshes independently and keeps its last valid set
- [x] Human approval over MCP 2026-07-28 (`input_required` + form elicitation + HMAC-sealed `requestState`), with an owner-bound HTTP fallback (`/executions/{id}`, `/executions/{id}/approvals/{approvalId}`)
- [x] Execution stores: in-memory, file, memcache (shared across pods), or `registerExecutionStoreBackend`; retention of terminal executions and their program text
- [x] Audit sink interface and pipeline (`AUDIT_SINKS`, `registerAuditSinkBackend`) — audit records and execution-state events
- [x] Review hardening (2026-09-27): one canonical `api.request` path for rules, journal and wire; forbidden program headers; POST/PATCH never re-sent; per-execution, per-call idempotency keys; runs drain calls the program did not await; concurrent calls admitted one at a time; JWT `exp` and asymmetric algorithms required, introspection honours `active`/`exp`; `/mcp` and `/executions` body limits; registered backends selectable by env name

---

## Open decisions and known gaps

Found in the 2026-09-27 review and not yet fixed. Several need an owner decision before they are code.

### Governance semantics
- [ ] Fail closed for unresolved operations? A call no rule targets is ALLOW (`NO_GOVERNANCE`) even with `GOVERNANCE_DEFAULT_DECISION=DENY`, and a path not in the spec is always untargeted unless a `*` or `/**` rule covers it
- [ ] Validate rule targets against the specs: a typo in `operation` / `service` / `path`, or a spec refresh that renames an operationId or drops a path, silently un-governs the operation
- [ ] `final` pins the broadest final level whatever its action (a gateway `final ALLOW` beats a service `final DENY`)
- [ ] Operators: `not_in` / `not_equals` on a missing field never match (a DENY rule fails open); no case-insensitive or array-any operators; numeric strings in a body compare strictly
- [ ] Principal-aware rules: rules see no caller identity today

### Approvals
- [ ] Re-evaluate rules on resume: a rule change between approval and resume is not applied, and stored approvals never expire (only `requestState` does)
- [ ] An approver role: the approver is the requester's own principal (self-approval)
- [ ] Concurrent approval-gated calls (`Promise.all`) resume in arrival order; if two siblings with one template race differently, the run stops with `REPLAY_DIVERGED` rather than executing the wrong one
- [ ] Transactional decisions: approval, activity and execution are separate store writes
- [ ] An API to cancel a running execution

### Auth and front door
- [ ] Decide whether `/mcp` answers an invalid or expired token with `401` + `WWW-Authenticate`: the transport checks only the bearer's format, so today it is HTTP 200 with a tool error; `discover_services` needs no valid token; `/health` lists service names
- [ ] Origin / Host validation (DNS rebinding)
- [ ] Introspection defaults to GET with the token in the query string, and sends no client authentication
- [ ] Bound the in-memory token cache; the static-token strategy caches any bearer

### Resource limits
- [ ] Cap backend response size (held in host memory) and the request bodies a program sends
- [ ] Idempotency strategies cache non-2xx responses (401 included) for the TTL — now keyed per execution and call, so the impact is limited

### Stores
- [ ] Memcache store: the lock owner is the process, `releaseLock` is get + delete, and index read-modify-write is serialised within a run but not across pods
- [ ] File store: no fsync; unreadable documents are skipped at boot

### Services and packaging
- [ ] `url` / `url-with-fallback` spec sources fetch the URL only on refresh, never at boot; a url-only service with no local spec file is skipped
- [ ] `config.json` is not schema-validated (`"enabled": "false"` is truthy, a partial `tls` block is dropped); a missing `config.json` skips the service
- [ ] Production Dockerfile ships no `governance/rules` (zero rules unless mounted), and its HEALTHCHECK uses `localhost` (IPv6 on Alpine)

### Observability
- [x] Error-path audit lines carry the authenticated `userIdHash` (they read `"unknown"` until the PR #7 follow-up)
- [ ] Metrics injection seam; pino redaction; full results and code are logged at info in places

---

## v1.x — Hardening & Ecosystem

### Observability
- [ ] OpenTelemetry trace propagation
- [ ] Prometheus `/metrics` endpoint
- [ ] Built-in S3 / GCS / file audit sinks

### Auth
- [ ] mTLS client certificate strategy

### Extension points (see `API_STABILITY.md`, Future Extension Points)
- [ ] `ConnectorAPI` injection through `createMcpGateway` (today a custom connector means building `ServiceResources` yourself)
- [ ] `ProtocolAdapter` — pluggable MCP transport
- [ ] `SkillProvider` — skills from a database or remote CMS

### Developer Experience
- [ ] `harbor init` CLI scaffold
- [ ] Hot-reload service configs without gateway restart
- [ ] JSON Schema validation for `config.json` at load time

---

## v2.x — Multi-modal & Cloud

- [ ] WebSocket transport alongside Streamable HTTP
- [ ] Multi-tenant service namespacing
- [ ] Remote service registry (etcd / Consul adapter)
- [ ] Kubernetes operator for automatic service discovery from CRDs

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) to propose features or claim roadmap items.
