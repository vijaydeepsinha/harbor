// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach } from 'vitest'
import { SessionManager } from '../../runtime/http/session-manager.js'
import type { SessionEntry } from '../../runtime/http/session-manager.js'

function fakeEntry(overrides: Partial<Omit<SessionEntry, 'lastSeenAt'>> = {}): Omit<SessionEntry, 'lastSeenAt'> {
  return {
    transport: {} as SessionEntry['transport'],
    server: {} as SessionEntry['server'],
    clientToken: 'tok',
    ...overrides
  }
}

describe('SessionManager', () => {
  let now: number
  let mgr: SessionManager
  beforeEach(() => {
    now = 1_000_000
    mgr = new SessionManager(() => now)
  })

  it('starts empty', () => {
    expect(mgr.size()).toBe(0)
    expect(mgr.get('anything')).toBeUndefined()
  })

  it('registers a new session with the current clock value', () => {
    mgr.register('sid-1', fakeEntry({ clientToken: 't1' }))
    const entry = mgr.get('sid-1')
    expect(entry).toBeDefined()
    expect(entry!.lastSeenAt).toBe(now)
    expect(entry!.clientToken).toBe('t1')
    expect(mgr.size()).toBe(1)
  })

  it('touch() updates lastSeenAt to the current clock value', () => {
    mgr.register('sid-1', fakeEntry())
    now += 5000
    mgr.touch('sid-1')
    expect(mgr.get('sid-1')!.lastSeenAt).toBe(1_005_000)
  })

  it('touch() is a no-op for unknown sessions', () => {
    mgr.touch('does-not-exist')
    expect(mgr.size()).toBe(0)
  })

  it('delete() removes the session and is idempotent', () => {
    mgr.register('sid-1', fakeEntry())
    mgr.delete('sid-1')
    mgr.delete('sid-1') // no throw
    expect(mgr.get('sid-1')).toBeUndefined()
    expect(mgr.size()).toBe(0)
  })

  it('sweepIdle() returns nothing when no session is past the TTL', () => {
    mgr.register('sid-1', fakeEntry())
    now += 1000
    const evicted = mgr.sweepIdle(10_000)
    expect(evicted).toEqual([])
    expect(mgr.size()).toBe(1)
  })

  it('sweepIdle() evicts only the sessions older than the TTL', () => {
    mgr.register('old', fakeEntry({ clientToken: 'old-tok' }))
    now += 5_000
    mgr.register('fresh', fakeEntry({ clientToken: 'fresh-tok' }))

    now += 6_000 // old is now 11s idle, fresh is 6s idle

    const evicted = mgr.sweepIdle(10_000)
    expect(evicted.map(e => e.sessionId)).toEqual(['old'])
    expect(evicted[0]!.idleMs).toBe(11_000)
    expect(mgr.get('old')).toBeUndefined()
    expect(mgr.get('fresh')).toBeDefined()
    expect(mgr.size()).toBe(1)
  })

  it('sweepIdle() returns the evicted entry so the caller can close its transport', () => {
    const marker = { closed: false }
    const fakeTransport = { close: () => { marker.closed = true } } as unknown as SessionEntry['transport']
    mgr.register('sid-1', fakeEntry({ transport: fakeTransport }))
    now += 20_000

    const [evicted] = mgr.sweepIdle(1_000)
    expect(evicted).toBeDefined()
    evicted!.entry.transport.close?.()
    expect(marker.closed).toBe(true)
  })
})
