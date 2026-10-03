// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** One document of Governance Rules as a source returns it, before validation. */
export interface GovernanceRuleDocument {
    /** File name or URL — names the document in load errors and in `LoadedRule.source`. */
    name: string
    /** `json` is parsed as JSON, `yaml` as YAML. */
    format: 'yaml' | 'json'
    text: string
}

/**
 * Where Governance Rules come from — a directory, a URL, or anything
 * registered with `registerGovernanceRuleSourceBackend` (object storage, a
 * config service, a database). Harbor asks for the whole set at boot and, when
 * `GOVERNANCE_RULES_REFRESH_SEC` > 0, again on every refresh; it validates the
 * set and swaps it in atomically, or keeps the previous set if anything is
 * wrong. So `load` must throw on any failure rather than return part of the
 * set: a missing document must never read as "that rule no longer exists".
 */
export interface GovernanceRuleSource {
    readonly name: string

    /** Every rule document, in the order that breaks precedence ties (file order for a directory). */
    load(): Promise<GovernanceRuleDocument[]>
}
