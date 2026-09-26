// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AllowedHttpMethod, GovernanceDecisionType } from '../../core/constants.js'
import { GOVERNANCE_DECISION, GOVERNANCE_PRECEDENCE, GOVERNANCE_REASON } from '../../core/constants.js'
import type { LoadedRule } from './rule-loader.js'
import { ruleVersionTag } from './rule-loader.js'
import { CONDITION_OPERATORS, PATH_SUBTREE_SUFFIX, type Condition, type ConditionLeaf, type ConditionNode, type GovernanceRule } from './rule-schema.js'

/** Everything the evaluator may look at (§17). Plain data — no I/O, no clock, no model. */
export interface GovernanceRequest {
  executionId: string
  activitySequence: number
  service: string
  method: AllowedHttpMethod
  specPath: string
  operationId?: string
  pathParams?: Record<string, string>
  query?: Record<string, unknown>
  body?: unknown
}

export interface GovernanceOutcome {
  decision: GovernanceDecisionType
  reason: string
  matchedRules: string[]
  ruleVersions: string[]
  decidingRule?: string
}

/**
 * Deterministic evaluator (§21–§22).
 *
 * 1. A rule *matches* when every clause in `match` equals the request (or
 *    is `*`) and its `conditions` tree holds (`allOf` AND, `anyOf` OR, `not`
 *    NOT). A leaf on a missing field — or on a computed operand that cannot be
 *    computed — holds only for `exists: false`; comparisons between
 *    mismatched types are false.
 * 2. Among matched rules the strongest action wins:
 *    DENY > REQUIRE_APPROVAL > ALLOW. The deciding rule is the first (file
 *    order) rule carrying the winning action.
 * 3. No rule matches ⇒ `defaultDecision` (`NO_MATCHING_RULE`).
 * 4. Any internal error ⇒ DENY (`GOVERNANCE_EVALUATION_FAILED`). Fail closed.
 */
export function evaluateGovernance(
  rules: readonly LoadedRule[],
  request: GovernanceRequest,
  defaultDecision: GovernanceDecisionType
): GovernanceOutcome {
  try {
    const matched = rules.filter(r => ruleMatches(r.rule, request))
    if (matched.length === 0) {
      return { decision: defaultDecision, reason: GOVERNANCE_REASON.NO_MATCHING_RULE, matchedRules: [], ruleVersions: [] }
    }
    let winner = matched[0] as LoadedRule
    for (const r of matched) {
      if (GOVERNANCE_PRECEDENCE[r.rule.action.type] > GOVERNANCE_PRECEDENCE[winner.rule.action.type]) winner = r
    }
    return {
      decision: winner.rule.action.type,
      reason: winner.rule.action.reason ?? `${GOVERNANCE_REASON.RULE_MATCHED}: ${winner.rule.name}`,
      matchedRules: matched.map(r => r.rule.name),
      ruleVersions: matched.map(ruleVersionTag),
      decidingRule: winner.rule.name
    }
  } catch (err) {
    return {
      decision: GOVERNANCE_DECISION.DENY,
      reason: `${GOVERNANCE_REASON.EVALUATION_FAILED}: ${(err as Error).message}`,
      matchedRules: [],
      ruleVersions: []
    }
  }
}

function ruleMatches(rule: GovernanceRule, req: GovernanceRequest): boolean {
  const m = rule.match
  if (m.service !== undefined && !clause(m.service, req.service)) return false
  if (m.operation !== undefined && !clause(m.operation, req.operationId)) return false
  if (m.method !== undefined && m.method !== req.method) return false
  if (m.path !== undefined && !pathClause(m.path, req.specPath)) return false
  return rule.conditions === undefined || conditionsHold(rule.conditions, req)
}

/** `allOf` = AND, `anyOf` = OR, `not` = NOT; a leaf compares its operand. */
function conditionsHold(node: ConditionNode, req: GovernanceRequest): boolean {
  switch (node.kind) {
    case 'allOf': return node.allOf.every(child => conditionsHold(child, req))
    case 'anyOf': return node.anyOf.some(child => conditionsHold(child, req))
    case 'not': return !conditionsHold(node.not, req)
    case 'leaf': return comparisonHolds(node, operandValue(node, req))
  }
}

const MS_PER_DAY = 86_400_000
/** Computed numbers are rounded to this many decimals, so 100 × 1.1 compares as 110, not 110.00000000000001. */
const COMPUTED_DECIMALS = 9

/**
 * The value a leaf compares: a request field, or a number computed from two
 * fields. A computed operand that cannot be computed — a missing or
 * non-numeric field, a zero denominator, a date that is not strict ISO 8601 —
 * is `undefined`, i.e. treated exactly like a missing field.
 */
export function operandValue(leaf: ConditionLeaf, req: GovernanceRequest): unknown {
  if (leaf.field !== undefined) return readField(req, leaf.field)
  if (leaf.ratio) return roundComputed(divide(readField(req, leaf.ratio.numerator), readField(req, leaf.ratio.denominator)))
  if (leaf.percent_of) {
    const part = readField(req, leaf.percent_of.part)
    return roundComputed(divide(typeof part === 'number' ? part * 100 : undefined, readField(req, leaf.percent_of.whole)))
  }
  if (leaf.days_between) {
    const from = isoInstant(readField(req, leaf.days_between.from))
    const to = isoInstant(readField(req, leaf.days_between.to))
    return from === undefined || to === undefined ? undefined : roundComputed((to - from) / MS_PER_DAY)
  }
  return undefined
}

function divide(numerator: unknown, denominator: unknown): number | undefined {
  if (typeof numerator !== 'number' || typeof denominator !== 'number') return undefined
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined
  return numerator / denominator
}

function roundComputed(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const factor = 10 ** COMPUTED_DECIMALS
  return Math.round(value * factor) / factor
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Date-times need an explicit zone (`Z` or ±hh:mm): without one, JS reads them in the host's local time zone. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** Epoch ms of a strict ISO 8601 date or zoned date-time; `undefined` otherwise (JS would roll 2026-02-30 over to March). */
function isoInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parts = ISO_DATE.exec(value) ?? ISO_DATE_TIME.exec(value)
  if (!parts) return undefined
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** `/campaigns/**` targets `/campaigns` and every template beneath it — segment-wise, so not `/campaigns-archive`. */
function pathClause(pattern: string, specPath: string): boolean {
  if (!pattern.endsWith(PATH_SUBTREE_SUFFIX)) return clause(pattern, specPath)
  const prefix = pattern.slice(0, -PATH_SUBTREE_SUFFIX.length)
  return specPath === prefix || specPath.startsWith(`${prefix}/`)
}

function clause(expected: string, actual: string | undefined): boolean {
  return expected === '*' ? actual !== undefined : expected === actual
}

/** `budget` ≡ `body.budget`; `query.x`, `path.x`, `body.x.y` select explicitly. Arrays may be indexed numerically. */
export function readField(req: GovernanceRequest, field: string): unknown {
  const parts = field.split('.')
  let root: unknown
  let rest: string[]
  switch (parts[0]) {
    case 'body': root = req.body; rest = parts.slice(1); break
    case 'query': root = req.query; rest = parts.slice(1); break
    case 'path': root = req.pathParams; rest = parts.slice(1); break
    default: root = req.body; rest = parts
  }
  let cur: unknown = root
  for (const p of rest) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** The comparison operators of a leaf (or flat-form field), all ANDed. */
function comparisonHolds(c: Condition, value: unknown): boolean {
  if (c.exists !== undefined && (value !== undefined) !== c.exists) return false
  if (value === undefined) {
    // Only `exists: false` can be satisfied by a missing field.
    // (A leaf also carries its operand keys — only the operators count here.)
    return CONDITION_OPERATORS.every(k => c[k] === undefined || k === 'exists')
  }
  if (c.equals !== undefined && value !== c.equals) return false
  if (c.not_equals !== undefined && value === c.not_equals) return false
  if (c.greater_than !== undefined && !(typeof value === 'number' && value > c.greater_than)) return false
  if (c.greater_than_or_equal !== undefined && !(typeof value === 'number' && value >= c.greater_than_or_equal)) return false
  if (c.less_than !== undefined && !(typeof value === 'number' && value < c.less_than)) return false
  if (c.less_than_or_equal !== undefined && !(typeof value === 'number' && value <= c.less_than_or_equal)) return false
  if (c.in !== undefined && !c.in.some(v => v === value)) return false
  if (c.not_in !== undefined && c.not_in.some(v => v === value)) return false
  if (c.starts_with !== undefined && !(typeof value === 'string' && value.startsWith(c.starts_with))) return false
  if (c.contains !== undefined) {
    if (typeof value === 'string') { if (typeof c.contains !== 'string' || !value.includes(c.contains)) return false }
    else if (Array.isArray(value)) { if (!value.some(v => v === c.contains)) return false }
    else return false
  }
  return true
}
