// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Joins two URL parts ensuring exactly one slash at the seam. Empty inputs
 * are passed through so callers can compose origins and paths incrementally
 * without having to guard for empty strings at each site.
 */
export function joinUrl(base: string, path: string): string {
  if (!path) return base
  if (!base) return path
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBase}${cleanPath}`
}

/**
 * Collapses numeric and alphanumeric-id path segments into a single `{id}`
 * placeholder so that circuit-breaker buckets and metrics group by endpoint
 * shape rather than by individual resource id.
 */
export function normalizeEndpointPath(path: string): string {
  return path
    .split('/')
    .map(segment => {
      if (/^\d+$/.test(segment)) return '{id}'
      if (/^[0-9a-zA-Z_-]+$/.test(segment) && /\d/.test(segment)) return '{id}'
      return segment
    })
    .join('/')
}

/**
 * Query parameters that carry a credential, by name: tokens, keys,
 * signatures, passwords (`access_token`, `api_key`, `sig`, `X-Amz-Signature`,
 * `X-Amz-Credential`, …). Deliberately broad — a harmless parameter that
 * happens to match (`keyword`) only loses its value in a log line.
 */
const CREDENTIAL_PARAM = /token|secret|passw|pwd|sig|key|auth|credential|jwt|bearer/i

/** What stands in for a credential's value in a redacted URL. */
export const REDACTED_VALUE = 'REDACTED'

/**
 * A URL as it may appear in logs and error messages. The query string is
 * kept — it often says *which* document was asked for (`?ref=main`,
 * `?version=2`) and an operator needs that to diagnose a failed fetch — but
 * the userinfo is dropped and the value of every credential-like parameter
 * is replaced, so a presigned or token-bearing URL never reaches a log.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    // Collected first: `set` rewrites the list being iterated (it also folds a repeated name into one).
    const credentialParams = [...new Set(u.searchParams.keys())].filter(name => CREDENTIAL_PARAM.test(name))
    for (const name of credentialParams) u.searchParams.set(name, REDACTED_VALUE)
    return u.toString()
  } catch {
    return '(invalid URL)'
  }
}
