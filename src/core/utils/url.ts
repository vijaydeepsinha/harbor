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

/** What stands in for a credential's value in a redacted URL. */
export const REDACTED_VALUE = 'REDACTED'

/**
 * A URL as it may appear in logs and error messages. The query string is
 * kept as parameter names, but every value is replaced: credentials can
 * travel under arbitrary names, not just `token` or `api_key`. Userinfo and
 * fragments are removed too. The origin and path remain diagnostic context.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.hash = ''
    const redacted = new URLSearchParams()
    for (const name of u.searchParams.keys()) redacted.append(name, REDACTED_VALUE)
    u.search = redacted.toString()
    return u.toString()
  } catch {
    return '(invalid URL)'
  }
}
