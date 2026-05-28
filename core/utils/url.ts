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
