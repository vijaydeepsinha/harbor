// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Secondary persistence failures (the owner's PR #7 review): a store write
 * that fails after the outcome it records was decided. The outcome stands —
 * the client gets the original one — the failed write is reported (one
 * structured log line, one metric), and the store is left in a state the
 * next run recovers from. Each test stops a write with a fault-injecting
 * store and then checks all three.
 */
import {describe, expect, it, vi} from 'vitest'
import type {Logger} from '../../src/core/types/logger.types.js'
import type {MetricsRegistry} from '../../src/runtime/observability/metrics.js'
import type {ActivityRecord, ExecutionRecord} from '../../src/core/types/execution.types.js'
import type {ConnectorAPI} from '../../src/spi/connector/connector-api.js'
import {registerExecuteApiTool} from '../../src/tools/execute-api.tool.js'
import {ActivityJournal} from '../../src/runtime/execution/activity-journal.js'
import {ActivityGate} from '../../src/runtime/execution/activity-gate.js'
import {resolveOperation} from '../../src/runtime/governance/operation-resolver.js'
import type {PersistenceFailure} from '../../src/runtime/execution/persistence-failure.js'
import {
    campaignSpec,
    globalConfig,
    makeConnector,
    makeCtx,
    makeFakeServer,
    makeRegistry,
    makeResources,
    makeRuntime,
    parseContent
} from '../unit/code-mode-harness.js'
import {faultyStore} from '../unit/faulty-store.js'
import {
    ACTIVITY_ADMISSION,
    ACTIVITY_STATUS,
    ERR,
    EXECUTION_ID_META_KEY,
    EXECUTION_STATUS,
    EXECUTION_STATUS_META_KEY,
    GOVERNANCE_DECISION,
    METRIC,
    PERSISTENCE_OPERATION,
    TOOL
} from '../../src/core/constants.js'

const PROGRAM = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const r = await api.request({ method: 'POST', path: '/campaigns/' + campaigns.data[0].id + '/finalize' })
  return { did: r.data.did }
}`

function observedTool(governanceRuntime: ReturnType<typeof makeRuntime>, connector: ConnectorAPI) {
    const logs: Array<Record<string, unknown>> = []
    const capture = (level: string) => (obj: unknown, msg?: string) => {
        logs.push({level, ...(typeof obj === 'object' && obj ? obj : {}), msg})
    }
    const logger = {
        info: capture('info'),
        warn: capture('warn'),
        debug: capture('debug'),
        error: capture('error')
    } as unknown as Logger
    const counted: Array<[string, Record<string, string> | undefined]> = []
    const metrics = {
        increment: (name: string, labels?: Record<string, string>) => {
            counted.push([name, labels])
        }, stop: () => {
        }
    } as unknown as MetricsRegistry
    const {handlers, server} = makeFakeServer()
    registerExecuteApiTool(server, makeRegistry({trafficking: makeResources('trafficking', connector)}), globalConfig, logger, metrics, 'client-token', governanceRuntime)
    const failureLogs = () => logs.filter(l => l['event'] === 'persistence_failure')
    return {handler: handlers[TOOL.API_EXECUTE]!, logs, failureLogs, counted}
}

const metaOf = (r: Record<string, unknown>) => r['_meta'] as Record<string, string>

describe('a run whose outcome the store cannot take', () => {
    it('completed: the client is told to resume, the execution stays RUNNING and resumable, and the resume sends nothing twice', async () => {
        const store = faultyStore()
        const governanceRuntime = makeRuntime([], GOVERNANCE_DECISION.ALLOW, store.persistence)
        const {connector, count} = makeConnector()
        const {handler, failureLogs, counted} = observedTool(governanceRuntime, connector)
        store.fail({method: 'updateExecution', when: r => (r as ExecutionRecord).status === EXECUTION_STATUS.COMPLETED})

        const first = await handler({service: 'trafficking', code: PROGRAM}, makeCtx())
        const executionId = metaOf(first)[EXECUTION_ID_META_KEY]!
        expect(parseContent(first)).toMatchObject({code: ERR.RUN_OUTCOME_NOT_RECORDED, retryable: true, executionId})
        expect(metaOf(first)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.RUNNING)
        expect(JSON.stringify(first)).not.toContain('store unavailable') // the store's own error stays in the log
        // Never written FAILED — finished work must stay resumable; and the lock is free.
        expect((await store.inner.getExecution(executionId))?.status).toBe(EXECUTION_STATUS.RUNNING)
        expect(await store.inner.acquireLock(executionId)).toBe(true)
        await store.inner.releaseLock(executionId)
        expect(failureLogs()).toEqual([expect.objectContaining({
            level: 'error',
            operation: PERSISTENCE_OPERATION.RUN_END,
            executionId,
            intended: EXECUTION_STATUS.COMPLETED,
            left: EXECUTION_STATUS.RUNNING,
            error: 'store unavailable (updateExecution)'
        })])
        expect(counted).toContainEqual([METRIC.PERSISTENCE_FAILURES, {operation: PERSISTENCE_OPERATION.RUN_END}])

        const resumed = await handler({service: 'trafficking', code: PROGRAM}, makeCtx({executionIdMeta: executionId}))
        expect(resumed['isError']).toBeUndefined()
        expect(parseContent(resumed)).toEqual({did: 'POST /campaigns/C1/finalize'})
        expect(metaOf(resumed)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
        expect((await store.inner.getExecution(executionId))?.status).toBe(EXECUTION_STATUS.COMPLETED)
        expect(count('GET', '/campaigns')).toBe(1)
        expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    })

    it.each(['completion acknowledgement', 'lock release before deletion', 'lock release after deletion'])(
        'returns the persisted completed result when %s fails', async fault => {
            const store = faultyStore()
            const governanceRuntime = makeRuntime([], GOVERNANCE_DECISION.ALLOW, store.persistence)
            const {connector, count} = makeConnector()
            const {handler, failureLogs} = observedTool(governanceRuntime, connector)
            if (fault === 'completion acknowledgement') {
                store.fail({
                    method: 'updateExecution', timing: 'after',
                    when: r => (r as ExecutionRecord).status === EXECUTION_STATUS.COMPLETED
                })
            } else {
                const update = store.persistence.updateExecution.bind(store.persistence)
                const spy = vi.spyOn(store.persistence, 'updateExecution').mockImplementation(async record => {
                    await update(record)
                    if (record.status === EXECUTION_STATUS.COMPLETED) {
                        store.fail({
                            method: 'releaseLock',
                            timing: fault === 'lock release after deletion' ? 'after' : 'before'
                        })
                    }
                })
                // Keep the spy local to this tool invocation; do not affect later cases.
                try {
                    await verify()
                } finally {
                    spy.mockRestore()
                }
                return
            }
            await verify()

            async function verify() {
                const first = await handler({service: 'trafficking', code: PROGRAM}, makeCtx())
                const executionId = metaOf(first)[EXECUTION_ID_META_KEY]!
                expect(first['isError']).toBeUndefined()
                expect(parseContent(first)).toEqual({did: 'POST /campaigns/C1/finalize'})
                expect(metaOf(first)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
                expect((await store.inner.getExecution(executionId))?.status).toBe(EXECUTION_STATUS.COMPLETED)
                expect(failureLogs()).toEqual([expect.objectContaining({
                    operation: PERSISTENCE_OPERATION.RUN_END, intended: EXECUTION_STATUS.COMPLETED,
                    left: EXECUTION_STATUS.COMPLETED, executionId
                })])
                const retry = await handler({
                    service: 'trafficking',
                    code: PROGRAM
                }, makeCtx({executionIdMeta: executionId}))
                expect(parseContent(retry)).toMatchObject({code: ERR.EXECUTION_NOT_RESUMABLE})
                expect(metaOf(retry)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
                expect(count('GET', '/campaigns')).toBe(1)
                expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
                await store.inner.releaseLock(executionId)
            }
        }
    )

    it.each(['before', 'after'] as const)('omits unknown status when completion fails %s applying and read-back also fails', async timing => {
        const store = faultyStore()
        const governanceRuntime = makeRuntime([], GOVERNANCE_DECISION.ALLOW, store.persistence)
        const {connector, count} = makeConnector()
        const {handler, failureLogs} = observedTool(governanceRuntime, connector)
        store.fail({
            method: 'updateExecution',
            timing,
            when: r => {
                if ((r as ExecutionRecord).status !== EXECUTION_STATUS.COMPLETED) return false
                store.fail({method: 'getExecution'})
                return true
            }
        })
        const first = await handler({service: 'trafficking', code: PROGRAM}, makeCtx())
        const executionId = metaOf(first)[EXECUTION_ID_META_KEY]!
        expect(parseContent(first)).toMatchObject({code: ERR.RUN_OUTCOME_NOT_RECORDED, retryable: true})
        expect(metaOf(first)[EXECUTION_STATUS_META_KEY]).toBeUndefined()
        expect(failureLogs()).toHaveLength(2)
        expect(failureLogs().every(log => log['left'] === 'unknown')).toBe(true)
        const resumed = await handler({service: 'trafficking', code: PROGRAM}, makeCtx({executionIdMeta: executionId}))
        if (timing === 'before') {
            expect(resumed['isError']).toBeUndefined()
        } else {
            expect(parseContent(resumed)).toMatchObject({code: ERR.EXECUTION_NOT_RESUMABLE})
        }
        expect(metaOf(resumed)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
        expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    })

    it('stopped: the original error stands, metadata reports the stored status, and a resume records the same outcome', async () => {
        const store = faultyStore()
        const deny = {
            name: 'no-finalize',
            match: {operation: 'finalizeCampaign'},
            action: {type: 'DENY', reason: 'frozen'}
        }
        const governanceRuntime = makeRuntime([deny], GOVERNANCE_DECISION.ALLOW, store.persistence)
        const {connector, count} = makeConnector()
        const {handler, failureLogs} = observedTool(governanceRuntime, connector)
        store.fail({method: 'updateExecution', when: r => (r as ExecutionRecord).status === EXECUTION_STATUS.DENIED})

        const first = await handler({service: 'trafficking', code: PROGRAM}, makeCtx())
        const executionId = metaOf(first)[EXECUTION_ID_META_KEY]!
        expect(parseContent(first)).toMatchObject({code: ERR.GOVERNANCE_DENIED}) // preserved, not replaced by the store's error
        expect(metaOf(first)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.RUNNING)
        expect(failureLogs()).toEqual([expect.objectContaining({
            operation: PERSISTENCE_OPERATION.RUN_END,
            intended: EXECUTION_STATUS.DENIED,
            executionId
        })])
        expect((await store.inner.getExecution(executionId))?.status).toBe(EXECUTION_STATUS.RUNNING)

        const again = await handler({service: 'trafficking', code: PROGRAM}, makeCtx({executionIdMeta: executionId}))
        expect(parseContent(again)).toMatchObject({code: ERR.GOVERNANCE_DENIED})
        expect((await store.inner.getExecution(executionId))?.status).toBe(EXECUTION_STATUS.DENIED)
        expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
        expect(count('GET', '/campaigns')).toBe(1) // replayed on the resume
    })

    it('stopped: unreadable settlement omits status without replacing the governance error', async () => {
        const store = faultyStore()
        const deny = {
            name: 'no-finalize',
            match: {operation: 'finalizeCampaign'},
            action: {type: 'DENY', reason: 'frozen'}
        }
        const governanceRuntime = makeRuntime([deny], GOVERNANCE_DECISION.ALLOW, store.persistence)
        const {connector, count} = makeConnector()
        const {handler, failureLogs} = observedTool(governanceRuntime, connector)
        store.fail({
            method: 'updateExecution',
            when: record => {
                if ((record as ExecutionRecord).status !== EXECUTION_STATUS.DENIED) return false
                store.fail({method: 'getExecution'})
                return true
            }
        })
        const first = await handler({service: 'trafficking', code: PROGRAM}, makeCtx())
        expect(parseContent(first)).toMatchObject({code: ERR.GOVERNANCE_DENIED, retryable: false})
        expect(metaOf(first)[EXECUTION_STATUS_META_KEY]).toBeUndefined()
        expect(failureLogs()).toHaveLength(2)
        expect(failureLogs().every(log => log['left'] === 'unknown')).toBe(true)
        expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    })
})

describe('an activity whose failure the store cannot take', () => {
    const failingFinalize = (): ConnectorAPI => {
        const {connector} = makeConnector()
        return {
            request: async (req, ctx) => {
                if (req.path.endsWith('/finalize')) throw Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'})
                return connector.request(req, ctx)
            }
        }
    }

    it('the program still sees its call\'s own error; the write is reported with the activity it concerns', async () => {
        const store = faultyStore()
        const governanceRuntime = makeRuntime([], GOVERNANCE_DECISION.ALLOW, store.persistence)
        const {handler, failureLogs, counted} = observedTool(governanceRuntime, failingFinalize())
        store.fail({method: 'putActivity', when: a => (a as ActivityRecord).status === ACTIVITY_STATUS.FAILED})
        const code = `async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      try { await api.request({ method: 'POST', path: '/campaigns/C1/finalize' }) } catch (e) { return { sawError: String(e.message) } }
      return 'unreachable'
    }`
        const r = await handler({service: 'trafficking', code}, makeCtx())
        expect(parseContent(r)).toEqual({sawError: expect.stringContaining('socket hang up')})
        const executionId = metaOf(r)[EXECUTION_ID_META_KEY]!
        expect(failureLogs()).toEqual([expect.objectContaining({
            operation: PERSISTENCE_OPERATION.ACTIVITY_FAILED, executionId, sequence: 2,
            intended: 'FAILED (outcome unknown)', left: ACTIVITY_STATUS.EXECUTING
        })])
        expect(counted).toContainEqual([METRIC.PERSISTENCE_FAILURES, {operation: PERSISTENCE_OPERATION.ACTIVITY_FAILED}])
        expect((await store.inner.getActivity(executionId, 2))?.status).toBe(ACTIVITY_STATUS.EXECUTING)
    })

    it('left EXECUTING, the activity is never silently repeated: a later run stops on a POST and re-sends only a GET', async () => {
        const store = faultyStore()
        const reported: PersistenceFailure[] = []
        const run1 = new ActivityJournal(store.persistence, 'exec-1', 'trafficking', 1, {
            onPersistenceFailure: f => {
                reported.push(f)
            }
        })
        const post = {method: 'POST' as const, rawPath: '/campaigns/C1/finalize', specPath: '/campaigns/{id}/finalize'}
        const get = {method: 'GET' as const, rawPath: '/campaigns', specPath: '/campaigns'}
        for (const request of [get, post]) {
            const {sequence} = await run1.next(request)
            await run1.markExecuting(sequence, request)
        }
        store.fail({method: 'putActivity', times: 2})
        for (const [sequence, request] of [[1, get], [2, post]] as const) {
            await run1.recordFailure({method: request.method, endpoint: request.specPath}, {
                code: 'API_ERROR',
                message: 'reset',
                aborted: false
            }, sequence)
        }
        expect(reported.map(f => [f.sequence, f.left])).toEqual([[1, ACTIVITY_STATUS.EXECUTING], [2, ACTIVITY_STATUS.EXECUTING]])
        // The run's own log still holds both failures — audit and progress see them.
        expect(run1.entries().map(e => e.outcome)).toEqual(['FAILED', 'FAILED'])

        const gate = new ActivityGate({
            journal: new ActivityJournal(store.persistence, 'exec-1', 'trafficking', 2),
            resolve: (m, p) => resolveOperation(campaignSpec, m, p)
        })
        const apiRequest = (r: typeof get | typeof post) => ({method: r.method, path: r.rawPath})
        expect((await gate.admit(apiRequest(get), resolveOperation(campaignSpec, 'GET', '/campaigns'))).kind).toBe(ACTIVITY_ADMISSION.EXECUTE)
        const second = await gate.admit(apiRequest(post), resolveOperation(campaignSpec, 'POST', '/campaigns/C1/finalize'))
        expect(second).toMatchObject({kind: ACTIVITY_ADMISSION.STOP, code: ERR.ACTIVITY_OUTCOME_UNKNOWN})
    })
})
