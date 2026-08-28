// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AllowedHttpMethod, GovernanceDecisionType } from '../../core/constants.js'
import { GOVERNANCE_DECISION, GOVERNANCE_PRECEDENCE, GOVERNANCE_REASON } from '../../core/constants.js'
import type { LoadedRule } from './rule-loader.js'
import { ruleVersionTag } from './rule-loader.js'
import type { Condition, GovernanceRule } from './rule-schema.js'

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
 *    is `*`) and every condition holds. A condition on a missing field holds
 *    only for `exists: false`; comparisons between mismatched types are false.
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
  if (m.path !== undefined && !clause(m.path, req.specPath)) return false
  for (const [field, condition] of Object.entries(rule.conditions ?? {})) {
    if (!conditionHolds(condition, readField(req, field))) return false
  }
  return true
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

function conditionHolds(c: Condition, value: unknown): boolean {
  if (c.exists !== undefined && (value !== undefined) !== c.exists) return false
  if (value === undefined) {
    // Only `exists: false` can be satisfied by a missing field.
    return Object.keys(c).every(k => k === 'exists')
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
