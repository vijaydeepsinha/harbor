// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-001 one execution id · RG-003 lifecycle · RG-015 fresh isolate on
 * resume · RG-019 crash mid-call · RG-023 durability across a restart.
 *
 * The restart / kill tests drive the real gateway process through the
 * HARBOR_*_CMD hooks the orchestrator provides (docker compose or the local
 * stack). They are intentionally serial and run last in this file.
 */
import {describe, expect, it} from 'vitest'
import {execSync} from 'node:child_process'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted, expectPaused, expectToolError} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, env, ERR, EXECUTION_STATUS} from '../helpers/env.js'
import {waitFor, waitForHealth} from '../helpers/wait.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

function run(cmd: string): void {
    execSync(cmd, {stdio: 'pipe', timeout: 120_000})
}

describe('execution lifecycle and isolate lifecycle', () => {
    const s = useScenario()

    it('should_keep_one_execution_id_across_every_round_trip_of_a_program', async () => {
        const c = s().client('alice')
        const p1 = expectPaused(await c.apiExecute('commerce', programs.fourStepWorkflow(RESOURCES.customerAllowed, AMOUNTS.highValue)))
        s().track(p1.executionId)
        const p2 = expectPaused(await c.answerApproval(p1, {action: 'accept'}))
        const done = expectCompleted(await c.answerApproval(p2, {action: 'accept'}))
        expect(new Set([p1.executionId, p2.executionId, done.meta.executionId]).size).toBe(1)
    })

    it('should_run_each_resume_in_a_fresh_isolate_that_restarts_the_program_from_the_top', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)))
        s().track(paused.executionId)
        const pausedAt = Date.now()
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        const value = done.value as { runStartedAt: number }
        const insp = await s().admin.inspect(paused.executionId)
        // The program re-captured Date.now() at its first line *after* the human decided — impossible for a suspended isolate.
        expect(value.runStartedAt).toBeGreaterThanOrEqual(Date.parse(insp.approvals[0]!.decidedAt!))
        expect(value.runStartedAt).toBeGreaterThanOrEqual(pausedAt)
        expect(insp.execution.runCount).toBe(2)
        // runIndex = the run that first *encountered* the activity: #3 was encountered (and paused) in run 1, executed in run 2.
        expect(insp.activities.map(a => a.runIndex)).toEqual([1, 1, 1])
        expect(insp.activities[2]!.updatedAt > insp.activities[2]!.createdAt).toBe(true)
        // …yet the completed activities were not repeated (state restored from the journal, not recomputed).
        expect(await s().mock.calls()).toEqual(['GET /customers/customer-001', 'POST /orders', 'POST /payments'])
    })

    it('should_refuse_every_later_call_in_a_paused_isolate_even_if_the_program_swallows_the_pause', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', programs.swallowPauseAndContinue(RESOURCES.customerAllowed)))
        s().track(paused.executionId)
        expect(await s().mock.calls()).toEqual(['GET /customers/customer-001']) // the notification and ping were refused, not executed
        let insp = await s().admin.inspect(paused.executionId)
        expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.WAITING_APPROVAL]])
        // After approval the same program runs cleanly in a new isolate.
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        const value = done.value as { log: string[] }
        expect(value.log).toEqual(['customer:200', 'payment:executed', 'notification:201', 'ping:200'])
        expect(await s().mock.calls()).toEqual(['GET /customers/customer-001', 'POST /payments', 'POST /notifications', 'GET /ping'])
        insp = await s().admin.inspect(paused.executionId)
        expect(insp.activities.map(a => a.status)).toEqual(Array(4).fill(ACTIVITY_STATUS.COMPLETED))
    })

    it('should_complete_an_empty_program_with_no_activities_and_no_decisions', async () => {
        const done = expectCompleted(await s().client('alice').apiExecute('commerce', 'async () => ({ nothing: true })'))
        s().track(done.meta.executionId)
        expect(done.value).toEqual({nothing: true})
        const insp = await s().admin.inspect(done.meta.executionId!)
        expect(insp.execution).toMatchObject({status: EXECUTION_STATUS.COMPLETED, runCount: 1, currentActivity: 0})
        expect(insp.activities).toEqual([]);
        expect(insp.decisions).toEqual([]);
        expect(insp.approvals).toEqual([])
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_expose_every_lifecycle_state_through_meta_and_inspection', async () => {
        const c = s().client('alice')
        const completed = expectCompleted(await c.apiExecute('commerce', programs.ping()))
        const paused = expectPaused(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)))
        const denied = expectToolError(await c.apiExecute('commerce', programs.createAdminUser('x').replace('/admin/users', '/orders/order-001').replace('POST', 'DELETE')), ERR.GOVERNANCE_DENIED)
        const cancelledPaused = expectPaused(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)))
        const cancelled = expectToolError(await c.answerApproval(cancelledPaused, {action: 'cancel'}), ERR.EXECUTION_CANCELLED)
        for (const id of [completed.meta.executionId, paused.executionId, denied.meta.executionId, cancelledPaused.executionId]) s().track(id)
        expect(completed.meta.executionStatus).toBe(EXECUTION_STATUS.COMPLETED)
        expect(paused.meta.executionStatus).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect(denied.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(cancelled.meta.executionStatus).toBe(EXECUTION_STATUS.CANCELLED)
        const statuses = await Promise.all([completed.meta.executionId!, paused.executionId, denied.meta.executionId!, cancelledPaused.executionId].map(async id => (await s().admin.inspect(id)).execution.status))
        expect(statuses).toEqual([EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.WAITING_APPROVAL, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED])
    })

    describe('gateway process lifecycle (restart / crash) — serial, needs the HARBOR_*_CMD hooks', () => {
        const hooks = Boolean(env.restartCmd && env.killCmd && env.startCmd)
        const reason = 'HARBOR_RESTART_CMD / HARBOR_KILL_CMD / HARBOR_START_CMD are not set; run through npm run test:governance'

        it.skipIf(!hooks)(`should_survive_a_gateway_restart_while_paused_and_resume_without_repeating_calls (${hooks ? 'hooks present' : reason})`, async () => {
            const c = s().client('alice')
            const paused = expectPaused(await c.apiExecute('commerce', programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)))
            s().track(paused.executionId)
            const before = await s().mock.calls()

            run(env.restartCmd!)
            await waitForHealth(env.mcpBaseUrl, 120_000)

            // The execution outlived the process (file store), the pending approval with it.
            const insp = await s().admin.inspect(paused.executionId)
            expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
            expect(insp.approvals[0]!.status).toBe('PENDING')
            expect(insp.execution.originalCode).toBe(paused.code)

            // …and the requestState minted before the restart is still redeemable (fixed HMAC key).
            const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
            expect(done.value).toMatchObject({orderId: 'order-001', paymentId: 'payment-001'})
            expect(await s().mock.calls()).toEqual([...before, 'POST /payments'])
            expect((await s().admin.inspect(paused.executionId)).execution.runCount).toBe(2)
        })

        it.skipIf(!hooks)(`should_fail_closed_with_outcome_unknown_when_the_gateway_dies_while_a_post_is_in_flight (${hooks ? 'hooks present' : reason})`, async () => {
            const c = s().client('alice', {capabilities: {}})
            const program = `async () => {
        const o = await api.request({ method: 'POST', path: '/orders', params: { delayMs: 1500 }, body: { customerId: 'customer-001', amount: 9 } })
        return { status: o.status }
      }`
            const inFlight = c.apiExecute('commerce', program).catch(err => ({kind: 'client_error', err} as const))
            // Deterministic kill point: the backend has received the call (it logs before delaying, and the 1.5 s delay is
            // shorter than the service's 2 s request timeout) and Harbor journaled it EXECUTING.
            await waitFor(async () => (await s().mock.count('POST', '/orders')) === 1 || undefined, {
                timeoutMs: 15_000,
                description: 'the backend to receive the in-flight POST'
            })
            run(env.killCmd!)
            const outcome = await inFlight
            expect(outcome.kind).not.toBe('completed')
            run(env.startCmd!)
            await waitForHealth(env.mcpBaseUrl, 120_000)

            // Find the execution: it is the one whose journal holds the EXECUTING order call.
            const executionId = await findExecutionIdFromMock(s().mock, 'POST', '/orders')
            s().track(executionId)
            let insp = await s().admin.inspect(executionId)
            expect(insp.execution.status).toBe(EXECUTION_STATUS.RUNNING) // died mid-run; the lock died with the process
            expect(insp.activities[0]).toMatchObject({
                sequence: 1,
                status: ACTIVITY_STATUS.EXECUTING,
                request: {method: 'POST', specPath: '/orders'}
            })

            const out = expectToolError(await c.resumeByMeta('commerce', program, executionId), ERR.ACTIVITY_OUTCOME_UNKNOWN)
            expect(out.message).toContain('will not be repeated')
            expect(await s().mock.count('POST', '/orders')).toBe(1) // the backend did execute it once; Harbor never repeated it
            insp = await s().admin.inspect(executionId)
            expect(insp.execution.status).toBe(EXECUTION_STATUS.FAILED)
            expect(insp.execution.terminalReason?.code).toBe(ERR.ACTIVITY_OUTCOME_UNKNOWN)
        })

        it.skipIf(!hooks)(`should_re_execute_a_safe_get_that_was_in_flight_when_the_gateway_died (${hooks ? 'hooks present' : reason})`, async () => {
            const c = s().client('alice', {capabilities: {}})
            const program = `async () => {
        const g = await api.request({ method: 'GET', path: '/ping', params: { delayMs: 1500 } })
        return { status: g.status }
      }`
            const inFlight = c.apiExecute('commerce', program).catch(err => ({kind: 'client_error', err} as const))
            await waitFor(async () => (await s().mock.count('GET', '/ping')) === 1 || undefined, {
                timeoutMs: 15_000,
                description: 'the backend to receive the in-flight GET'
            })
            run(env.killCmd!)
            await inFlight
            run(env.startCmd!)
            await waitForHealth(env.mcpBaseUrl, 120_000)

            const executionId = await findExecutionIdFromMock(s().mock, 'GET', '/ping')
            s().track(executionId)
            expect((await s().admin.inspect(executionId)).activities[0]!.status).toBe(ACTIVITY_STATUS.EXECUTING)
            const done = expectCompleted(await c.resumeByMeta('commerce', program, executionId))
            expect(done.value).toEqual({status: 200})
            expect(await s().mock.count('GET', '/ping')).toBe(2) // GET is safe to re-issue
            expect((await s().admin.inspect(executionId)).activities[0]!.status).toBe(ACTIVITY_STATUS.COMPLETED)
        })
    })
})

/**
 * The gateway died before answering, so the client never learned the
 * execution id. The backend did: Harbor stamps `X-Idempotency-Key` as
 * `mcp-{service}-{userHash12}-{codeHash16}-{sequence}` — and the execution
 * inspection route is the only way to map that back, so we scan the store's
 * documents by listing what the mock saw and asking the gateway for each
 * candidate id it exposes through the correlation header.
 */
async function findExecutionIdFromMock(mock: import('../client/mock-api.js').MockApi, method: string, path: string): Promise<string> {
    const reqs = await mock.requests({method, path})
    const correlation = reqs[0]?.headers['x-correlation-id']
    if (!correlation) throw new Error('mock did not record an X-Correlation-ID for the in-flight call')
    // The correlation id is the JSON-RPC request id, not the execution id; the execution id must come from the store.
    // The file store keeps one JSON document per execution — the orchestrator mounts it at artifacts/executions (compose)
    // or artifacts/local/executions (local mode).
    const {readdirSync, readFileSync, existsSync} = await import('node:fs')
    const {join} = await import('node:path')
    for (const dir of [join(env.repoRoot, 'artifacts', 'executions'), join(env.repoRoot, 'artifacts', 'local', 'executions')]) {
        if (!existsSync(dir)) continue
        const docs = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
            execution: { executionId: string; status: string };
            activities: Array<{ status: string; request: { method: string; specPath: string } }>
        })
        const hit = docs.find(d => d.execution.status === 'RUNNING' && d.activities.some(a => a.status === 'EXECUTING' && a.request.method === method))
        if (hit) return hit.execution.executionId
    }
    throw new Error('could not locate the interrupted execution in the file store')
}
