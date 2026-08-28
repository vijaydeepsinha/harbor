// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { OpenAPISpec } from '../../core/types/spec.types.js'
import type { AllowedHttpMethod } from '../../core/constants.js'
import { normalizeEndpointPath } from '../../core/utils/url.js'

/** Where a concrete `api.request` landed in the service's OpenAPI document. */
export interface ResolvedOperation {
  /** Path template from `spec.paths` (e.g. `/campaigns/{id}/activate`), or the normalized path when nothing matched. */
  specPath: string
  operationId?: string
  pathParams: Record<string, string>
  /** `false` when the spec has no template for this method+path; governance then sees the fallback `specPath`. */
  matched: boolean
}

interface PathItemLike { [method: string]: unknown }

/**
 * Resolves a concrete path to its OpenAPI template and `operationId` (§18)
 * so Governance Rules can target `operation: createCampaign` instead of raw
 * URLs. Matching is segment-by-segment: a literal segment must be equal, a
 * `{param}` segment captures exactly one segment. When several templates
 * match, the one with the most literal segments wins (`/users/me` beats
 * `/users/{id}`); ties keep spec order. The method must exist on the item.
 *
 * Falls back to the digit-collapsing `normalizeEndpointPath` heuristic only
 * when the spec has no match, and says so via `matched: false`.
 */
export function resolveOperation(
  spec: OpenAPISpec,
  method: AllowedHttpMethod,
  rawPath: string
): ResolvedOperation {
  const concrete = splitPath(rawPath)
  const paths = (spec.paths ?? {}) as Record<string, PathItemLike | undefined>
  const lowerMethod = method.toLowerCase()

  let best: { template: string; literals: number; params: Record<string, string>; item: PathItemLike } | undefined
  for (const [template, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue
    if (!(lowerMethod in item)) continue
    const segs = splitPath(template)
    if (segs.length !== concrete.length) continue
    const params: Record<string, string> = {}
    let literals = 0
    let ok = true
    for (let i = 0; i < segs.length; i++) {
      const t = segs[i] as string
      const c = concrete[i] as string
      const param = /^\{([^}]+)\}$/.exec(t)
      if (param) {
        params[param[1] as string] = safeDecode(c)
      } else if (t === c) {
        literals++
      } else {
        ok = false
        break
      }
    }
    if (!ok) continue
    if (!best || literals > best.literals) best = { template, literals, params, item }
  }

  if (!best) {
    return { specPath: normalizeEndpointPath(stripQuery(rawPath)), pathParams: {}, matched: false }
  }
  const op = best.item[lowerMethod]
  const operationId = op && typeof op === 'object' && typeof (op as { operationId?: unknown }).operationId === 'string'
    ? (op as { operationId: string }).operationId
    : undefined
  return {
    specPath: best.template,
    ...(operationId !== undefined ? { operationId } : {}),
    pathParams: best.params,
    matched: true
  }
}

function stripQuery(path: string): string {
  const q = path.indexOf('?')
  return q === -1 ? path : path.slice(0, q)
}

/** `/a/b/` → ['a','b']; 'a/b' → ['a','b']; '/' → []. Query strings are ignored. */
function splitPath(path: string): string[] {
  return stripQuery(path).split('/').filter(seg => seg.length > 0)
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}
