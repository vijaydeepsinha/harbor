// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import {
  makeConnector, makeResources, makeRuntime, registerGoverned, makeCtx, retryCtx, parseContent,
  makeFakeServer, makeRegistry, globalConfig, silentLogger
} from './code-mode-harness.js'
import { registerExecuteApiTool } from '../../src/tools/execute-api.tool.js'
import type { MetricsRegistry } from '../../src/runtime/observability/metrics.js'
import { MemcacheExecutionStore } from '../../src/adapters/execution/memcache-execution-store.js'
import { FakeMemcache } from './fake-memcache.js'
import { AuditPipeline } from '../../src/runtime/observability/audit-pipeline.js'
import type { AuditEvent } from '../../src/spi/observability/audit-sink.js'
import {
  ERR, EXECUTION_STATUS, ACTIVITY_STATUS, APPROVAL_STATUS, GOVERNANCE_DECISION, GOVERNANCE_REASON, TOOL,
  EXECUTION_ID_META_KEY, EXECUTION_STATUS_META_KEY, APPROVAL_ID_META_KEY, APPROVAL_INPUT_KEY
} from '../../src/core/constants.js'

const APPROVAL_RULE = {
  name: 'activate-needs-approval', match: { service: 'trafficking', operation: 'activateCampaign' },
  action: { type: 'REQUIRE_APPROVAL', reason: 'Activation changes live delivery' }
}
const PROGRAM = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const id = campaigns.data[0].id
  const r = await api.request({ method: 'POST', path: '/campaigns/' + id + '/activate', body: { budget: 5 } })
  return { id, did: r.data.did }
}`
// Note: '/campaigns/{id}/activate' is not in the harness spec → unmatched (fallback path); use finalize for matched.
const PROGRAM_FINALIZE = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const id = campaigns.data[0].id
  const r = await api.request({ method: 'POST', path: '/campaigns/' + id + '/finalize' })
  return { id, did: r.data.did }
}`
const FINALIZE_RULE = { ...APPROVAL_RULE, name: 'finalize-needs-approval', match: { service: 'trafficking', operation: 'finalizeCampaign' } }

describe('api_execute under the Code Mode governance layer', () => {
  it('creates a durable execution, runs it, and returns the id + status in _meta', async () => {
    const governanceRuntime = makeRuntime()
    const { connector, calls } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx())
    expect(r['isError']).toBeUndefined()
    expect(parseContent(r)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/activate' })
    const meta = r['_meta'] as Record<string, unknown>
    const executionId = meta[EXECUTION_ID_META_KEY] as string
    expect(typeof executionId).toBe('string')
    expect(meta[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    expect(calls.length).toBe(2)
    const exec = await governanceRuntime.executionManager.load(executionId)
    expect(exec.originalCode).toBeUndefined() // a COMPLETED execution keeps no program text (EXECUTION_CODE_RETENTION=DROP)
    expect(exec.currentActivity).toBe(2)
    expect((await governanceRuntime.persistence.listDecisions(executionId)).map(d => d.decision)).toEqual(['ALLOW', 'ALLOW'])
  })

  it('REQUIRE_APPROVAL pauses with input_required (elicitation + sealed requestState); accept resumes and executes once', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))

    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect(paused['resultType']).toBe('input_required')
    const inputRequests = paused['inputRequests'] as Record<string, { method: string; params: { message: string; requestedSchema: unknown } }>
    expect(inputRequests[APPROVAL_INPUT_KEY]?.method).toBe('elicitation/create')
    expect(inputRequests[APPROVAL_INPUT_KEY]?.params.message).toContain('finalizeCampaign — POST /campaigns/{id}/finalize')
    expect(inputRequests[APPROVAL_INPUT_KEY]?.params.message).toContain('Activation changes live delivery')
    expect(typeof paused['requestState']).toBe('string')
    const meta = paused['_meta'] as Record<string, unknown>
    const executionId = meta[EXECUTION_ID_META_KEY] as string
    const approvalId = meta[APPROVAL_ID_META_KEY] as string
    expect(meta[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect((await governanceRuntime.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect((await governanceRuntime.persistence.getActivity(executionId, 2))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

    // client retries the SAME call with the human's answer (and, per MRTR, the same arguments)
    const done = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept', approve: true, comment: 'ship it' }))
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/finalize' })
    expect((done['_meta'] as Record<string, unknown>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    expect(count('GET', '/campaigns')).toBe(1) // replayed, not re-fetched
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1) // executed exactly once
    const approval = await governanceRuntime.approvals.get(approvalId)
    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED)
    expect(approval.comment).toBe('ship it')
    const exec = await governanceRuntime.executionManager.load(executionId)
    expect(exec.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(exec.runCount).toBe(2)
  })

  it('decline denies the execution; cancel cancels it; neither executes the operation', async () => {
    for (const [action, status, code] of [
      ['decline', EXECUTION_STATUS.DENIED, ERR.GOVERNANCE_DENIED],
      ['cancel', EXECUTION_STATUS.CANCELLED, ERR.EXECUTION_CANCELLED]
    ] as const) {
      const governanceRuntime = makeRuntime([FINALIZE_RULE])
      const { connector, count } = makeConnector()
      const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action }))
      expect(r['isError']).toBe(true)
      expect((parseContent(r) as { code: string }).code).toBe(code)
      const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
      expect((await governanceRuntime.executionManager.load(executionId)).status).toBe(status)
      expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    }
  })

  it('accept with approve=false is a rejection', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept', approve: false }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.GOVERNANCE_DENIED)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
  })

  it('retrying without an answer re-asks instead of resuming', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const again = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, undefined))
    expect(again['resultType']).toBe('input_required')
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
  })

  it('a client without elicitation gets APPROVAL_REQUIRED with ids in _meta and resumes via _meta after an HTTP decision', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false }))
    expect(paused['isError']).toBe(true)
    const body = parseContent(paused) as { code: string; executionId: string; approvalId: string; approval: { specPath: string } }
    expect(body.code).toBe(ERR.APPROVAL_REQUIRED)
    expect(body.approval.specPath).toBe('/campaigns/{id}/finalize')
    const meta = paused['_meta'] as Record<string, unknown>
    expect(meta[APPROVAL_ID_META_KEY]).toBe(body.approvalId)

    expect((await governanceRuntime.executionManager.load(body.executionId)).originalCode).toBe(PROGRAM_FINALIZE) // persisted while paused

    await governanceRuntime.approvals.decide(body.approvalId, { action: 'accept', approve: true, via: 'http', executionId: body.executionId })
    const done = await handler({ service: 'trafficking', code: 'async () => "REPLACEMENT CODE IS IGNORED"' }, makeCtx({ elicitation: false, executionIdMeta: body.executionId }))
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/finalize' }) // the persisted program ran
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    expect((await governanceRuntime.executionManager.load(body.executionId)).originalCode).toBeUndefined() // dropped once COMPLETED (default DROP)
  })

  it('resuming before the approval is decided pauses again — it does not report the execution as FAILED', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false }))
    const { executionId, approvalId } = parseContent(paused) as { executionId: string; approvalId: string }

    // Fallback client resumes via _meta while the approval is still PENDING.
    const early = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false, executionIdMeta: executionId }))
    expect(early['isError']).toBe(true)
    const body = parseContent(early) as { code: string; approvalId: string; activitySequence: number }
    expect(body.code).toBe(ERR.APPROVAL_REQUIRED)
    expect(body.approvalId).toBe(approvalId)
    expect(body.activitySequence).toBe(2)
    const meta = early['_meta'] as Record<string, unknown>
    expect(meta[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(meta[APPROVAL_ID_META_KEY]).toBe(approvalId)

    // An elicitation-capable client that lost its requestState is simply asked again.
    const reasked = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ executionIdMeta: executionId }))
    expect(reasked['resultType']).toBe('input_required')
    expect((reasked['_meta'] as Record<string, unknown>)[APPROVAL_ID_META_KEY]).toBe(approvalId)

    // Nothing ran and nothing changed: still paused on the same approval, one run so far.
    const exec = await governanceRuntime.executionManager.load(executionId)
    expect(exec.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(exec.pendingApprovalId).toBe(approvalId)
    expect(exec.runCount).toBe(1)
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    expect((await governanceRuntime.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)

    // Still resumable once decided.
    await governanceRuntime.approvals.decide(approvalId, { action: 'accept', approve: true, via: 'http', executionId })
    const done = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false, executionIdMeta: executionId }))
    expect(done['isError']).toBeUndefined()
    expect((done['_meta'] as Record<string, unknown>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
  })

  it('nested request DTOs (body and query) reach the rules, the journal and the backend with their full shape', async () => {
    const NESTED_RULE = {
      name: 'nested-budget', match: { service: 'trafficking', operation: 'createCampaign' },
      conditions: {
        'body.campaign.budget.amount': { greater_than: 1_000_000 },
        'body.campaign.flights.0.start': { starts_with: '2026-' },
        'query.filter.status': { equals: 'draft' }
      },
      action: { type: 'REQUIRE_APPROVAL', reason: 'Large nested budget' }
    }
    const body = (amount: number) => ({ campaign: { name: 'Q4', budget: { amount, currency: 'USD' }, flights: [{ start: '2026-10-01', end: '2026-12-31' }] } })
    const params = { filter: { status: 'draft', owner: { team: 'growth' } }, ids: ['a', 'b'] }
    const program = (amount: number) => `async () => {
      const r = await api.request({ method: 'POST', path: '/campaigns', params: ${JSON.stringify(params)}, body: ${JSON.stringify(body(amount))} })
      return r.data.did
    }`
    const governanceRuntime = makeRuntime([NESTED_RULE])
    const { connector, calls, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))

    // A deep field over the threshold triggers the rule …
    const paused = await handler({ service: 'trafficking', code: program(2_000_000) }, makeCtx())
    expect(paused['resultType']).toBe('input_required')
    expect(count('POST', '/campaigns')).toBe(0)
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    const activity = await governanceRuntime.persistence.getActivity(executionId, 1)
    expect(activity?.request.body).toEqual(body(2_000_000))
    expect(activity?.request.query).toEqual(params)
    expect(activity?.request.pathParams).toBeUndefined()
    const approvalId = (paused['_meta'] as Record<string, unknown>)[APPROVAL_ID_META_KEY] as string
    expect((await governanceRuntime.approvals.get(approvalId)).summary.body).toEqual(body(2_000_000))

    // … and below it the same nested DTOs pass through to the backend unchanged.
    const done = await handler({ service: 'trafficking', code: program(500) }, makeCtx())
    expect(done['isError']).toBeUndefined()
    expect(calls.at(-1)?.req.body).toEqual(body(500))
    expect(calls.at(-1)?.req.params).toEqual(params)
  })

  it('a /campaigns/** rule governs endpoints it never names (resolved OpenAPI template → subtree match)', async () => {
    const governanceRuntime = makeRuntime([{ name: 'campaign-writes', match: { method: 'POST', path: '/campaigns/**' }, action: { type: 'REQUIRE_APPROVAL', reason: 'writes under /campaigns' } }])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect(paused['resultType']).toBe('input_required')
    expect(count('GET', '/campaigns')).toBe(1)                // GET is not a POST: allowed
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)   // /campaigns/{id}/finalize is under /campaigns/**
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    expect((await governanceRuntime.persistence.listDecisions(executionId)).map(d => [d.decision, d.decidingRule])).toEqual([['ALLOW', undefined], ['REQUIRE_APPROVAL', 'campaign-writes']])
  })

  it('default DENY applies only where governance applies: untargeted calls run, a targeted unmatched call is denied', async () => {
    const FORCE_ONLY = {
      name: 'finalize-with-force', match: { service: 'trafficking', operation: 'finalizeCampaign' },
      conditions: { 'body.force': { equals: true } }, action: { type: 'ALLOW' }
    }
    const governanceRuntime = makeRuntime([FORCE_ONLY], GOVERNANCE_DECISION.DENY)
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect((parseContent(r) as { code: string }).code).toBe(ERR.GOVERNANCE_DENIED)
    expect(count('GET', '/campaigns')).toBe(1)               // no rule targets it: ungoverned
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)  // targeted, condition false: default DENY
    const executionId = (r['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    expect((await governanceRuntime.persistence.listDecisions(executionId)).map(d => [d.decision, d.reason])).toEqual([
      ['ALLOW', GOVERNANCE_REASON.NO_GOVERNANCE],
      ['DENY', GOVERNANCE_REASON.NO_MATCHING_RULE]
    ])
    expect((await governanceRuntime.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.DENIED)
  })

  it('multi-pod on the memcache store: paused on pod A, approved and resumed on pod B, every call made once', async () => {
    const memcache = new FakeMemcache()
    const podA = makeRuntime([FINALIZE_RULE], GOVERNANCE_DECISION.ALLOW, new MemcacheExecutionStore(memcache))
    const podB = makeRuntime([FINALIZE_RULE], GOVERNANCE_DECISION.ALLOW, new MemcacheExecutionStore(memcache))
    const { connector, count } = makeConnector()
    const onA = registerGoverned(podA, makeResources('trafficking', connector))
    const onB = registerGoverned(podB, makeResources('trafficking', connector))

    const paused = await onA({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect(paused['resultType']).toBe('input_required')
    // the client's retry lands on another pod (same GOVERNANCE_REQUEST_STATE_KEY)
    const done = await onB({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(podB, paused, { action: 'accept', approve: true }))
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/finalize' })
    expect(count('GET', '/campaigns')).toBe(1)                // replayed on pod B from the shared journal
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)   // executed exactly once
    const executionId = (done['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    expect((await podA.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.COMPLETED) // pod A sees pod B's outcome
  })

  it('X-Correlation-ID is the execution id on every call of one script, across approval resumes; the client id is forwarded', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector, calls } = makeConnector()
    const { handlers, server } = makeFakeServer()
    registerExecuteApiTool(server, makeRegistry({ trafficking: makeResources('trafficking', connector) }), globalConfig, silentLogger,
      { increment() {}, stop() {} } as unknown as MetricsRegistry, 'tok', governanceRuntime, undefined, 'agent-7')
    const handler = handlers[TOOL.API_EXECUTE]!
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ requestId: 'rpc-1' }))
    await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept', approve: true }, 'rpc-2'))
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    expect(calls.map(c => `${c.req.method} ${c.req.path}`)).toEqual(['GET /campaigns', 'POST /campaigns/C1/finalize']) // two runs, two MCP requests
    expect(calls.map(c => c.ctx.correlationId)).toEqual([executionId, executionId])
    expect(calls.map(c => c.ctx.clientId)).toEqual(['agent-7', 'agent-7'])
  })

  it('a DENY rule stops the execution before the call and records the decision', async () => {
    const governanceRuntime = makeRuntime([{ name: 'no-finalize', match: { operation: 'finalizeCampaign' }, action: { type: 'DENY', reason: 'frozen' } }])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect((parseContent(r) as { code: string; message?: string }).code).toBe(ERR.GOVERNANCE_DENIED)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    const executionId = (r['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    const decisions = await governanceRuntime.persistence.listDecisions(executionId)
    expect(decisions[1]).toMatchObject({ decision: 'DENY', matchedRules: ['no-finalize'], ruleVersions: ['no-finalize@1#deadbeefcafe'] })
    expect((await governanceRuntime.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.DENIED)
  })

  it('refuses a resume by another principal and by another service', async () => {
    const governanceRuntime = makeRuntime([FINALIZE_RULE])
    const { connector } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string

    const other = registerGoverned(governanceRuntime, makeResources('trafficking', connector, 'someone-else'))
    const r = await other({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept' }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)

    const otherService = registerGoverned(governanceRuntime, makeResources('billing', connector))
    const r2 = await otherService({ service: 'billing', code: PROGRAM_FINALIZE }, makeCtx({ executionIdMeta: executionId }))
    expect((parseContent(r2) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)
    expect((await governanceRuntime.approvals.get((paused['_meta'] as Record<string, unknown>)[APPROVAL_ID_META_KEY] as string)).status).toBe(APPROVAL_STATUS.PENDING)
  })

  it('unknown execution ids are reported, not silently turned into new executions', async () => {
    const governanceRuntime = makeRuntime()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', makeConnector().connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx({ executionIdMeta: 'does-not-exist' }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.EXECUTION_NOT_FOUND)
  })

  describe('answers and refusals after the decision', () => {
    it('a conflicting MRTR answer after an HTTP decision is refused and runs nothing; the same answer resumes', async () => {
      const governanceRuntime = makeRuntime([FINALIZE_RULE])
      const { connector, count } = makeConnector()
      const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      const meta = paused['_meta'] as Record<string, string>
      await governanceRuntime.approvals.decide(meta[APPROVAL_ID_META_KEY]!, { action: 'accept', approve: true, via: 'http', executionId: meta[EXECUTION_ID_META_KEY]! })

      const declined = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'decline' }))
      expect((parseContent(declined) as { code: string }).code).toBe(ERR.APPROVAL_ALREADY_DECIDED)
      expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

      const accepted = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept' }))
      expect(accepted['isError']).toBeUndefined()
      expect(count('POST', '/campaigns/C1/finalize')).toBe(1)

      // Once finished, a late conflicting answer is refused as not resumable, and changes nothing.
      const late = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'decline' }))
      expect((parseContent(late) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)
      expect((await governanceRuntime.executionManager.load(meta[EXECUTION_ID_META_KEY]!)).status).toBe(EXECUTION_STATUS.COMPLETED)
    })

    it('a refused resume reports the stored status in _meta, not the status of a run that never started', async () => {
      const governanceRuntime = makeRuntime()
      const handler = registerGoverned(governanceRuntime, makeResources('trafficking', makeConnector().connector))
      const done = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      const executionId = (done['_meta'] as Record<string, string>)[EXECUTION_ID_META_KEY]!
      const again = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ executionIdMeta: executionId }))
      expect((parseContent(again) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)
      expect((again['_meta'] as Record<string, string>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    })

    it('a decision that meets a held lock is reported retryable on the MCP path too', async () => {
      const governanceRuntime = makeRuntime([FINALIZE_RULE])
      const handler = registerGoverned(governanceRuntime, makeResources('trafficking', makeConnector().connector))
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      const executionId = (paused['_meta'] as Record<string, string>)[EXECUTION_ID_META_KEY]!
      expect(await governanceRuntime.persistence.acquireLock(executionId)).toBe(true)
      const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'accept' }))
      expect(parseContent(r)).toMatchObject({ code: ERR.EXECUTION_LOCKED, retryable: true })
      await governanceRuntime.persistence.releaseLock(executionId)
    })
  })

  describe('audit trail on resume', () => {
    function auditedTool(governanceRuntime: ReturnType<typeof makeRuntime>, failFinalize = false) {
      const events: AuditEvent[] = []
      const pipeline = new AuditPipeline([{ name: 'capture', write: (e: AuditEvent) => { events.push(e) } }], silentLogger)
      const { handlers, server } = makeFakeServer()
      const metrics = { increment: () => {}, stop: () => {} } as unknown as MetricsRegistry
      const config = { ...globalConfig, observability: { ...globalConfig.observability, enableAudit: true } }
      const base = makeConnector().connector
      const connector = failFinalize
        ? { request: async (req: Parameters<typeof base.request>[0], c: Parameters<typeof base.request>[1]) => {
            if (req.path.endsWith('/finalize')) throw new Error('backend down')
            return base.request(req, c)
          } }
        : base
      registerExecuteApiTool(server, makeRegistry({ trafficking: makeResources('trafficking', connector) }), config, silentLogger, metrics, 'client-token', governanceRuntime, pipeline)
      const records = () => events.filter(e => e.kind === 'audit').map(e => (e as Extract<AuditEvent, { kind: 'audit' }>).record)
      return { handler: handlers[TOOL.API_EXECUTE]!, records }
    }
    const settle = () => new Promise(r => setTimeout(r, 0))

    it('records the persisted program that ran, not the ignored code a resume carried', async () => {
      const governanceRuntime = makeRuntime([FINALIZE_RULE])
      const { handler, records } = auditedTool(governanceRuntime, true)
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false }))
      const { executionId, approvalId } = parseContent(paused) as { executionId: string; approvalId: string }
      await governanceRuntime.approvals.decide(approvalId, { action: 'accept', approve: true, via: 'http', executionId })
      // The persisted program runs and fails at the approved finalize (backend down) — the error path.
      const failed = await handler({ service: 'trafficking', code: 'async () => "I only read the weather"' }, makeCtx({ elicitation: false, executionIdMeta: executionId }))
      expect(failed['isError']).toBe(true)
      await settle()
      const last = records().at(-1)!
      expect(last.executionId).toBe(executionId)
      expect(last.codeSubmitted).toBe(PROGRAM_FINALIZE)
    })

    it('a decline answered on resume is audited, with the code that caller sent', async () => {
      const governanceRuntime = makeRuntime([FINALIZE_RULE])
      const { handler, records } = auditedTool(governanceRuntime)
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      await settle()
      const before = records().length
      const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(governanceRuntime, paused, { action: 'decline' }))
      expect((parseContent(r) as { code: string }).code).toBe(ERR.GOVERNANCE_DENIED)
      await settle()
      expect(records()).toHaveLength(before + 1)
      expect(records().at(-1)).toMatchObject({ outcome: 'governance_denied', errorCode: ERR.GOVERNANCE_DENIED, executionId: (paused['_meta'] as Record<string, string>)[EXECUTION_ID_META_KEY] })
    })
  })
})
