// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {createHash} from 'node:crypto'
import yaml from 'js-yaml'
import type {Logger} from '../../core/types/logger.types.js'
import type {GovernanceRuleDocument} from '../../spi/governance/rule-source.js'
import {readRuleDirectory} from '../../wiring/strategy-builders.js'
import {type GovernanceRule, governanceRuleSchema} from './rule-schema.js'

/** A rule plus where it came from and a content hash for audit (§35). */
export interface LoadedRule {
    rule: GovernanceRule
    /** The document it was read from: a file name, or a URL without credentials or query. */
    source: string
    /** sha256 of that document (first 12 hex chars used in decision records). */
    contentHash: string
}

/** `name@version#hash12` — the identifier stored on every decision. */
export function ruleVersionTag(loaded: LoadedRule): string {
    return `${loaded.rule.name}@${loaded.rule.version}#${loaded.contentHash.slice(0, 12)}`
}

export class GovernanceRuleLoadError extends Error {
    constructor(message: string, readonly file: string) {
        super(message)
        this.name = 'GovernanceRuleLoadError'
    }
}

/**
 * Validates a whole rule set — the documents one GovernanceRuleSource
 * returned, in order (that order is the tie-break for precedence — see the
 * evaluator).
 *
 * Fail loud: a document that does not parse or a rule that does not validate
 * throws, as does a rule name used twice anywhere in the set, so a typo can
 * never silently turn into "rule not enforced". At boot that stops the
 * gateway; on a refresh the caller keeps the previous set.
 */
export function parseRuleDocuments(documents: readonly GovernanceRuleDocument[], logger?: Logger, sourceName?: string): LoadedRule[] {
    const loaded: LoadedRule[] = []
    const seen = new Map<string, string>()
    for (const doc of documents) {
        const contentHash = createHash('sha256').update(doc.text).digest('hex')
        let raw: unknown
        try {
            raw = doc.format === 'json' ? JSON.parse(doc.text) : yaml.load(doc.text)
        } catch (err) {
            throw new GovernanceRuleLoadError(`${doc.name}: cannot parse — ${(err as Error).message}`, doc.name)
        }
        for (const rule of parseRuleFile(raw, doc.name, doc.name)) {
            const dup = seen.get(rule.name)
            if (dup) throw new GovernanceRuleLoadError(`${doc.name}: duplicate rule name "${rule.name}" (also in ${dup})`, doc.name)
            seen.set(rule.name, doc.name)
            loaded.push({rule, source: doc.name, contentHash})
        }
    }
    logger?.info({
        ...(sourceName !== undefined ? {source: sourceName} : {}),
        rules: loaded.map(ruleVersionTag)
    }, 'Governance rules loaded')
    return loaded
}

/** The rule files directly in `dir` (see readRuleDirectory), validated. A missing directory means no rules. */
export function loadGovernanceRules(dir: string, logger?: Logger): LoadedRule[] {
    return parseRuleDocuments(readRuleDirectory(dir, logger), logger, `file:${dir}`)
}

/**
 * A file holds one rule, a list of rules, or `{ rules: [...] }`. Each rule is
 * validated on its own so the error names the exact key that is wrong
 * (a union parse would only report "invalid input").
 */
function parseRuleFile(raw: unknown, file: string, path: string): GovernanceRule[] {
    const candidates: unknown[] =
        Array.isArray(raw) ? raw
            : raw !== null && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
                ? (raw as { rules: unknown[] }).rules
                : [raw]
    return candidates.map((candidate, index) => {
        const parsed = governanceRuleSchema.safeParse(candidate)
        if (parsed.success) return parsed.data
        const where = candidates.length > 1 ? ` (rule ${index + 1})` : ''
        const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        throw new GovernanceRuleLoadError(`${file}${where}: invalid Governance Rule — ${issues}`, path)
    })
}
