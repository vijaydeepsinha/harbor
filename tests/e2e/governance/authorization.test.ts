// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-024 principal binding · RG-025 requestState integrity · RG-028 stale
 * approvals. An approval is an authorization event bound to an identity,
 * an execution and one activity — never a generic "continue".
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectPaused, expectRpcError, expectToolError } from '../helpers/assertions.js'
import { APPROVAL_STATUS, ERR, EXECUTION_STATUS, WIRE } from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import { AMOUNTS, RESOURCES } from '../fixtures/identities.js'

describe('authorization of approvals and resumes', () => {
  const s = useScenario()
  const highValue = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)

  it('should_refuse_a_tampered_request_state_before_the_tool_runs', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', highValue))
    s().track(paused.executionId)
    const tampered = { ...paused, requestState: paused.requestState.slice(0, -4) + (paused.requestState.endsWith('AAAA') ? 'BBBB' : 'AAAA') }
    expectRpcError(await c.answerApproval(tampered, { action: 'accept' }), -32602)
    expectRpcError(await c.answerApproval({ ...paused, requestState: 'not-a-sealed-state' }, { action: 'accept' }), -32602)
    expect(await s().mock.requests()).toHaveLength(0)
    const insp = await s().admin.inspect(paused.executionId)
    expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
    expect(insp.execution.runCount).toBe(1)
  })

  it('should_refuse_an_approval_answer_from_a_different_principal_than_the_one_who_started_the_execution', async () => {
    const alice = s().client('alice'), bob = s().client('bob')
    const paused = expectPaused(await alice.apiExecute('commerce', highValue))
    s().track(paused.executionId)
    const out = expectToolError(await bob.answerApproval(paused, { action: 'accept' }), ERR.EXECUTION_NOT_RESUMABLE)
    expect(out.message).toContain('different principal')
    expect(await s().mock.requests()).toHaveLength(0)
    expect((await s().admin.inspect(paused.executionId)).approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
    // The rightful principal can still complete it.
    expectCompleted(await alice.answerApproval(paused, { action: 'accept' }))
    expect(await s().mock.count('POST', '/orders')).toBe(1)
  })

  it('should_refuse_a_meta_resume_of_another_principals_execution', async () => {
    const alice = s().client('alice', { capabilities: {} }), bob = s().client('bob', { capabilities: {} })
    const out = expectToolError(await alice.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true })
    const stolen = expectToolError(await bob.resumeByMeta('commerce', highValue, out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
    expect(stolen.message).toContain('different principal')
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_refuse_a_resume_against_a_different_service_than_the_execution_was_created_for', async () => {
    const c = s().client('alice', { capabilities: {} })
    const out = expectToolError(await c.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true })
    const wrong = expectToolError(await c.resumeByMeta('ops', programs.createAdminUser('x'), out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
    expect(wrong.message).toContain('"commerce"')
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_refuse_a_stale_request_state_from_an_earlier_activity_once_the_execution_has_moved_on', async () => {
    const c = s().client('alice')
    const p1 = expectPaused(await c.apiExecute('commerce', programs.fourStepWorkflow(RESOURCES.customerAllowed, AMOUNTS.highValue)))
    s().track(p1.executionId)
    const p2 = expectPaused(await c.answerApproval(p1, { action: 'accept' }))
    expect(await s().mock.calls()).toEqual(['GET /customers/customer-001', 'POST /orders'])
    // Replay the *first* approval's state (activity #2, already decided) while #3 waits.
    const stale = expectToolError(await c.answerApproval(p1, { action: 'accept' }), ERR.EXECUTION_NOT_RESUMABLE)
    expect(stale.message).toContain('WAITING_APPROVAL')
    expect(await s().mock.calls()).toEqual(['GET /customers/customer-001', 'POST /orders']) // nothing moved
    const insp = await s().admin.inspect(p1.executionId)
    expect(insp.approvals.map(a => [a.activitySequence, a.status])).toEqual([[2, APPROVAL_STATUS.APPROVED], [3, APPROVAL_STATUS.PENDING]])
    // The current state still works.
    expectCompleted(await c.answerApproval(p2, { action: 'accept' }))
    expect(await s().mock.count('POST', '/payments')).toBe(1)
  })

  it('should_refuse_a_replayed_request_state_after_the_execution_completed', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', highValue))
    s().track(paused.executionId)
    expectCompleted(await c.answerApproval(paused, { action: 'accept' }))
    expectToolError(await c.answerApproval(paused, { action: 'decline' }), ERR.EXECUTION_NOT_RESUMABLE)
    expect((await s().admin.inspect(paused.executionId)).execution.status).toBe(EXECUTION_STATUS.COMPLETED) // a late decline cannot flip it
    expect(await s().mock.count('POST', '/orders')).toBe(1)
  })

  it('should_refuse_to_decide_an_approval_through_a_different_executions_path', async () => {
    const c = s().client('alice', { capabilities: {} })
    const a = expectToolError(await c.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    const b = expectToolError(await c.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
    s().track(a.meta.executionId); s().track(b.meta.executionId)
    const cross = await s().admin.decide(b.meta.executionId!, a.meta.approvalId!, { action: 'accept', approve: true })
    expect(cross.status).toBe(404)
    expect((cross.body as { code: string }).code).toBe(ERR.APPROVAL_NOT_FOUND)
    expect((await s().admin.decide(a.meta.executionId!, 'ffffffff-ffff-ffff-ffff-ffffffffffff', { action: 'accept' })).status).toBe(404)
    expect((await s().admin.decide('ffffffff-ffff-ffff-ffff-ffffffffffff', a.meta.approvalId!, { action: 'accept' })).status).toBe(404)
    const insp = await s().admin.inspect(a.meta.executionId!)
    expect(insp.approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_report_unknown_or_manipulated_execution_ids_instead_of_starting_a_new_execution', async () => {
    const c = s().client('alice', { capabilities: {} })
    for (const bogus of ['does-not-exist', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '../../etc/passwd', "' OR 1=1 --", 'x'.repeat(2000)]) {
      const out = expectToolError(await c.resumeByMeta('commerce', programs.ping(), bogus), ERR.EXECUTION_NOT_FOUND)
      expect(out.meta.executionId).toBeUndefined()
    }
    expect(await s().mock.requests()).toHaveLength(0)
    expect((await s().admin.request('GET', '/executions/..%2F..%2Fetc%2Fpasswd')).status).toBe(404)
    expect((await s().admin.inspectRaw('ffffffff-ffff-ffff-ffff-ffffffffffff')).status).toBe(404)
  })

  it('should_ignore_a_non_string_execution_id_in_meta_and_start_a_fresh_execution', async () => {
    const c = s().client('alice')
    const out = expectCompleted(await c.apiExecute('commerce', programs.ping(), { meta: { [WIRE.META_EXECUTION_ID]: 12345 } }))
    s().track(out.meta.executionId)
    expect(out.meta.executionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('should_not_honour_a_request_state_on_a_method_it_was_not_minted_for', async () => {
    const c = s().client('alice')
    const paused = expectPaused(await c.apiExecute('commerce', highValue))
    s().track(paused.executionId)
    const res = await c.rpc('tools/list', { requestState: paused.requestState })
    // Either the seam refuses it (-32602: bound to tools/call) or it is ignored; it must never decide the approval.
    s().note('requestStateOnToolsList', res.error ?? 'accepted-and-ignored')
    if (res.error) expect(res.error.code).toBe(-32602)
    expect((await s().admin.inspect(paused.executionId)).approvals[0]!.status).toBe(APPROVAL_STATUS.PENDING)
    expect(await s().mock.requests()).toHaveLength(0)
  })

  describe('known gaps pinned as documented in docs/code-mode-governance.md §14 (flip these when the approver model lands)', () => {
    it('known_gap_any_valid_bearer_can_inspect_and_decide_another_principals_execution_over_http', async () => {
      const alice = s().client('alice', { capabilities: {} })
      const out = expectToolError(await alice.apiExecute('commerce', highValue), ERR.APPROVAL_REQUIRED)
      s().track(out.meta.executionId)
      const bobAdmin = s().adminAs('bob')
      expect((await bobAdmin.inspectRaw(out.meta.executionId!)).status).toBe(200)
      const decided = await bobAdmin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true })
      expect(decided.status).toBe(200)
      // The *resume* is still bound to alice — bob cannot run it.
      expectToolError(await s().client('bob', { capabilities: {} }).resumeByMeta('commerce', highValue, out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
      expect(await s().mock.requests()).toHaveLength(0)
    })
  })
})
