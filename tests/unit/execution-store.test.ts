// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {ExecutionPersistence} from '../../src/spi/execution/execution-store.js'
import {InMemoryExecutionStore} from '../../src/adapters/execution/in-memory-execution-store.js'
import {FileExecutionStore} from '../../src/adapters/execution/file-execution-store.js'
import {MemcacheExecutionStore} from '../../src/adapters/execution/memcache-execution-store.js'
import {FakeMemcache} from './fake-memcache.js'
import {buildExecutionStore, registerExecutionStoreBackend} from '../../src/wiring/strategy-builders.js'
import {ACTIVITY_STATUS, APPROVAL_STATUS, EXECUTION_STATUS, GOVERNANCE_DECISION} from '../../src/core/constants.js'
import type {ActivityRecord, ExecutionRecord} from '../../src/core/types/execution.types.js'

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
        request: {method, rawPath: `/things/${sequence}`, specPath: '/things/{id}'},
        response: {status: 200, ok: true, data: {n: sequence}},
        runIndex: 1, createdAt: now(), updatedAt: now()
    }
}

/** `nativeExpiry`: the store expires records itself (item TTLs), so it never lists expired executions. */
function contractSuite(name: string, make: () => ExecutionPersistence, cleanup?: () => void, opts: {
    nativeExpiry?: boolean
} = {}) {
    describe(`${name} store contract`, () => {
        let persistence: ExecutionPersistence
        beforeEach(() => {
            persistence = make()
        })
        afterEach(() => {
            cleanup?.()
        })

        it('creates, reads and updates executions; rejects duplicates and unknown updates', async () => {
            await persistence.createExecution(execution())
            const got = await persistence.getExecution('e-1')
            expect(got?.status).toBe(EXECUTION_STATUS.CREATED)
            await expect(persistence.createExecution(execution())).rejects.toThrow(/already exists/)
            await persistence.updateExecution({...got!, status: EXECUTION_STATUS.RUNNING, currentActivity: 2})
            expect((await persistence.getExecution('e-1'))?.currentActivity).toBe(2)
            await expect(persistence.updateExecution(execution('nope'))).rejects.toThrow(/does not exist/)
            expect(await persistence.getExecution('missing')).toBeUndefined()
        })

        it('returns detached copies — mutating a result never changes the store', async () => {
            await persistence.createExecution(execution())
            const a = await persistence.getExecution('e-1')
            a!.status = EXECUTION_STATUS.FAILED
            expect((await persistence.getExecution('e-1'))?.status).toBe(EXECUTION_STATUS.CREATED)
            const rec = execution('e-2')
            await persistence.createExecution(rec)
            rec.status = EXECUTION_STATUS.DENIED
            expect((await persistence.getExecution('e-2'))?.status).toBe(EXECUTION_STATUS.CREATED)
        })

        it('journals activities by sequence and lists them in order', async () => {
            await persistence.createExecution(execution())
            await persistence.putActivity(activity('e-1', 3, 'POST'))
            await persistence.putActivity(activity('e-1', 1))
            await persistence.putActivity(activity('e-1', 2))
            const list = await persistence.listActivities('e-1')
            expect(list.map(a => a.sequence)).toEqual([1, 2, 3])
            expect((await persistence.getActivity('e-1', 3))?.request.method).toBe('POST')
            expect(await persistence.getActivity('e-1', 9)).toBeUndefined()
            expect(await persistence.listActivities('other')).toEqual([])
            // overwrite keeps one record per sequence
            await persistence.putActivity({...activity('e-1', 2), status: ACTIVITY_STATUS.FAILED})
            expect((await persistence.listActivities('e-1')).length).toBe(3)
            expect((await persistence.getActivity('e-1', 2))?.status).toBe(ACTIVITY_STATUS.FAILED)
        })

        it('stores approvals and governance decisions per execution', async () => {
            await persistence.createExecution(execution())
            await persistence.putApproval({
                approvalId: 'a-1', executionId: 'e-1', activitySequence: 3, status: APPROVAL_STATUS.PENDING,
                summary: {service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: ['r1']},
                createdAt: '2026-01-01T00:00:00.000Z'
            })
            await persistence.putApproval({
                approvalId: 'a-0', executionId: 'e-1', activitySequence: 1, status: APPROVAL_STATUS.APPROVED,
                summary: {service: 'svc', method: 'POST', specPath: '/y', reason: 'r', matchedRules: []},
                createdAt: '2025-12-31T00:00:00.000Z'
            })
            expect((await persistence.listApprovals('e-1')).map(a => a.approvalId)).toEqual(['a-0', 'a-1'])
            expect((await persistence.getApproval('a-1'))?.status).toBe(APPROVAL_STATUS.PENDING)
            await persistence.putDecision({
                executionId: 'e-1',
                activitySequence: 1,
                decision: GOVERNANCE_DECISION.ALLOW,
                reason: 'NO_MATCHING_RULE',
                matchedRules: [],
                ruleVersions: [],
                evaluatedAt: '2026-01-01T00:00:01.000Z'
            })
            await persistence.putDecision({
                executionId: 'e-1',
                activitySequence: 3,
                decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL,
                reason: 'RULE_MATCHED',
                matchedRules: ['r1'],
                ruleVersions: ['r1@1#abc'],
                evaluatedAt: '2026-01-01T00:00:02.000Z'
            })
            const decisions = await persistence.listDecisions('e-1')
            expect(decisions.map(d => d.activitySequence)).toEqual([1, 3])
        })

        it('deleteExecution removes the execution and everything recorded for it — and nothing else', async () => {
            for (const id of ['e-1', 'e-2']) {
                await persistence.createExecution(execution(id))
                await persistence.putActivity(activity(id, 1))
                await persistence.putApproval({
                    approvalId: `ap-${id}`,
                    executionId: id,
                    activitySequence: 1,
                    status: APPROVAL_STATUS.PENDING,
                    summary: {service: 'svc', method: 'POST', specPath: '/x', reason: 'r', matchedRules: []},
                    createdAt: now()
                })
                await persistence.putDecision({
                    executionId: id,
                    activitySequence: 1,
                    decision: GOVERNANCE_DECISION.ALLOW,
                    reason: 'NO_GOVERNANCE',
                    matchedRules: [],
                    ruleVersions: [],
                    evaluatedAt: now()
                })
            }
            await persistence.acquireLock('e-1')
            await persistence.deleteExecution('e-1')
            expect(await persistence.getExecution('e-1')).toBeUndefined()
            expect(await persistence.listActivities('e-1')).toEqual([])
            expect(await persistence.getApproval('ap-e-1')).toBeUndefined()
            expect(await persistence.listDecisions('e-1')).toEqual([])
            expect(await persistence.acquireLock('e-1')).toBe(true)
            expect(await persistence.getExecution('e-2')).toBeDefined()
            expect(await persistence.listActivities('e-2')).toHaveLength(1)
            expect(await persistence.getApproval('ap-e-2')).toBeDefined()
            await persistence.deleteExecution('never-existed')
        })

        it.skipIf(opts.nativeExpiry)('listExpiredExecutions returns only executions past their expiresAt, oldest first, up to the limit', async () => {
            const at = (iso: string) => ({expiresAt: iso})
            await persistence.createExecution({...execution('late'), ...at('2026-01-03T00:00:00.000Z')})
            await persistence.createExecution({...execution('early'), ...at('2026-01-01T00:00:00.000Z')})
            await persistence.createExecution({...execution('future'), ...at('2027-01-01T00:00:00.000Z')})
            await persistence.createExecution(execution('kept')) // no expiresAt: never swept
            expect(await persistence.listExpiredExecutions('2026-06-01T00:00:00.000Z', 10)).toEqual(['early', 'late'])
            expect(await persistence.listExpiredExecutions('2026-06-01T00:00:00.000Z', 1)).toEqual(['early'])
            expect(await persistence.listExpiredExecutions('2026-01-01T00:00:00.000Z', 10)).toEqual(['early']) // at expiresAt is expired
        })

        it('locks are exclusive per execution and released explicitly', async () => {
            expect(await persistence.acquireLock('e-1')).toBe(true)
            expect(await persistence.acquireLock('e-1')).toBe(false)
            expect(await persistence.acquireLock('e-2')).toBe(true)
            await persistence.releaseLock('e-1')
            expect(await persistence.acquireLock('e-1')).toBe(true)
        })
    })
}

contractSuite('in-memory', () => new InMemoryExecutionStore())

let fileDir = ''
contractSuite(
    'file',
    () => {
        fileDir = mkdtempSync(join(tmpdir(), 'harbor-exec-'));
        return new FileExecutionStore(fileDir)
    },
    () => {
        if (fileDir) rmSync(fileDir, {recursive: true, force: true})
    }
)

contractSuite('memcache', () => new MemcacheExecutionStore(new FakeMemcache()), undefined, {nativeExpiry: true})

describe('file store durability', () => {
    it('reloads executions, activities, approvals and decisions from disk in a new instance', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
        try {
            const first = new FileExecutionStore(dir)
            await first.createExecution({
                ...execution('e-9'),
                status: EXECUTION_STATUS.WAITING_APPROVAL,
                currentActivity: 2
            })
            await first.putActivity(activity('e-9', 1))
            await first.putActivity({
                ...activity('e-9', 2, 'POST'),
                status: ACTIVITY_STATUS.WAITING_APPROVAL,
                approvalId: 'a-9'
            })
            await first.putApproval({
                approvalId: 'a-9', executionId: 'e-9', activitySequence: 2, status: APPROVAL_STATUS.PENDING,
                summary: {
                    service: 'svc',
                    method: 'POST',
                    specPath: '/things/{id}',
                    reason: 'r',
                    matchedRules: ['rule']
                }, createdAt: now()
            })
            await first.putDecision({
                executionId: 'e-9',
                activitySequence: 2,
                decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL,
                reason: 'RULE_MATCHED',
                matchedRules: ['rule'],
                ruleVersions: ['rule@1#x'],
                evaluatedAt: now()
            })
            expect(readdirSync(dir)).toEqual(['e-9.json'])

            // "process restart"
            const second = new FileExecutionStore(dir)
            expect((await second.getExecution('e-9'))?.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
            expect((await second.listActivities('e-9')).map(a => a.sequence)).toEqual([1, 2])
            expect((await second.getActivity('e-9', 2))?.approvalId).toBe('a-9')
            expect((await second.getApproval('a-9'))?.status).toBe(APPROVAL_STATUS.PENDING)
            expect((await second.listDecisions('e-9')).length).toBe(1)
            // locks are process-local: a fresh instance starts unlocked
            expect(await second.acquireLock('e-9')).toBe(true)
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    it('a deleted execution\'s document is removed from disk and does not come back on reload', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
        try {
            const a = new FileExecutionStore(dir)
            await a.createExecution(execution('e-1'))
            await a.createExecution(execution('e-2'))
            await a.deleteExecution('e-1')
            expect(readdirSync(dir).sort()).toEqual(['e-2.json'])
            const b = new FileExecutionStore(dir)
            expect(await b.getExecution('e-1')).toBeUndefined()
            expect(await b.getExecution('e-2')).toBeDefined()
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    it('rejects an executionId that could escape the directory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
        try {
            const persistence = new FileExecutionStore(dir)
            await expect(persistence.createExecution(execution('../evil'))).rejects.toThrow(/Invalid executionId/)
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })
})

describe('buildExecutionStore', () => {
    it('builds in-memory by default and file when configured', () => {
        expect(buildExecutionStore(undefined).name).toBe('in-memory')
        expect(buildExecutionStore({type: 'in-memory'}).name).toBe('in-memory')
        const dir = mkdtempSync(join(tmpdir(), 'harbor-exec-'))
        try {
            expect(buildExecutionStore({type: 'file', dir}).name).toBe('file')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    it('lets a custom backend take over its type string', () => {
        const custom = new InMemoryExecutionStore()
        registerExecutionStoreBackend('custom-kv', () => custom)
        expect(buildExecutionStore({type: 'custom-kv'} as never)).toBe(custom)
    })
})
