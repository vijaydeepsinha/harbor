// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { z } from 'zod'
import { ALLOWED_HTTP_METHODS, GOVERNANCE_DECISION } from '../../core/constants.js'

/**
 * Governance Rule — Harbor-facing policy over external operations (§20).
 * Deliberately small: exact-match targeting plus a fixed operator set over
 * request values. No expressions, no regex, no code.
 *
 * ```yaml
 * name: high-budget-campaign
 * version: 2
 * match: { service: trafficking, operation: createCampaign }
 * conditions:
 *   budget: { greater_than: 1000000 }        # bare field ≡ body.budget
 *   query.dryRun: { not_equals: true }
 * action: { type: REQUIRE_APPROVAL, reason: Campaign budget exceeds the approval threshold }
 * ```
 */

const scalar = z.union([z.string(), z.number(), z.boolean()])

export const conditionSchema = z.object({
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
}).strict().refine(c => Object.keys(c).length > 0, { message: 'a condition needs at least one operator' })

export type Condition = z.infer<typeof conditionSchema>
export const CONDITION_OPERATORS = Object.keys(conditionSchema.shape) as ReadonlyArray<keyof Condition>

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
  /** Field path → condition. Bare names read from the request body; `body.`, `query.`, `path.` select explicitly. */
  conditions: z.record(z.string().min(1), conditionSchema).optional(),
  action: z.object({
    type: z.enum([GOVERNANCE_DECISION.ALLOW, GOVERNANCE_DECISION.DENY, GOVERNANCE_DECISION.REQUIRE_APPROVAL]),
    reason: z.string().optional()
  }).strict()
}).strict()

export type GovernanceRule = z.infer<typeof governanceRuleSchema>
