// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/**
 * A single authenticated MCP session — one per connected client.
 * `lastSeenAt` is bumped on every request and used by {@link SessionManager.sweepIdle}.
 */
export interface SessionEntry {
  transport: StreamableHTTPServerTransport
  server: McpServer
  clientToken: string
  lastSeenAt: number
}

/**
 * `() => number` injection point so tests can control the clock. In
 * production this is `Date.now`; tests pass a fake that advances on demand.
 */
export type Clock = () => number

/**
 * Owns the lifecycle of every active MCP session: creation, touch-on-use,
 * explicit deletion, and idle eviction. Kept deliberately transport-agnostic
 * so the HTTP gateway (and any future transport that needs session state)
 * can depend on this class without pulling in `node:http`.
 *
 * The class is intentionally thin — one `Map` plus a few helpers — because
 * the business rule (TTL-based eviction) is too simple to warrant a
 * strategy pattern here. The value is in having one testable seam.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()

  constructor(private readonly clock: Clock = Date.now) {}

  /** Returns the session for the given id, or `undefined` if it does not exist. */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId)
  }

  /** Updates `lastSeenAt` so this session survives the next idle sweep. */
  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry) entry.lastSeenAt = this.clock()
  }

  /**
   * Registers a new session. The SDK assigns the id asynchronously after
   * the first request is handled, which is why this is a separate step
   * from transport creation.
   */
  register(sessionId: string, entry: Omit<SessionEntry, 'lastSeenAt'>): void {
    this.sessions.set(sessionId, { ...entry, lastSeenAt: this.clock() })
  }

  /** Removes a session. Idempotent. */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Number of currently-tracked sessions. Exposed for /health and metrics. */
  size(): number {
    return this.sessions.size
  }

  /**
   * Evicts every session whose last activity is older than `idleTtlMs`.
   * Returns the list of evicted entries so the caller can close transports
   * and emit logs — this class does not know about `transport.close()`.
   */
  sweepIdle(idleTtlMs: number): Array<{ sessionId: string; entry: SessionEntry; idleMs: number }> {
    const now = this.clock()
    const evicted: Array<{ sessionId: string; entry: SessionEntry; idleMs: number }> = []
    for (const [sid, entry] of this.sessions) {
      const idleMs = now - entry.lastSeenAt
      if (idleMs > idleTtlMs) {
        this.sessions.delete(sid)
        evicted.push({ sessionId: sid, entry, idleMs })
      }
    }
    return evicted
  }
}
