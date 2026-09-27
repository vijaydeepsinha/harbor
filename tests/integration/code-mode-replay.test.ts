// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach } from 'vitest'
import { runApiInSandbox, type SandboxExecutionContext, type GovernanceVerdict } from '../../runtime/sandbox/execute-api-in-sandbox.js'
import { ActivityJournal } from '../../runtime/execution/activity-journal.js'
import { AuditCollector } from '../../runtime/observability/audit.js'
import { ProgressCollector } from '../../runtime/observability/progress.js'
import { resolveOperation } from '../../runtime/governance/operation-resolver.js'
import { InMemoryCodeModeStore } from '../../adapters/execution/in-memory-execution-store.js'
import { noopCircuitBreaker } from '../../spi/resilience/strategies/noop-circuit-breaker.strategy.js'
import { forwardTokenPermissionGuard } from '../../spi/permissions/strategies/forward-token-permission-guard.strategy.js'
import type { ConnectorAPI, ApiRequest, ExecuteRequestContext } from '../../spi/connector/connector-api.js'
import type { OpenAPISpec } from '../../core/types/spec.types.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import { ACTIVITY_STATUS, EXECUTION_STATUS } from '../../core/constants.js'
import {
  ApprovalRequiredError, GovernanceDeniedError, ReplayDivergedError, ActivityOutcomeUnknownError
} from '../../core/types/execution.types.js'

const spec: OpenAPISpec = {
  openapi: '3.0.3', info: { title: 'Trafficking', version: '1' },
  paths: {
    '/campaigns': { get: { operationId: 'listCampaigns' } },
    '/campaigns/{id}': { post: { operationId: 'updateCampaign' } },
    '/campaigns/{id}/creatives': { get: { operationId: 'listCreatives' } },
    '/campaigns/{id}/activate': { post: { operationId: 'activateCampaign' } },
    '/campaigns/{id}/finalize': { post: { operationId: 'finalizeCampaign' } }
  }
}

const tokenPayload: TokenPayload = { access_token: 't', token_type: 'bearer', expires_in: 3600, refresh_token: 'r', scope: '' }

/** Counting connector: every call is recorded; responses are canned per method+path. */
function makeConnector(fail?: (req: ApiRequest) => Error | undefined) {
  const calls: Array<{ req: ApiRequest; ctx: ExecuteRequestContext }> = []
  const connector: ConnectorAPI = {
    async request(req, ctx) {
      const err = fail?.(req)
      if (err) throw err
      calls.push({ req, ctx })
      if (req.method === 'GET' && req.path === '/campaigns') return { status: 200, ok: true, data: [{ id: 'C1' }] }
      if (req.method === 'GET') return { status: 200, ok: true, data: [{ id: 'CR1' }] }
      return { status: 201, ok: true, data: { id: `res-${calls.length}`, did: `${req.method} ${req.path}` } }
    }
  }
  return { connector, calls }
}

async function seed(store: InMemoryCodeModeStore, executionId = 'exec-1') {
  await store.createExecution({
    executionId, service: 'trafficking', originalCode: '', status: EXECUTION_STATUS.CREATED,
    userIdHash: 'h', createdAt: 't0', updatedAt: 't0', currentActivity: 0, runCount: 0
  })
}

function makeCtx(
  store: InMemoryCodeModeStore,
  connector: ConnectorAPI,
  runIndex: number,
  decide?: (sequence: number) => Promise<GovernanceVerdict>,
  executionId = 'exec-1'
): SandboxExecutionContext {
  return {
    tokenPayload, invalidate: async () => {}, apiClient: connector,
    circuitBreaker: noopCircuitBreaker(), permissionGuard: forwardTokenPermissionGuard(),
    idempotencyKey: 'idem', idempotencyKeyTtlMs: 1000, correlationId: 'c', sessionId: 's',
    limits: { memoryLimitMb: 64, executeTimeoutMs: 5000, searchTimeoutMs: 1000, maxApiCalls: 20, maxConcurrentCalls: 3 },
    executionBridge: {
      journal: new ActivityJournal(store, executionId, 'trafficking', runIndex),
      resolve: (m, p) => resolveOperation(spec, m, p),
      ...(decide ? { decide: (seq: number) => decide(seq) } : {})
    }
  }
}

const PROGRAM = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const id = campaigns.data[0].id
  const creatives = await api.request({ method: 'GET', path: '/campaigns/' + id + '/creatives', params: { limit: 5 } })
  const r = await api.request({ method: 'POST', path: '/campaigns/' + id + '/activate', body: { action: 'activate', budget: 10 } })
  return { id, creatives: creatives.data.length, activated: r.data.did, status: r.status }
}`

describe('durable execution at the bridge: journal + replay', () => {
  let store: InMemoryCodeModeStore
  beforeEach(async () => { store = new InMemoryCodeModeStore(); await seed(store) })

  it('assigns sequential activities in call order and persists request + response', async () => {
    const { connector, calls } = makeConnector()
    const result = await runApiInSandbox(PROGRAM, makeCtx(store, connector, 1))
    expect(result).toEqual({ id: 'C1', creatives: 1, activated: 'POST /campaigns/C1/activate', status: 201 })
    expect(calls.length).toBe(3)
    expect(calls.map(c => c.ctx.idempotencyKey)).toEqual(['idem-1', 'idem-2', 'idem-3'])

    const acts = await store.listActivities('exec-1')
    expect(acts.map(a => [a.sequence, a.status, a.request.method, a.request.specPath, a.request.operationId])).toEqual([
      [1, ACTIVITY_STATUS.COMPLETED, 'GET', '/campaigns', 'listCampaigns'],
      [2, ACTIVITY_STATUS.COMPLETED, 'GET', '/campaigns/{id}/creatives', 'listCreatives'],
      [3, ACTIVITY_STATUS.COMPLETED, 'POST', '/campaigns/{id}/activate', 'activateCampaign']
    ])
    expect(acts[1]?.request.query).toEqual({ limit: 5 })
    expect(acts[1]?.request.pathParams).toEqual({ id: 'C1' })
    expect(acts[2]?.request.body).toEqual({ action: 'activate', budget: 10 })
    expect(acts[2]?.response).toEqual({ status: 201, ok: true, data: { id: 'res-3', did: 'POST /campaigns/C1/activate' } })
    expect(acts.every(a => a.runIndex === 1)).toBe(true)
  })

  it('a second run of the same program replays every completed activity without touching the backend', async () => {
    const { connector, calls } = makeConnector()
    const first = await runApiInSandbox(PROGRAM, makeCtx(store, connector, 1))
    const second = await runApiInSandbox(PROGRAM, makeCtx(store, connector, 2))
    expect(second).toEqual(first)
    expect(calls.length).toBe(3)
    expect((await store.listActivities('exec-1')).length).toBe(3)
  })

  it('the journal is the one record: a resumed run audits only the call it made, its progress also shows the replayed one', async () => {
    const { connector, calls } = makeConnector()
    await runApiInSandbox(`async () => { await api.request({ method: 'POST', path: '/campaigns/C1', body: {} }); return 1 }`, makeCtx(store, connector, 1))
    const resumed = makeCtx(store, connector, 2)
    await runApiInSandbox(`async () => {
      await api.request({ method: 'POST', path: '/campaigns/C1', body: {} })
      await api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return 2
    }`, resumed)
    expect(calls).toHaveLength(2)

    const journal = resumed.executionBridge!.journal
    expect(journal.entries().map(e => `${e.outcome} ${e.method} ${e.endpoint}`)).toEqual([
      'REPLAYED POST /campaigns/{id}', 'EXECUTED POST /campaigns/{id}/finalize'
    ])
    expect(new AuditCollector(journal).getEndpoints()).toEqual(['POST /campaigns/{id}/finalize'])
    expect(new ProgressCollector(journal, 10).summary()).toEqual({
      completedCalls: 2,
      calls: [
        { i: 1, method: 'POST', endpoint: '/campaigns/{id}', status: 201, ok: true, ids: { id: 'res-1' } },
        { i: 2, method: 'POST', endpoint: '/campaigns/{id}/finalize', status: 201, ok: true, ids: { id: 'res-2' } }
      ]
    })
  })

  it('pauses at a WAITING_APPROVAL activity after replaying earlier ones; later calls in the program are refused', async () => {
    const { connector, calls } = makeConnector()
    // run 1 executes #1 and #2; #3 is journaled as waiting (as governance would leave it)
    await runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      await api.request({ method: 'GET', path: '/campaigns/C1/creatives' })
      return 'ok'
    }`, makeCtx(store, connector, 1))
    const j = new ActivityJournal(store, 'exec-1', 'trafficking', 1)
    await j.next({ method: 'GET', rawPath: '/campaigns', specPath: '/campaigns' })
    await j.next({ method: 'GET', rawPath: '/campaigns/C1/creatives', specPath: '/campaigns/{id}/creatives' })
    await j.recordWaitingApproval(3, { method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' }, 'ap-1')
    expect(calls.length).toBe(2)

    // user code swallows the pause and tries to keep going — the bridge refuses and the pause is still promoted
    const swallowing = `async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      await api.request({ method: 'GET', path: '/campaigns/C1/creatives' })
      try { await api.request({ method: 'POST', path: '/campaigns/C1/activate', body: {} }) } catch (e) {}
      try { await api.request({ method: 'POST', path: '/campaigns/C1/finalize' }) } catch (e) {}
      return 'pretend success'
    }`
    await expect(runApiInSandbox(swallowing, makeCtx(store, connector, 2))).rejects.toBeInstanceOf(ApprovalRequiredError)
    expect(calls.length).toBe(2) // nothing new hit the backend
    expect((await store.getActivity('exec-1', 3))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(await store.getActivity('exec-1', 4)).toBeUndefined()
  })

  it('an APPROVED activity executes exactly once on resume and keeps its approval id; new activities continue', async () => {
    const { connector, calls } = makeConnector()
    await runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      return 1
    }`, makeCtx(store, connector, 1))
    const j = new ActivityJournal(store, 'exec-1', 'trafficking', 1)
    await j.next({ method: 'GET', rawPath: '/campaigns', specPath: '/campaigns' })
    await j.recordWaitingApproval(2, { method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' }, 'ap-1')
    const waiting = (await store.getActivity('exec-1', 2))!
    await store.putActivity({ ...waiting, status: ACTIVITY_STATUS.APPROVED })

    const result = await runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      const a = await api.request({ method: 'POST', path: '/campaigns/C1/activate', body: { x: 1 } })
      const f = await api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return [a.data.did, f.data.did]
    }`, makeCtx(store, connector, 2))
    expect(result).toEqual(['POST /campaigns/C1/activate', 'POST /campaigns/C1/finalize'])
    expect(calls.map(c => `${c.req.method} ${c.req.path}`)).toEqual([
      'GET /campaigns', 'POST /campaigns/C1/activate', 'POST /campaigns/C1/finalize'
    ])
    const acts = await store.listActivities('exec-1')
    expect(acts.map(a => a.status)).toEqual([ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.COMPLETED])
    expect(acts[1]?.approvalId).toBe('ap-1')
    expect(acts[1]?.runIndex).toBe(1)
    expect(acts[2]?.runIndex).toBe(2)
  })

  it('stops with REPLAY_DIVERGED when the program issues a different call at a journaled sequence', async () => {
    const { connector, calls } = makeConnector()
    await runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      await api.request({ method: 'GET', path: '/campaigns/C1/creatives' })
      return 1
    }`, makeCtx(store, connector, 1))
    const drifted = `async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      await api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return 1
    }`
    await expect(runApiInSandbox(drifted, makeCtx(store, connector, 2))).rejects.toBeInstanceOf(ReplayDivergedError)
    expect(calls.length).toBe(2)
    expect((await store.getActivity('exec-1', 2))?.request.method).toBe('GET') // history untouched
  })

  it('an EXECUTING record from a crashed run: unsafe methods fail closed, GET re-executes', async () => {
    const { connector, calls } = makeConnector()
    const j = new ActivityJournal(store, 'exec-1', 'trafficking', 1)
    await j.next({ method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' })
    await j.markExecuting(1, { method: 'POST', rawPath: '/campaigns/C1/activate', specPath: '/campaigns/{id}/activate' })
    await expect(runApiInSandbox(`async () => {
      await api.request({ method: 'POST', path: '/campaigns/C1/activate' })
      return 1
    }`, makeCtx(store, connector, 2))).rejects.toBeInstanceOf(ActivityOutcomeUnknownError)
    expect(calls.length).toBe(0)

    const store2 = new InMemoryCodeModeStore(); await seed(store2, 'exec-2')
    const j2 = new ActivityJournal(store2, 'exec-2', 'trafficking', 1)
    await j2.next({ method: 'GET', rawPath: '/campaigns', specPath: '/campaigns' })
    await j2.markExecuting(1, { method: 'GET', rawPath: '/campaigns', specPath: '/campaigns' })
    const r = await runApiInSandbox(`async () => (await api.request({ method: 'GET', path: '/campaigns' })).data`,
      makeCtx(store2, connector, 2, undefined, 'exec-2'))
    expect(r).toEqual([{ id: 'C1' }])
    expect((await store2.getActivity('exec-2', 1))?.status).toBe(ACTIVITY_STATUS.COMPLETED)
  })

  it('governance verdicts: DENY stops and journals DENIED; REQUIRE_APPROVAL pauses and journals WAITING_APPROVAL', async () => {
    const { connector, calls } = makeConnector()
    const deny = async (seq: number): Promise<GovernanceVerdict> =>
      seq === 2 ? { decision: 'DENY', reason: 'budget too high', matchedRules: ['cap'] } : { decision: 'ALLOW' }
    const denied = await runApiInSandbox(PROGRAM, makeCtx(store, connector, 1, deny)).catch(e => e)
    expect(denied).toBeInstanceOf(GovernanceDeniedError)
    expect(denied).toMatchObject({ activitySequence: 2, matchedRules: ['cap'] })
    expect(calls.length).toBe(1)
    expect((await store.getActivity('exec-1', 2))?.status).toBe(ACTIVITY_STATUS.DENIED)

    const store2 = new InMemoryCodeModeStore(); await seed(store2, 'exec-2')
    const approve = async (seq: number): Promise<GovernanceVerdict> =>
      seq === 3
        ? { decision: 'REQUIRE_APPROVAL', approvalId: 'ap-9', summary: { service: 'trafficking', method: 'POST', specPath: '/campaigns/{id}/activate', reason: 'r', matchedRules: ['big'] } }
        : { decision: 'ALLOW' }
    const err = await runApiInSandbox(PROGRAM, makeCtx(store2, connector, 1, approve, 'exec-2')).catch(e => e)
    expect(err).toBeInstanceOf(ApprovalRequiredError)
    expect(err.approvalId).toBe('ap-9')
    expect(err.activitySequence).toBe(3)
    expect(calls.length).toBe(3) // 1 from the deny run + 2 GETs here; the POST never went out
    const a3 = await store2.getActivity('exec-2', 3)
    expect(a3?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(a3?.approvalId).toBe('ap-9')
  })

  it('a transport failure is journaled as FAILED with outcomeKnown=false and is never replayed', async () => {
    const { connector, calls } = makeConnector(req => req.method === 'POST' ? new Error('socket hang up') : undefined)
    const result = await runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      try { await api.request({ method: 'POST', path: '/campaigns/C1/activate' }) } catch (e) { return 'caught: ' + e.message }
    }`, makeCtx(store, connector, 1))
    expect(String(result)).toContain('socket hang up')
    expect(calls.length).toBe(1)
    const a2 = await store.getActivity('exec-1', 2)
    expect(a2?.status).toBe(ACTIVITY_STATUS.FAILED)
    expect(a2?.failure).toMatchObject({ outcomeKnown: false })
    await expect(runApiInSandbox(`async () => {
      await api.request({ method: 'GET', path: '/campaigns' })
      await api.request({ method: 'POST', path: '/campaigns/C1/activate' })
    }`, makeCtx(store, makeConnector().connector, 2))).rejects.toBeInstanceOf(ActivityOutcomeUnknownError)
  })
})
