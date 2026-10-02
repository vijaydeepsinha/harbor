// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AllowedHttpMethod, GovernanceDecisionType, RuleLevel } from '../../core/constants.js'
import { GOVERNANCE_DECISION, GOVERNANCE_PRECEDENCE, GOVERNANCE_REASON, RULE_LEVEL, RULE_LEVEL_SPECIFICITY } from '../../core/constants.js'
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
 * 1. A rule *targets* a call when every clause in `match` fits it (or is
 *    `*`), and *matches* when it targets it and its `conditions` tree holds (`allOf` AND, `anyOf` OR, `not`
 *    NOT). A leaf on a missing field — or on a computed operand that cannot be
 *    computed — holds only for `exists: false`; comparisons between
 *    mismatched types are false.
 * 2. One level decides. Each rule's level follows from its `match`
 *    (see {@link ruleLevel}): the most specific level with a matched rule
 *    decides — endpoint overrides service, service overrides gateway — unless
 *    a matched rule is `final`, which pins the decision to the broadest level
 *    holding a matched `final` rule.
 * 3. Within the deciding level the strongest action wins:
 *    DENY > REQUIRE_APPROVAL > ALLOW. The deciding rule is the first (file
 *    order) rule of that level carrying the winning action. `matchedRules`
 *    still lists every matched rule, at every level, for audit.
 * 4. No rule matches: if some rule *targets* the call (its `match` fits,
 *    conditions aside) ⇒ `defaultDecision` (`NO_MATCHING_RULE`); if no rule
 *    targets it at all, the call is ungoverned ⇒ ALLOW (`NO_GOVERNANCE`).
 * 5. Any internal error ⇒ DENY (`GOVERNANCE_EVALUATION_FAILED`). Fail closed.
 */
export function evaluateGovernance(
  rules: readonly LoadedRule[],
  request: GovernanceRequest,
  defaultDecision: GovernanceDecisionType
): GovernanceOutcome {
  try {
    const targeted = rules.filter(r => ruleTargets(r.rule, request))
    const matched = targeted.filter(r => r.rule.conditions === undefined || conditionsHold(r.rule.conditions, request))
    if (matched.length === 0) {
      return targeted.length === 0
        ? { decision: GOVERNANCE_DECISION.ALLOW, reason: GOVERNANCE_REASON.NO_GOVERNANCE, matchedRules: [], ruleVersions: [] }
        : { decision: defaultDecision, reason: GOVERNANCE_REASON.NO_MATCHING_RULE, matchedRules: [], ruleVersions: [] }
    }
    const deciding = decidingLevelRules(matched)
    let winner = deciding[0] as LoadedRule
    for (const r of deciding) {
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

/**
 * A rule's level follows from what its `match` names: an operation or a path
 * ⇒ endpoint; a service only ⇒ service; neither ⇒ gateway. A clause that
 * matches anything (`*`, or the path `/**`) names nothing. `method` restricts
 * a rule at any level and does not change it.
 */
export function ruleLevel(rule: GovernanceRule): RuleLevel {
  const m = rule.match
  const names = (value: string | undefined, ...anything: string[]) => value !== undefined && !anything.includes(value)
  if (names(m.operation, '*') || names(m.path, '*', PATH_SUBTREE_SUFFIX)) return RULE_LEVEL.ENDPOINT
  if (names(m.service, '*')) return RULE_LEVEL.SERVICE
  return RULE_LEVEL.GATEWAY
}

/** The matched rules of the level that decides (see evaluateGovernance, step 2). */
function decidingLevelRules(matched: readonly LoadedRule[]): LoadedRule[] {
  const specificity = (r: LoadedRule) => RULE_LEVEL_SPECIFICITY[ruleLevel(r.rule)]
  const finals = matched.filter(r => r.rule.final === true)
  const level = finals.length > 0
    ? Math.min(...finals.map(specificity))
    : Math.max(...matched.map(specificity))
  return matched.filter(r => specificity(r) === level)
}

/** The rule's `match` fits the call — its service / operation / method / path clauses, conditions aside. */
function ruleTargets(rule: GovernanceRule, req: GovernanceRequest): boolean {
  const m = rule.match
  if (m.service !== undefined && !clause(m.service, req.service)) return false
  if (m.operation !== undefined && !clause(m.operation, req.operationId)) return false
  if (m.method !== undefined && !m.method.includes(req.method)) return false
  if (m.path !== undefined && !pathClause(m.path, req.specPath)) return false
  return true
}

/** `allOf` = AND, `anyOf` = OR, `not` = NOT; a leaf compares its operand. */
function conditionsHold(node: ConditionNode, req: GovernanceRequest): boolean {
  switch (node.kind) {
    case 'allOf': return node.allOf.every(child => conditionsHold(child, req))
    case 'anyOf': return node.anyOf.some(child => conditionsHold(child, req))
    case 'not': return !conditionsHold(node.not, req)
    case 'leaf': return comparisonHolds(node, operandValue(node, req), node.field !== undefined && travelsAsText(node.field))
  }
}

/**
 * Query values and path parameters reach the backend as text — `?all=true`,
 * `/campaigns/42` — so they compare as they travel: `path.id: { equals: 42 }`
 * matches the segment `42`, and `greater_than: 100` reads `150` as a number.
 * Read strictly, a numeric YAML value never equals a path segment, and a DENY
 * written that way would never fire. Body values keep their JSON types.
 */
function travelsAsText(field: string): boolean {
  return field.startsWith('query.') || field.startsWith('path.')
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

/**
 * `budget` ≡ `body.budget`; `query.x`, `path.x`, `body.x.y` select explicitly.
 * Arrays may be indexed numerically. Only the request's own data is read:
 * `constructor`, `__proto__` or `toString` are missing fields, never
 * inherited properties.
 */
export function readField(req: GovernanceRequest, field: string): unknown {
  const parts = field.split('.')
  let root: unknown
  let rest: string[]
  switch (parts[0]) {
    case 'body': root = jsonBody(req.body); rest = parts.slice(1); break
    case 'query': root = req.query; rest = parts.slice(1); break
    case 'path': root = req.pathParams; rest = parts.slice(1); break
    default: root = jsonBody(req.body); rest = parts
  }
  let cur: unknown = root
  for (const p of rest) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/**
 * A body the program passed as a JSON string reaches the backend as that
 * JSON — the same bytes as the object would — so rules read it as the
 * object. Otherwise `body: JSON.stringify({ amount: 5e6 })` would slip past
 * every `body.*` condition.
 */
function jsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' ? parsed : body
  } catch {
    return body
  }
}

/** A number as it appears in a query string: `5`, `-1.5`, `2e6` — not `0x10`, `''` or `1_000`. */
const WIRE_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * The comparison operators of a leaf (or flat-form field), all ANDed.
 *
 * `wire`: the operand is a query parameter. On the wire every query value is
 * text — `params: { all: true }`, `{ all: 'true' }` and `?all=true` all send
 * `all=true` — so equality compares that text (`equals: true` matches the
 * string `'true'`) and ordering reads a numeric string as its number.
 * Elsewhere types stay strict: mismatched types never compare equal.
 */
function comparisonHolds(c: Condition, value: unknown, wire = false): boolean {
  if (c.exists !== undefined && (value !== undefined) !== c.exists) return false
  if (value === undefined) {
    // Only `exists: false` can be satisfied by a missing field.
    // (A leaf also carries its operand keys — only the operators count here.)
    return CONDITION_OPERATORS.every(k => c[k] === undefined || k === 'exists')
  }
  const same = (expected: unknown): boolean =>
    expected === value || (wire && isScalar(expected) && isScalar(value) && String(expected) === String(value))
  const num: number | undefined =
    typeof value === 'number' ? value
    : wire && typeof value === 'string' && WIRE_NUMBER.test(value) ? Number(value)
    : undefined
  const text: string | undefined = typeof value === 'string' ? value : wire && isScalar(value) ? String(value) : undefined
  if (c.equals !== undefined && !same(c.equals)) return false
  if (c.not_equals !== undefined && same(c.not_equals)) return false
  if (c.greater_than !== undefined && !(num !== undefined && num > c.greater_than)) return false
  if (c.greater_than_or_equal !== undefined && !(num !== undefined && num >= c.greater_than_or_equal)) return false
  if (c.less_than !== undefined && !(num !== undefined && num < c.less_than)) return false
  if (c.less_than_or_equal !== undefined && !(num !== undefined && num <= c.less_than_or_equal)) return false
  if (c.in !== undefined && !c.in.some(same)) return false
  if (c.not_in !== undefined && c.not_in.some(same)) return false
  if (c.starts_with !== undefined && !(text !== undefined && text.startsWith(c.starts_with))) return false
  if (c.contains !== undefined) {
    if (text !== undefined) { if (typeof c.contains !== 'string' || !text.includes(c.contains)) return false }
    else if (Array.isArray(value)) { if (!value.some(v => v === c.contains || (wire && isScalar(v) && isScalar(c.contains) && String(v) === String(c.contains)))) return false }
    else return false
  }
  return true
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}
