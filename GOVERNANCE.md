# Governance

This file is about how the project is run. For the Governance Rules that decide whether Harbor makes an API call, see `governance/rules/README.md` and `docs/code-mode-governance.md`.

## Maintainer

**Vijaydeep Sinha** — project creator and primary maintainer.

Responsibilities: architectural decisions, release tagging, breaking-change review, merging contributions.

## Contribution Model

Community contributions are welcome. See `CONTRIBUTING.md` for setup, coding guidelines, and the PR process.

**Bug fixes and docs:** open a PR directly.

**New features and good-first-issues:** open an issue first to align on scope, then submit a PR.

**Architectural changes** require maintainer review and sign-off before merge. Open a GitHub issue describing the change before starting implementation. That covers anything that touches:

- the layer boundaries: `src/core/`, `src/spi/`, `src/adapters/`, `src/wiring/`, `src/runtime/`, `src/tools/`;
- the public extension points: `ConnectorAPI`, the `ExecutionPersistence`, `GovernanceRuleSource` and `AuditSink` SPIs, and the five registration functions (`registerTokenCacheBackend`, `registerIdempotencyBackend`, `registerExecutionStoreBackend`, `registerAuditSinkBackend`, `registerGovernanceRuleSourceBackend` in `src/wiring/strategy-builders.ts`);
- the MCP tool surface: the five tools (`discover_services`, `discover_skills`, `get_skill_details`, `search_code`, `api_execute`) and their input schemas are frozen;
- the Governance Rule file format (`governance/rules/README.md`, `src/runtime/governance/rule-schema.ts`).

## Decision Process

1. **Routine changes** (bug fixes, docs, new adapters, new service examples) — PR review by maintainer or a community reviewer with merge rights.
2. **Significant changes** (new SPI interfaces, sandbox behavior, tool contracts, Governance Rule semantics) — discussed in a GitHub issue; maintainer makes the final call.
3. **Breaking changes** — documented in `CHANGELOG.md`, communicated in the release notes, and tagged with a semver bump.

## Stability Commitments

See `API_STABILITY.md` for the stability legend. Public APIs marked ✅ Stable follow semver. Interfaces marked 🟡 Experimental may change between minor versions during the 1.x series.

## License

Apache License, Version 2.0. All contributions are accepted under the same license. See `LICENSE` and `NOTICE`.
