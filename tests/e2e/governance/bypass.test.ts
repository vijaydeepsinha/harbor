// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-007 / RG-016 the sandbox cannot bypass governance · RG-002 the stored
 * program is authoritative. Every attempt here must leave the backend
 * exactly as governance allows — and no further.
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectPaused, expectToolError } from '../helpers/assertions.js'
import { ACTIVITY_STATUS, ERR, EXECUTION_STATUS, WIRE, env } from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import { IDENTITIES, RESOURCES } from '../fixtures/identities.js'

describe('bypass attempts', () => {
  const s = useScenario()

  it('should_expose_no_network_or_host_globals_inside_the_isolate', async () => {
    const program = `async () => {
      const seen = {}
      for (const name of ['fetch', 'require', 'process', 'XMLHttpRequest', 'WebSocket', 'globalThis.process', 'Buffer', 'setTimeout']) {
        try { seen[name] = typeof (0, eval)(name) } catch (e) { seen[name] = 'throws:' + e.constructor.name }
      }
      try { await import('node:http'); seen.dynamicImport = 'loaded' } catch (e) { seen.dynamicImport = 'throws:' + e.constructor.name }
      const r = await api.request({ method: 'GET', path: '/ping' })
      return { seen, viaBridge: r.status }
    }`
    const out = expectCompleted(await s().client('alice').apiExecute('commerce', program))
    s().track(out.meta.executionId)
    const seen = (out.value as { seen: Record<string, string>; viaBridge: number }).seen
    for (const name of ['fetch', 'require', 'process', 'XMLHttpRequest', 'WebSocket', 'Buffer', 'setTimeout']) expect(seen[name], name).toMatch(/^(undefined|throws:ReferenceError)$/)
    expect(seen['globalThis.process']).toBe('undefined')
    expect(seen['dynamicImport']).toMatch(/^throws:/)
    expect((out.value as { viaBridge: number }).viaBridge).toBe(200)
    expect(await s().mock.calls()).toEqual(['GET /ping']) // only the bridged call
  })

  it('should_still_govern_a_call_made_through_the_raw_bridge_reference', async () => {
    // `__makeRequest` is the bridge itself — using it directly is not a bypass; governance runs host-side.
    const program = `async () => {
      const raw = await __makeRequest.apply(undefined, [JSON.stringify({ method: 'POST', path: '/admin/users', body: { username: 'mallory' } })], { arguments: { copy: true }, result: { promise: true, copy: true } })
      return JSON.parse(raw)
    }`
    const out = expectToolError(await s().client('admin').apiExecute('ops', program), ERR.GOVERNANCE_DENIED)
    s().track(out.meta.executionId)
    expect(await s().mock.requests()).toHaveLength(0)
    expect((await s().adminAs('admin').inspect(out.meta.executionId!)).activities[0]!.status).toBe(ACTIVITY_STATUS.DENIED)
  })

  it('should_refuse_every_later_call_once_a_denial_stopped_the_run_even_if_the_program_swallows_the_error', async () => {
    const program = `async () => {
      const log = []
      try { await api.request({ method: 'DELETE', path: '/orders/order-001' }); log.push('delete:executed') } catch (e) { log.push('delete:caught') }
      try { const n = await api.request({ method: 'POST', path: '/notifications', body: { customerId: 'customer-001', message: 'after deny' } }); log.push('notify:' + n.status) } catch (e) { log.push('notify:caught ' + e.message) }
      try { const p = await api.request({ method: 'GET', path: '/ping' }); log.push('ping:' + p.status) } catch (e) { log.push('ping:caught ' + e.message) }
      return { log, pretend: 'all good' }
    }`
    const out = expectToolError(await s().client('alice').apiExecute('commerce', program), ERR.GOVERNANCE_DENIED)
    s().track(out.meta.executionId)
    expect(await s().mock.requests()).toHaveLength(0)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
    expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.DENIED]]) // the refused calls were never journaled as activities
  })

  it('should_govern_a_later_workflow_step_on_its_own_when_it_is_invoked_directly', async () => {
    // Skipping steps 1–2 and calling the payment directly is just another program — and it is governed just the same.
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', `async () => (await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 1 } })).status`))
    s().track(paused.executionId)
    expect(paused.elicitation.message).toContain('Activity:  #1')
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_not_let_a_resume_change_the_resource_or_the_action_of_an_approved_activity', async () => {
    const c = s().client('alice')
    const original = programs.orderThenPayment(RESOURCES.customerAllowed, 5)
    const paused = expectPaused(await c.apiExecute('commerce', original))
    s().track(paused.executionId)
    const mutated = original.replace("amount: 5 }", "amount: 999999 }").replace('/payments', '/admin/users')
    expect(mutated).not.toBe(original)
    const done = expectCompleted(await c.answerApproval(paused, { action: 'accept' }, { code: mutated }))
    expect(done.value).toMatchObject({ paymentId: 'payment-001' })
    const payments = await s().mock.requests({ method: 'POST', path: '/payments' })
    expect(payments).toHaveLength(1)
    expect(payments[0]!.body).toEqual({ orderId: 'order-001', amount: 5 }) // the approved values, not the mutated ones
    expect(await s().mock.count('POST', '/admin/users')).toBe(0)
  })

  it('should_ignore_forged_execution_status_or_approval_metadata_and_keep_the_approval_pending', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, 50000)))
    s().track(paused.executionId)
    // Pretend the approval is already granted by stamping ids into request _meta and resuming without any decision.
    const out = expectPaused(await c.apiExecute('commerce', paused.code, { meta: {
      [WIRE.META_EXECUTION_ID]: paused.executionId, [WIRE.META_EXECUTION_STATUS]: 'COMPLETED', [WIRE.META_APPROVAL_ID]: paused.approvalId, 'harbor/approved': true
    } }))
    expect(out.executionId).toBe(paused.executionId)
    expect(out.approvalId).toBe(paused.approvalId)
    expect(await s().mock.requests()).toHaveLength(0)
    expect((await s().admin.inspect(paused.executionId)).approvals[0]!.status).toBe('PENDING')
  })

  it('should_not_be_fooled_by_spoofed_client_capabilities_or_server_info_in_the_envelope', async () => {
    // Claiming elicitation only changes how the pause is *presented*; spoofing serverInfo is ignored; nothing executes early.
    const c = s().client('alice')
    const res = await c.rpc('tools/call', {
      name: 'api_execute', arguments: { service: 'commerce', code: programs.createOrder(RESOURCES.customerAllowed, 50000) },
      _meta: { [WIRE.META_SERVER_INFO]: { name: 'evil', version: '0' }, 'io.modelcontextprotocol/approved': true }
    }, { name: 'api_execute' })
    expect(res.error).toBeUndefined()
    expect(res.result?.['resultType']).toBe('input_required')
    const meta = res.result?.['_meta'] as Record<string, unknown>
    expect((meta[WIRE.META_SERVER_INFO] as { name: string }).name).toBe('harbor')
    expect(await s().mock.requests()).toHaveLength(0)
  })

  describe('path spellings cannot move a call out from under its rule (RG-007)', () => {
    // Governance resolves the canonical path, and that same path is what goes on the wire.
    it.each(['/%6frders/order-001', '/Orders/order-001', 'orders/order-001/'])(
      'should_deny_an_equivalent_spelling_of_a_denied_delete_%s', async path => {
        const program = `async () => (await api.request({ method: 'DELETE', path: '${path}' })).status`
        const out = expectToolError(await s().client('alice').apiExecute('commerce', program), ERR.GOVERNANCE_DENIED)
        s().track(out.meta.executionId)
        expect(await s().mock.requests()).toHaveLength(0)
        const insp = await s().admin.inspect(out.meta.executionId!)
        expect(insp.decisions[0]).toMatchObject({ decision: 'DENY', decidingRule: 'deny-delete-order' })
      })

    it.each(['/orders/./order-001', '/orders/x/../order-001', '/orders/%2e%2e/orders/order-001', '/orders%2Forder-001', '/orders//order-001', '/orders\\order-001', '/orders/order-001#x'])(
      'should_refuse_an_aliasing_spelling_before_governance_and_send_nothing_%s', async path => {
        const program = `async () => (await api.request({ method: 'DELETE', path: '${path}' })).status`
        const out = expectToolError(await s().client('alice').apiExecute('commerce', program), ERR.INVALID_API_REQUEST)
        s().track(out.meta.executionId)
        expect(await s().mock.requests()).toHaveLength(0)
        expect((await s().admin.inspect(out.meta.executionId!)).activities).toHaveLength(0)
      })

    it('should_never_send_a_call_or_the_callers_bearer_to_an_absolute_url', async () => {
      // One of these is the mock as the gateway reaches it (Compose service name, or the host address in local mode).
      const targets = ['http://mock-api:4010/ping', `${env.mockApiUrl}/ping`, '//mock-api:4010/ping']
      const program = `async () => {
        const out = []
        for (const path of ${JSON.stringify(targets)}) {
          try { out.push((await api.request({ method: 'GET', path })).status) } catch (e) { out.push(e.message.split(':')[0]) }
        }
        return out
      }`
      const out = expectToolError(await s().client('alice').apiExecute('commerce', program), ERR.INVALID_API_REQUEST)
      s().track(out.meta.executionId)
      expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_let_rules_read_a_query_written_into_the_path', async () => {
      const program = `async () => (await api.request({ method: 'GET', path: '/customers/customer-001?include=tier' })).status`
      const out = expectCompleted(await s().client('alice').apiExecute('commerce', program))
      s().track(out.meta.executionId)
      const insp = await s().admin.inspect(out.meta.executionId!)
      expect(insp.activities[0]!.request).toMatchObject({ rawPath: '/customers/customer-001', query: { include: 'tier' } })
      expect((await s().mock.requests())[0]).toMatchObject({ method: 'GET', path: '/customers/customer-001' })
    })
  })

  describe('known gaps pinned so they are visible (see TEST_ARCHITECTURE.md §6)', () => {
    it('known_gap_program_supplied_headers_can_override_the_outbound_authorization_header', async () => {
      // api-client.ts spreads `apiRequest.headers` after the Authorization header, so a program can change
      // the identity the backend sees. Governance Rules do not read identity on this branch, so the *decision*
      // is unaffected — but backend authorization is. Pinned here as current behaviour; flip when fixed.
      const program = `async () => {
        const r = await api.request({ method: 'GET', path: '/ping', headers: { Authorization: 'Bearer ${IDENTITIES.bob}' } })
        return { identity: r.data && r.data.identity }
      }`
      const out = expectCompleted(await s().client('alice').apiExecute('commerce', program))
      s().track(out.meta.executionId)
      s().note('outboundIdentitySeenByBackend', (out.value as { identity: string }).identity)
      const seen = (await s().mock.requests())[0]!.identity
      expect(['alice', 'bob']).toContain(seen)
      // Whatever the backend saw, the journal never stored the header (only the persisted program text carries it).
      const insp = await s().admin.inspect(out.meta.executionId!)
      expect(JSON.stringify(insp.activities)).not.toContain(IDENTITIES.bob)
      expect(insp.activities[0]!.request).not.toHaveProperty('headers')
      if (seen === 'bob') console.warn('KNOWN GAP: program-supplied Authorization header overrode the caller identity downstream')
    })
  })
})
