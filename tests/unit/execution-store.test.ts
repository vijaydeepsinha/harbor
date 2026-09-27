// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodeModeStore } from '../../src/spi/execution/execution-store.js'
import { InMemoryCodeModeStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { FileCodeModeStore } from '../../src/adapters/execution/file-execution-store.js'
import { MemcacheCodeModeStore } from '../../src/adapters/execution/memcache-execution-store.js'
import { FakeMemcache } from './fake-memcache.js'
import { buildExecutionStore, registerExecutionStoreBackend } from '../../src/wiring/strategy-builders.js'
import { EXECUTION_STATUS, ACTIVITY_STATUS, APPROVAL_STATUS, GOVERNANCE_DECISION } from '../../src/core/constants.js'
import type { ExecutionRecord, ActivityRecord } from '../../src/core/types/execution.types.js'

const now = () => new Date().toISOString()

function execution(id = 'e-1'): ExecutionRecord {
  return {
    executionId: id, service: 'svc', originalCode: 'async () => 1', status: EXECUTION_STATUS.CREATED,
    userIdHash: 'abc', createdAt: now(), updatedAt: now(), currentActivity: 0, runCount: 0
  }
}

function activity(executionId: string, sequence: number, method: 'GET' | 'POST' = 'GET'): ActivityRecord {
  return {
    executionId, sequence, service: 'svc', status: ACTIVITY_STATUS.COMPLETED,
    request: { method, rawPath: `/things/${sequence}`, specPath: '/things/{id}' },
    response: { status: 200, ok: true, data: { n: sequence } },
    runIndex: 1, createdAt: now(), updatedAt: now()
  }
}

/** `nativeExpiry`: the store expires records itself (item TTLs), so it never lists expired executions. */
function contractSuite(name: string, make: () => CodeModeStore, cleanup?: () => void, opts: { nativeExpiry?: boolean } = {}) {
  describe(`${name} store contract`, () => {
    let store: CodeModeStore
    beforeEach(() => { store = make() })
    afterEach(() => { cleanup?.() })

    it('creates, reads and updates executions; rejects duplicates and unknown updates', async () => {
      await store.createExecution(execution())
      const got = await store.getExecution('e-1')
      expect(got?.status).toBe(EXECUTION_STATUS.CREATED)
      await expect(store.createExecution(execution())).rejects.toThrow(/already exists/)
      await store.updateExecution({ ...got!, status: EXECUTION_STATUS.RUNNING, currentActivity: 2 })
      expect((await store.getExecution('e-1'))?.currentActivity).toBe(2)
      await expect(store.updateExecution(execution('nope'))).rejects.toThrow(/does not exist/)
      expect(await store.getExecution('missing')).toBeUndefined()
    })

    it('returns detached copies — mutating a result never changes the store', async () => {
      await store.createExecution(execution())
      const a = await store.getExecution('e-1')
      a!.status = EXECUTION_STATUS.FAILED
      expect((await store.getExecution('e-1'))?.status).toBe(EXECUTION_STATUS.CREATED)
      const rec = execution('e-2')
      await store.createExecution(rec)
      rec.status = EXECUTION_STATUS.DENIED
      expect((await store.getExecution('e-2'))?.status).toBe(EXECUTION_STATUS.CREATED)
    })

    it('journals activities by sequence and lists them in order', async () => {
      await store.createExecution(execution())
      await store.putActivity(activity('e-1', 3, 'POST'))
      await store.putActivity(activity('e-1', 1))
      await store.putActivity(activity('e-1', 2))
      const list = await store.listActivities('e-1')
      expect(list.map(a => a.sequence)).toEqual([1, 2, 3])
      expect((await store.getActivity('e-1', 3))?.request.method).toBe('POST')
      expect(await store.getActivity('e-1', 9)).toBeUndefined()
      expect(await store.listActivities('other')).toEqual([])
      // overwrite keeps one record per sequence
      await store.putActivity({ ...activity('e-1', 2), status: ACTIVITY_STATUS.FAILED })
      expect((await store.listActivities('e-1')).length).toBe(3)
      expect((await store.getActivity('e-1', 2))?.status).toBe(ACTIVITY_STATUS.FAILED)
    })

    it('stores approvals and governance decisions per execution', async () => {
      await store.createExecution(execution())
      await store.putApproval({
        approvalId: 'a-1', executionId: 'e-1', activitySequence: 3, status: APPROVAL_STATUS.PENDING,
        summary: { service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: ['r1'] },
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      await store.putApproval({
        approvalId: 'a-0', executionId: 'e-1', activitySequence: 1, status: APPROVAL_STATUS.APPROVED,
        summary: { service: 'svc', method: 'POST', specPath: '/y', reason: 'r', matchedRules: [] },
        createdAt: '2025-12-31T00:00:00.000Z'
      })
      expect((await store.listApprovals('e-1')).map(a => a.approvalId)).toEqual(['a-0', 'a-1'])
      expect((await store.getApproval('a-1'))?.status).toBe(APPROVAL_STATUS.PENDING)
      await store.putDecision({
        executionId: 'e-1', activitySequence: 1, decision: GOVERNANCE_DECISION.ALLOW, reason: 'NO_MATCHING_RULE',
        matchedRules: [], ruleVersions: [], evaluatedAt: '2026-01-01T00:00:01.000Z'
      })
      await store.putDecision({
        executionId: 'e-1', activitySequence: 3, decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, reason: 'RULE_MATCHED',
        matchedRules: ['r1'], ruleVersions: ['r1@1#abc'], evaluatedAt: '2026-01-01T00:00:02.000Z'
      })
      const decisions = await store.listDecisions('e-1')
      expect(decisions.map(d => d.activitySequence)).toEqual([1, 3])
    })

    it('deleteExecution removes the execution and everything recorded for it — and nothing else', async () => {
      for (const id of ['e-1', 'e-2']) {
        await store.createExecution(execution(id))
        await store.putActivity(activity(id, 1))
        await store.putApproval({ approvalId: `ap-${id}`, executionId: id, activitySequence: 1, status: APPROVAL_STATUS.PENDING, summary: { service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: [] }, createdAt: now() })
        await store.putDecision({ executionId: id, activitySequence: 1, decision: GOVERNANCE_DECISION.ALLOW, reason: 'NO_GOVERNANCE', matchedRules: [], ruleVersions: [], evaluatedAt: now() })
      }
      await store.acquireLock('e-1')
      await store.deleteExecution('e-1')
      expect(await store.getExecution('e-1')).toBeUndefined()
      expect(await store.listActivities('e-1')).toEqual([])
      expect(await store.getApproval('ap-e-1')).toBeUndefined()
      expect(await store.listDecisions('e-1')).toEqual([])
      expect(await store.acquireLock('e-1')).toBe(true)
      expect(await store.getExecution('e-2')).toBeDefined()
      expect(await store.listActivities('e-2')).toHaveLength(1)
      expect(await store.getApproval('ap-e-2')).toBeDefined()
      await store.deleteExecution('never-existed')
    })

    it.skipIf(opts.nativeExpiry)('listExpiredExecutions returns only executions past their expiresAt, oldest first, up to the limit', async () => {
      const at = (iso: string) => ({ expiresAt: iso })
      await store.createExecution({ ...execution('late'), ...at('2026-01-03T00:00:00.000Z') })
      await store.createExecution({ ...execution('early'), ...at('2026-01-01T00:00:00.000Z') })
      await store.createExecution({ ...execution('future'), ...at('2027-01-01T00:00:00.000Z') })
      await store.createExecution(execution('kept')) // no expiresAt: never swept
      expect(await store.listExpiredExecutions('2026-06-01T00:00:00.000Z', 10)).toEqual(['early', 'late'])
      expect(await store.listExpiredExecutions('2026-06-01T00:00:00.000Z', 1)).toEqual(['early'])
      expect(await store.listExpiredExecutions('2026-01-01T00:00:00.000Z', 10)).toEqual(['early']) // at expiresAt is expired
    })

    it('locks are exclusive per execution and released explicitly', async () => {
      expect(await store.acquireLock('e-1')).toBe(true)
      expect(await store.acquireLock('e-1')).toBe(false)
      expect(await store.acquireLock('e-2')).toBe(true)
      await store.releaseLock('e-1')
      expect(await store.acquireLock('e-1')).toBe(true)
    })
  })
}

contractSuite('in-memory', () => new InMemoryCodeModeStore())

let fileDir = ''
contractSuite(
  'file',
  () => { fileDir = mkdtempSync(join(tmpdir(), 'harbor-exec-')); return new FileCodeModeStore(fileDir) },
  () => { if (fileDir) rmSync(fileDir, { recursive: true, force: true }) }
)

contractSuite('memcache', () => new MemcacheCodeModeStore(new FakeMemcache()), undefined, { nativeExpiry: true })

describe('file store durability', () => {
  it('reloads executions, activities, approvals and decisions from disk in a new instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
    try {
      const first = new FileCodeModeStore(dir)
      await first.createExecution({ ...execution('e-9'), status: EXECUTION_STATUS.WAITING_APPROVAL, currentActivity: 2 })
      await first.putActivity(activity('e-9', 1))
      await first.putActivity({ ...activity('e-9', 2, 'POST'), status: ACTIVITY_STATUS.WAITING_APPROVAL, approvalId: 'a-9' })
      await first.putApproval({
        approvalId: 'a-9', executionId: 'e-9', activitySequence: 2, status: APPROVAL_STATUS.PENDING,
        summary: { service: 'svc', method: 'POST', specPath: '/things/{id}', reason: 'r', matchedRules: ['rule'] }, createdAt: now()
      })
      await first.putDecision({
        executionId: 'e-9', activitySequence: 2, decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, reason: 'RULE_MATCHED',
        matchedRules: ['rule'], ruleVersions: ['rule@1#x'], evaluatedAt: now()
      })
      expect(readdirSync(dir)).toEqual(['e-9.json'])

      // "process restart"
      const second = new FileCodeModeStore(dir)
      expect((await second.getExecution('e-9'))?.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
      expect((await second.listActivities('e-9')).map(a => a.sequence)).toEqual([1, 2])
      expect((await second.getActivity('e-9', 2))?.approvalId).toBe('a-9')
      expect((await second.getApproval('a-9'))?.status).toBe(APPROVAL_STATUS.PENDING)
      expect((await second.listDecisions('e-9')).length).toBe(1)
      // locks are process-local: a fresh instance starts unlocked
      expect(await second.acquireLock('e-9')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a deleted execution\'s document is removed from disk and does not come back on reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
    try {
      const a = new FileCodeModeStore(dir)
      await a.createExecution(execution('e-1'))
      await a.createExecution(execution('e-2'))
      await a.deleteExecution('e-1')
      expect(readdirSync(dir).sort()).toEqual(['e-2.json'])
      const b = new FileCodeModeStore(dir)
      expect(await b.getExecution('e-1')).toBeUndefined()
      expect(await b.getExecution('e-2')).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an executionId that could escape the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
    try {
      const store = new FileCodeModeStore(dir)
      await expect(store.createExecution(execution('../evil'))).rejects.toThrow(/Invalid executionId/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildExecutionStore', () => {
  it('builds in-memory by default and file when configured', () => {
    expect(buildExecutionStore(undefined).name).toBe('in-memory')
    expect(buildExecutionStore({ type: 'in-memory' }).name).toBe('in-memory')
    const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
    try {
      expect(buildExecutionStore({ type: 'file', dir }).name).toBe('file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets a custom backend take over its type string', () => {
    const custom = new InMemoryCodeModeStore()
    registerExecutionStoreBackend('custom-kv', () => custom)
    expect(buildExecutionStore({ type: 'custom-kv' } as never)).toBe(custom)
  })
})
