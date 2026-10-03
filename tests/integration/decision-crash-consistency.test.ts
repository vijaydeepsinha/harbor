// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Crash consistency of a human decision (the owner's PR #7 review: the lock
 * prevents concurrent decisions but does not make their writes crash-atomic).
 * A decision is three writes — the approval, its activity, and for a
 * rejection or cancellation the execution — and no store offers a
 * transaction across them. The approval write is the commit point: each test
 * cuts the decision after one of the writes (a store outage, or a crash at
 * that point) and checks that the next decide or resume completes it rather
 * than leaving the execution stuck.
 */
import { describe, it, expect } from 'vitest'
import type { ActivityRecord, ApprovalRecord, ExecutionRecord } from '../../src/core/types/execution.types.js'
import { ApprovalAlreadyDecidedError } from '../../src/core/types/execution.types.js'
import { makeConnector, makeResources, makeRuntime, registerGoverned, makeCtx, retryCtx, parseContent } from '../unit/code-mode-harness.js'
import { faultyStore, StoreDownError } from '../unit/faulty-store.js'
import {
  ERR, ACTIVITY_STATUS, APPROVAL_STATUS, EXECUTION_STATUS, GOVERNANCE_DECISION, EXECUTION_STATUS_META_KEY
} from '../../src/core/constants.js'

const FINALIZE_NEEDS_APPROVAL = { name: 'finalize-needs-approval', match: { operation: 'finalizeCampaign' }, action: { type: 'REQUIRE_APPROVAL', reason: 'r' } }
const PROGRAM = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const r = await api.request({ method: 'POST', path: '/campaigns/' + campaigns.data[0].id + '/finalize' })
  return { did: r.data.did }
}`

/** A paused execution (HTTP-fallback client) on a store whose writes the test can fail. */
async function paused() {
  const store = faultyStore()
  const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL], GOVERNANCE_DECISION.ALLOW, store.persistence)
  const { connector, count } = makeConnector()
  const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
  const pause = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx({ elicitation: false }))
  const { executionId, approvalId } = parseContent(pause) as { executionId: string; approvalId: string }
  const stored = async () => ({
    approval: (await store.inner.getApproval(approvalId))!.status,
    activity: (await store.inner.getActivity(executionId, 2))!.status,
    execution: (await store.inner.getExecution(executionId))!.status
  })
  const resume = () => handler({ service: 'trafficking', code: PROGRAM }, makeCtx({ elicitation: false, executionIdMeta: executionId }))
  return { store, governanceRuntime, handler, count, executionId, approvalId, stored, resume }
}

const isApproval = (status: string) => (a: unknown) => (a as ApprovalRecord).status === status
const isActivity = (status: string) => (a: unknown) => (a as ActivityRecord).status === status
const isExecution = (status: string) => (e: unknown) => (e as ExecutionRecord).status === status

describe('a decision cut short between its writes', () => {
  it('nothing written (the approval write failed): nothing changed, and the decision can simply be made again', async () => {
    const p = await paused()
    p.store.fail({ method: 'putApproval', when: isApproval(APPROVAL_STATUS.APPROVED) })
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'accept', approve: true, via: 'http', executionId: p.executionId }))
      .rejects.toBeInstanceOf(StoreDownError)
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.PENDING, activity: ACTIVITY_STATUS.WAITING_APPROVAL, execution: EXECUTION_STATUS.WAITING_APPROVAL })
    await p.governanceRuntime.approvals.decide(p.approvalId, { action: 'accept', approve: true, via: 'http', executionId: p.executionId })
    expect(parseContent(await p.resume())).toEqual({ did: 'POST /campaigns/C1/finalize' })
  })

  it('approved, activity not yet: the resume runs the approved call once — it used to pause on the old question forever', async () => {
    const p = await paused()
    p.store.fail({ method: 'putActivity', when: isActivity(ACTIVITY_STATUS.APPROVED) })
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'accept', approve: true, via: 'http', executionId: p.executionId }))
      .rejects.toBeInstanceOf(StoreDownError)
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.APPROVED, activity: ACTIVITY_STATUS.WAITING_APPROVAL, execution: EXECUTION_STATUS.WAITING_APPROVAL })

    const done = await p.resume()
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ did: 'POST /campaigns/C1/finalize' })
    expect(p.count('POST', '/campaigns/C1/finalize')).toBe(1)
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.APPROVED, activity: ACTIVITY_STATUS.COMPLETED, execution: EXECUTION_STATUS.COMPLETED })
  })

  it('approved, activity not yet: deciding again is refused as already decided, and completes the activity', async () => {
    const p = await paused()
    p.store.fail({ method: 'putActivity', when: isActivity(ACTIVITY_STATUS.APPROVED) })
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'accept', approve: true, via: 'http', executionId: p.executionId })).rejects.toThrow()
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'accept', approve: true, via: 'http', executionId: p.executionId }))
      .rejects.toBeInstanceOf(ApprovalAlreadyDecidedError)
    expect((await p.stored()).activity).toBe(ACTIVITY_STATUS.APPROVED)
  })

  it('rejected, activity and execution not yet: the resume ends the execution DENIED and runs nothing', async () => {
    const p = await paused()
    p.store.fail({ method: 'putActivity', when: isActivity(ACTIVITY_STATUS.DENIED) })
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'decline', via: 'http', executionId: p.executionId })).rejects.toThrow()
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.REJECTED, activity: ACTIVITY_STATUS.WAITING_APPROVAL, execution: EXECUTION_STATUS.WAITING_APPROVAL })

    const r = await p.resume()
    expect(parseContent(r)).toMatchObject({ code: ERR.EXECUTION_NOT_RESUMABLE })
    expect((r['_meta'] as Record<string, string>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.DENIED)
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.REJECTED, activity: ACTIVITY_STATUS.DENIED, execution: EXECUTION_STATUS.DENIED })
    expect(p.count('POST', '/campaigns/C1/finalize')).toBe(0)
    expect(p.count('GET', '/campaigns')).toBe(1) // nothing ran on the resume either
  })

  it('cancelled, execution not yet: deciding again completes it — no run is needed to end the execution', async () => {
    const p = await paused()
    p.store.fail({ method: 'updateExecution', when: isExecution(EXECUTION_STATUS.CANCELLED) })
    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'cancel', via: 'http', executionId: p.executionId })).rejects.toThrow()
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.CANCELLED, activity: ACTIVITY_STATUS.CANCELLED, execution: EXECUTION_STATUS.WAITING_APPROVAL })

    await expect(p.governanceRuntime.approvals.decide(p.approvalId, { action: 'cancel', via: 'http', executionId: p.executionId }))
      .rejects.toBeInstanceOf(ApprovalAlreadyDecidedError)
    expect(await p.stored()).toEqual({ approval: APPROVAL_STATUS.CANCELLED, activity: ACTIVITY_STATUS.CANCELLED, execution: EXECUTION_STATUS.CANCELLED })
  })

  it('over MCP: the client retries the same answer after the failed one, and the approved call runs once', async () => {
    const store = faultyStore()
    const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL], GOVERNANCE_DECISION.ALLOW, store.persistence)
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const pause = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx())
    expect(pause['resultType']).toBe('input_required')

    store.fail({ method: 'putActivity', when: isActivity(ACTIVITY_STATUS.APPROVED) })
    const failed = await handler({ service: 'trafficking', code: PROGRAM }, await retryCtx(governanceRuntime, pause, { action: 'accept', approve: true }))
    expect(failed['isError']).toBe(true)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

    const retried = await handler({ service: 'trafficking', code: PROGRAM }, await retryCtx(governanceRuntime, pause, { action: 'accept', approve: true }, '3'))
    expect(retried['isError']).toBeUndefined()
    expect(parseContent(retried)).toEqual({ did: 'POST /campaigns/C1/finalize' })
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
  })
})
