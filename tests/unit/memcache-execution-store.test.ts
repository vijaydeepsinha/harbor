// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { MemcacheCodeModeStore, DEFAULT_MEMCACHE_LOCK_TTL_SEC } from '../../src/adapters/execution/memcache-execution-store.js'
import { buildExecutionStore } from '../../src/wiring/strategy-builders.js'
import { FakeMemcache } from './fake-memcache.js'
import { EXECUTION_STATUS, ACTIVITY_STATUS } from '../../src/core/constants.js'
import type { ExecutionRecord } from '../../src/core/types/execution.types.js'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function clock() {
  let now = T0
  return { now: () => now, advanceSec: (s: number) => { now += s * 1000 } }
}

function execution(id: string, extra: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: id, service: 'svc', originalCode: 'async () => 1', status: EXECUTION_STATUS.CREATED,
    userIdHash: 'h', createdAt: 't', updatedAt: 't', currentActivity: 0, runCount: 0, ...extra
  }
}

/** Two pods: two store instances (each with its own lock owner) on one memcache. */
function twoPods() {
  const c = clock()
  const memcache = new FakeMemcache(c.now)
  return {
    c, memcache,
    podA: new MemcacheCodeModeStore(memcache, { nowMs: c.now, lockTtlSec: 60 }),
    podB: new MemcacheCodeModeStore(memcache, { nowMs: c.now, lockTtlSec: 60 })
  }
}

describe('memcache execution store — shared by every pod', () => {
  it('what one pod writes, another reads: execution, journal, approvals, decisions', async () => {
    const { podA, podB } = twoPods()
    await podA.createExecution(execution('e-1'))
    await podA.putActivity({ executionId: 'e-1', sequence: 2, service: 'svc', status: ACTIVITY_STATUS.WAITING_APPROVAL, request: { method: 'POST', rawPath: '/x', specPath: '/x' }, runIndex: 1, createdAt: 't', updatedAt: 't', approvalId: 'ap-1' })
    await podA.putActivity({ executionId: 'e-1', sequence: 1, service: 'svc', status: ACTIVITY_STATUS.COMPLETED, request: { method: 'GET', rawPath: '/y', specPath: '/y' }, runIndex: 1, createdAt: 't', updatedAt: 't' })
    await podA.putApproval({ approvalId: 'ap-1', executionId: 'e-1', activitySequence: 2, status: 'PENDING', summary: { service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: [] }, createdAt: 't' })
    await podA.putDecision({ executionId: 'e-1', activitySequence: 2, decision: 'REQUIRE_APPROVAL', reason: 'r', matchedRules: [], ruleVersions: [], evaluatedAt: 't' })

    expect((await podB.getExecution('e-1'))?.originalCode).toBe('async () => 1')
    expect((await podB.listActivities('e-1')).map(a => a.sequence)).toEqual([1, 2])
    expect((await podB.getApproval('ap-1'))?.status).toBe('PENDING')
    expect(await podB.listDecisions('e-1')).toHaveLength(1)

    // a human decision taken through pod B is what pod A sees next
    await podB.putApproval({ ...(await podB.getApproval('ap-1'))!, status: 'APPROVED' })
    expect((await podA.getApproval('ap-1'))?.status).toBe('APPROVED')
    expect((await podA.listApprovals('e-1'))).toHaveLength(1)
  })

  it('the run lock is held across pods; only its holder releases it', async () => {
    const { podA, podB } = twoPods()
    expect(await podA.acquireLock('e-1')).toBe(true)
    expect(await podB.acquireLock('e-1')).toBe(false)
    await podB.releaseLock('e-1') // not the holder: no effect
    expect(await podB.acquireLock('e-1')).toBe(false)
    await podA.releaseLock('e-1')
    expect(await podB.acquireLock('e-1')).toBe(true)
    expect(await podA.acquireLock('e-2')).toBe(true) // per execution
  })

  it('the lock of a pod that died mid-run expires after lockTtlSec, and a late release by it cannot free the new holder\'s lock', async () => {
    const { c, podA, podB } = twoPods()
    expect(await podA.acquireLock('e-1')).toBe(true) // pod A crashes here without releasing
    c.advanceSec(59)
    expect(await podB.acquireLock('e-1')).toBe(false)
    c.advanceSec(2)
    expect(await podB.acquireLock('e-1')).toBe(true)
    await podA.releaseLock('e-1') // pod A comes back and releases "its" lock
    expect(await podA.acquireLock('e-1')).toBe(false) // pod B still holds it
    expect(DEFAULT_MEMCACHE_LOCK_TTL_SEC).toBe(300)
  })

  it('retention is native: a terminal execution with expiresAt gives every item of it that TTL', async () => {
    const { c, memcache, podA } = twoPods()
    await podA.createExecution(execution('e-1'))
    await podA.putActivity({ executionId: 'e-1', sequence: 1, service: 'svc', status: ACTIVITY_STATUS.COMPLETED, request: { method: 'GET', rawPath: '/y', specPath: '/y' }, runIndex: 1, createdAt: 't', updatedAt: 't' })
    await podA.putApproval({ approvalId: 'ap-1', executionId: 'e-1', activitySequence: 1, status: 'APPROVED', summary: { service: 'svc', method: 'GET', specPath: '/y', reason: 'r', matchedRules: [] }, createdAt: 't' })
    await podA.putDecision({ executionId: 'e-1', activitySequence: 1, decision: 'ALLOW', reason: 'r', matchedRules: [], ruleVersions: [], evaluatedAt: 't' })
    await podA.createExecution(execution('other'))
    expect(memcache.keys().every(k => memcache.expiresAtMs(k) === undefined)).toBe(true) // live executions never expire

    const expiresAt = new Date(T0 + 3_600_000).toISOString()
    await podA.updateExecution({ ...(await podA.getExecution('e-1'))!, status: EXECUTION_STATUS.COMPLETED, finishedAt: new Date(T0).toISOString(), expiresAt })
    expect(await podA.listExpiredExecutions()).toEqual([])
    c.advanceSec(3599)
    expect(await podA.getExecution('e-1')).toBeDefined()
    c.advanceSec(2)
    expect(await podA.getExecution('e-1')).toBeUndefined()
    expect(await podA.listActivities('e-1')).toEqual([])
    expect(await podA.getApproval('ap-1')).toBeUndefined()
    expect(await podA.listDecisions('e-1')).toEqual([])
    expect(await podA.getExecution('other')).toBeDefined()
    expect(memcache.keys().some(k => k.includes('e-1'))).toBe(false)
  })

  it('a retention beyond 30 days is sent as an absolute Unix time, as memcached requires', async () => {
    const { memcache, podA } = twoPods()
    await podA.createExecution(execution('e-1'))
    const expiresAt = new Date(T0 + 40 * 24 * 3_600_000).toISOString()
    await podA.updateExecution({ ...execution('e-1'), status: EXECUTION_STATUS.COMPLETED, expiresAt })
    expect(memcache.expiresAtMs('harbor:exec:e-1')).toBe(Date.parse(expiresAt))
  })

  it('keys are namespaced and refuse ids that could forge or break a key', async () => {
    const memcache = new FakeMemcache()
    const store = new MemcacheCodeModeStore(memcache, { keyPrefix: 'staging:harbor:' })
    await store.createExecution(execution('e-1'))
    expect(memcache.keys()).toEqual(['staging:harbor:e-1'])
    await expect(store.createExecution(execution('e 1'))).rejects.toThrow(/Invalid id/)
    await expect(store.getApproval('ap-1\r\nflush_all')).rejects.toThrow(/Invalid id/)
  })

  it('is built for EXECUTION_STORE_TYPE=memcache (the client connects on first use)', async () => {
    const store = buildExecutionStore({ type: 'memcache', host: '127.0.0.1', port: 1, kvTimeoutMs: 100, lockTtlSec: 90 })
    expect(store).toBeInstanceOf(MemcacheCodeModeStore)
    expect(store.name).toBe('memcache')
    await store.destroy?.()
  })
})
