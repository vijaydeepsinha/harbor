// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Requirements §47 — the final acceptance scenario, end to end through the
 * real api_execute handler, the real V8 sandbox and the journaled bridge:
 *
 *   #1 GET  campaigns              → execute
 *   #2 GET  creatives              → execute
 *   #3 POST activate               → approval required   (V8 #1 dies)
 *   resume: #1,#2 replay · #3 execute · #4 POST creative → approval required (V8 #2 dies)
 *   resume: #1..#3 replay · #4 execute · #5 POST finalize → execute (ALLOW)
 *
 * Every backend operation must execute exactly once.
 */
import { describe, it, expect } from 'vitest'
import {
  makeConnector, makeResources, makeRuntime, registerGoverned, makeCtx, retryCtx, parseContent
} from '../unit/code-mode-harness.js'
import { EXECUTION_STATUS, ACTIVITY_STATUS, EXECUTION_ID_META_KEY, EXECUTION_STATUS_META_KEY } from '../../src/core/constants.js'

const PROGRAM = `async () => {
  const campaigns = await api.request({ method: 'GET', path: '/campaigns' })
  const campaignId = campaigns.data[0].id

  const creatives = await api.request({ method: 'GET', path: \`/campaigns/\${campaignId}/creatives\` })

  const result1 = await api.request({
    method: 'POST', path: \`/campaigns/\${campaignId}\`,
    body: { action: 'activate' }
  })

  const result2 = await api.request({
    method: 'POST', path: \`/campaigns/\${campaignId}/creative\`,
    body: { creativeId: creatives.data[0].id }
  })

  const result3 = await api.request({ method: 'POST', path: \`/campaigns/\${campaignId}/finalize\` })

  return { campaignId, activated: result1.data.did, attached: result2.data.did, finalized: result3.data.did }
}`

const RULES = [
  { name: 'activate-requires-approval', match: { service: 'trafficking', operation: 'updateCampaign' },
    conditions: { action: { equals: 'activate' } }, action: { type: 'REQUIRE_APPROVAL', reason: 'Activation goes live' } },
  { name: 'creative-requires-approval', match: { service: 'trafficking', operation: 'attachCreative' },
    action: { type: 'REQUIRE_APPROVAL', reason: 'Creative content must be reviewed' } },
  { name: 'finalize-allowed', match: { service: 'trafficking', operation: 'finalizeCampaign' }, action: { type: 'ALLOW' } }
]

describe('§47 acceptance: two approval rounds, every side effect exactly once', () => {
  it('runs the scenario', async () => {
    const governanceRuntime = makeRuntime(RULES)
    const { connector, count, calls } = makeConnector()
    const handler = registerGoverned(governanceRuntime, makeResources('trafficking', connector))
    const args = { service: 'trafficking', code: PROGRAM }

    // ── Initial execution ────────────────────────────────────────────────
    const run1 = await handler(args, makeCtx({ requestId: '1' }))
    expect(run1['resultType']).toBe('input_required')
    const executionId = (run1['_meta'] as Record<string, unknown>)[EXECUTION_ID_META_KEY] as string
    expect(count('GET', '/campaigns')).toBe(1)          // #1 executed
    expect(count('GET', '/campaigns/C1/creatives')).toBe(1) // #2 executed
    expect(count('POST', '/campaigns/C1')).toBe(0)      // #3 paused before executing
    let acts = await governanceRuntime.persistence.listActivities(executionId)
    expect(acts.map(a => [a.sequence, a.status])).toEqual([[1, 'COMPLETED'], [2, 'COMPLETED'], [3, 'WAITING_APPROVAL']])
    expect((await governanceRuntime.executionManager.load(executionId)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)

    // ── First resume (approve activation) ────────────────────────────────
    const run2 = await handler(args, await retryCtx(governanceRuntime, run1, { action: 'accept', approve: true }, '2'))
    expect(run2['resultType']).toBe('input_required')
    expect(count('GET', '/campaigns')).toBe(1)          // #1 replayed
    expect(count('GET', '/campaigns/C1/creatives')).toBe(1) // #2 replayed
    expect(count('POST', '/campaigns/C1')).toBe(1)      // #3 executed after approval
    expect(count('POST', '/campaigns/C1/creative')).toBe(0) // #4 paused
    acts = await governanceRuntime.persistence.listActivities(executionId)
    expect(acts.map(a => [a.sequence, a.status])).toEqual([
      [1, 'COMPLETED'], [2, 'COMPLETED'], [3, 'COMPLETED'], [4, 'WAITING_APPROVAL']
    ])
    expect((await governanceRuntime.executionManager.load(executionId)).runCount).toBe(2)

    // ── Second resume (approve creative) ─────────────────────────────────
    const run3 = await handler(args, await retryCtx(governanceRuntime, run2, { action: 'accept', approve: true }, '3'))
    expect(run3['isError']).toBeUndefined()
    expect(run3['resultType']).toBeUndefined()
    expect(parseContent(run3)).toEqual({
      campaignId: 'C1',
      activated: 'POST /campaigns/C1',
      attached: 'POST /campaigns/C1/creative',
      finalized: 'POST /campaigns/C1/finalize'
    })
    expect((run3['_meta'] as Record<string, unknown>)[EXECUTION_STATUS_META_KEY]).toBe(EXECUTION_STATUS.COMPLETED)

    // ── Exactly-once verification ────────────────────────────────────────
    expect(count('GET', '/campaigns')).toBe(1)
    expect(count('GET', '/campaigns/C1/creatives')).toBe(1)
    expect(count('POST', '/campaigns/C1')).toBe(1)
    expect(count('POST', '/campaigns/C1/creative')).toBe(1)
    expect(count('POST', '/campaigns/C1/finalize')).toBe(1)
    expect(calls.length).toBe(5)
    // …and in the order the program issued them across three isolates
    expect(calls.map(c => `${c.req.method} ${c.req.path}`)).toEqual([
      'GET /campaigns', 'GET /campaigns/C1/creatives', 'POST /campaigns/C1', 'POST /campaigns/C1/creative', 'POST /campaigns/C1/finalize'
    ])

    // ── Records: journal, decisions, approvals, history ───────────────────
    const { execution, activities, approvals, decisions, history } = await governanceRuntime.executionManager.inspect(executionId)
    expect(execution.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(execution.runCount).toBe(3)
    // The persisted program drove all three isolates (call order above); once
    // COMPLETED its text is dropped (EXECUTION_CODE_RETENTION=DROP, the default).
    expect(execution.originalCode).toBeUndefined()
    expect(activities.map(a => a.status)).toEqual(Array(5).fill(ACTIVITY_STATUS.COMPLETED))
    expect(activities.map(a => a.runIndex)).toEqual([1, 1, 1, 2, 3])
    expect(activities[2]?.approvalId).toBe(approvals[0]?.approvalId)
    expect(activities[3]?.approvalId).toBe(approvals[1]?.approvalId)
    expect(decisions.map(d => [d.activitySequence, d.decision])).toEqual([
      [1, 'ALLOW'], [2, 'ALLOW'], [3, 'REQUIRE_APPROVAL'], [4, 'REQUIRE_APPROVAL'], [5, 'ALLOW']
    ])
    expect(decisions[2]?.matchedRules).toEqual(['activate-requires-approval'])
    expect(decisions[4]?.decidingRule).toBe('finalize-allowed')
    expect(approvals.map(a => [a.activitySequence, a.status, a.decidedVia])).toEqual([
      [3, 'APPROVED', 'mcp-elicitation'], [4, 'APPROVED', 'mcp-elicitation']
    ])
    const events = history.map(h => `${h.kind}:${h.event}${h.sequence ? '#' + h.sequence : ''}`)
    expect(events).toContain('APPROVAL:REQUESTED#3')
    expect(events).toContain('APPROVAL:APPROVED#3')
    expect(events).toContain('APPROVAL:REQUESTED#4')
    expect(events).toContain('ACTIVITY:COMPLETED#5')
    expect(events[events.length - 1]).toBe('EXECUTION:COMPLETED')
  })
})
