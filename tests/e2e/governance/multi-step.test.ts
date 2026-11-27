// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-006 multiple approval rounds · RG-014 approval per activity ·
 * RG-029 the §47 acceptance shape, end to end over the wire.
 *
 * GIVEN the four-step workflow
 *   #1 GET  /customers/{id}   → ALLOW
 *   #2 POST /orders (>10000)  → REQUIRE_APPROVAL
 *   #3 POST /payments         → REQUIRE_APPROVAL
 *   #4 POST /notifications    → ALLOW
 * every pause is verified from three angles: the MCP result, the execution
 * store (inspection) and the backend's request log.
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted, expectPaused, expectToolError} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, APPROVAL_STATUS, DECISION, ERR, EXECUTION_STATUS} from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

const CALLS = {
    customer: 'GET /customers/customer-001',
    order: 'POST /orders',
    payment: 'POST /payments',
    note: 'POST /notifications'
}

describe('multi-step workflow with two approval points', () => {
    const s = useScenario()
    const program = programs.fourStepWorkflow(RESOURCES.customerAllowed, AMOUNTS.highValue)

    it('should_pause_at_step_2_then_step_3_and_complete_after_both_approvals_with_every_call_exactly_once', async () => {
        const c = s().client('alice')

        // ── Run 1: step 1 executes, step 2 pauses ─────────────────────────────
        const paused1 = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused1.executionId)
        expect(paused1.elicitation.message).toContain('Activity:  #2')
        expect(paused1.elicitation.message).toContain('createOrder — POST /orders')
        expect(await s().mock.calls()).toEqual([CALLS.customer])
        let insp = await s().admin.inspect(paused1.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect(insp.execution.runCount).toBe(1)
        expect(insp.execution.currentActivity).toBe(2)
        expect(insp.activities.map(a => [a.sequence, a.status, a.runIndex])).toEqual([[1, ACTIVITY_STATUS.COMPLETED, 1], [2, ACTIVITY_STATUS.WAITING_APPROVAL, 1]])
        expect(insp.approvals.map(a => [a.activitySequence, a.status])).toEqual([[2, APPROVAL_STATUS.PENDING]])
        expect(insp.decisions.map(d => [d.activitySequence, d.decision])).toEqual([[1, DECISION.ALLOW], [2, DECISION.REQUIRE_APPROVAL]])

        // ── Run 2: steps 1 replayed, 2 executed, 3 pauses ─────────────────────
        const paused2 = expectPaused(await c.answerApproval(paused1, {
            action: 'accept',
            approve: true,
            comment: 'order ok'
        }))
        expect(paused2.executionId).toBe(paused1.executionId)
        expect(paused2.approvalId).not.toBe(paused1.approvalId)     // a new approval for a new activity
        expect(paused2.requestState).not.toBe(paused1.requestState) // and a new sealed state
        expect(paused2.elicitation.message).toContain('Activity:  #3')
        expect(paused2.elicitation.message).toContain('createPayment — POST /payments')
        expect(paused2.elicitation.message).toContain('"orderId":"order-001"') // built from the *replayed* order response
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order]) // the GET was replayed, not re-issued
        insp = await s().admin.inspect(paused1.executionId)
        expect(insp.execution.runCount).toBe(2)
        expect(insp.activities.map(a => [a.sequence, a.status, a.runIndex])).toEqual([
            [1, ACTIVITY_STATUS.COMPLETED, 1], [2, ACTIVITY_STATUS.COMPLETED, 1], [3, ACTIVITY_STATUS.WAITING_APPROVAL, 2]
        ])
        expect(insp.activities[1]!.approvalId).toBe(paused1.approvalId)
        expect(insp.activities[2]!.approvalId).toBe(paused2.approvalId)
        expect(insp.activities[2]!.request.body).toEqual({orderId: 'order-001', amount: AMOUNTS.highValue})
        expect(insp.approvals.map(a => [a.activitySequence, a.status])).toEqual([[2, APPROVAL_STATUS.APPROVED], [3, APPROVAL_STATUS.PENDING]])
        expect(insp.decisions.map(d => [d.activitySequence, d.decision])).toEqual([[1, DECISION.ALLOW], [2, DECISION.REQUIRE_APPROVAL], [3, DECISION.REQUIRE_APPROVAL]])

        // ── Run 3: 1–2 replayed, 3 executed, 4 executes, done ─────────────────
        const done = expectCompleted(await c.answerApproval(paused2, {action: 'accept', approve: true}))
        expect(done.meta.executionId).toBe(paused1.executionId)
        expect(done.meta.executionStatus).toBe(EXECUTION_STATUS.COMPLETED)
        const value = done.value as {
            startedAt: number;
            customerId: string;
            orderId: string;
            paymentId: string;
            notificationId: string;
            statuses: number[]
        }
        expect(value).toMatchObject({
            customerId: 'customer-001',
            orderId: 'order-001',
            paymentId: 'payment-001',
            notificationId: 'notification-001',
            statuses: [200, 201, 201, 201]
        })

        // Exactly once, in program order, across three isolates.
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order, CALLS.payment, CALLS.note])
        const state = await s().mock.state()
        expect(state['orders']).toHaveLength(1);
        expect(state['payments']).toHaveLength(1);
        expect(state['notifications']).toHaveLength(1)

        insp = await s().admin.inspect(paused1.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
        expect(insp.execution.runCount).toBe(3)
        expect(insp.execution.result).toEqual(value)
        expect(insp.activities.map(a => [a.sequence, a.status, a.runIndex])).toEqual([
            [1, ACTIVITY_STATUS.COMPLETED, 1], [2, ACTIVITY_STATUS.COMPLETED, 1], [3, ACTIVITY_STATUS.COMPLETED, 2], [4, ACTIVITY_STATUS.COMPLETED, 3]
        ])
        expect(insp.approvals.map(a => [a.activitySequence, a.status, a.decidedVia])).toEqual([[2, APPROVAL_STATUS.APPROVED, 'mcp-elicitation'], [3, APPROVAL_STATUS.APPROVED, 'mcp-elicitation']])
        expect(insp.approvals[0]!.comment).toBe('order ok')
        expect(insp.decisions.map(d => [d.activitySequence, d.decision])).toEqual([[1, DECISION.ALLOW], [2, DECISION.REQUIRE_APPROVAL], [3, DECISION.REQUIRE_APPROVAL], [4, DECISION.ALLOW]])

        // Fresh isolate proof: the program's top-of-program timestamp was taken after the *second* human decision.
        const decidedAt = insp.approvals.map(a => Date.parse(a.decidedAt!))
        expect(value.startedAt).toBeGreaterThanOrEqual(decidedAt[1]!)
        expect(value.startedAt).toBeGreaterThanOrEqual(decidedAt[0]!)

        const events = insp.history.map(h => `${h.kind}:${h.event}${h.sequence ? '#' + h.sequence : ''}`)
        expect(events[0]).toBe('EXECUTION:CREATED')
        for (const e of ['APPROVAL:REQUESTED#2', 'APPROVAL:APPROVED#2', 'ACTIVITY:COMPLETED#2', 'APPROVAL:REQUESTED#3', 'APPROVAL:APPROVED#3', 'ACTIVITY:COMPLETED#4']) expect(events).toContain(e)
        expect(events[events.length - 1]).toBe('EXECUTION:COMPLETED')
    })

    it('should_terminate_at_step_2_and_never_reach_step_3_when_the_first_approval_is_denied', async () => {
        const c = s().client('alice')
        const paused1 = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused1.executionId)
        const out = expectToolError(await c.answerApproval(paused1, {action: 'decline'}), ERR.GOVERNANCE_DENIED)
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(await s().mock.calls()).toEqual([CALLS.customer])
        const insp = await s().admin.inspect(paused1.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
        expect(insp.execution.runCount).toBe(1) // no run happened after the denial
        expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.DENIED]])
        expect(insp.approvals.map(a => a.status)).toEqual([APPROVAL_STATUS.REJECTED])
        expect((await s().mock.state())['orders']).toEqual([])
        expectToolError(await c.resumeByMeta('commerce', program, paused1.executionId), ERR.EXECUTION_NOT_RESUMABLE)
    })

    it('should_stop_at_step_3_and_never_execute_step_4_when_the_second_approval_is_denied', async () => {
        const c = s().client('alice')
        const paused1 = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused1.executionId)
        const paused2 = expectPaused(await c.answerApproval(paused1, {action: 'accept'}))
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order])
        const out = expectToolError(await c.answerApproval(paused2, {action: 'decline'}), ERR.GOVERNANCE_DENIED)
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order]) // no payment, no notification
        const insp = await s().admin.inspect(paused1.executionId)
        expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.COMPLETED], [3, ACTIVITY_STATUS.DENIED]])
        expect(insp.approvals.map(a => [a.activitySequence, a.status])).toEqual([[2, APPROVAL_STATUS.APPROVED], [3, APPROVAL_STATUS.REJECTED]])
        const state = await s().mock.state()
        expect(state['payments']).toEqual([]);
        expect(state['notifications']).toEqual([])
    })

    it('should_deny_step_3_by_rule_after_step_2_was_approved_because_an_approval_covers_one_activity_only', async () => {
        // #1 GET → ALLOW · #2 POST /payments → approve · #3 DELETE /orders → DENY by rule · #4 never runs.
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', programs.approveThenDenyWorkflow(RESOURCES.customerAllowed)))
        s().track(paused.executionId)
        expect(paused.elicitation.message).toContain('Activity:  #2')
        const out = expectToolError(await c.answerApproval(paused, {action: 'accept'}), ERR.GOVERNANCE_DENIED)
        expect(out.message).toContain('activity #3')
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.payment])
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.runCount).toBe(2)
        expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.COMPLETED], [3, ACTIVITY_STATUS.DENIED]])
        expect(insp.approvals.map(a => [a.activitySequence, a.status])).toEqual([[2, APPROVAL_STATUS.APPROVED]])
        expect(insp.decisions.map(d => [d.activitySequence, d.decision])).toEqual([[1, DECISION.ALLOW], [2, DECISION.REQUIRE_APPROVAL], [3, DECISION.DENY]])
        expect(insp.decisions[2]!.decidingRule).toBe('gateway/deny-all-delete')
        expect(await s().mock.count('POST', '/notifications')).toBe(0)
    })

    it('should_complete_when_the_approval_point_is_the_final_step', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)))
        s().track(paused.executionId)
        expect(paused.elicitation.message).toContain('Activity:  #3')
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order])
        const done = expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        expect(done.value).toMatchObject({orderId: 'order-001', paymentId: 'payment-001'})
        expect(await s().mock.calls()).toEqual([CALLS.customer, CALLS.order, CALLS.payment])
    })

    it('should_approve_two_orders_separately_in_one_program_without_repeating_the_first', async () => {
        const c = s().client('alice')
        const program = `async () => {
  const first = await api.request({
    method: 'POST',
    path: '/orders',
    body: { customerId: '${RESOURCES.customerAllowed}', amount: 50000, items: ['sku-1'] }
  })
  const second = await api.request({
    method: 'POST',
    path: '/orders',
    body: { customerId: '${RESOURCES.customerAllowed}', amount: 60000, items: ['sku-2'] }
  })
  return [first.data.id, second.data.id]
}`

        const firstPause = expectPaused(await c.apiExecute('commerce', program))
        s().track(firstPause.executionId)
        expect(await s().mock.count('POST', '/orders')).toBe(0)

        const secondPause = expectPaused(await c.answerApproval(firstPause, {
            action: 'accept',
            approve: true
        }))
        expect(secondPause.executionId).toBe(firstPause.executionId)
        expect(secondPause.approvalId).not.toBe(firstPause.approvalId)
        expect(await s().mock.count('POST', '/orders')).toBe(1)

        const done = expectCompleted(await c.answerApproval(secondPause, {
            action: 'accept',
            approve: true
        }))
        expect(done.value).toEqual(['order-001', 'order-002'])
        expect(await s().mock.calls()).toEqual([CALLS.order, CALLS.order])

        const inspection = await s().admin.inspect(firstPause.executionId)
        expect(inspection.execution).toMatchObject({
            status: EXECUTION_STATUS.COMPLETED,
            runCount: 3
        })
        expect(inspection.activities.map(activity => activity.status)).toEqual([
            ACTIVITY_STATUS.COMPLETED,
            ACTIVITY_STATUS.COMPLETED
        ])
        expect(inspection.approvals.map(approval => approval.status)).toEqual([
            APPROVAL_STATUS.APPROVED,
            APPROVAL_STATUS.APPROVED
        ])
    })

    it('should_keep_two_concurrent_workflows_of_different_principals_independent', async () => {
        const alice = s().client('alice'), bob = s().client('bob')
        const [pa, pb] = await Promise.all([alice.apiExecute('commerce', program), bob.apiExecute('commerce', program)])
        const a = expectPaused(pa), b = expectPaused(pb)
        s().track(a.executionId);
        s().track(b.executionId)
        expect(a.executionId).not.toBe(b.executionId)
        expect(a.approvalId).not.toBe(b.approvalId)
        const [da, db] = await Promise.all([alice.answerApproval(a, {action: 'accept'}), bob.answerApproval(b, {action: 'decline'})])
        expectPaused(da)
        expectToolError(db, ERR.GOVERNANCE_DENIED)
        const orders = (await s().mock.requests({method: 'POST', path: '/orders'})).map(r => r.identity)
        expect(orders).toEqual(['alice']) // only alice's order was placed
        expect((await s().adminAs('bob').inspect(b.executionId)).execution.status).toBe(EXECUTION_STATUS.DENIED)
        expect((await s().admin.inspect(a.executionId)).execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    })
})
