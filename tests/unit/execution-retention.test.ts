// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it, vi} from 'vitest'
import pino from 'pino'
import {ExecutionRetentionSweeper} from '../../src/runtime/execution/execution-retention.js'
import {InMemoryExecutionStore} from '../../src/adapters/execution/in-memory-execution-store.js'
import {buildGovernanceRuntime} from '../../src/runtime/execution/governance-runtime.js'
import type {ExecutionPersistence} from '../../src/spi/execution/execution-store.js'
import type {Logger} from '../../src/core/types/logger.types.js'
import {ExecutionManager, type RunOutcome} from '../../src/runtime/execution/execution-manager.js'
import {EXECUTION_STATUS, GOVERNANCE_DECISION, RUN_OUTCOME} from '../../src/core/constants.js'

const silent = pino({level: 'silent'}) as unknown as Logger
const NOW = '2026-06-01T00:00:00.000Z'

async function seed(persistence: ExecutionPersistence, id: string, expiresAt?: string) {
    await persistence.createExecution({
        executionId: id,
        service: 's',
        status: expiresAt ? EXECUTION_STATUS.COMPLETED : EXECUTION_STATUS.WAITING_APPROVAL,
        userIdHash: 'h',
        createdAt: 't',
        updatedAt: 't',
        currentActivity: 0,
        runCount: 1,
        ...(expiresAt ? {expiresAt} : {})
    })
    await persistence.putActivity({
        executionId: id,
        sequence: 1,
        service: 's',
        status: 'COMPLETED',
        request: {method: 'GET', rawPath: '/x', specPath: '/x'},
        runIndex: 1,
        createdAt: 't',
        updatedAt: 't'
    })
}

describe('ExecutionRetentionSweeper', () => {
    it('deletes only executions past their expiresAt, with their records; paused ones are never touched', async () => {
        const persistence = new InMemoryExecutionStore()
        await seed(persistence, 'expired', '2026-05-01T00:00:00.000Z')
        await seed(persistence, 'not-yet', '2026-07-01T00:00:00.000Z')
        await seed(persistence, 'paused')
        const sweeper = new ExecutionRetentionSweeper(persistence, 60, silent, () => NOW)
        expect(await sweeper.sweep()).toBe(1)
        expect(await persistence.getExecution('expired')).toBeUndefined()
        expect(await persistence.listActivities('expired')).toEqual([])
        expect(await persistence.getExecution('not-yet')).toBeDefined()
        expect(await persistence.getExecution('paused')).toBeDefined()
        expect(await sweeper.sweep()).toBe(0)
    })

    it('only a terminal execution gets an expiry: paused and interrupted executions are kept however long retention is', async () => {
        const persistence = new InMemoryExecutionStore()
        const manager = new ExecutionManager(persistence, undefined, undefined, {retentionSec: 1})
        const ended = async (outcome: RunOutcome) => {
            const {executionId} = await manager.create({service: 's', code: 'c', userIdHash: 'h'})
            await manager.beginRun(executionId)
            return manager.endRun(executionId, outcome)
        }
        const interrupted = await ended({kind: RUN_OUTCOME.INTERRUPTED, code: 'CIRCUIT_OPEN', message: 'open'})
        const paused = await ended({kind: RUN_OUTCOME.WAITING_APPROVAL, approvalId: 'ap-1'})
        const completed = await ended({kind: RUN_OUTCOME.COMPLETED, result: 1})
        const failed = await ended({kind: RUN_OUTCOME.FAILED, code: 'X', message: 'x'})
        expect(interrupted.expiresAt).toBeUndefined()
        expect(paused.expiresAt).toBeUndefined()
        expect(completed.expiresAt).toBeDefined()
        expect(failed.expiresAt).toBeDefined()

        // A year later the sweep removes exactly the two finished executions.
        const sweeper = new ExecutionRetentionSweeper(persistence, 1, silent, () => '2027-12-31T00:00:00.000Z')
        expect(await sweeper.sweep()).toBe(2)
        expect((await persistence.getExecution(interrupted.executionId))?.status).toBe(EXECUTION_STATUS.INTERRUPTED)
        expect((await persistence.getExecution(paused.executionId))?.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect(await persistence.getExecution(completed.executionId)).toBeUndefined()
    })

    it('works through more expired executions than one batch', async () => {
        const persistence = new InMemoryExecutionStore()
        for (let i = 0; i < 250; i++) await seed(persistence, `e-${i}`, '2026-05-01T00:00:00.000Z')
        expect(await new ExecutionRetentionSweeper(persistence, 60, silent, () => NOW).sweep()).toBe(250)
        expect(await persistence.listExpiredExecutions(NOW, 1000)).toEqual([])
    })

    it('a failing store is logged, not thrown', async () => {
        const errors: string[] = []
        const logger = {
            info() {
            }, warn() {
            }, debug() {
            }, error(_o: unknown, m: string) {
                errors.push(m)
            }
        } as unknown as Logger
        const persistence = {
            listExpiredExecutions: async () => {
                throw new Error('store down')
            }
        } as unknown as ExecutionPersistence
        expect(await new ExecutionRetentionSweeper(persistence, 60, logger, () => NOW).sweep()).toBe(0)
        expect(errors).toEqual(['Execution retention sweep failed — will retry'])
    })

    it('sweeps on min(retention, 1 h); never with retention 0; stops', async () => {
        vi.useFakeTimers()
        try {
            const listExpiredExecutions = vi.fn(async () => [])
            const persistence = {listExpiredExecutions} as unknown as ExecutionPersistence
            new ExecutionRetentionSweeper(persistence, 0, silent).start()
            await vi.advanceTimersByTimeAsync(7_200_000)
            expect(listExpiredExecutions).not.toHaveBeenCalled()

            const short = new ExecutionRetentionSweeper(persistence, 120, silent)
            short.start()
            await vi.advanceTimersByTimeAsync(360_000)
            expect(listExpiredExecutions).toHaveBeenCalledTimes(3)
            short.stop()

            listExpiredExecutions.mockClear()
            const long = new ExecutionRetentionSweeper(persistence, 86_400, silent)
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
            const governanceRuntime = await buildGovernanceRuntime({
                store: {type: 'in-memory'},
                retention: {executionSec: 60},
                governance: {defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600}
            }, [], silent)
            const rec = await governanceRuntime.executionManager.create({service: 'svc', code: 'c', userIdHash: 'h'})
            await governanceRuntime.executionManager.beginRun(rec.executionId)
            await governanceRuntime.executionManager.endRun(rec.executionId, {kind: 'completed', result: 1})
            await vi.advanceTimersByTimeAsync(59_000)
            expect(await governanceRuntime.persistence.getExecution(rec.executionId)).toBeDefined()
            await vi.advanceTimersByTimeAsync(62_000)
            expect(await governanceRuntime.persistence.getExecution(rec.executionId)).toBeUndefined()
            await governanceRuntime.shutdown()
        } finally {
            vi.useRealTimers()
        }
    })
})
