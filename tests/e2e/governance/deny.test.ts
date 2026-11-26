// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-007 governance before side effect · RG-009 request-value conditions ·
 * RG-011 precedence · RG-012 decision persistence.
 *
 * GIVEN the default rule set. A DENY must leave the backend untouched.
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectPaused, expectToolError} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, DECISION, ERR, EXECUTION_STATUS} from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

describe('denied operations', () => {
    const s = useScenario()

    it('should_stop_before_the_call_and_deny_the_execution_when_a_rule_denies_delete', async () => {
        const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.createThenDeleteOrder(RESOURCES.customerAllowed, AMOUNTS.normal)), ERR.GOVERNANCE_DENIED)
        s().track(out.meta.executionId)
        expect(out.retryable).toBe(false)
        expect(out.message).toContain('Gateway policy forbids all DELETE requests.')
        expect(out.message).toContain('deny-all-delete')
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(out.payload['executionId']).toBe(out.meta.executionId)

        // Policy = DENY for #2, execution = DENIED, downstream = the allowed #1 only.
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
        expect(insp.execution.terminalReason?.code).toBe(ERR.GOVERNANCE_DENIED)
        expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.DENIED]])
        expect(insp.activities[1]!.request).toMatchObject({
            method: 'DELETE',
            specPath: '/orders/{orderId}',
            operationId: 'deleteOrder',
            pathParams: {orderId: 'order-001'}
        })
        expect(insp.activities[1]).not.toHaveProperty('response')
        expect(insp.decisions.map(d => [d.activitySequence, d.decision, d.decidingRule ?? null])).toEqual([[1, DECISION.ALLOW, null], [2, DECISION.DENY, 'gateway/deny-all-delete']])
        expect(insp.approvals).toEqual([])
        expect(await s().mock.calls()).toEqual(['POST /orders'])
        expect((await s().mock.state())['orders']).toHaveLength(1) // still there
    })

    it('should_deny_a_restricted_resource_even_though_a_broader_allow_rule_matches', async () => {
        const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.readCustomer(RESOURCES.customerRestricted)), ERR.GOVERNANCE_DENIED)
        s().track(out.meta.executionId)
        const insp = await s().admin.inspect(out.meta.executionId!)
        const d = insp.decisions[0]!
        expect(d.decision).toBe(DECISION.DENY)
        expect(d.matchedRules.sort()).toEqual(['commerce/allow-read-customer', 'commerce/deny-restricted-customer'])
        expect(d.decidingRule).toBe('commerce/deny-restricted-customer')
        expect(d.reason).toBe('customer-002 is a restricted record')
        expect(d.ruleVersions).toEqual(expect.arrayContaining([expect.stringMatching(/^commerce\/deny-restricted-customer@2#/)]))
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_allow_the_same_operation_for_a_resource_the_condition_does_not_name', async () => {
        const ok = await s().client('alice').apiExecute('commerce', programs.readCustomer(RESOURCES.customerAllowed))
        expect(ok.kind).toBe('completed')
        expect(await s().mock.count('GET', '/customers/customer-001')).toBe(1)
    })

    it('should_deny_admin_user_creation_on_the_ops_service', async () => {
        const out = expectToolError(await s().client('admin').apiExecute('ops', programs.createAdminUser('mallory')), ERR.GOVERNANCE_DENIED)
        s().track(out.meta.executionId)
        const insp = await s().adminAs('admin').inspect(out.meta.executionId!)
        expect(insp.decisions[0]).toMatchObject({decision: DECISION.DENY, decidingRule: 'ops/deny-admin-user-creation'})
        expect(await s().mock.requests()).toHaveLength(0)
        expect((await s().mock.state())['adminUsers']).toEqual([])
    })

    it('should_let_deny_win_when_an_allow_rule_and_a_deny_rule_both_match', async () => {
        const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.createThenUpdateOrder(RESOURCES.customerAllowed, AMOUNTS.normal, {status: 'cancelled'})), ERR.GOVERNANCE_DENIED)
        s().track(out.meta.executionId)
        const insp = await s().admin.inspect(out.meta.executionId!)
        const d = insp.decisions[1]!
        expect(d.matchedRules.sort()).toEqual(['commerce/allow-update-order', 'commerce/deny-cancel-via-update'])
        expect(d.decidingRule).toBe('commerce/deny-cancel-via-update')
        expect(await s().mock.calls()).toEqual(['POST /orders'])
    })

    it('should_let_require_approval_win_when_an_allow_rule_and_an_approval_rule_both_match', async () => {
        const paused = expectPaused(await s().client('alice').apiExecute('commerce', programs.createThenUpdateOrder(RESOURCES.customerAllowed, AMOUNTS.normal, {expedite: true})))
        s().track(paused.executionId)
        const insp = await s().admin.inspect(paused.executionId)
        const d = insp.decisions[1]!
        expect(d.decision).toBe(DECISION.REQUIRE_APPROVAL)
        expect(d.matchedRules.sort()).toEqual(['commerce/allow-update-order', 'commerce/expedite-requires-approval'])
        expect(d.decidingRule).toBe('commerce/expedite-requires-approval')
        expect(await s().mock.calls()).toEqual(['POST /orders'])
    })

    it('should_not_allow_a_denied_execution_to_be_resumed', async () => {
        const denied = expectToolError(await s().client('alice').apiExecute('commerce', programs.readCustomer(RESOURCES.customerRestricted)), ERR.GOVERNANCE_DENIED)
        s().track(denied.meta.executionId)
        const again = expectToolError(await s().client('alice').resumeByMeta('commerce', programs.readCustomer(RESOURCES.customerRestricted), denied.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
        expect(again.message).toContain('DENIED')
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_deny_a_high_value_order_when_the_condition_reads_the_actual_body_amount_after_approval_is_declined', async () => {
        // Value-based rule: same operation, different body ⇒ different decision (approval vs allow was shown in allow.test.ts).
        const paused = expectPaused(await s().client('alice').apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)))
        s().track(paused.executionId)
        expect(await s().mock.count('POST', '/orders')).toBe(0)
        const declined = expectToolError(await s().client('alice').answerApproval(paused, {action: 'decline'}), ERR.GOVERNANCE_DENIED)
        expect(declined.meta.executionStatus).toBe(EXECUTION_STATUS.DENIED)
        expect(await s().mock.count('POST', '/orders')).toBe(0)
    })
})
