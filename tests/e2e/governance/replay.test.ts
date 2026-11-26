// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-002 original code authoritative · RG-004 journal · RG-005 replay ·
 * RG-017 divergence · RG-019 unknown outcome.
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted, expectPaused, expectToolError} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, ERR, EXECUTION_STATUS} from '../helpers/env.js'
import {sleepUntil} from '../helpers/wait.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

describe('replay of the activity journal', () => {
    const s = useScenario()

    it('should_replay_completed_get_and_post_activities_from_the_journal_without_calling_the_backend_on_resume', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)))
        s().track(paused.executionId)
        const before = await s().mock.calls()
        expect(before).toEqual(['GET /customers/customer-001', 'POST /orders'])
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        // The resumed program used the *stored* order response — the same id, and the backend was not asked again.
        expect(done.value).toMatchObject({orderId: 'order-001', paymentId: 'payment-001'})
        expect(await s().mock.calls()).toEqual([...before, 'POST /payments'])
        expect((await s().mock.state())['orders']).toHaveLength(1)
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.activities[1]!.response?.data).toMatchObject({id: 'order-001'})
        expect(insp.activities[2]!.request.body).toEqual({orderId: 'order-001', amount: AMOUNTS.normal})
    })

    it('should_replay_a_recorded_non_2xx_response_as_is', async () => {
        const program = `async () => {
      const c = await api.request({ method: 'GET', path: '/customers/${RESOURCES.customerUnknown}' })
      const p = await api.request({ method: 'POST', path: '/payments', body: { orderId: 'none', amount: 1 } })
      return { customerStatus: c.status, customerOk: c.ok, payment: p.status }
    }`
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        let insp = await s().admin.inspect(paused.executionId)
        expect(insp.activities[0]).toMatchObject({
            status: ACTIVITY_STATUS.COMPLETED,
            response: {status: 404, ok: false}
        }) // explicit failure = replayable
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        expect(done.value).toEqual({customerStatus: 404, customerOk: false, payment: 201})
        expect(await s().mock.count('GET', `/customers/${RESOURCES.customerUnknown}`)).toBe(1)
        insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
    })

    it('should_run_the_persisted_program_and_ignore_replacement_code_sent_with_the_resume', async () => {
        const original = programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', original))
        s().track(paused.executionId)
        expect((await s().admin.inspect(paused.executionId)).execution.originalCode).toBe(original)
        const replacement = programs.createAdminUser('mallory') // would be a different program entirely
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}, {code: replacement}))
        expect(done.value).toMatchObject({orderId: 'order-001', paymentId: 'payment-001'})
        expect(await s().mock.calls()).toEqual(['GET /customers/customer-001', 'POST /orders', 'POST /payments'])
        expect(await s().mock.count('POST', '/admin/users')).toBe(0)
        // The program text is dropped once terminal (EXECUTION_CODE_RETENTION=DROP), so the
        // paused snapshot above is where the persisted program can still be compared.
        expect((await s().admin.inspect(paused.executionId)).execution).not.toHaveProperty('originalCode')
    })

    it('should_also_ignore_replacement_code_on_the_meta_resume_path', async () => {
        const original = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)
        const c = s().client('alice', {capabilities: {}})
        const out = expectToolError(await c.apiExecute('commerce', original), ERR.APPROVAL_REQUIRED)
        s().track(out.meta.executionId)
        await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, {action: 'accept', approve: true})
        const done = expectCompleted(await c.resumeByMeta('commerce', programs.createAdminUser('mallory'), out.meta.executionId!))
        expect(done.value).toMatchObject({status: 201, order: {id: 'order-001'}})
        expect(await s().mock.calls()).toEqual(['POST /orders'])
    })

    it('should_not_re_execute_a_completed_execution_but_expose_its_persisted_result', async () => {
        const c = s().client('alice')
        const done = expectCompleted(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal)))
        s().track(done.meta.executionId)
        const again = expectToolError(await c.resumeByMeta('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal), done.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
        expect(again.message).toContain('COMPLETED')
        expect(await s().mock.count('POST', '/orders')).toBe(1)
        const insp = await s().admin.inspect(done.meta.executionId!)
        expect(insp.execution.result).toEqual(done.value)
        expect(insp.execution.runCount).toBe(1)
    })

    it('should_persist_query_body_and_path_params_but_never_headers_in_the_journal', async () => {
        const program = `async () => {
      const r = await api.request({ method: 'GET', path: '/customers/customer-001', params: { include: 'tier', page: 2 }, headers: { 'x-custom': 'secret-ish' } })
      const o = await api.request({ method: 'POST', path: '/orders', body: { customerId: 'customer-001', amount: 5, items: ['a', 'b'] } })
      return [r.status, o.status]
    }`
        const done = expectCompleted(await s().client('alice').apiExecute('commerce', program))
        s().track(done.meta.executionId)
        const insp = await s().admin.inspect(done.meta.executionId!)
        expect(insp.activities[0]!.request).toEqual({
            method: 'GET',
            rawPath: '/customers/customer-001',
            specPath: '/customers/{customerId}',
            operationId: 'getCustomer',
            pathParams: {customerId: 'customer-001'},
            query: {include: 'tier', page: 2}
        })
        expect(insp.activities[1]!.request).toEqual({
            method: 'POST',
            rawPath: '/orders',
            specPath: '/orders',
            operationId: 'createOrder',
            body: {customerId: 'customer-001', amount: 5, items: ['a', 'b']}
        })
        expect(JSON.stringify(insp.activities)).not.toContain('secret-ish') // headers are never journaled (the program text itself is persisted verbatim)
        expect((await s().mock.requests())[0]!.query).toEqual({include: 'tier', page: '2'})
    })

    it('should_stop_with_replay_diverged_when_the_resumed_program_issues_a_different_call_at_a_journaled_sequence', async () => {
        // A time-dependent program: before the threshold activity #2 is a payment (pauses), after it a notification.
        const switchAt = Date.now() + 1500
        const program = programs.timeBranching(RESOURCES.customerAllowed, switchAt)
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        expect(paused.elicitation.message).toContain('createPayment')
        await sleepUntil(switchAt + 300) // a clock predicate, not a race: the resume must take the other branch

        const out = expectToolError(await c.answerApproval(paused, {action: 'accept'}), ERR.REPLAY_DIVERGED)
        expect(out.message).toContain('recorded "POST /payments"')
        expect(out.message).toContain('issued "POST /notifications"')
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.FAILED)
        // Nothing executed under the old history: no payment, no notification.
        expect(await s().mock.calls()).toEqual(['GET /customers/customer-001'])
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.FAILED)
        expect(insp.execution.terminalReason?.code).toBe(ERR.REPLAY_DIVERGED)
        expect(insp.activities[1]).toMatchObject({
            sequence: 2,
            status: ACTIVITY_STATUS.APPROVED,
            request: {specPath: '/payments'}
        }) // history untouched
        expect(insp.activities[1]).not.toHaveProperty('response')
        expectToolError(await c.resumeByMeta('commerce', program, paused.executionId), ERR.EXECUTION_NOT_RESUMABLE)
    })

    it('should_fail_closed_with_outcome_unknown_instead_of_repeating_an_activity_whose_outcome_was_never_known', async () => {
        // #1 POST /unstable → 500 (a POST is never retried; thrown: outcome unknown, journaled FAILED) · caught by the program
        // #2 POST /payments → REQUIRE_APPROVAL (pauses)
        const program = `async () => {
      let first
      try { first = (await api.request({ method: 'POST', path: '/unstable', body: { mode: '500' } })).status } catch (e) { first = 'threw:' + e.message }
      const p = await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 2 } })
      return { first, payment: p.status }
    }`
        const c = s().client('alice')
        const stopped = expectToolError(
            await c.apiExecute('commerce', program),
            ERR.ACTIVITY_OUTCOME_UNKNOWN
        )
        const executionId = stopped.meta.executionId!
        s().track(executionId)
        let insp = await s().admin.inspect(executionId)
        expect(insp.activities[0]).toMatchObject({
            sequence: 1,
            status: ACTIVITY_STATUS.FAILED,
            failure: {outcomeKnown: false}
        })
        const attempts = await s().mock.count('POST', '/unstable')
        expect(attempts).toBe(1) // maxRetries: 1, but a POST whose outcome is unknown is never re-sent

        expect(stopped.message).toContain('Activity #1')
        expect(stopped.meta.executionStatus).toBe(EXECUTION_STATUS.FAILED)
        expect(await s().mock.count('POST', '/unstable')).toBe(attempts) // never repeated
        expect(await s().mock.count('POST', '/payments')).toBe(0)     // the stopped run never reached the approval
        insp = await s().admin.inspect(executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.FAILED)
        expect(insp.execution.terminalReason?.code).toBe(ERR.ACTIVITY_OUTCOME_UNKNOWN)
    })
})
