// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { BridgeRequestHandler } from '../../src/runtime/sandbox/bridge-request-handler.js'
import type { SandboxExecutionContext } from '../../src/runtime/sandbox/execute-api-in-sandbox.js'
import { ActivityJournal, CallLog } from '../../src/runtime/execution/activity-journal.js'
import { InMemoryExecutionStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { resolveOperation } from '../../src/runtime/governance/operation-resolver.js'
import { AuditCollector } from '../../src/runtime/observability/audit.js'
import { ProgressCollector } from '../../src/runtime/observability/progress.js'
import { noopCircuitBreaker } from '../../src/adapters/resilience/strategies/noop-circuit-breaker.strategy.js'
import { forwardTokenPermissionGuard } from '../../src/adapters/permissions/strategies/forward-token-permission-guard.strategy.js'
import { ERR, ACTIVITY_STATUS } from '../../src/core/constants.js'
import { SandboxCallLimitError, SandboxInvalidApiRequestError } from '../../src/core/types/sandbox-error.types.js'
import { ApprovalRequiredError, GovernanceDeniedError } from '../../src/core/types/execution.types.js'
import { makeConnector, campaignSpec } from './code-mode-harness.js'

function makeCtx(overrides: Partial<SandboxExecutionContext> = {}) {
  const { connector, calls } = makeConnector()
  const ctx: SandboxExecutionContext = {
    tokenPayload: { access_token: 't', token_type: 'bearer', expires_in: 60, refresh_token: '', scope: '' },
    invalidate: async () => {},
    apiClient: connector,
    circuitBreaker: noopCircuitBreaker(),
    permissionGuard: forwardTokenPermissionGuard(),
    idempotencyKey: 'idem', idempotencyKeyTtlMs: 1000, correlationId: 'c',
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
    expect(calls[0]?.ctx.idempotencyKey).toBe('idem-c1') // arrival index outside an execution (no sequence)
    expect(calls[0]?.ctx).not.toHaveProperty('clientId')
    expect(ctx.callLog?.entries()).toHaveLength(1)
    expect(new AuditCollector(ctx.callLog!).getEndpoints()).toEqual(['POST /campaigns/{id}'])
    expect(new ProgressCollector(ctx.callLog!, 10).summary().calls[0]).toMatchObject({ method: 'POST', endpoint: '/campaigns/{id}', status: 201 })
    expect(() => handler.throwIfViolated()).not.toThrow()
  })

  it('gives every call of a legacy run its own idempotency key, stable for an identical rerun', async () => {
    const keys = async () => {
      const { ctx, calls } = makeCtx({ limits: { memoryLimitMb: 64, executeTimeoutMs: 1000, searchTimeoutMs: 1000, maxApiCalls: 5, maxConcurrentCalls: 2 } })
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      await handler.handle(call({ method: 'GET', path: '/campaigns' }))
      await handler.handle(call({ method: 'POST', path: '/campaigns', body: { name: 'x' } }))
      return calls.map(c => c.ctx.idempotencyKey)
    }
    const first = await keys()
    expect(first).toEqual(['idem-c1', 'idem-c2'])
    expect(await keys()).toEqual(first)
  })

  it('passes the caller\'s client id through to the connector', async () => {
    const { ctx, calls } = makeCtx({ clientId: 'agent-7', correlationId: 'exec-1' })
    await new BridgeRequestHandler(ctx, new AbortController().signal).handle(call({ method: 'GET', path: '/campaigns' }))
    expect(calls[0]?.ctx).toMatchObject({ clientId: 'agent-7', correlationId: 'exec-1' })
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
    const persistence = new InMemoryExecutionStore()
    const { ctx, calls } = makeCtx({
      executionBridge: {
        journal: new ActivityJournal(persistence, 'exec-1', 'trafficking', 1),
        resolve: (m, p) => resolveOperation(campaignSpec, m, p),
        decide: async () => ({ decision: 'REQUIRE_APPROVAL', approvalId: 'ap-1', summary: { service: 'trafficking', method: 'POST', specPath: '/campaigns/{id}/finalize', reason: 'r', matchedRules: [] } })
      }
    })
    const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
    expect(parse(await handler.handle(call({ method: 'POST', path: '/campaigns/C1/finalize' }))).code).toBe(ERR.APPROVAL_REQUIRED)
    const after = parse(await handler.handle(call({ method: 'GET', path: '/campaigns' })))
    expect(after.message).toContain('Execution is paused or stopped')
    expect(calls).toHaveLength(0)
    expect((await persistence.getActivity('exec-1', 1))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(() => handler.throwIfViolated()).toThrow(ApprovalRequiredError)
  })

  describe('one path for governance, journal and wire', () => {
    function governed(decide: (req: { specPath: string; operationId?: string; query?: Record<string, unknown> }) => 'ALLOW' | 'DENY') {
      const persistence = new InMemoryExecutionStore()
      const seen: Array<{ specPath: string; operationId?: string; query?: Record<string, unknown> }> = []
      const { ctx, calls } = makeCtx({
        limits: { memoryLimitMb: 64, executeTimeoutMs: 1000, searchTimeoutMs: 1000, maxApiCalls: 10, maxConcurrentCalls: 2 },
        executionBridge: {
          journal: new ActivityJournal(persistence, 'exec-1', 'trafficking', 1),
          resolve: (m, p) => resolveOperation(campaignSpec, m, p),
          decide: async (_seq, req) => {
            seen.push(req)
            return decide(req) === 'DENY' ? { decision: 'DENY', reason: 'no', matchedRules: ['r'] } : { decision: 'ALLOW' }
          }
        }
      })
      return { persistence, seen, ctx, calls, handler: new BridgeRequestHandler(ctx, new AbortController().signal) }
    }
    const denyFinalize = (req: { operationId?: string }) => req.operationId === 'finalizeCampaign' ? 'DENY' : 'ALLOW'

    it.each(['/campaigns/C1/finalize', '/campaigns/C1/%66inalize', '/Campaigns/C1/finalize', 'campaigns/C1/finalize/'])(
      'an equivalent spelling (%s) reaches the same operation and the same DENY', async path => {
        const { handler, calls, seen } = governed(denyFinalize)
        expect(parse(await handler.handle(call({ method: 'POST', path }))).code).toBe(ERR.GOVERNANCE_DENIED)
        expect(seen[0]?.operationId).toBe('finalizeCampaign')
        expect(calls).toHaveLength(0)
      })

    it.each(['/campaigns/C1/./finalize', '/campaigns/x/../C1/finalize', '/campaigns/%2e%2e/C1/finalize', 'http://elsewhere.example/campaigns/C1/finalize', '//elsewhere.example/x', '/campaigns/C1%2Ffinalize'])(
      'an aliasing spelling (%s) is refused before governance and never sent', async path => {
        const { handler, calls, seen, persistence } = governed(denyFinalize)
        const reply = parse(await handler.handle(call({ method: 'POST', path })))
        expect(reply.code).toBe(ERR.INVALID_API_REQUEST)
        expect(seen).toHaveLength(0)
        expect(calls).toHaveLength(0)
        expect(await persistence.getActivity('exec-1', 1)).toBeUndefined()
        expect(() => handler.throwIfViolated()).toThrow(SandboxInvalidApiRequestError)
      })

    it('sends the canonical path, and a query written into the path travels as params that rules can read', async () => {
      const { handler, calls, seen, persistence } = governed(() => 'ALLOW')
      await handler.handle(call({ method: 'GET', path: '/%63ampaigns?status=active', params: { page: 2 } }))
      expect(calls[0]?.req).toMatchObject({ path: '/campaigns', params: { page: 2, status: 'active' } })
      expect(seen[0]).toMatchObject({ specPath: '/campaigns', query: { page: 2, status: 'active' } })
      expect((await persistence.getActivity('exec-1', 1))?.request).toMatchObject({ rawPath: '/campaigns', query: { page: 2, status: 'active' } })
    })

    it('refuses params that are not an object of query parameters', async () => {
      const { ctx } = makeCtx()
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      expect(parse(await handler.handle(call({ method: 'GET', path: '/campaigns', params: 'status=active' }))).code).toBe(ERR.INVALID_API_REQUEST)
      expect(parse(await new BridgeRequestHandler(makeCtx().ctx, new AbortController().signal)
        .handle(call({ method: 'GET', path: '/campaigns', params: null }))).status).toBe(200)
    })

    it('applies the same refusals on the legacy (ungoverned) path', async () => {
      const { ctx, calls } = makeCtx()
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      expect(parse(await handler.handle(call({ method: 'GET', path: 'http://169.254.169.254/latest' }))).code).toBe(ERR.INVALID_API_REQUEST)
      expect(calls).toHaveLength(0)
    })
  })

  describe('concurrent calls of one run', () => {
    it('admits them one at a time: after a sibling is denied, a call that would need approval is refused and opens nothing', async () => {
      const persistence = new InMemoryExecutionStore()
      const asked: string[] = []
      const { ctx, calls } = makeCtx({
        limits: { memoryLimitMb: 64, executeTimeoutMs: 1000, searchTimeoutMs: 1000, maxApiCalls: 10, maxConcurrentCalls: 5 },
        executionBridge: {
          journal: new ActivityJournal(persistence, 'exec-1', 'trafficking', 1),
          resolve: (m, p) => resolveOperation(campaignSpec, m, p),
          decide: async (_seq, req) => {
            asked.push(req.specPath)
            await new Promise(r => setTimeout(r, 20)) // a store round-trip
            return req.specPath === '/campaigns'
              ? { decision: 'DENY', reason: 'no', matchedRules: ['r'] }
              : { decision: 'REQUIRE_APPROVAL', approvalId: 'ap-1', summary: { service: 'trafficking', method: 'POST', specPath: req.specPath, reason: 'r', matchedRules: [] } }
          }
        }
      })
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      const [denied, second] = await Promise.all([
        handler.handle(call({ method: 'POST', path: '/campaigns', body: {} })),
        handler.handle(call({ method: 'POST', path: '/campaigns/C1/finalize' }))
      ])
      expect(parse(denied).code).toBe(ERR.GOVERNANCE_DENIED)
      expect(parse(second).code).toBe(ERR.GOVERNANCE_DENIED) // refused, naming why the run stopped
      expect(asked).toEqual(['/campaigns']) // governance never saw the sibling
      expect(await persistence.getActivity('exec-1', 2)).toBeUndefined()
      expect(calls).toHaveLength(0)
      expect(() => handler.throwIfViolated()).toThrow(GovernanceDeniedError)
    })

    it('drain lets an un-awaited call finish and be journaled before the run is reported', async () => {
      const persistence = new InMemoryExecutionStore()
      const slow = makeConnector()
      const { ctx } = makeCtx({
        apiClient: { request: async (req, c) => { await new Promise(r => setTimeout(r, 50)); return slow.connector.request(req, c) } },
        executionBridge: { journal: new ActivityJournal(persistence, 'exec-1', 'trafficking', 1), resolve: (m, p) => resolveOperation(campaignSpec, m, p) }
      })
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      void handler.handle(call({ method: 'POST', path: '/campaigns', body: {} })) // never awaited by the "program"
      await handler.drain(1000, () => { throw new Error('should not need to abort') })
      expect((await persistence.getActivity('exec-1', 1))?.status).toBe(ACTIVITY_STATUS.COMPLETED)
      expect(parse(await handler.handle(call({ method: 'GET', path: '/campaigns' }))).message).toContain('already returned')
    })

    it('drain aborts calls that outlive the budget, and stops waiting for a connector that ignores the abort', async () => {
      const { ctx } = makeCtx({ apiClient: { request: () => new Promise(() => {}) } })
      const handler = new BridgeRequestHandler(ctx, new AbortController().signal)
      void handler.handle(call({ method: 'GET', path: '/campaigns' }))
      let aborted = 0
      const started = Date.now()
      await handler.drain(10, () => { aborted++ })
      expect(aborted).toBe(1)
      expect(Date.now() - started).toBeLessThan(3000)
    })
  })
})
