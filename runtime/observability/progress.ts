// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Per-tool-invocation progress tracker for `api_execute`. Lives on the host
 * side so progress is preserved even if the sandbox isolate is disposed
 * (timeout / OOM / runtime error). Append-only; entries are recorded in
 * completion order which is acceptable for v1 even when user code issues
 * concurrent api.request() calls.
 *
 * Returned to the caller alongside the standard `mcpError` payload so a
 * failing multi-step workflow can be resumed without recreating already-
 * created entities.
 */

/** Cap on truncated error messages so a chatty backend cannot blow up the
 *  client error payload. */
const MAX_ERROR_MESSAGE_LENGTH = 200

/** Cap on number of id-like fields extracted from a single response. */
const MAX_ID_KEYS = 20

/** Cap on each id value length. IDs are typically UUIDs / short strings;
 *  anything longer is almost certainly not an identifier. */
const MAX_ID_VALUE_LENGTH = 128

export interface ProgressCallEntry {
  /** 1-based completion-order index. */
  i: number
  method: string
  /** Normalized path (path-template form, same identity used by audit + CB). */
  endpoint: string
  /** HTTP status code when the request returned. Absent when the request
   *  threw before a response was received (network error, abort). */
  status?: number
  /** True when status is 2xx/3xx. */
  ok?: boolean
  /** Top-level id-like fields extracted from a successful create response.
   *  Only populated when the call was a create (`POST` + ok === true). */
  ids?: Record<string, string>
  /** Truncated error message if the request threw. */
  error?: string
  /** True when the failure was caused by sandbox abort (timeout / dispose). */
  aborted?: boolean
}

export interface ProgressSummary {
  /** Number of calls where the HTTP request returned a response (any status). */
  completedCalls: number
  calls: ProgressCallEntry[]
}

export class ProgressCollector {
  private readonly entries: ProgressCallEntry[] = []
  private counter = 0

  /**
   * @param maxEntries — upper bound on stored rows; must match the same
   *   `maxApiCalls` limit enforced for this `api_execute` run (global default
   *   ∪ per-service `config.json` override) so progress cannot outlive the
   *   sandbox call budget.
   */
  constructor(private readonly maxEntries: number) {}

  /** Record a completed HTTP call (any status). For successful POSTs the
   *  caller may pass `ids` extracted from the response body. */
  recordSuccess(
    method: string,
    endpoint: string,
    status: number,
    ok: boolean,
    ids?: Record<string, string>
  ): void {
    if (this.entries.length >= this.maxEntries) return
    this.counter++
    const entry: ProgressCallEntry = { i: this.counter, method, endpoint, status, ok }
    if (ids && Object.keys(ids).length > 0) entry.ids = ids
    this.entries.push(entry)
  }

  /** Record a failed HTTP call (request threw, e.g. network error or abort). */
  recordFailure(method: string, endpoint: string, error: string, aborted: boolean): void {
    if (this.entries.length >= this.maxEntries) return
    this.counter++
    this.entries.push({
      i: this.counter,
      method,
      endpoint,
      error: truncate(error, MAX_ERROR_MESSAGE_LENGTH),
      aborted
    })
  }

  summary(): ProgressSummary {
    const completedCalls = this.entries.reduce((n, e) => n + (e.status !== undefined ? 1 : 0), 0)
    return { completedCalls, calls: [...this.entries] }
  }

  hasAny(): boolean {
    return this.entries.length > 0
  }
}

/**
 * Extract top-level id-like fields from a response body. Conservative on
 * purpose: only the first level is inspected. Keys must look like API
 * identifiers, not arbitrary English words ending in "id" (e.g. `paid`):
 *
 * - Whole key `id`, `uid`, or `uuid` (case-insensitive).
 * - Snake_case: suffix `_id`, `_uid`, or `_uuid` (case-insensitive on the key).
 * - Camel / Pascal: suffix `Id`, `ID`, `Uid`, `UID`, `Uuid`, or `UUID` preceded
 *   by a letter, digit, or underscore (so `campaignId`, `resourceUid`, …).
 *
 * Only string/number values are kept. Returns `undefined` when nothing matches
 * so callers can omit the field entirely.
 */
export function extractTopLevelIds(data: unknown): Record<string, string> | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined

  const result: Record<string, string> = {}
  let kept = 0
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (kept >= MAX_ID_KEYS) break
    if (!isIdLikeKey(key)) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    result[key] = truncate(String(value), MAX_ID_VALUE_LENGTH)
    kept++
  }
  return kept > 0 ? result : undefined
}

/** Whole-key identifiers — test on lowercased key (case-insensitive). */
const WHOLE_ID_KEY = /^(?:id|uid|uuid)$/

/** Snake_case suffix `_id` / `_uid` / `_uuid` — test on lowercased key. */
const SNAKE_ID_SUFFIX = /_(?:id|uid|uuid)$/

/** Camel / Pascal suffix after [a-z0-9_] — avoids `paid`, `fluid`, … (original casing). */
const CAMEL_ID_SUFFIX = /[a-z0-9_](?:Id|ID|Uid|UID|Uuid|UUID)$/

function isIdLikeKey(key: string): boolean {
  if (key.length === 0) return false
  const k = key.toLowerCase()
  if (WHOLE_ID_KEY.test(k)) return true
  if (SNAKE_ID_SUFFIX.test(k)) return true
  return CAMEL_ID_SUFFIX.test(key)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}
