// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import pino from 'pino'
import { ExecutionRetentionSweeper } from '../../src/runtime/execution/execution-retention.js'
import { InMemoryCodeModeStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { buildCodeModeRuntime } from '../../src/runtime/execution/code-mode-runtime.js'
import type { CodeModeStore } from '../../src/spi/execution/execution-store.js'
import type { Logger } from '../../src/core/types/logger.types.js'
import { EXECUTION_STATUS, GOVERNANCE_DECISION } from '../../src/core/constants.js'

const silent = pino({ level: 'silent' }) as unknown as Logger
const NOW = '2026-06-01T00:00:00.000Z'

async function seed(store: CodeModeStore, id: string, expiresAt?: string) {
  await store.createExecution({
    executionId: id, service: 's', status: expiresAt ? EXECUTION_STATUS.COMPLETED : EXECUTION_STATUS.WAITING_APPROVAL,
    userIdHash: 'h', createdAt: 't', updatedAt: 't', currentActivity: 0, runCount: 1,
    ...(expiresAt ? { expiresAt } : {})
  })
  await store.putActivity({ executionId: id, sequence: 1, service: 's', status: 'COMPLETED', request: { method: 'GET', rawPath: '/x', specPath: '/x' }, runIndex: 1, createdAt: 't', updatedAt: 't' })
}

describe('ExecutionRetentionSweeper', () => {
  it('deletes only executions past their expiresAt, with their records; paused ones are never touched', async () => {
    const store = new InMemoryCodeModeStore()
    await seed(store, 'expired', '2026-05-01T00:00:00.000Z')
    await seed(store, 'not-yet', '2026-07-01T00:00:00.000Z')
    await seed(store, 'paused')
    const sweeper = new ExecutionRetentionSweeper(store, 60, silent, () => NOW)
    expect(await sweeper.sweep()).toBe(1)
    expect(await store.getExecution('expired')).toBeUndefined()
    expect(await store.listActivities('expired')).toEqual([])
    expect(await store.getExecution('not-yet')).toBeDefined()
    expect(await store.getExecution('paused')).toBeDefined()
    expect(await sweeper.sweep()).toBe(0)
  })

  it('works through more expired executions than one batch', async () => {
    const store = new InMemoryCodeModeStore()
    for (let i = 0; i < 250; i++) await seed(store, `e-${i}`, '2026-05-01T00:00:00.000Z')
    expect(await new ExecutionRetentionSweeper(store, 60, silent, () => NOW).sweep()).toBe(250)
    expect(await store.listExpiredExecutions(NOW, 1000)).toEqual([])
  })

  it('a failing store is logged, not thrown', async () => {
    const errors: string[] = []
    const logger = { info() {}, warn() {}, debug() {}, error(_o: unknown, m: string) { errors.push(m) } } as unknown as Logger
    const store = { listExpiredExecutions: async () => { throw new Error('store down') } } as unknown as CodeModeStore
    expect(await new ExecutionRetentionSweeper(store, 60, logger, () => NOW).sweep()).toBe(0)
    expect(errors).toEqual(['Execution retention sweep failed — will retry'])
  })

  it('sweeps on min(retention, 1 h); never with retention 0; stops', async () => {
    vi.useFakeTimers()
    try {
      const listExpiredExecutions = vi.fn(async () => [])
      const store = { listExpiredExecutions } as unknown as CodeModeStore
      new ExecutionRetentionSweeper(store, 0, silent).start()
      await vi.advanceTimersByTimeAsync(7_200_000)
      expect(listExpiredExecutions).not.toHaveBeenCalled()

      const short = new ExecutionRetentionSweeper(store, 120, silent)
      short.start()
      await vi.advanceTimersByTimeAsync(360_000)
      expect(listExpiredExecutions).toHaveBeenCalledTimes(3)
      short.stop()

      listExpiredExecutions.mockClear()
      const long = new ExecutionRetentionSweeper(store, 86_400, silent)
      long.start()
      await vi.advanceTimersByTimeAsync(7_200_000)
      expect(listExpiredExecutions).toHaveBeenCalledTimes(2) // hourly
      long.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('end to end: a finished execution is deleted once EXECUTION_RETENTION_SEC has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const rt = await buildCodeModeRuntime({
        store: { type: 'in-memory' },
        retention: { executionSec: 60 },
        governance: { rulesDir: '/nonexistent', defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600 }
      }, silent)
      const rec = await rt.manager.create({ service: 'svc', code: 'c', userIdHash: 'h' })
      await rt.manager.beginRun(rec.executionId)
      await rt.manager.endRun(rec.executionId, { kind: 'completed', result: 1 })
      await vi.advanceTimersByTimeAsync(59_000)
      expect(await rt.store.getExecution(rec.executionId)).toBeDefined()
      await vi.advanceTimersByTimeAsync(62_000)
      expect(await rt.store.getExecution(rec.executionId)).toBeUndefined()
      await rt.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
})
