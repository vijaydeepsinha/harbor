// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-012 decision persistence · RG-020 inspection + history. Audit is
 * asserted semantically through GET /executions/{id}, never through log
 * formatting.
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectPaused, expectToolError } from '../helpers/assertions.js'
import { DECISION, ERR, EXECUTION_STATUS } from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import { AMOUNTS, IDENTITIES, RESOURCES } from '../fixtures/identities.js'

const RULE_TAG = /^[a-z0-9-]+@[^#]+#[0-9a-f]{12}$/

describe('audit trail', () => {
  const s = useScenario()

  it('should_record_every_decision_with_rule_identity_version_hash_reason_and_time', async () => {
    const c = s().client('alice')
    const done = expectCompleted(await c.apiExecute('commerce', programs.createThenUpdateOrder(RESOURCES.customerAllowed, AMOUNTS.normal, { status: 'shipped' })))
    s().track(done.meta.executionId)
    const { decisions } = await s().admin.inspect(done.meta.executionId!)
    expect(decisions).toHaveLength(2)
    // #1 createOrder: nothing matched → default, with the reason code and no rule identity.
    expect(decisions[0]).toMatchObject({ activitySequence: 1, decision: DECISION.ALLOW, reason: 'NO_MATCHING_RULE', matchedRules: [], ruleVersions: [] })
    // #2 updateOrder: allow-update-order has no reason text → the generic RULE_MATCHED reason names the rule.
    expect(decisions[1]).toMatchObject({ activitySequence: 2, decision: DECISION.ALLOW, reason: 'RULE_MATCHED: allow-update-order', matchedRules: ['allow-update-order'], decidingRule: 'allow-update-order' })
    expect(decisions[1]!.ruleVersions).toEqual([expect.stringMatching(RULE_TAG)])
    for (const d of decisions) expect(Number.isNaN(Date.parse(d.evaluatedAt))).toBe(false)
  })

  it('should_stamp_the_same_rule_hash_on_every_execution_evaluated_under_the_same_rule_file', async () => {
    const c = s().client('alice')
    const a = expectPaused(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)))
    const b = expectPaused(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.veryHigh)))
    s().track(a.executionId); s().track(b.executionId)
    const [ia, ib] = await Promise.all([s().admin.inspect(a.executionId), s().admin.inspect(b.executionId)])
    expect(ia.decisions[0]!.ruleVersions).toEqual(ib.decisions[0]!.ruleVersions)
    expect(ia.decisions[0]!.ruleVersions[0]).toMatch(/^high-value-order-requires-approval@3#/)
  })

  it('should_record_who_decided_when_and_with_what_comment_on_each_approval', async () => {
    const c = s().client('alice', { capabilities: {} })
    const out = expectToolError(await c.apiExecute('commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)), ERR.APPROVAL_REQUIRED)
    s().track(out.meta.executionId)
    await s().admin.decide(out.meta.executionId!, out.meta.approvalId!, { action: 'accept', approve: true, comment: 'reviewed by finance' })
    const { approvals } = await s().admin.inspect(out.meta.executionId!)
    expect(approvals[0]).toMatchObject({ status: 'APPROVED', decidedVia: 'http', comment: 'reviewed by finance', activitySequence: 1 })
    expect(Date.parse(approvals[0]!.decidedAt!)).toBeGreaterThanOrEqual(Date.parse(approvals[0]!.createdAt))
    expect(approvals[0]!.summary).toMatchObject({ reason: 'Order amount exceeds the approval threshold', matchedRules: ['high-value-order-requires-approval'] })
  })

  it('should_derive_a_chronological_history_that_tells_the_whole_story_without_logs', async () => {
    const c = s().client('alice')
    const p1 = expectPaused(await c.apiExecute('commerce', programs.fourStepWorkflow(RESOURCES.customerAllowed, AMOUNTS.highValue)))
    s().track(p1.executionId)
    const p2 = expectPaused(await c.answerApproval(p1, { action: 'accept' }))
    expectCompleted(await c.answerApproval(p2, { action: 'accept' }))
    const { history } = await s().admin.inspect(p1.executionId)
    const times = history.map(h => h.at)
    expect([...times].sort()).toEqual(times) // chronological
    const events = history.map(h => `${h.kind}:${h.event}${h.sequence ? '#' + h.sequence : ''}`)
    expect(events[0]).toBe('EXECUTION:CREATED')
    expect(events[events.length - 1]).toBe('EXECUTION:COMPLETED')
    const before = (a: string, b: string) => {
      const ia = events.indexOf(a), ib = events.indexOf(b)
      expect(ia, `${a} missing in ${events.join(' > ')}`).toBeGreaterThanOrEqual(0)
      expect(ib, `${b} missing in ${events.join(' > ')}`).toBeGreaterThanOrEqual(0)
      expect(ia, `${a} should precede ${b} in ${events.join(' > ')}`).toBeLessThan(ib)
    }
    // Per activity: the governance decision is timestamped *before* the activity is journaled (governance before
    // side effect), so both precede COMPLETED; approvals are requested, then decided, then the activity completes.
    before('GOVERNANCE:ALLOW#1', 'ACTIVITY:COMPLETED#1')
    before('ACTIVITY:ENCOUNTERED#1', 'ACTIVITY:COMPLETED#1')
    before('ACTIVITY:COMPLETED#1', 'GOVERNANCE:REQUIRE_APPROVAL#2')
    before('GOVERNANCE:REQUIRE_APPROVAL#2', 'APPROVAL:REQUESTED#2')
    before('APPROVAL:REQUESTED#2', 'APPROVAL:APPROVED#2')
    before('APPROVAL:APPROVED#2', 'ACTIVITY:COMPLETED#2')
    before('ACTIVITY:COMPLETED#2', 'GOVERNANCE:REQUIRE_APPROVAL#3')
    before('GOVERNANCE:REQUIRE_APPROVAL#3', 'APPROVAL:REQUESTED#3')
    before('APPROVAL:REQUESTED#3', 'APPROVAL:APPROVED#3')
    before('APPROVAL:APPROVED#3', 'ACTIVITY:COMPLETED#3')
    before('ACTIVITY:COMPLETED#3', 'GOVERNANCE:ALLOW#4')
    before('GOVERNANCE:ALLOW#4', 'ACTIVITY:COMPLETED#4')
    before('ACTIVITY:COMPLETED#4', 'EXECUTION:COMPLETED')
    const approvalLine = history.find(h => h.kind === 'GOVERNANCE' && h.sequence === 2)!
    expect(approvalLine.detail).toContain('high-value-order-requires-approval')
    const decided = history.find(h => h.kind === 'APPROVAL' && h.event === 'APPROVED' && h.sequence === 2)!
    expect(decided.detail).toBe('mcp-elicitation')
  })

  it('should_keep_a_terminal_reason_on_failed_and_denied_executions_and_the_result_on_completed_ones', async () => {
    const c = s().client('alice')
    const denied = expectToolError(await c.apiExecute('commerce', programs.readCustomer(RESOURCES.customerRestricted)), ERR.GOVERNANCE_DENIED)
    const failed = expectToolError(await c.apiExecute('commerce', programs.syntaxError()), ERR.SANDBOX_SYNTAX)
    const done = expectCompleted(await c.apiExecute('commerce', programs.ping()))
    for (const id of [denied.meta.executionId, failed.meta.executionId, done.meta.executionId]) s().track(id)
    const [d, f, ok] = await Promise.all([denied.meta.executionId, failed.meta.executionId, done.meta.executionId].map(id => s().admin.inspect(id!)))
    expect(d!.execution.terminalReason).toMatchObject({ code: ERR.GOVERNANCE_DENIED })
    expect(d!.execution.terminalReason!.message).toContain('customer-002 is a restricted record')
    expect(f!.execution).toMatchObject({ status: EXECUTION_STATUS.FAILED, terminalReason: { code: ERR.SANDBOX_SYNTAX } })
    expect(ok!.execution.result).toEqual(done.value)
    expect(ok!.execution).not.toHaveProperty('terminalReason')
    for (const insp of [d, f, ok]) expect(JSON.stringify(insp)).not.toContain(IDENTITIES.alice)
  })

  it('should_answer_404_for_an_unknown_execution_and_405_for_an_unsupported_method', async () => {
    const missing = await s().admin.inspectRaw('ffffffff-ffff-ffff-ffff-ffffffffffff')
    expect(missing.status).toBe(404)
    expect((missing.body as { code: string }).code).toBe(ERR.EXECUTION_NOT_FOUND)
    const done = expectCompleted(await s().client('alice').apiExecute('commerce', programs.ping()))
    s().track(done.meta.executionId)
    expect((await s().admin.request('DELETE', `/executions/${done.meta.executionId}`)).status).toBe(405)
  })
})
