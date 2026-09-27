# Roadmap

This document outlines the planned direction for Harbor.
It is aspirational — timelines depend on contributor activity.

---

## v1.x — Hardening & Ecosystem

### Observability
- [ ] OpenTelemetry trace propagation
- [ ] Prometheus `/metrics` endpoint
- [x] Audit sink interface and pipeline (`AUDIT_SINKS`, `registerAuditSinkBackend`) — audit records and execution state
- [ ] Built-in S3 / GCS / file audit sinks

### Auth
- [ ] mTLS client certificate strategy

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
