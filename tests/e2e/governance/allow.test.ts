// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-007 governance before side effect · RG-008 OpenAPI-aware targeting ·
 * RG-011 default decision · RG-012 decision persistence.
 *
 * GIVEN the default rule set (see fixtures/governance/default/README.md).
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, DECISION, EXECUTION_STATUS} from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import {AMOUNTS, RESOURCES} from '../fixtures/identities.js'

describe('allowed operations', () => {
    const s = useScenario()

    it('should_execute_downstream_exactly_once_when_a_rule_allows_the_read', async () => {
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.readCustomer(RESOURCES.customerAllowed), {
            headers: {'x-harbor-client-id': 'e2e-client-7'}
        }))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 200, ok: true, customer: {id: 'customer-001'}})
        expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.COMPLETED)

        // Policy decision and execution result are two different facts — assert both.
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
        expect(insp.execution.runCount).toBe(1)
        expect(insp.decisions).toHaveLength(1)
        expect(insp.decisions[0]).toMatchObject({
            activitySequence: 1,
            decision: DECISION.ALLOW,
            matchedRules: ['allow-read-customer'],
            decidingRule: 'allow-read-customer'
        })
        expect(insp.decisions[0]!.ruleVersions).toEqual([expect.stringMatching(/^allow-read-customer@1#[0-9a-f]{12}$/)])
        expect(insp.activities).toHaveLength(1)
        expect(insp.activities[0]).toMatchObject({
            sequence: 1, status: ACTIVITY_STATUS.COMPLETED, runIndex: 1,
            request: {
                method: 'GET',
                rawPath: '/customers/customer-001',
                specPath: '/customers/{customerId}',
                operationId: 'getCustomer',
                pathParams: {customerId: 'customer-001'}
            },
            response: {status: 200, ok: true}
        })
        expect(insp.activities[0]!.request).not.toHaveProperty('headers')

        // Downstream: exactly one call, and it was this execution's.
        const calls = await s().mock.requests({method: 'GET', path: '/customers/customer-001'})
        expect(calls).toHaveLength(1)
        expect(calls[0]!.identity).toBe('alice')
        expect(calls[0]!.headers['x-harbor-execution-id']).toBe(out.meta.executionId)
        expect(calls[0]!.headers['x-harbor-server-id']).toBe('HARBOR_GATEWAY')
        expect(calls[0]!.headers['x-mcp-service']).toBe('commerce')
        expect(calls[0]!.headers['x-mcp-tool']).toBe('api_execute')
        expect(calls[0]!.headers['x-correlation-id']).toBeTruthy()
        expect(calls[0]!.headers['x-harbor-server-id']).toBe('HARBOR_GATEWAY')
        expect(calls[0]!.headers['x-harbor-client-id']).toBe('e2e-client-7')
        expect(calls[0]!.headers['x-idempotency-key']).toMatch(/-1$/)
    })

    it('should_allow_an_ungoverned_call_when_no_rule_targets_it', async () => {
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.ping()))
        s().track(out.meta.executionId)
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.decisions[0]).toMatchObject({
            decision: DECISION.ALLOW,
            reason: 'NO_GOVERNANCE',
            matchedRules: [],
            ruleVersions: []
        })
        expect(insp.decisions[0]).not.toHaveProperty('decidingRule')
        expect(await s().mock.count('GET', '/ping')).toBe(1)
    })

    it('should_forward_the_calling_identity_to_the_backend_unchanged', async () => {
        const asBob = expectCompleted(await s().client('bob').apiExecute('commerce', programs.ping()))
        const asFinance = expectCompleted(await s().client('finance-user').apiExecute('commerce', programs.ping()))
        s().track(asBob.meta.executionId);
        s().track(asFinance.meta.executionId)
        expect(asBob.value).toMatchObject({identity: 'bob'})
        expect(asFinance.value).toMatchObject({identity: 'finance-user'})
        const seen = (await s().mock.requests({path: '/ping'})).map(r => r.identity)
        expect(seen).toEqual(['bob', 'finance-user'])
        // Different bearers are different principals: the executions are not the same owner.
        const [b, f] = await Promise.all([
            s().adminAs('bob').inspect(asBob.meta.executionId!),
            s().adminAs('finance-user').inspect(asFinance.meta.executionId!)
        ])
        expect(b.execution.userIdHash).not.toBe(f.execution.userIdHash)
    })

    it('should_allow_a_normal_value_order_and_persist_the_created_resource_id', async () => {
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal)))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 201, order: {id: 'order-001', amount: AMOUNTS.normal}})
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.decisions[0]).toMatchObject({decision: DECISION.ALLOW, reason: 'NO_MATCHING_RULE'})
        expect(insp.activities[0]!.request.body).toEqual({
            customerId: 'customer-001',
            amount: AMOUNTS.normal,
            items: ['sku-1']
        })
        expect(insp.activities[0]!.response?.data).toMatchObject({id: 'order-001'})
        expect(await s().mock.count('POST', '/orders')).toBe(1)
    })

    it('should_treat_the_threshold_amount_itself_as_not_high_value', async () => {
        // greater_than 10000 — the boundary is allowed.
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.boundary)))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 201})
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.decisions[0]!.decision).toBe(DECISION.ALLOW)
        expect(insp.decisions[0]!.matchedRules).toEqual([])
    })

    it('should_allow_ops_reads_via_a_method_plus_wildcard_path_rule', async () => {
        const out = expectCompleted(await s().client('admin').apiExecute('ops', programs.listAdminUsers()))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 200, count: 0})
        const insp = await s().adminAs('admin').inspect(out.meta.executionId!)
        expect(insp.execution.service).toBe('ops')
        expect(insp.decisions[0]).toMatchObject({decision: DECISION.ALLOW, decidingRule: 'allow-ops-reads'})
        expect(insp.activities[0]!.request.operationId).toBe('listAdminUsers')
    })

    it('should_allow_an_update_when_only_the_allow_rule_matches', async () => {
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.createThenUpdateOrder(RESOURCES.customerAllowed, AMOUNTS.normal, {status: 'shipped'})))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({orderId: 'order-001', status: 200, ok: true})
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.decisions.map(d => [d.activitySequence, d.decision, d.decidingRule ?? null])).toEqual([[1, DECISION.ALLOW, null], [2, DECISION.ALLOW, 'allow-update-order']])
        expect(await s().mock.calls()).toEqual(['POST /orders', 'PATCH /orders/order-001'])
    })
})
