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
  /**
   * Values captured by `{param}` segments of the URL path, percent-decoded.
   * Always strings: a path segment cannot carry a nested DTO. Nested request
   * data travels in `query` (`Record<string, unknown>`) and `body` (`unknown`),
   * which keep their full shape and which rules read with dotted paths (`body.a.b`).
   */
  pathParams: Record<string, string>
  /** `false` when the spec has no template for this method+path; governance then sees the fallback `specPath`. */
  matched: boolean
}

interface PathItemLike { [method: string]: unknown }

/**
 * Resolves a concrete path to its OpenAPI template and `operationId` (§18)
 * so Governance Rules can target `operation: createCampaign` instead of raw
 * URLs. Matching is segment-by-segment on the percent-decoded segment: a
 * literal segment must be equal, a `{param}` segment captures exactly one
 * segment, and a segment mixing both (`{name}.json`, `{id}:cancel`) must fit
 * its literal parts. When several templates match, the most specific wins —
 * literal segments over mixed over `{param}` (`/users/me` beats
 * `/users/{id}`) — then exact letter case, then spec order. The method must
 * exist on the item.
 *
 * Literals also match ignoring letter case: many backends (Express by
 * default, ASP.NET) route `/Orders/1` to `/orders/{id}`, and a call must not
 * escape the rules on that operation just by changing case.
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

  let best: { template: string; score: number; exact: number; params: Record<string, string>; item: PathItemLike } | undefined
  for (const [template, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue
    if (!(lowerMethod in item)) continue
    const segs = splitPath(template)
    if (segs.length !== concrete.length) continue
    const params: Record<string, string> = {}
    let score = 0
    let exact = 0
    let ok = true
    for (let i = 0; i < segs.length; i++) {
      const fit = matchSegment(segs[i] as string, safeDecode(concrete[i] as string))
      if (!fit) { ok = false; break }
      Object.assign(params, fit.params)
      score += fit.specificity
      if (fit.exactCase) exact++
    }
    if (!ok) continue
    if (!best || score > best.score || (score === best.score && exact > best.exact)) {
      best = { template, score, exact, params, item }
    }
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

/** How one template segment fits one decoded concrete segment; `undefined` when it does not. */
interface SegmentFit {
  /** literal 2, mixed literal+param 1, whole `{param}` 0 */
  specificity: number
  exactCase: boolean
  params: Record<string, string>
}

const WHOLE_PARAM = /^\{([^}]+)\}$/
const PARAM = /\{([^}]+)\}/g

function matchSegment(template: string, decoded: string): SegmentFit | undefined {
  const whole = WHOLE_PARAM.exec(template)
  if (whole) return { specificity: 0, exactCase: true, params: { [whole[1] as string]: decoded } }
  if (!template.includes('{')) {
    if (template === decoded) return { specificity: 2, exactCase: true, params: {} }
    return template.toLowerCase() === decoded.toLowerCase() ? { specificity: 2, exactCase: false, params: {} } : undefined
  }
  // Mixed: literal parts escaped, each {name} captures a non-empty run.
  const names: string[] = []
  const source = template.split(PARAM).map((part, i) => {
    if (i % 2 === 1) { names.push(part); return '(.+?)' }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  for (const [flags, exactCase] of [['', true], ['i', false]] as const) {
    const m = new RegExp(`^${source}$`, flags).exec(decoded)
    if (m) {
      const params: Record<string, string> = {}
      names.forEach((name, i) => { params[name] = m[i + 1] as string })
      return { specificity: 1, exactCase, params }
    }
  }
  return undefined
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}
