// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach } from 'vitest'
import { ApprovalService } from '../../runtime/execution/approval-service.js'
import { ExecutionManager } from '../../runtime/execution/execution-manager.js'
import { ActivityJournal } from '../../runtime/execution/activity-journal.js'
import { InMemoryCodeModeStore } from '../../adapters/execution/in-memory-execution-store.js'
import { APPROVAL_STATUS, ACTIVITY_STATUS, EXECUTION_STATUS, ERR } from '../../core/constants.js'
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  ExecutionLockedError,
  type ApprovalSummary
} from '../../core/types/execution.types.js'

const summary: ApprovalSummary = {
  service: 'trafficking', method: 'POST', specPath: '/campaigns/{id}/activate', operationId: 'activateCampaign',
  pathParams: { id: 'C1' }, body: { action: 'activate', budget: 1_500_000 },
  reason: 'Campaign budget exceeds the approval threshold', matchedRules: ['high-budget-campaign']
}

describe('ApprovalService', () => {
  let store: InMemoryCodeModeStore
  let manager: ExecutionManager
  let service: ApprovalService
  let executionId: string
  let n = 0

  beforeEach(async () => {
    store = new InMemoryCodeModeStore()
    manager = new ExecutionManager(store)
    service = new ApprovalService(store, manager, undefined, () => `ap-${++n}`)
    const exec = await manager.create({ service: 'trafficking', code: 'c', userIdHash: 'h' })
    executionId = exec.executionId
    await manager.beginRun(executionId)
    const journal = new ActivityJournal(store, executionId, 'trafficking', 1)
    await journal.next({ method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' })
  })

  async function pauseOnApproval() {
    const approval = await service.request(executionId, 1, summary)
    const journal = new ActivityJournal(store, executionId, 'trafficking', 1)
    await journal.recordWaitingApproval(1, { method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' }, approval.approvalId)
    await manager.endRun(executionId, { kind: 'waitingApproval', approvalId: approval.approvalId })
    return approval
  }

  it('request() creates a PENDING approval bound to one activity', async () => {
    const approval = await pauseOnApproval()
    expect(approval).toMatchObject({ approvalId: 'ap-1', executionId, activitySequence: 1, status: APPROVAL_STATUS.PENDING })
    expect((await manager.load(executionId)).pendingApprovalId).toBe('ap-1')
    await expect(service.get('nope')).rejects.toBeInstanceOf(ApprovalNotFoundError)
  })

  it('accept approves: activity becomes APPROVED and the execution is resumable', async () => {
    const { approvalId } = await pauseOnApproval()
    const { outcome, approval } = await service.decide(approvalId, { action: 'accept', approve: true, comment: 'go', via: 'mcp-elicitation', executionId })
    expect(outcome).toBe('APPROVED')
    expect(approval).toMatchObject({ status: APPROVAL_STATUS.APPROVED, comment: 'go', decidedVia: 'mcp-elicitation' })
    expect(approval.decidedAt).toBeDefined()
    expect((await store.getActivity(executionId, 1))?.status).toBe(ACTIVITY_STATUS.APPROVED)
    expect((await manager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    const resumed = await manager.beginRun(executionId)
    expect(resumed.status).toBe(EXECUTION_STATUS.RUNNING)
  })

  it('accept with approve=false and decline both reject: activity DENIED, execution DENIED', async () => {
    for (const input of [{ action: 'accept', approve: false }, { action: 'decline' }] as const) {
      store = new InMemoryCodeModeStore(); manager = new ExecutionManager(store)
      service = new ApprovalService(store, manager, undefined, () => `ap-${++n}`)
      const exec = await manager.create({ service: 'trafficking', code: 'c', userIdHash: 'h' })
      executionId = exec.executionId
      await manager.beginRun(executionId)
      await new ActivityJournal(store, executionId, 'trafficking', 1).next({ method: 'POST', rawPath: '/x', specPath: '/x' })
      const { approvalId } = await pauseOnApproval()
      const { outcome } = await service.decide(approvalId, { ...input, via: 'http', executionId })
      expect(outcome).toBe('REJECTED')
      expect((await store.getActivity(executionId, 1))?.status).toBe(ACTIVITY_STATUS.DENIED)
      const exec2 = await manager.load(executionId)
      expect(exec2.status).toBe(EXECUTION_STATUS.DENIED)
      expect(exec2.terminalReason?.code).toBe(ERR.GOVERNANCE_DENIED)
      await expect(manager.beginRun(executionId)).rejects.toThrow(/cannot be resumed/)
    }
  })

  it('cancel cancels: activity CANCELLED, execution CANCELLED', async () => {
    const { approvalId } = await pauseOnApproval()
    const { outcome } = await service.decide(approvalId, { action: 'cancel', via: 'mcp-elicitation', executionId })
    expect(outcome).toBe('CANCELLED')
    expect((await store.getActivity(executionId, 1))?.status).toBe(ACTIVITY_STATUS.CANCELLED)
    expect((await manager.load(executionId))).toMatchObject({ status: EXECUTION_STATUS.CANCELLED, terminalReason: { code: ERR.EXECUTION_CANCELLED } })
  })

  it('an approval is decided exactly once', async () => {
    const { approvalId } = await pauseOnApproval()
    await service.decide(approvalId, { action: 'accept', via: 'http', executionId })
    await expect(service.decide(approvalId, { action: 'decline', via: 'http', executionId })).rejects.toBeInstanceOf(ApprovalAlreadyDecidedError)
    expect((await store.getActivity(executionId, 1))?.status).toBe(ACTIVITY_STATUS.APPROVED)
  })

  it('serializes concurrent opposite decisions and leaves records consistent with the winner', async () => {
    const { approvalId } = await pauseOnApproval()
    const results = await Promise.allSettled([
      service.decide(approvalId, { action: 'accept', via: 'http', executionId }),
      service.decide(approvalId, { action: 'decline', via: 'http', executionId })
    ])
    const winners = results.filter((result) => result.status === 'fulfilled')
    const losers = results.filter((result) => result.status === 'rejected')

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({
      status: 'rejected',
      reason: expect.any(ExecutionLockedError)
    })

    const winner = winners[0]
    if (!winner || winner.status !== 'fulfilled') throw new Error('Expected one successful decision')
    const expectedStatus = winner.value.outcome === 'APPROVED' ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED
    const expectedActivityStatus = winner.value.outcome === 'APPROVED' ? ACTIVITY_STATUS.APPROVED : ACTIVITY_STATUS.DENIED
    const expectedExecutionStatus = winner.value.outcome === 'APPROVED' ? EXECUTION_STATUS.WAITING_APPROVAL : EXECUTION_STATUS.DENIED

    expect((await service.get(approvalId)).status).toBe(expectedStatus)
    expect((await store.getActivity(executionId, 1))?.status).toBe(expectedActivityStatus)
    expect((await manager.load(executionId)).status).toBe(expectedExecutionStatus)
    expect(await store.acquireLock(executionId)).toBe(true)
    await store.releaseLock(executionId)
    await expect(service.decide(approvalId, { action: 'cancel', via: 'http', executionId })).rejects.toBeInstanceOf(ApprovalAlreadyDecidedError)
  })

  it('refuses a decision whose executionId does not own the approval — before any mutation', async () => {
    const { approvalId } = await pauseOnApproval()
    const other = await manager.create({ service: 'trafficking', code: 'c', userIdHash: 'other-hash' })

    await expect(
      service.decide(approvalId, { action: 'accept', via: 'http', executionId: other.executionId })
    ).rejects.toBeInstanceOf(ApprovalNotFoundError)

    // Nothing moved: the approval, its activity and its execution are untouched.
    expect((await service.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
    expect((await store.getActivity(executionId, 1))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect((await manager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    // The lock was never taken, so the rightful owner can still decide.
    expect(await store.acquireLock(executionId)).toBe(true)
    await store.releaseLock(executionId)
    expect((await service.decide(approvalId, { action: 'accept', via: 'http', executionId })).outcome).toBe('APPROVED')
  })

  it('builds an elicitation that explains what/where/values/why without secrets', async () => {
    const approval = await pauseOnApproval()
    const e = service.buildElicitation(approval)
    expect(e.message).toContain('Service:   trafficking')
    expect(e.message).toContain('activateCampaign — POST /campaigns/{id}/activate')
    expect(e.message).toContain('"budget":1500000')
    expect(e.message).toContain('{"id":"C1"}')
    expect(e.message).toContain('high-budget-campaign')
    expect(e.message).not.toMatch(/authorization|bearer|token/i)
    expect(e.requestedSchema.required).toEqual(['approve'])
    expect(e.requestedSchema.properties['approve']?.type).toBe('boolean')
    expect(e.requestedSchema.properties['comment']?.type).toBe('string')
  })

  it('caps very large bodies in the prompt', async () => {
    const big = await service.request(executionId, 1, { ...summary, body: { blob: 'x'.repeat(5000) } })
    const e = service.buildElicitation(big)
    expect(e.message.length).toBeLessThan(1500)
    expect(e.message).toContain('more chars')
  })
})
