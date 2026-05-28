# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a security issue, please open a [GitHub Security Advisory](https://github.com/vdssinha/harbor/security/advisories/new) (private disclosure). Include:

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
- **Dependency vulnerabilities** — run `npm audit` to check known CVEs

## Out of scope

- Vulnerabilities in services you connect to the gateway (those are your services' responsibility)
- Issues requiring physical access to the host machine
- Social engineering attacks
