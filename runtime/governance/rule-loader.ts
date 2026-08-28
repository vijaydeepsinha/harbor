// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import type { Logger } from '../../core/types/logger.types.js'
import { governanceRuleSchema, type GovernanceRule } from './rule-schema.js'

/** A rule plus where it came from and a content hash for audit (§35). */
export interface LoadedRule {
  rule: GovernanceRule
  source: string
  /** sha256 of the file the rule was read from (first 12 hex chars used in decision records). */
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
 * Loads every `*.yaml` / `*.yml` / `*.json` under `dir`, in filename order
 * (that order is the tie-break for precedence — see the evaluator).
 *
 * Fail loud: a rule file that does not validate throws, so a typo can never
 * silently turn into "rule not enforced". A missing directory is not an
 * error — it means no rules, which the evaluator resolves to the configured
 * default decision.
 */
export function loadGovernanceRules(dir: string, logger?: Logger): LoadedRule[] {
  if (!existsSync(dir)) {
    logger?.info({ dir }, 'Governance rules directory absent — no rules loaded')
    return []
  }
  const files = readdirSync(dir)
    .filter(f => ['.yaml', '.yml', '.json'].includes(extname(f)))
    .sort()
  const loaded: LoadedRule[] = []
  const seen = new Map<string, string>()
  for (const file of files) {
    const path = join(dir, file)
    const text = readFileSync(path, 'utf8')
    const contentHash = createHash('sha256').update(text).digest('hex')
    let raw: unknown
    try {
      raw = extname(file) === '.json' ? JSON.parse(text) : yaml.load(text)
    } catch (err) {
      throw new GovernanceRuleLoadError(`${file}: cannot parse — ${(err as Error).message}`, path)
    }
    const rules = parseRuleFile(raw, file, path)
    for (const rule of rules) {
      const dup = seen.get(rule.name)
      if (dup) throw new GovernanceRuleLoadError(`${file}: duplicate rule name "${rule.name}" (also in ${dup})`, path)
      seen.set(rule.name, file)
      loaded.push({ rule, source: file, contentHash })
    }
  }
  logger?.info({ dir, rules: loaded.map(ruleVersionTag) }, 'Governance rules loaded')
  return loaded
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
