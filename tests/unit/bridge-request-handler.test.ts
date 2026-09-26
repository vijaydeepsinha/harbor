// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { BridgeRequestHandler } from '../../runtime/sandbox/bridge-request-handler.js'
import type { SandboxExecutionContext } from '../../runtime/sandbox/execute-api-in-sandbox.js'
import { ActivityJournal, CallLog } from '../../runtime/execution/activity-journal.js'
import { InMemoryCodeModeStore } from '../../adapters/execution/in-memory-execution-store.js'
import { resolveOperation } from '../../runtime/governance/operation-resolver.js'
import { AuditCollector } from '../../runtime/observability/audit.js'
import { ProgressCollector } from '../../runtime/observability/progress.js'
import { noopCircuitBreaker } from '../../spi/resilience/strategies/noop-circuit-breaker.strategy.js'
import { forwardTokenPermissionGuard } from '../../spi/permissions/strategies/forward-token-permission-guard.strategy.js'
import { ERR, ACTIVITY_STATUS } from '../../core/constants.js'
import { SandboxCallLimitError, SandboxInvalidApiRequestError } from '../../core/types/sandbox-error.types.js'
import { ApprovalRequiredError } from '../../core/types/execution.types.js'
import { makeConnector, campaignSpec } from './code-mode-harness.js'

function makeCtx(overrides: Partial<SandboxExecutionContext> = {}) {
  const { connector, calls } = makeConnector()
  const ctx: SandboxExecutionContext = {
    tokenPayload: { access_token: 't', token_type: 'bearer', expires_in: 60, refresh_token: '', scope: '' },
    invalidate: async () => {},
    apiClient: connector,
    circuitBreaker: noopCircuitBreaker(),
    permissionGuard: forwardTokenPermissionGuard(),
    idempotencyKey: 'idem', idempotencyKeyTtlMs: 1000, correlationId: 'c', sessionId: 's',
    callLog: new CallLog(),
    limits: { memoryLimitMb: 64, executeTimeoutMs: 1000, searchTimeoutMs: 1000, maxApiCalls: 2, maxConcurrentCalls: 2 },
    ...overrides
  }
  return { ctx, calls }
}
const call = (req: Record<string, unknown>) => JSON.stringify(req)
const parse = (reply: string) => JSON.parse(reply) as Record<string, unknown>

describe('BridgeRequestHandler — the per-run api.request pipeline, callable without an isolate', () => {
  it('executes a call and records it once, in the call log that audit and progress project (legacy path)', async () => {
    const { ctx, calls } = makeCtx()
    const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
    const reply = parse(await handler.handle(call({ method: 'POST', path: '/campaigns/42', body: { a: 1 } })))
    expect(reply).toMatchObject({ status: 201, ok: true })
    expect(calls[0]?.ctx.idempotencyKey).toBe('idem') // no sequence suffix outside an execution
    expect(ctx.callLog?.entries()).toHaveLength(1)
    expect(new AuditCollector(ctx.callLog!).getEndpoints()).toEqual(['POST /campaigns/{id}'])
    expect(new ProgressCollector(ctx.callLog!, 10).summary().calls[0]).toMatchObject({ method: 'POST', endpoint: '/campaigns/{id}', status: 201 })
    expect(() => handler.throwIfViolated()).not.toThrow()
  })

  it('refuses over-budget and malformed calls and promotes them afterwards', async () => {
    const { ctx } = makeCtx()
    const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
    expect(parse(await handler.handle(call({ path: '/x' }))).code).toBe(ERR.INVALID_API_REQUEST)
    expect(() => handler.throwIfViolated()).toThrow(SandboxInvalidApiRequestError)
    await handler.handle(call({ method: 'GET', path: '/campaigns' }))
    expect(parse(await handler.handle(call({ method: 'GET', path: '/campaigns' }))).code).toBe(ERR.CALL_LIMIT_EXCEEDED)
    expect(() => handler.throwIfViolated()).toThrow(SandboxCallLimitError)
  })

  it('a governed stop refuses every later call in the run without executing it', async () => {
    const store = new InMemoryCodeModeStore()
    const { ctx, calls } = makeCtx({
      executionBridge: {
        journal: new ActivityJournal(store, 'exec-1', 'trafficking', 1),
        resolve: (m, p) => resolveOperation(campaignSpec, m, p),
        decide: async () => ({ decision: 'REQUIRE_APPROVAL', approvalId: 'ap-1', summary: { service: 'trafficking', method: 'POST', specPath: '/campaigns/{id}/finalize', reason: 'r', matchedRules: [] } })
      }
    })
    const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
    expect(parse(await handler.handle(call({ method: 'POST', path: '/campaigns/C1/finalize' }))).code).toBe(ERR.APPROVAL_REQUIRED)
    const after = parse(await handler.handle(call({ method: 'GET', path: '/campaigns' })))
    expect(after.message).toContain('Execution is paused or stopped')
    expect(calls).toHaveLength(0)
    expect((await store.getActivity('exec-1', 1))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(() => handler.throwIfViolated()).toThrow(ApprovalRequiredError)
  })
})
