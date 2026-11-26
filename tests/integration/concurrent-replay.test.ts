// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * How calls a program makes concurrently are numbered, and what replay does
 * with them (the owner's PR #4 question: "five placements created with five
 * parallel calls — how is each activity numbered, and is there a provision?").
 *
 * Calls are numbered in the order they reach the bridge, which admits them
 * one at a time. On a resume the program runs again and its replayed calls
 * resolve in sequence order, so calls whose order depended on timing (chains
 * racing on their responses) can reach a sequence in another order. A
 * COMPLETED record replays even when its body drifted — for a call admitted
 * while another was in flight that used to hand one sibling the other's
 * response, and the run completed with it.
 */
import {describe, expect, it} from 'vitest'
import type {ApiRequest, ConnectorAPI} from '../../src/spi/connector/connector-api.js'
import {ActivityJournal} from '../../src/runtime/execution/activity-journal.js'
import {InMemoryExecutionStore} from '../../src/adapters/execution/in-memory-execution-store.js'
import {
    makeCtx,
    makeResources,
    makeRuntime,
    parseContent,
    registerGoverned,
    retryCtx
} from '../unit/code-mode-harness.js'
import {
    ACTIVITY_STATUS,
    ERR,
    EXECUTION_ID_META_KEY,
    EXECUTION_STATUS,
    EXECUTION_STATUS_META_KEY
} from '../../src/core/constants.js'
import {ReplayDivergedError} from '../../src/core/types/execution.types.js'

const FINALIZE_NEEDS_APPROVAL = {
    name: 'finalize-needs-approval',
    match: {operation: 'finalizeCampaign'},
    action: {type: 'REQUIRE_APPROVAL', reason: 'r'}
}

/** A backend whose latency the test chooses per request; POST answers with a fresh id and echoes the body. */
function timedConnector(latencyMs: (req: ApiRequest) => number) {
    const wire: ApiRequest[] = []
    const connector: ConnectorAPI = {
        async request(req) {
            wire.push(req)
            const n = wire.length
            await new Promise(r => setTimeout(r, latencyMs(req)))
            if (req.method === 'GET') return {status: 200, ok: true, data: {path: req.path}}
            return {status: 201, ok: true, data: {id: `res-${n}`, echo: req.body ?? null}}
        }
    }
    return {connector, wire}
}

const executionIdOf = (res: Record<string, unknown>) => (res['_meta'] as Record<string, string>)[EXECUTION_ID_META_KEY]!
const statusOf = (res: Record<string, unknown>) => (res['_meta'] as Record<string, string>)[EXECUTION_STATUS_META_KEY]

describe('concurrent calls: numbering and replay', () => {
    it('five parallel creates are numbered in arrival order, whatever order they finish in, and a resume gives each its own response', async () => {
        const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL])
        // The first create is the slowest: completion order is the reverse of arrival order.
        const {connector, wire} = timedConnector(req => req.body ? 30 - 5 * (req.body as { n: number }).n : 1)
        const tool = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
        const code = `async () => {
      const created = await Promise.all([1, 2, 3, 4, 5].map(n => api.request({ method: 'POST', path: '/campaigns', body: { n } })))
      await api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return created.map(r => ({ n: r.data.echo.n, id: r.data.id }))
    }`

        const paused = await tool({service: 'trafficking', code}, makeCtx())
        expect(paused['resultType']).toBe('input_required')
        const executionId = executionIdOf(paused)
        const journal = (await governanceRuntime.executionManager.inspect(executionId)).activities
        expect(journal.map(a => [a.sequence, (a.request.body as { n?: number } | undefined)?.n, a.status])).toEqual([
            [1, 1, ACTIVITY_STATUS.COMPLETED], [2, 2, ACTIVITY_STATUS.COMPLETED], [3, 3, ACTIVITY_STATUS.COMPLETED],
            [4, 4, ACTIVITY_STATUS.COMPLETED], [5, 5, ACTIVITY_STATUS.COMPLETED], [6, undefined, ACTIVITY_STATUS.WAITING_APPROVAL]
        ])
        // Siblings admitted while another was in flight say so; the approval-gated call came after they all returned.
        expect(journal.slice(1, 5).every(a => a.admittedConcurrently === true)).toBe(true)
        expect(journal[5]!.admittedConcurrently).toBeUndefined()

        const done = await tool({
            service: 'trafficking',
            code
        }, await retryCtx(governanceRuntime, paused, {action: 'accept', approve: true}))
        expect(statusOf(done)).toBe(EXECUTION_STATUS.COMPLETED)
        // Each create gets back the id the backend gave *it* (res-1 … res-5, by arrival), and none is sent again.
        expect(parseContent(done)).toEqual([1, 2, 3, 4, 5].map(n => ({n, id: `res-${n}`})))
        expect(wire.filter(r => r.path === '/campaigns')).toHaveLength(5)
    })

    it('chains that race on their responses and arrive in another order on resume stop the run — no sibling is handed another\'s response', async () => {
        const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL])
        // First run: A's read is slow, so B's create arrives first (#3) and A's second (#4).
        // On resume both reads replay at once, in sequence order, so A's create arrives first.
        const {connector, wire} = timedConnector(req => (req.method === 'GET' && req.path.includes('/A/') ? 40 : 1))
        const tool = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
        const code = `async () => {
      const made = await Promise.all(['A', 'B'].map(async name => {
        await api.request({ method: 'GET', path: '/campaigns/' + name + '/creatives' })
        const created = await api.request({ method: 'POST', path: '/campaigns', body: { name } })
        return { name, createdFor: created.data.echo.name, id: created.data.id }
      }))
      await api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return made
    }`

        const paused = await tool({service: 'trafficking', code}, makeCtx())
        const executionId = executionIdOf(paused)
        const recorded = (await governanceRuntime.executionManager.inspect(executionId)).activities
        expect(recorded.slice(2, 4).map(a => [a.sequence, (a.request.body as {
            name: string
        }).name])).toEqual([[3, 'B'], [4, 'A']])

        const resumed = await tool({
            service: 'trafficking',
            code
        }, await retryCtx(governanceRuntime, paused, {action: 'accept', approve: true}))
        expect(resumed['isError']).toBe(true)
        expect(parseContent(resumed)).toMatchObject({code: ERR.REPLAY_DIVERGED})
        expect((parseContent(resumed) as { error: string }).error).toContain('arrived in another order')
        expect(statusOf(resumed)).toBe(EXECUTION_STATUS.FAILED)
        // Fail closed: the approved finalize was never sent, and nothing was created twice.
        expect(wire.filter(r => r.path === '/campaigns/C1/finalize')).toHaveLength(0)
        expect(wire.filter(r => r.path === '/campaigns')).toHaveLength(2)
        // The history is left exactly as it was recorded.
        const after = (await governanceRuntime.executionManager.inspect(executionId)).activities
        expect(after.slice(2, 4).map(a => [a.sequence, (a.request.body as { name: string }).name, a.status]))
            .toEqual([[3, 'B', ACTIVITY_STATUS.COMPLETED], [4, 'A', ACTIVITY_STATUS.COMPLETED]])
    })

    it('a program that makes its calls one at a time still resumes when a body carries the time — drift is tolerated where order cannot race', async () => {
        const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL])
        const {connector, wire} = timedConnector(() => 1)
        const tool = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
        const code = `async () => {
      const created = await api.request({ method: 'POST', path: '/campaigns', body: { name: 'Q4', at: Date.now() } })
      await new Promise(r => r())
      await api.request({ method: 'POST', path: '/campaigns/' + created.data.id + '/finalize' })
      return { id: created.data.id }
    }`
        const paused = await tool({service: 'trafficking', code}, makeCtx())
        expect((await governanceRuntime.executionManager.inspect(executionIdOf(paused))).activities[0]!.admittedConcurrently).toBeUndefined()
        await new Promise(r => setTimeout(r, 5)) // the clock moves: the resumed program sends another `at`
        const done = await tool({
            service: 'trafficking',
            code
        }, await retryCtx(governanceRuntime, paused, {action: 'accept', approve: true}))
        expect(statusOf(done)).toBe(EXECUTION_STATUS.COMPLETED)
        expect(parseContent(done)).toEqual({id: 'res-1'})
        expect(wire.filter(r => r.path === '/campaigns')).toHaveLength(1)
    })
})

describe('ActivityJournal.next — what a COMPLETED record binds', () => {
    const request = (body: unknown) => ({method: 'POST' as const, rawPath: '/campaigns', specPath: '/campaigns', body})

    async function journalWith(admittedConcurrently: boolean) {
        const persistence = new InMemoryExecutionStore()
        const first = new ActivityJournal(persistence, 'exec-1', 'trafficking', 1)
        const {sequence} = await first.next(request({name: 'B'}))
        await first.markExecuting(sequence, request({name: 'B'}), undefined, admittedConcurrently)
        await first.recordResponse({method: 'POST', endpoint: '/campaigns'}, {
            status: 201,
            ok: true,
            data: {id: 'res-B'}
        }, sequence)
        return new ActivityJournal(persistence, 'exec-1', 'trafficking', 2)
    }

    it('admitted alone: replays even when the body drifted', async () => {
        const resumed = await journalWith(false)
        const {existing} = await resumed.next(request({name: 'A'}))
        expect(existing?.status).toBe(ACTIVITY_STATUS.COMPLETED)
    })

    it('admitted concurrently: a different body at its sequence is a divergence', async () => {
        const resumed = await journalWith(true)
        await expect(resumed.next(request({name: 'A'}))).rejects.toBeInstanceOf(ReplayDivergedError)
        // The same request (keys in any order) still replays.
        const again = await journalWith(true)
        expect((await again.next(request({name: 'B'}))).existing?.response?.data).toEqual({id: 'res-B'})
    })
})
