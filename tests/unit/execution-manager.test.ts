// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach } from 'vitest'
import { ExecutionManager, buildHistory } from '../../src/runtime/execution/execution-manager.js'
import { InMemoryCodeModeStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { EXECUTION_STATUS, APPROVAL_STATUS, ACTIVITY_STATUS, GOVERNANCE_DECISION, ERR, EXECUTION_CODE_RETENTION } from '../../src/core/constants.js'
import {
  ExecutionNotFoundError, ExecutionLockedError, ExecutionNotResumableError,
  ApprovalPendingError, ApprovalRequiredError
} from '../../src/core/types/execution.types.js'

let tick = 0
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
let ids = 0
const newId = () => `exec-${++ids}`

describe('ExecutionManager', () => {
  let store: InMemoryCodeModeStore
  let manager: ExecutionManager
  beforeEach(() => {
    tick = 0; ids = 0
    store = new InMemoryCodeModeStore()
    manager = new ExecutionManager(store, clock, newId)
  })

  it('creates an execution with a durable id and persists the original code', async () => {
    const rec = await manager.create({ service: 'svc', code: 'async () => 42', userIdHash: 'h' })
    expect(rec.executionId).toBe('exec-1')
    expect(rec.status).toBe(EXECUTION_STATUS.CREATED)
    expect((await manager.load('exec-1')).originalCode).toBe('async () => 42')
    await expect(manager.load('nope')).rejects.toBeInstanceOf(ExecutionNotFoundError)
  })

  it('beginRun takes the lock, marks RUNNING and counts runs; a concurrent run is refused', async () => {
    await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    const running = await manager.beginRun('exec-1')
    expect(running.status).toBe(EXECUTION_STATUS.RUNNING)
    expect(running.runCount).toBe(1)
    await expect(manager.beginRun('exec-1')).rejects.toBeInstanceOf(ExecutionLockedError)
    await manager.endRun('exec-1', { kind: 'completed', result: { ok: true } })
    const done = await manager.load('exec-1')
    expect(done.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(done.result).toEqual({ ok: true })
    // lock released, but a COMPLETED execution is terminal
    await expect(manager.beginRun('exec-1')).rejects.toBeInstanceOf(ExecutionNotResumableError)
  })

  it('a paused execution resumes only after its approval has been decided', async () => {
    await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await manager.beginRun('exec-1')
    await manager.endRun('exec-1', { kind: 'waitingApproval', approvalId: 'ap-1' })
    await store.putApproval({
      approvalId: 'ap-1', executionId: 'exec-1', activitySequence: 3, status: APPROVAL_STATUS.PENDING,
      summary: { service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: [] }, createdAt: clock()
    })
    expect((await manager.load('exec-1')).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    // Undecided approval ⇒ the pause signal again, not a termination.
    const pending = await manager.beginRun('exec-1').catch((e: unknown) => e)
    expect(pending).toBeInstanceOf(ApprovalPendingError)
    expect(pending).toBeInstanceOf(ApprovalRequiredError)
    expect(pending).toMatchObject({ code: ERR.APPROVAL_REQUIRED, executionId: 'exec-1', approvalId: 'ap-1', activitySequence: 3 })
    // …and the record is untouched: still paused, no extra run counted, lock free.
    const untouched = await manager.load('exec-1')
    expect(untouched.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(untouched.runCount).toBe(1)
    expect(await store.acquireLock('exec-1')).toBe(true)
    await store.releaseLock('exec-1')

    const ap = (await store.getApproval('ap-1'))!
    await store.putApproval({ ...ap, status: APPROVAL_STATUS.APPROVED, decidedAt: clock() })
    const resumed = await manager.beginRun('exec-1')
    expect(resumed.runCount).toBe(2)
    expect(resumed.status).toBe(EXECUTION_STATUS.RUNNING)
  })

  describe('code retention (EXECUTION_CODE_RETENTION)', () => {
    it('DROP (default): the program text is removed once the execution is terminal, kept while it can still resume', async () => {
      for (const [kind, extra] of [
        ['completed', { result: 1 }], ['failed', { code: 'X', message: 'm' }], ['denied', { code: 'X', message: 'm' }], ['cancelled', { code: 'X', message: 'm' }]
      ] as const) {
        const rec = await manager.create({ service: 'svc', code: 'async () => 1', userIdHash: 'h' })
        await manager.beginRun(rec.executionId)
        await manager.endRun(rec.executionId, { kind, ...extra } as never)
        expect((await manager.load(rec.executionId)).originalCode).toBeUndefined()
      }
      for (const outcome of [{ kind: 'waitingApproval', approvalId: 'ap' }, { kind: 'interrupted', code: 'CIRCUIT_OPEN', message: 'm' }] as const) {
        const rec = await manager.create({ service: 'svc', code: 'async () => 2', userIdHash: 'h' })
        await manager.beginRun(rec.executionId)
        await manager.endRun(rec.executionId, outcome)
        expect((await manager.load(rec.executionId)).originalCode).toBe('async () => 2')
      }
    })

    it('DROP applies to a human rejection or cancellation too', async () => {
      for (const status of [EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED] as const) {
        const rec = await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
        await manager.markApprovalDecided(rec.executionId, status, { code: 'X', message: 'm' })
        expect((await manager.load(rec.executionId)).originalCode).toBeUndefined()
      }
    })

    it('KEEP stores the code against the executionId for good', async () => {
      const keep = new ExecutionManager(store, clock, newId, { codeRetention: EXECUTION_CODE_RETENTION.KEEP })
      const rec = await keep.create({ service: 'svc', code: 'async () => 3', userIdHash: 'h' })
      await keep.beginRun(rec.executionId)
      await keep.endRun(rec.executionId, { kind: 'completed', result: 3 })
      await keep.markApprovalDecided((await keep.create({ service: 'svc', code: 'k', userIdHash: 'h' })).executionId, EXECUTION_STATUS.DENIED)
      expect((await keep.load(rec.executionId)).originalCode).toBe('async () => 3')
      expect((await keep.load('exec-2')).originalCode).toBe('k')
    })

    it('an execution without its program cannot be resumed — nothing else may run in its place', async () => {
      const rec = await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
      const { originalCode: _dropped, ...withoutCode } = await manager.load(rec.executionId)
      await store.updateExecution({ ...withoutCode, status: EXECUTION_STATUS.INTERRUPTED })
      await expect(manager.beginRun(rec.executionId)).rejects.toBeInstanceOf(ExecutionNotResumableError)
    })
  })

  it('stamps a terminal execution with finishedAt, and with expiresAt under a retention period; a paused one gets neither', async () => {
    const retained = new ExecutionManager(store, clock, newId, { retentionSec: 3600 })
    const done = await retained.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await retained.beginRun(done.executionId)
    await retained.endRun(done.executionId, { kind: 'completed', result: 1 })
    const finished = await retained.load(done.executionId)
    expect(finished.finishedAt).toBe(finished.updatedAt)
    expect(Date.parse(finished.expiresAt!) - Date.parse(finished.finishedAt!)).toBe(3_600_000)

    const paused = await retained.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await retained.beginRun(paused.executionId)
    await retained.endRun(paused.executionId, { kind: 'waitingApproval', approvalId: 'ap' })
    expect((await retained.load(paused.executionId)).finishedAt).toBeUndefined()
    expect((await retained.load(paused.executionId)).expiresAt).toBeUndefined()

    const rejected = await retained.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await retained.markApprovalDecided(rejected.executionId, EXECUTION_STATUS.DENIED)
    expect((await retained.load(rejected.executionId)).expiresAt).toBeDefined()

    // no retention period ⇒ finished, but never expires
    const kept = await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await manager.beginRun(kept.executionId)
    await manager.endRun(kept.executionId, { kind: 'failed', code: 'X', message: 'm' })
    expect((await manager.load(kept.executionId)).finishedAt).toBeDefined()
    expect((await manager.load(kept.executionId)).expiresAt).toBeUndefined()
  })

  it('endRun records terminal reasons for failed / denied / cancelled and releases the lock', async () => {
    for (const [kind, status] of [
      ['failed', EXECUTION_STATUS.FAILED], ['denied', EXECUTION_STATUS.DENIED], ['cancelled', EXECUTION_STATUS.CANCELLED]
    ] as const) {
      const rec = await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
      await manager.beginRun(rec.executionId)
      await manager.endRun(rec.executionId, { kind, code: 'X', message: 'why' })
      const after = await manager.load(rec.executionId)
      expect(after.status).toBe(status)
      expect(after.terminalReason).toEqual({ code: 'X', message: 'why' })
      expect(await store.acquireLock(rec.executionId)).toBe(true)
      await store.releaseLock(rec.executionId)
    }
  })

  it('a RUNNING record whose lock is free (crashed run) can be resumed from its journal', async () => {
    await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    const rec = await manager.beginRun('exec-1')
    // simulate a process crash: status stays RUNNING, lock evaporates
    await store.releaseLock('exec-1')
    expect(rec.status).toBe(EXECUTION_STATUS.RUNNING)
    const again = await manager.beginRun('exec-1')
    expect(again.runCount).toBe(2)
  })

  it('recordProgress only ever raises the activity high-water mark', async () => {
    await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await manager.beginRun('exec-1') // progress is recorded by a live run
    await manager.recordProgress('exec-1', 3)
    await manager.recordProgress('exec-1', 2)
    expect((await manager.load('exec-1')).currentActivity).toBe(3)
  })

  it('recordProgress never writes over a run that has finished (a stale copy would resurrect it)', async () => {
    await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    await manager.beginRun('exec-1')
    const finished = await manager.endRun('exec-1', { kind: 'completed', result: 1 })
    await manager.recordProgress('exec-1', 9)
    expect(await manager.load('exec-1')).toEqual(finished)
  })

  it('inspect assembles a chronological history from the records', async () => {
    const rec = await manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
    const id = rec.executionId
    await manager.beginRun(id)
    await store.putActivity({
      executionId: id, sequence: 1, service: 'svc', status: ACTIVITY_STATUS.COMPLETED,
      request: { method: 'GET', rawPath: '/a', specPath: '/a' }, response: { status: 200, ok: true, data: [] },
      runIndex: 1, createdAt: clock(), updatedAt: clock()
    })
    await store.putDecision({
      executionId: id, activitySequence: 2, decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, reason: 'RULE_MATCHED',
      matchedRules: ['big'], ruleVersions: ['big@1#x'], evaluatedAt: clock()
    })
    const createdAt = clock()
    await store.putActivity({
      executionId: id, sequence: 2, service: 'svc', status: ACTIVITY_STATUS.WAITING_APPROVAL,
      request: { method: 'POST', rawPath: '/b', specPath: '/b' }, runIndex: 1, createdAt, updatedAt: createdAt, approvalId: 'ap'
    })
    await store.putApproval({
      approvalId: 'ap', executionId: id, activitySequence: 2, status: APPROVAL_STATUS.PENDING,
      summary: { service: 'svc', method: 'POST', specPath: '/b', reason: 'r', matchedRules: ['big'] }, createdAt: clock()
    })
    await manager.endRun(id, { kind: 'waitingApproval', approvalId: 'ap' })
    const { history } = await manager.inspect(id)
    const events = history.map(h => `${h.kind}:${h.event}${h.sequence ? '#' + h.sequence : ''}`)
    expect(events).toEqual([
      'EXECUTION:CREATED',
      'ACTIVITY:ENCOUNTERED#1', 'ACTIVITY:COMPLETED#1',
      'GOVERNANCE:REQUIRE_APPROVAL#2',
      'ACTIVITY:ENCOUNTERED#2',
      'APPROVAL:REQUESTED#2',
      'EXECUTION:WAITING_APPROVAL'
    ])
    expect(history.map(h => h.at)).toEqual([...history.map(h => h.at)].sort())
  })

  it('buildHistory records human decisions and terminal reasons', () => {
    const base = { executionId: 'e', service: 's', originalCode: 'c', userIdHash: 'h', currentActivity: 1, runCount: 2 }
    const h = buildHistory(
      { ...base, status: EXECUTION_STATUS.DENIED, createdAt: 't0', updatedAt: 't9', terminalReason: { code: 'GOVERNANCE_DENIED', message: 'm' } },
      [], [{
        approvalId: 'a', executionId: 'e', activitySequence: 1, status: APPROVAL_STATUS.REJECTED, createdAt: 't1', decidedAt: 't2',
        decidedVia: 'mcp-elicitation', summary: { service: 's', method: 'POST', specPath: '/p', reason: 'r', matchedRules: [] }
      }], []
    )
    expect(h.map(x => x.event)).toEqual(['CREATED', 'REQUESTED', 'REJECTED', 'DENIED'])
    expect(h[2]?.detail).toBe('mcp-elicitation')
    expect(h[3]?.detail).toBe('GOVERNANCE_DENIED')
  })
})
