// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-011 default decision · RG-025 requestState TTL · RG-026 fail closed.
 *
 * GIVEN the strict instance: GOVERNANCE_DEFAULT_DECISION=DENY, a one-rule
 * set (ping allowed, high-value orders need approval) and a 3-second requestState TTL.
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectPaused, expectRpcError, expectToolError } from '../helpers/assertions.js'
import { APPROVAL_STATUS, DECISION, ERR, EXECUTION_STATUS, env } from '../helpers/env.js'
import { sleepUntil } from '../helpers/wait.js'
import * as programs from '../fixtures/programs.js'
import { AMOUNTS, RESOURCES } from '../fixtures/identities.js'

describe.skipIf(!env.strictBaseUrl)('fail-closed instance (default DENY, short requestState TTL)', () => {
  const s = useScenario()

  it('should_deny_a_targeted_operation_when_no_rule_conditions_match_and_the_default_is_deny', async () => {
    const out = expectToolError(await s().strictClient('alice').apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal)), ERR.GOVERNANCE_DENIED)
    expect(out.message).toContain('NO_MATCHING_RULE')
    const insp = await s().strictAdmin().inspect(out.meta.executionId!)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
    expect(insp.decisions[0]).toMatchObject({ decision: DECISION.DENY, reason: 'NO_MATCHING_RULE', matchedRules: [] })
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_still_allow_an_operation_an_explicit_allow_rule_names', async () => {
    const out = expectCompleted(await s().strictClient('alice').apiExecute('commerce', programs.ping()))
    expect(out.value).toMatchObject({ status: 200 })
    expect((await s().strictAdmin().inspect(out.meta.executionId!)).decisions[0]).toMatchObject({ decision: DECISION.ALLOW, decidingRule: 'strict-allow-ping' })
    expect(await s().mock.count('GET', '/ping')).toBe(1)
  })

  it('should_complete_an_approval_round_trip_answered_within_the_ttl', async () => {
    const c = s().strictClient('alice')
    const paused = expectPaused(await c.apiExecute('commerce', programs.slowPayment(0)))
    const done = expectCompleted(await c.answerApproval(paused, { action: 'accept' }))
    expect(done.value).toMatchObject({ status: 201 })
    expect(await s().mock.count('POST', '/payments')).toBe(1)
  })

  it('should_refuse_an_expired_request_state_but_keep_the_pending_approval_decidable_over_http', async () => {
    const c = s().strictClient('alice')
    const paused = expectPaused(await c.apiExecute('commerce', programs.slowPayment(0)))
    const mintedAt = Date.now()
    await sleepUntil(mintedAt + 4500) // The SDK encodes expiry in whole seconds, so wait beyond the 3 s TTL boundary.
    expectRpcError(await c.answerApproval(paused, { action: 'accept' }), -32602)
    expect(await s().mock.requests()).toHaveLength(0)
    const admin = s().strictAdmin()
    let insp = await admin.inspect(paused.executionId)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING) // the approval itself did not expire
    // The fallback channel has no TTL: decide over HTTP, then resume by id.
    expect((await admin.decide(paused.executionId, paused.approvalId, { action: 'accept', approve: true })).status).toBe(200)
    const done = expectCompleted(await c.resumeByMeta('commerce', paused.code, paused.executionId))
    expect(done.value).toMatchObject({ status: 201 })
    insp = await admin.inspect(paused.executionId)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(await s().mock.count('POST', '/payments')).toBe(1)
  }, 30_000)

  it('should_reject_a_request_state_minted_by_the_other_instance', async () => {
    // Different HMAC keys: a state sealed by the main gateway is refused by the strict one.
    const main = s().client('alice')
    const paused = expectPaused(await main.apiExecute('commerce', programs.slowPayment(0)))
    s().track(paused.executionId)
    const strict = s().strictClient('alice')
    expectRpcError(await strict.answerApproval(paused, { action: 'accept' }), -32602)
    expect(await s().mock.requests()).toHaveLength(0)
  })
})
