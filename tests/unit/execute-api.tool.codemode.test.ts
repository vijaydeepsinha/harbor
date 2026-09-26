// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import {
  makeConnector, makeResources, makeRuntime, registerGoverned, makeCtx, retryCtx, parseContent
} from './code-mode-harness.js'
import {
  ERR, EXECUTION_STATUS, ACTIVITY_STATUS, APPROVAL_STATUS,
  EXECUTION_ID_META_KEY, EXECUTION_STATUS_META_KEY, APPROVAL_ID_META_KEY, APPROVAL_INPUT_KEY
} from '../../core/constants.js'

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
    const rt = makeRuntime()
    const { connector, calls } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx())
    expect(r['isError']).toBeUndefined()
    expect(parseContent(r)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/activate' })
    const meta = r['_meta'] as Record<string, unknown>
    const executionId = meta[EXECUTION_ID_META_KEY] as string
    expect(typeof executionId).toBe('string')
    expect(meta[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    expect(calls.length).toBe(2)
    const exec = await rt.manager.load(executionId)
    expect(exec.originalCode).toBe(PROGRAM)
    expect(exec.currentActivity).toBe(2)
    expect((await rt.store.listDecisions(executionId)).map(d => d.decision)).toEqual(['ALLOW', 'ALLOW'])
  })

  it('REQUIRE_APPROVAL pauses with input_required (elicitation + sealed requestState); accept resumes and executes once', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))

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
    expect((await rt.manager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect((await rt.store.getActivity(executionId, 2))?.status).toBe(ACTIVITY_STATUS.WAITING_APPROVAL)
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)

    // client retries the SAME call with the human's answer (and, per MRTR, the same arguments)
    const done = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(rt, paused, { action: 'accept', approve: true, comment: 'ship it' }))
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/finalize' })
    expect((done['_meta'] as Record<string, unknown>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)
    expect(count('GET', '/campaigns')).toBe(1) // replayed, not re-fetched
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1) // executed exactly once
    const approval = await rt.approvals.get(approvalId)
    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED)
    expect(approval.comment).toBe('ship it')
    const exec = await rt.manager.load(executionId)
    expect(exec.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(exec.runCount).toBe(2)
  })

  it('decline denies the execution; cancel cancels it; neither executes the operation', async () => {
    for (const [action, status, code] of [
      ['decline', EXECUTION_STATUS.DENIED, ERR.GOVERNANCE_DENIED],
      ['cancel', EXECUTION_STATUS.CANCELLED, ERR.EXECUTION_CANCELLED]
    ] as const) {
      const rt = makeRuntime([FINALIZE_RULE])
      const { connector, count } = makeConnector()
      const handler = registerGoverned(rt, makeResources('trafficking', connector))
      const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
      const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(rt, paused, { action }))
      expect(r['isError']).toBe(true)
      expect((parseContent(r) as { code: string }).code).toBe(code)
      const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
      expect((await rt.manager.load(executionId)).status).toBe(status)
      expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    }
  })

  it('accept with approve=false is a rejection', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(rt, paused, { action: 'accept', approve: false }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.GOVERNANCE_DENIED)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
  })

  it('retrying without an answer re-asks instead of resuming', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const again = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(rt, paused, undefined))
    expect(again['resultType']).toBe('input_required')
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
  })

  it('a client without elicitation gets APPROVAL_REQUIRED with ids in _meta and resumes via _meta after an HTTP decision', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx({ elicitation: false }))
    expect(paused['isError']).toBe(true)
    const body = parseContent(paused) as { code: string; executionId: string; approvalId: string; approval: { specPath: string } }
    expect(body.code).toBe(ERR.APPROVAL_REQUIRED)
    expect(body.approval.specPath).toBe('/campaigns/{id}/finalize')
    const meta = paused['_meta'] as Record<string, unknown>
    expect(meta[APPROVAL_ID_META_KEY]).toBe(body.approvalId)

    await rt.approvals.decide(body.approvalId, { action: 'accept', via: 'http' })
    const done = await handler({ service: 'trafficking', code: 'async () => "REPLACEMENT CODE IS IGNORED"' }, makeCtx({ elicitation: false, executionIdMeta: body.executionId }))
    expect(done['isError']).toBeUndefined()
    expect(parseContent(done)).toEqual({ id: 'C1', did: 'POST /campaigns/C1/finalize' })
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    expect((await rt.manager.load(body.executionId)).originalCode).toBe(PROGRAM_FINALIZE)
  })

  it('resuming before the approval is decided pauses again — it does not report the execution as FAILED', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
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
    const exec = await rt.manager.load(executionId)
    expect(exec.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(exec.pendingApprovalId).toBe(approvalId)
    expect(exec.runCount).toBe(1)
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    expect((await rt.approvals.get(approvalId)).status).toBe(APPROVAL_STATUS.PENDING)

    // Still resumable once decided.
    await rt.approvals.decide(approvalId, { action: 'accept', via: 'http' })
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
    const rt = makeRuntime([NESTED_RULE])
    const { connector, calls, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))

    // A deep field over the threshold triggers the rule …
    const paused = await handler({ service: 'trafficking', code: program(2_000_000) }, makeCtx())
    expect(paused['resultType']).toBe('input_required')
    expect(count('POST', '/campaigns')).toBe(0)
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    const activity = await rt.store.getActivity(executionId, 1)
    expect(activity?.request.body).toEqual(body(2_000_000))
    expect(activity?.request.query).toEqual(params)
    expect(activity?.request.pathParams).toBeUndefined()
    const approvalId = (paused['_meta'] as Record<string, unknown>)[APPROVAL_ID_META_KEY] as string
    expect((await rt.approvals.get(approvalId)).summary.body).toEqual(body(2_000_000))

    // … and below it the same nested DTOs pass through to the backend unchanged.
    const done = await handler({ service: 'trafficking', code: program(500) }, makeCtx())
    expect(done['isError']).toBeUndefined()
    expect(calls.at(-1)?.req.body).toEqual(body(500))
    expect(calls.at(-1)?.req.params).toEqual(params)
  })

  it('a DENY rule stops the execution before the call and records the decision', async () => {
    const rt = makeRuntime([{ name: 'no-finalize', match: { operation: 'finalizeCampaign' }, action: { type: 'DENY', reason: 'frozen' } }])
    const { connector, count } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    expect((parseContent(r) as { code: string; message?: string }).code).toBe(ERR.GOVERNANCE_DENIED)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(0)
    const executionId = (r['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    const decisions = await rt.store.listDecisions(executionId)
    expect(decisions[1]).toMatchObject({ decision: 'DENY', matchedRules: ['no-finalize'], ruleVersions: ['no-finalize@1#deadbeefcafe'] })
    expect((await rt.manager.load(executionId)).status).toBe(EXECUTION_STATUS.DENIED)
  })

  it('refuses a resume by another principal and by another service', async () => {
    const rt = makeRuntime([FINALIZE_RULE])
    const { connector } = makeConnector()
    const handler = registerGoverned(rt, makeResources('trafficking', connector))
    const paused = await handler({ service: 'trafficking', code: PROGRAM_FINALIZE }, makeCtx())
    const executionId = (paused['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string

    const other = registerGoverned(rt, makeResources('trafficking', connector, 'someone-else'))
    const r = await other({ service: 'trafficking', code: PROGRAM_FINALIZE }, await retryCtx(rt, paused, { action: 'accept' }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)

    const otherService = registerGoverned(rt, makeResources('billing', connector))
    const r2 = await otherService({ service: 'billing', code: PROGRAM_FINALIZE }, makeCtx({ executionIdMeta: executionId }))
    expect((parseContent(r2) as { code: string }).code).toBe(ERR.EXECUTION_NOT_RESUMABLE)
    expect((await rt.approvals.get((paused['_meta'] as Record<string, unknown>)[APPROVAL_ID_META_KEY] as string)).status).toBe(APPROVAL_STATUS.PENDING)
  })

  it('unknown execution ids are reported, not silently turned into new executions', async () => {
    const rt = makeRuntime()
    const handler = registerGoverned(rt, makeResources('trafficking', makeConnector().connector))
    const r = await handler({ service: 'trafficking', code: PROGRAM }, makeCtx({ executionIdMeta: 'does-not-exist' }))
    expect((parseContent(r) as { code: string }).code).toBe(ERR.EXECUTION_NOT_FOUND)
  })
})
