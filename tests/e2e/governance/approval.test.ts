// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-013 human approval over MCP elicitation (multi-round-trip) ·
 * RG-014 approval bound to one activity · RG-027 HTTP fallback channel.
 *
 * GIVEN `createOrder` with amount > 10000 requires approval.
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted, expectPaused, expectToolError} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, APPROVAL_STATUS, DECISION, ERR, EXECUTION_STATUS, WIRE} from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

describe('approval required', () => {
    const s = useScenario()
    const program = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)

    it('should_pause_with_an_elicitation_form_and_a_sealed_request_state_when_a_high_value_order_is_created', async () => {
        const paused = expectPaused(await s().client('alice').apiExecute('commerce', program))
        s().track(paused.executionId)

        // The MCP result: input_required + elicitation/create form + requestState + Harbor ids in _meta.
        const result = paused.raw.result!
        expect(result['resultType']).toBe('input_required')
        const requests = result['inputRequests'] as Record<string, {
            method: string;
            params: {
                mode?: string;
                message: string;
                requestedSchema: { type: string; properties: Record<string, { type: string }>; required: string[] }
            }
        }>
        expect(Object.keys(requests)).toEqual([WIRE.APPROVAL_INPUT_KEY])
        const req = requests[WIRE.APPROVAL_INPUT_KEY]!
        expect(req.method).toBe('elicitation/create')
        expect(req.params.mode ?? 'form').toBe('form')
        expect(req.params.requestedSchema.required).toEqual(['approve'])
        expect(req.params.requestedSchema.properties['approve']?.type).toBe('boolean')
        expect(req.params.requestedSchema.properties['comment']?.type).toBe('string')
        // What the human is told: execution, activity, service, operation, values, why.
        expect(paused.elicitation.message).toContain(`Execution: ${paused.executionId}`)
        expect(paused.elicitation.message).toContain('Activity:  #1')
        expect(paused.elicitation.message).toContain('Service:   commerce')
        expect(paused.elicitation.message).toContain('createOrder — POST /orders')
        expect(paused.elicitation.message).toContain(`"amount":${AMOUNTS.highValue}`)
        expect(paused.elicitation.message).toContain('Order amount exceeds the approval threshold')
        expect(paused.elicitation.message).toContain('high-value-order-requires-approval')
        expect(paused.elicitation.message).not.toContain('e2e-alice-token') // never credentials
        expect(paused.meta.executionStatus).toBe(EXECUTION_STATUS.WAITING_APPROVAL)

        // Policy = REQUIRE_APPROVAL, execution = WAITING_APPROVAL, downstream = 0.
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect(insp.execution.pendingApprovalId).toBe(paused.approvalId)
        expect(insp.execution.runCount).toBe(1)
        expect(insp.activities).toEqual([expect.objectContaining({
            sequence: 1,
            status: ACTIVITY_STATUS.WAITING_APPROVAL,
            approvalId: paused.approvalId
        })])
        expect(insp.decisions[0]).toMatchObject({
            activitySequence: 1,
            decision: DECISION.REQUIRE_APPROVAL,
            decidingRule: 'commerce/high-value-order-requires-approval'
        })
        expect(insp.approvals).toEqual([expect.objectContaining({
            approvalId: paused.approvalId,
            executionId: paused.executionId,
            activitySequence: 1,
            status: APPROVAL_STATUS.PENDING
        })])
        expect(insp.approvals[0]!.summary).toMatchObject({
            service: 'commerce',
            method: 'POST',
            specPath: '/orders',
            operationId: 'createOrder',
            body: {amount: AMOUNTS.highValue}
        })
        expect(insp.approvals[0]).not.toHaveProperty('decidedAt')
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_execute_the_approved_operation_exactly_once_and_complete_when_the_human_accepts', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        const done = expectCompleted(await c.answerApproval(paused, {
            action: 'accept',
            approve: true,
            comment: 'looks fine'
        }))
        expect(done.meta.executionId).toBe(paused.executionId) // same execution across the round trip
        expect(done.meta.executionStatus).toBe(EXECUTION_STATUS.COMPLETED)
        expect(done.value).toMatchObject({status: 201, order: {id: 'order-001', amount: AMOUNTS.highValue}})

        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
        expect(insp.execution.runCount).toBe(2) // run 1 paused, run 2 (fresh isolate) executed
        expect(insp.execution).not.toHaveProperty('pendingApprovalId')
        expect(insp.activities[0]).toMatchObject({
            sequence: 1,
            status: ACTIVITY_STATUS.COMPLETED,
            approvalId: paused.approvalId,
            runIndex: 1,
            response: {status: 201}
        })
        expect(insp.approvals[0]).toMatchObject({
            status: APPROVAL_STATUS.APPROVED,
            decidedVia: 'mcp-elicitation',
            comment: 'looks fine'
        })
        expect(insp.approvals[0]!.decidedAt).toBeDefined()
        expect(await s().mock.calls()).toEqual(['POST /orders'])
    })

    it('should_deny_the_execution_and_execute_nothing_when_the_human_declines', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        const out = expectToolError(await c.answerApproval(paused, {action: 'decline'}), ERR.GOVERNANCE_DENIED)
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(out.meta.approvalId).toBe(paused.approvalId)
        expect(out.message).toContain('Approval rejected for activity #1')
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
        expect(insp.execution.terminalReason).toMatchObject({code: ERR.GOVERNANCE_DENIED})
        expect(insp.activities[0]!.status).toBe(ACTIVITY_STATUS.DENIED)
        expect(insp.approvals[0]).toMatchObject({status: APPROVAL_STATUS.REJECTED, decidedVia: 'mcp-elicitation'})
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_treat_accept_with_approve_false_as_a_rejection', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        expectToolError(await c.answerApproval(paused, {
            action: 'accept',
            approve: false,
            comment: 'no'
        }), ERR.GOVERNANCE_DENIED)
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
        expect(insp.approvals[0]).toMatchObject({status: APPROVAL_STATUS.REJECTED, comment: 'no'})
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_refuse_an_accept_that_does_not_say_approve_true_and_keep_the_approval_pending', async () => {
        // The form declares `approve` required; a missing or non-boolean value is not a yes (fail closed).
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        for (const content of [undefined, {}, {approve: 'false'}, {approve: 1}]) {
            const out = expectToolError(await c.apiExecute('commerce', program, {
                requestState: paused.requestState,
                inputResponses: {[WIRE.APPROVAL_INPUT_KEY]: {action: 'accept', ...(content ? {content} : {})}}
            }), ERR.INVALID_API_REQUEST)
            expect(out.retryable).toBe(false)
        }
        const overHttp = await s().admin.decide(paused.executionId, paused.approvalId, {action: 'accept'})
        expect(overHttp.status).toBe(400)
        expect(await s().mock.count('POST', '/orders')).toBe(0)
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        // A proper answer still works afterwards.
        expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        expect(await s().mock.count('POST', '/orders')).toBe(1)
    })

    it('should_refuse_a_conflicting_answer_after_the_approval_was_decided_over_http', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        expect((await s().admin.decide(paused.executionId, paused.approvalId, {
            action: 'accept',
            approve: true
        })).status).toBe(200)
        expectToolError(await c.answerApproval(paused, {action: 'decline'}), ERR.APPROVAL_ALREADY_DECIDED)
        expect(await s().mock.count('POST', '/orders')).toBe(0) // the decliner did not run the approved call
        expectCompleted(await c.answerApproval(paused, {action: 'accept'}))
        expect(await s().mock.count('POST', '/orders')).toBe(1)
    })

    it('should_cancel_the_execution_and_execute_nothing_when_the_human_cancels', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        const out = expectToolError(await c.answerApproval(paused, {action: 'cancel'}), ERR.EXECUTION_CANCELLED)
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.CANCELLED)
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.CANCELLED)
        expect(insp.execution.terminalReason).toMatchObject({code: ERR.EXECUTION_CANCELLED})
        expect(insp.activities[0]!.status).toBe(ACTIVITY_STATUS.CANCELLED)
        expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.CANCELLED)
        expect(await s().mock.requests()).toHaveLength(0)
        // Cancelled is terminal.
        expectToolError(await c.resumeByMeta('commerce', program, paused.executionId), ERR.EXECUTION_NOT_RESUMABLE)
    })

    it('should_ask_again_with_the_same_approval_when_the_client_retries_without_an_answer', async () => {
        const c = s().client('alice')
        const paused = expectPaused(await c.apiExecute('commerce', program))
        s().track(paused.executionId)
        const again = expectPaused(await c.retryWithoutAnswer(paused))
        expect(again.executionId).toBe(paused.executionId)
        expect(again.approvalId).toBe(paused.approvalId) // no second approval was minted
        const insp = await s().admin.inspect(paused.executionId)
        expect(insp.approvals).toHaveLength(1)
        expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
        expect(insp.execution.runCount).toBe(1) // nothing was re-run
        expect(await s().mock.requests()).toHaveLength(0)
        // …and the re-issued state is still redeemable.
        expectCompleted(await c.answerApproval(again, {action: 'accept'}))
        expect(await s().mock.count('POST', '/orders')).toBe(1)
    })

    it('should_bind_the_approval_to_the_specific_activity_operation_and_values', async () => {
        const paused = expectPaused(await s().client('alice').apiExecute('commerce', program))
        s().track(paused.executionId)
        const insp = await s().admin.inspect(paused.executionId)
        const approval = insp.approvals[0]!
        const activity = insp.activities[0]!
        expect(approval.executionId).toBe(paused.executionId)
        expect(approval.activitySequence).toBe(activity.sequence)
        expect(activity.approvalId).toBe(approval.approvalId)
        expect(approval.summary.operationId).toBe(activity.request.operationId)
        expect(approval.summary.body).toEqual(activity.request.body)
        expect(approval.summary.matchedRules).toEqual(['commerce/high-value-order-requires-approval'])
    })

    describe('client without elicitation (HTTP fallback channel)', () => {
        it('should_return_approval_required_with_the_ids_in_meta_instead_of_an_elicitation', async () => {
            const c = s().client('alice', {capabilities: {}})
            const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
            s().track(out.meta.executionId)
            expect(out.raw.result!['resultType']).toBe('complete')
            expect(out.raw.result!['inputRequests']).toBeUndefined()
            expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
            expect(out.meta.approvalId).toBe(out.payload['approvalId'])
            expect(out.payload).toMatchObject({
                executionId: out.meta.executionId,
                activitySequence: 1,
                approval: {operationId: 'createOrder', specPath: '/orders'}
            })
            expect(out.message).toContain(`POST /executions/${out.meta.executionId}/approvals/${out.meta.approvalId}`)
            expect(await s().mock.requests()).toHaveLength(0)
        })

        it('should_resume_by_execution_id_after_an_http_accept_and_execute_exactly_once', async () => {
            const c = s().client('alice', {capabilities: {}})
            const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
            s().track(out.meta.executionId)
            const decided = await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, {
                action: 'accept',
                approve: true,
                comment: 'via http'
            })
            expect(decided.status).toBe(200)
            expect(decided.body).toMatchObject({
                outcome: 'APPROVED',
                executionStatus: EXECUTION_STATUS.WAITING_APPROVAL,
                approval: {status: APPROVAL_STATUS.APPROVED, decidedVia: 'http', comment: 'via http'}
            })
            expect(await s().mock.requests()).toHaveLength(0) // deciding never executes; only the next run does
            const done = expectCompleted(await c.resumeByMeta('commerce', program, out.meta.executionId!))
            expect(done.value).toMatchObject({status: 201})
            expect(await s().mock.count('POST', '/orders')).toBe(1)
            expect((await s().admin.inspect(out.meta.executionId!)).execution.runCount).toBe(2)
        })

        it('should_deny_the_execution_after_an_http_decline_and_refuse_the_resume', async () => {
            const c = s().client('alice', {capabilities: {}})
            const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
            s().track(out.meta.executionId)
            const decided = await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, {action: 'decline'})
            expect(decided.body).toMatchObject({outcome: 'REJECTED', executionStatus: EXECUTION_STATUS.DENIED})
            expectToolError(await c.resumeByMeta('commerce', program, out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
            expect(await s().mock.requests()).toHaveLength(0)
        })

        it('should_refuse_a_resume_while_the_approval_is_still_pending', async () => {
            const c = s().client('alice', {capabilities: {}})
            const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
            s().track(out.meta.executionId)
            const early = expectToolError(await c.resumeByMeta('commerce', program, out.meta.executionId!), ERR.APPROVAL_REQUIRED)
            expect(early.message).toContain('still pending')
            expect(await s().mock.requests()).toHaveLength(0)
        })

        it('should_validate_the_http_decision_body', async () => {
            const c = s().client('alice', {capabilities: {}})
            const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
            s().track(out.meta.executionId)
            const id = out.meta.executionId!, ap = out.meta.approvalId!
            expect((await s().admin.decide(id, ap, {action: 'maybe'})).status).toBe(400)
            expect((await s().admin.decide(id, ap, {}, {rawBody: '{not json'})).status).toBe(400)
            expect((await s().admin.decide(id, ap, [1, 2])).status).toBe(400)
            expect((await s().admin.request('GET', `/executions/${id}/approvals/${ap}`)).status).toBe(405)
            expect((await s().admin.inspect(id)).approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING) // untouched
        })
    })
})
