# Governance

## Maintainer

**Vijaydeep Sinha** — project creator and primary maintainer.

Responsibilities: architectural decisions, release tagging, breaking-change review, merging contributions.

## Contribution Model

Community contributions are welcome. See `CONTRIBUTING.md` for setup, coding guidelines, and the PR process.

**Bug fixes and docs:** open a PR directly.

**New features and good-first-issues:** open an issue first to align on scope, then submit a PR.

**Architectural changes** — anything that touches the layer boundaries (`core/`, `spi/`, `runtime/`, `tools/`, `adapters/`) or the public extension points (`ConnectorAPI`, `registerTokenCacheBackend`, `registerIdempotencyBackend`) — require maintainer review and sign-off before merge. Open a GitHub issue describing the change before starting implementation.

## Decision Process

1. **Routine changes** (bug fixes, docs, new adapters, new service examples) — PR review by maintainer or a community reviewer with merge rights.
2. **Significant changes** (new SPI interfaces, sandbox behavior, tool contracts) — discussed in a GitHub issue; maintainer makes the final call.
3. **Breaking changes** — documented in `CHANGELOG.md`, communicated in the release notes, and tagged with a semver bump.

## Stability Commitments

See `API_STABILITY.md` for the stability legend. Public APIs marked ✅ Stable follow semver. Interfaces marked 🟡 Experimental may change between minor versions during the v0.x series.

## License

Apache License, Version 2.0. All contributions are accepted under the same license. See `LICENSE` and `NOTICE`.
