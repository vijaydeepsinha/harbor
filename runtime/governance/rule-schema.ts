// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { z } from 'zod'
import { ALLOWED_HTTP_METHODS, GOVERNANCE_DECISION } from '../../core/constants.js'

/**
 * Governance Rule — Harbor-facing policy over external operations (§20).
 *
 * - `match` routes a rule to operations: exact service / operation / method /
 *   path (`*` matches anything).
 * - `conditions` is a bounded boolean tree over request values: `allOf`
 *   (AND), `anyOf` (OR), `not` (NOT), and leaves that compare one value — a
 *   request field, or a number computed from two fields (`ratio`,
 *   `percent_of`, `days_between`) — with a fixed operator set.
 * - `action` is advisory only: ALLOW | DENY | REQUIRE_APPROVAL plus a reason.
 *   A rule never rewrites the request and has no side effects.
 *
 * No expressions, no regex, no code.
 *
 * ```yaml
 * name: high-budget-campaign
 * version: 2
 * match: { service: trafficking, operation: createCampaign }
 * conditions:
 *   allOf:
 *     - percent_of: { part: body.budget, whole: body.totalBudget }
 *       greater_than: 20                      # budget > 20% of the total budget
 *     - not: { field: query.dryRun, equals: true }
 * action: { type: REQUIRE_APPROVAL, reason: Campaign budget exceeds the approval threshold }
 * ```
 *
 * The flat form of earlier rule files is still accepted, as shorthand for
 * `allOf`: `conditions: { budget: { greater_than: 1000000 } }` (bare field ≡
 * `body.budget`).
 */

const scalar = z.union([z.string(), z.number(), z.boolean()])

/** The comparison operators — one set, used by flat-form fields and tree leaves alike. */
const comparisonOperators = {
  equals: scalar.optional(),
  not_equals: scalar.optional(),
  greater_than: z.number().optional(),
  greater_than_or_equal: z.number().optional(),
  less_than: z.number().optional(),
  less_than_or_equal: z.number().optional(),
  in: z.array(scalar).min(1).optional(),
  not_in: z.array(scalar).min(1).optional(),
  exists: z.boolean().optional(),
  starts_with: z.string().optional(),
  contains: scalar.optional()
}

/** One field's operators in the flat form (`budget: { greater_than: 1 }`). */
export const conditionSchema = z.object(comparisonOperators).strict()
  .refine(c => Object.keys(c).length > 0, { message: 'a condition needs at least one operator' })

export type Condition = z.infer<typeof conditionSchema>
export const CONDITION_OPERATORS = Object.keys(comparisonOperators) as ReadonlyArray<keyof Condition>

/** Bounds that keep every rule cheap to evaluate and readable by a reviewer. */
export const MAX_CONDITION_DEPTH = 8
export const MAX_CONDITION_NODES = 64

/** Where a leaf takes its value from: a request field, or a number computed from two fields. */
export const CONDITION_OPERANDS = ['field', 'ratio', 'percent_of', 'days_between'] as const

/** A computed operand is a number; only these operators can hold on it. */
const NUMERIC_OPERATORS: ReadonlySet<keyof Condition> = new Set<keyof Condition>([
  'equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'in', 'not_in', 'exists'
])

const fieldPath = z.string().min(1)

const leafSchema = z.object({
  kind: z.literal('leaf'),
  field: fieldPath.optional(),
  /** numerator ÷ denominator — e.g. "bid > 1.3× the current bid". */
  ratio: z.object({ numerator: fieldPath, denominator: fieldPath }).strict().optional(),
  /** 100 × part ÷ whole — e.g. "budget > 20% of the total budget". */
  percent_of: z.object({ part: fieldPath, whole: fieldPath }).strict().optional(),
  /** (to − from) in days between two ISO 8601 dates — e.g. "endDate is 30 days after startDate". */
  days_between: z.object({ from: fieldPath, to: fieldPath }).strict().optional(),
  ...comparisonOperators
}).strict().superRefine((leaf, ctx) => {
  const operands = CONDITION_OPERANDS.filter(k => leaf[k] !== undefined)
  if (operands.length !== 1) {
    ctx.addIssue({ code: 'custom', message: `a condition reads exactly one of ${CONDITION_OPERANDS.join(', ')}` })
  }
  const operators = CONDITION_OPERATORS.filter(k => leaf[k] !== undefined)
  if (operators.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'a condition needs at least one operator' })
  }
  // A computed operand is a number: an operator or value that can never hold
  // on a number is a mistake in the rule, so it fails at load, not silently.
  const computed = operands.length === 1 && operands[0] !== 'field' ? operands[0] : undefined
  if (computed) {
    for (const op of operators) {
      if (!NUMERIC_OPERATORS.has(op) || !numericValue(op, leaf[op])) {
        ctx.addIssue({
          code: 'custom', path: [op],
          message: `${computed} yields a number: use ${[...NUMERIC_OPERATORS].join(', ')} with number values`
        })
      }
    }
  }
})

function numericValue(op: keyof Condition, value: unknown): boolean {
  if (op === 'exists') return true
  if (op === 'in' || op === 'not_in') return Array.isArray(value) && value.every(v => typeof v === 'number')
  return typeof value === 'number'
}

export type ConditionLeaf = z.infer<typeof leafSchema>

/** The normalised condition tree every loaded rule carries (`kind` is set by Harbor, not written by authors). */
export type ConditionNode =
  | { kind: 'allOf'; allOf: ConditionNode[] }
  | { kind: 'anyOf'; anyOf: ConditionNode[] }
  | { kind: 'not'; not: ConditionNode }
  | ConditionLeaf

const COMPOSITES = ['allOf', 'anyOf', 'not'] as const

/**
 * Authors write `{ allOf: [...] }`, `{ not: {...} }` or a leaf; the node's
 * `kind` is inferred from its keys so validation can say exactly which key is
 * wrong (a plain union would only report "invalid input"). A node that already
 * carries `kind` is validated as-is, so parsing is idempotent.
 */
function tagNode(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || 'kind' in value) return value
  const composite = COMPOSITES.find(k => k in value)
  return { ...value, kind: composite ?? 'leaf' }
}

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() => z.preprocess(tagNode, z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allOf'), allOf: z.array(conditionNodeSchema).min(1) }).strict(),
  z.object({ kind: z.literal('anyOf'), anyOf: z.array(conditionNodeSchema).min(1) }).strict(),
  z.object({ kind: z.literal('not'), not: conditionNodeSchema }).strict(),
  leafSchema
])))

/** Keys that make `conditions` a tree node rather than the flat shorthand. */
const TREE_KEYS: ReadonlySet<string> = new Set<string>(['kind', ...COMPOSITES, ...CONDITION_OPERANDS])

/**
 * `kind` is Harbor's own node tag and always a string on a normalised node;
 * with any other value it is an author's body field (`kind: { equals: video }`)
 * in the flat form.
 */
function isFlatForm(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([k, v]) => !TREE_KEYS.has(k) || (k === 'kind' && typeof v !== 'string'))
}

function treeSize(node: ConditionNode, depth = 1): { depth: number; nodes: number } {
  const children =
    node.kind === 'allOf' ? node.allOf
    : node.kind === 'anyOf' ? node.anyOf
    : node.kind === 'not' ? [node.not]
    : []
  return children.reduce(
    (acc, child) => {
      const c = treeSize(child, depth + 1)
      return { depth: Math.max(acc.depth, c.depth), nodes: acc.nodes + c.nodes }
    },
    { depth, nodes: 1 }
  )
}

/**
 * `conditions`: either the tree, or the flat map (field path → operators)
 * normalised to `allOf` of `field` leaves. Output is always a tree (or
 * nothing), so the evaluator has one shape to handle. Every problem is
 * reported at its own path; anything malformed stops the rule from loading.
 */
const conditionsSchema = z.unknown().transform((raw, ctx): ConditionNode | undefined => {
  if (raw === undefined) return undefined
  const forward = (issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }>) => {
    for (const issue of issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...issue.path] })
    return z.NEVER
  }

  if (isFlatForm(raw)) {
    const flat = z.record(fieldPath, conditionSchema).safeParse(raw)
    if (!flat.success) return forward(flat.error.issues)
    const leaves = Object.entries(flat.data).map(([field, c]): ConditionNode => ({ kind: 'leaf', field, ...c }))
    return leaves.length === 0 ? undefined : { kind: 'allOf', allOf: leaves }
  }

  const tree = conditionNodeSchema.safeParse(raw)
  if (!tree.success) return forward(tree.error.issues)
  const size = treeSize(tree.data)
  if (size.depth > MAX_CONDITION_DEPTH) {
    return forward([{ message: `conditions nest ${size.depth} levels deep; the limit is ${MAX_CONDITION_DEPTH}`, path: [] }])
  }
  if (size.nodes > MAX_CONDITION_NODES) {
    return forward([{ message: `conditions have ${size.nodes} nodes; the limit is ${MAX_CONDITION_NODES}`, path: [] }])
  }
  return tree.data
})

/** `*` matches anything; otherwise exact, case-sensitive. */
const matchValue = z.string().min(1)

export const governanceRuleSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case, e.g. high-budget-campaign'),
  description: z.string().optional(),
  /** Free-form revision marker kept on every decision for audit (§35). */
  version: z.union([z.string(), z.number()]).optional().transform(v => (v === undefined ? '1' : String(v))),
  match: z.object({
    service: matchValue.optional(),
    /** OpenAPI operationId. */
    operation: matchValue.optional(),
    method: z.enum(ALLOWED_HTTP_METHODS).optional(),
    /** OpenAPI path template exactly as in the spec (e.g. `/campaigns/{id}/activate`). */
    path: matchValue.optional()
  }).strict().refine(m => Object.keys(m).length > 0, { message: 'match needs at least one of service, operation, method, path' }),
  /** Boolean tree over request values; bare field names read the body, `body.` / `query.` / `path.` select explicitly. */
  conditions: conditionsSchema.optional(),
  /** Advisory outcome only — never a request mutation or a side effect. */
  action: z.object({
    type: z.enum([GOVERNANCE_DECISION.ALLOW, GOVERNANCE_DECISION.DENY, GOVERNANCE_DECISION.REQUIRE_APPROVAL]),
    reason: z.string().optional()
  }).strict()
}).strict()

export type GovernanceRule = z.infer<typeof governanceRuleSchema>
