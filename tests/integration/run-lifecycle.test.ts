// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * A run ends when its calls end, not when the program's function returns.
 * Calls the program started without awaiting them used to keep running
 * after api_execute had reported the execution finished — reaching the
 * backend, journaling, and on a slow store writing a stale RUNNING record
 * back over the finished one.
 */
import { describe, it, expect } from 'vitest'
import type { ConnectorAPI } from '../../src/spi/connector/connector-api.js'
import type { ExecutionPersistence } from '../../src/spi/execution/execution-store.js'
import { InMemoryExecutionStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { makeConnector, makeResources, makeRuntime, registerGoverned, makeCtx } from '../unit/code-mode-harness.js'
import { ACTIVITY_STATUS, EXECUTION_STATUS, EXECUTION_ID_META_KEY, GOVERNANCE_DECISION } from '../../src/core/constants.js'

const FINALIZE_NEEDS_APPROVAL = { name: 'finalize-needs-approval', version: 1, match: { operation: 'finalizeCampaign' }, action: { type: 'REQUIRE_APPROVAL' } }
const DENY_CREATE = { name: 'no-create', version: 1, match: { operation: 'createCampaign' }, action: { type: 'DENY', reason: 'no' } }

function slow(connector: ConnectorAPI, ms: number): ConnectorAPI {
  return { request: async (req, ctx) => { await new Promise(r => setTimeout(r, ms)); return connector.request(req, ctx) } }
}

/** Every store call takes a few ms, like a real shared store — enough for concurrent calls to interleave. */
function laggyStore(ms = 5): ExecutionPersistence {
  const innerPersistence = new InMemoryExecutionStore()
  return new Proxy(innerPersistence, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => { await new Promise(r => setTimeout(r, ms)); return (value as (...a: unknown[]) => unknown).apply(target, args) }
    }
  }) as ExecutionPersistence
}

const executionIdOf = (res: Record<string, unknown>) => (res['_meta'] as Record<string, string>)[EXECUTION_ID_META_KEY]!

describe('run lifecycle — calls the program did not await', () => {
  it('finish and are journaled before the execution is reported COMPLETED; nothing changes afterwards', async () => {
    const { connector, calls } = makeConnector()
    const runtime = makeRuntime([], GOVERNANCE_DECISION.ALLOW, laggyStore())
    const tool = registerGoverned(runtime, makeResources('trafficking', slow(connector, 80)))
    const res = await tool({ service: 'trafficking', code: `async () => {
      ['C1', 'C2'].forEach(async id => { await api.request({ method: 'POST', path: '/campaigns/' + id + '/finalize' }) })
      return 'returned early'
    }` }, makeCtx())
    const id = executionIdOf(res)
    expect(JSON.stringify(res['content'])).toContain('returned early')
    expect(calls.map(c => c.req.path)).toEqual(['/campaigns/C1/finalize', '/campaigns/C2/finalize'])
    const before = await runtime.executionManager.inspect(id)
    expect(before.execution.status).toBe(EXECUTION_STATUS.COMPLETED)
    expect(before.activities.map(a => a.status)).toEqual([ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.COMPLETED])
    await new Promise(r => setTimeout(r, 150))
    expect(await runtime.executionManager.inspect(id)).toEqual(before)
  })

  it('an un-awaited call that needs approval pauses the execution instead of leaving an orphan approval on a finished one', async () => {
    const { connector, calls } = makeConnector()
    const runtime = makeRuntime([FINALIZE_NEEDS_APPROVAL], GOVERNANCE_DECISION.ALLOW, laggyStore())
    const tool = registerGoverned(runtime, makeResources('trafficking', connector))
    const res = await tool({ service: 'trafficking', code: `async () => {
      api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      return 'returned early'
    }` }, makeCtx())
    expect(res['resultType']).toBe('input_required')
    const insp = await runtime.executionManager.inspect(executionIdOf(res))
    expect(insp.execution.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
    expect(insp.approvals.map(a => a.status)).toEqual(['PENDING'])
    expect(calls).toHaveLength(0)
  })

  it('a DENY stands when a concurrent sibling would have needed approval: the execution ends DENIED with no approval opened', async () => {
    const { connector, calls } = makeConnector()
    const runtime = makeRuntime([DENY_CREATE, FINALIZE_NEEDS_APPROVAL], GOVERNANCE_DECISION.ALLOW, laggyStore())
    const tool = registerGoverned(runtime, makeResources('trafficking', connector))
    const res = await tool({ service: 'trafficking', code: `async () => {
      const r = await Promise.allSettled([
        api.request({ method: 'POST', path: '/campaigns', body: { name: 'x' } }),
        api.request({ method: 'POST', path: '/campaigns/C1/finalize' })
      ])
      return r.map(x => x.status)
    }` }, makeCtx())
    const insp = await runtime.executionManager.inspect(executionIdOf(res))
    expect(insp.execution.status).toBe(EXECUTION_STATUS.DENIED)
    expect(insp.approvals).toHaveLength(0)
    expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.DENIED]])
    expect(calls).toHaveLength(0)
  })
})
