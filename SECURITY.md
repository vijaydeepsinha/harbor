# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a security issue, please open a [GitHub Security Advisory](https://github.com/vijaydeepsinha/harbor/security/advisories/new) (private disclosure). Include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix

You will receive a response within 5 business days. We will coordinate a fix and disclosure timeline with you.

## Scope

Areas of particular concern:

- **Sandbox escape** — code executing in the V8 isolate via `isolated-vm` (v5.x) accessing the host filesystem, network, or Node.js internals. Vulnerabilities in `isolated-vm` itself that allow sandbox escape or unbounded memory growth are in scope and treated as critical severity.
- **Token leakage** — bearer tokens exposed in logs, error messages, or API responses
- **Auth bypass** — requests reaching service backends without valid token validation
- **Governance bypass** — an `api.request()` call reaching a backend without the Governance Rules being evaluated first, or with a decision other than the one the rules produce (e.g. a path spelling that resolves to a different operation for the rules than on the wire)
- **`requestState` forgery or replay** — tampering with, forging, or reusing the sealed MRTR `requestState` to answer an approval that was not issued to you or has expired, or to have one approval decided twice
- **Cross-principal access** — inspecting, approving, rejecting, or resuming another principal's execution, over MCP or `/executions`
- **Replay divergence** — a resumed execution running a request other than the one journaled or approved, or re-sending a call whose outcome was recorded or is unknown
- **Harbor-owned header forgery** — a program setting or overriding `Authorization`, `X-Correlation-ID`, `X-Harbor-Server-ID`, `X-Harbor-Client-ID`, `X-Idempotency-Key` or other headers Harbor sets on outbound calls
- **Outbound request escape** — a program making Harbor send a request to a host, scheme or path outside the service's configured base URL (absolute or protocol-relative URLs, `..` or encoded-slash segments, routing headers)
- **Dependency vulnerabilities** — run `npm audit` to check known CVEs

Known limitations and open design decisions are listed in [`docs/code-mode-governance.md`](docs/code-mode-governance.md); a report that shows one of them is exploitable in a way the document does not describe is still welcome.

## Out of scope

- Vulnerabilities in services you connect to the gateway (those are your services' responsibility)
- Issues requiring physical access to the host machine
- Social engineering attacks
