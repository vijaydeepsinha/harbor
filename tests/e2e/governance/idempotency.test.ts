// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-018 execution locking · RG-028 an approval is decided once.
 *
 * Duplicate approvals, duplicate resumes and concurrent resumes must never
 * produce a second side effect.
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectPaused, expectToolError } from '../helpers/assertions.js'
import { APPROVAL_STATUS, ERR, EXECUTION_STATUS } from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import { AMOUNTS, RESOURCES } from '../fixtures/identities.js'

describe('idempotency of approvals and resumes', () => {
  const s = useScenario()
  const highValue = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)

  it('should_not_execute_twice_when_the_same_approval_answer_is_sent_twice', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', highValue))
    s().track(paused.executionId)
    expectCompleted(await c.answerApproval(paused, { action: 'accept' }))
    const dup = expectToolError(await c.answerApproval(paused, { action: 'accept' }), ERR.EXECUTION_NOT_RESUMABLE)
    expect(dup.message).toContain('COMPLETED')
    expect(await s().mock.count('POST', '/orders')).toBe(1)
    const insp = await s().admin.inspect(paused.executionId)
    expect(insp.approvals).toHaveLength(1)
    expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.APPROVED)
    expect(insp.execution.runCount).toBe(2)
  })

  it('should_refuse_a_second_http_decision_with_409_and_keep_the_first', async () => {
    const c = s().client('alice', { capabilities: {} })
    const out = expectToolError(await c.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    const id = out.meta.executionId!, ap = out.meta.approvalId!
    expect((await s().admin.decide(id, ap, { action: 'accept', approve: true })).status).toBe(200)
    const second = await s().admin.decide(id, ap, { action: 'decline' })
    expect(second.status).toBe(409)
    expect((second.body as { code: string }).code).toBe(ERR.APPROVAL_ALREADY_DECIDED)
    const third = await s().admin.decide(id, ap, { action: 'accept', approve: true })
    expect(third.status).toBe(409)
    expect((await s().admin.inspect(id)).approvals[0]!.status).toBe(APPROVAL_STATUS.APPROVED) // the first decision stands
    expectCompleted(await c.resumeByMeta('commerce', highValue, id))
    expect(await s().mock.count('POST', '/orders')).toBe(1)
  })

  it('should_refuse_a_duplicate_meta_resume_after_completion', async () => {
    const c = s().client('alice', { capabilities: {} })
    const out = expectToolError(await c.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true })
    expectCompleted(await c.resumeByMeta('commerce', highValue, out.meta.executionId!))
    expectToolError(await c.resumeByMeta('commerce', highValue, out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
    expectToolError(await c.resumeByMeta('commerce', highValue, out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
    expect(await s().mock.count('POST', '/orders')).toBe(1)
  })

  it('should_let_only_one_of_two_simultaneous_approval_answers_advance_the_execution', async () => {
    // The approved payment is slow (1.5 s) so the second answer deterministically meets the run lock.
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', programs.slowPayment(1500)))
    s().track(paused.executionId)
    const [a, b] = await Promise.all([
      c.answerApproval(paused, { action: 'accept' }, { id: 'race-a' }),
      c.answerApproval(paused, { action: 'accept' }, { id: 'race-b' })
    ])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['completed', 'tool_error'])
    const loser = (a.kind === 'tool_error' ? a : b) as Extract<typeof a, { kind: 'tool_error' }>
    expect([ERR.EXECUTION_LOCKED, ERR.EXECUTION_NOT_RESUMABLE]).toContain(loser.code)
    if (loser.code === ERR.EXECUTION_LOCKED) expect(loser.retryable).toBe(true)
    s().note('concurrentAnswerLoser', loser.code)
    expect(await s().mock.count('POST', '/payments')).toBe(1)
    const insp = await s().admin.inspect(paused.executionId)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(insp.approvals).toHaveLength(1)
    expect(insp.execution.runCount).toBe(2)
  })

  it('should_let_only_one_of_two_simultaneous_meta_resumes_run', async () => {
    const c = s().client('alice', { capabilities: {} })
    const program = programs.slowPayment(1500)
    const out = expectToolError(await c.apiExecute('commerce', program), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true })
    const [a, b] = await Promise.all([c.resumeByMeta('commerce', program, out.meta.executionId!), c.resumeByMeta('commerce', program, out.meta.executionId!)])
    expect([a.kind, b.kind].sort()).toEqual(['completed', 'tool_error'])
    const loser = (a.kind === 'tool_error' ? a : b) as Extract<typeof a, { kind: 'tool_error' }>
    expect(loser.code).toBe(ERR.EXECUTION_LOCKED)
    expect(loser.retryable).toBe(true)
    expect(await s().mock.count('POST', '/payments')).toBe(1)
  })

  it('should_stamp_a_distinct_idempotency_key_per_activity_and_never_resend_a_replayed_one', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)))
    s().track(paused.executionId)
    expectCompleted(await c.answerApproval(paused, { action: 'accept' }))
    const keys = (await s().mock.requests()).map(r => r.headers['x-idempotency-key'] as string)
    expect(keys).toHaveLength(3)
    expect(keys.map(k => k.slice(k.lastIndexOf('-') + 1))).toEqual(['1', '2', '3'])
    expect(new Set(keys.map(k => k.slice(0, k.lastIndexOf('-')))).size).toBe(1) // same execution prefix
  })

  it('should_create_a_new_execution_for_every_fresh_submission_even_with_identical_code_and_request_id', async () => {
    // Documented: api_execute is not deduplicated by JSON-RPC id or code hash — the execution id is the identity.
    const c = s().client('alice')
    const program = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal)
    const first = expectCompleted(await c.apiExecute('commerce', program, { id: 'same-id' }))
    const second = expectCompleted(await c.apiExecute('commerce', program, { id: 'same-id' }))
    s().track(first.meta.executionId); s().track(second.meta.executionId)
    expect(first.meta.executionId).not.toBe(second.meta.executionId)
    expect((await s().mock.state())['orders']).toHaveLength(2)
  })
})
