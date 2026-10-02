// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { ActivityJournal, CallLog } from '../../src/runtime/execution/activity-journal.js'
import { InMemoryExecutionStore } from '../../src/adapters/execution/in-memory-execution-store.js'
import { AuditCollector } from '../../src/runtime/observability/audit.js'
import { ProgressCollector } from '../../src/runtime/observability/progress.js'
import { ACTIVITY_STATUS } from '../../src/core/constants.js'

const LIST = { method: 'GET', endpoint: '/campaigns' } as const
const CREATE = { method: 'POST', endpoint: '/campaigns' } as const
const REQUEST = { method: 'POST', rawPath: '/campaigns', specPath: '/campaigns' } as const

describe('CallLog / ActivityJournal — one record per call; audit and progress are projections', () => {
  it('audit counts only calls executed in this run, in completion order (replays and failures are not calls made)', async () => {
    const log = new CallLog()
    log.recordReplayed(LIST, 1, { status: 200, ok: true, data: [] })
    await log.recordResponse(CREATE, { status: 201, ok: true, data: { id: 'C1' } })
    await log.recordFailure({ method: 'DELETE', endpoint: '/campaigns/{id}' }, { code: 'API_ERROR', message: 'reset', aborted: false })
    await log.recordResponse(LIST, { status: 404, ok: false, data: null })

    const audit = new AuditCollector(log)
    expect(audit.getEndpoints()).toEqual(['POST /campaigns', 'GET /campaigns'])
    expect(audit.getCallCount()).toBe(2)
    expect(new ProgressCollector(log, 10).summary().calls.map(c => c.endpoint)).toEqual(['/campaigns', '/campaigns', '/campaigns/{id}', '/campaigns'])
  })

  it('a journaled response is written once: the durable activity and the run outcome come from the same call', async () => {
    const persistence = new InMemoryExecutionStore()
    const journal = new ActivityJournal(persistence, 'exec-1', 'svc', 1)
    await journal.markExecuting(1, REQUEST)
    await journal.recordResponse(CREATE, { status: 201, ok: true, data: { id: 'C1' } }, 1)

    expect(await persistence.getActivity('exec-1', 1)).toMatchObject({ status: ACTIVITY_STATUS.COMPLETED, response: { status: 201, data: { id: 'C1' } } })
    expect(journal.entries()).toEqual([{ ...CREATE, outcome: 'EXECUTED', sequence: 1, response: { status: 201, ok: true, data: { id: 'C1' } } }])
    expect(new AuditCollector(journal).getEndpoints()).toEqual(['POST /campaigns'])
  })

  it('a failure marks the EXECUTING activity FAILED (outcome unknown); a failure before execution touches only the run outcome', async () => {
    const persistence = new InMemoryExecutionStore()
    const journal = new ActivityJournal(persistence, 'exec-1', 'svc', 1)
    await journal.markExecuting(1, REQUEST)
    await journal.recordFailure(CREATE, { code: 'API_ERROR', message: 'socket hang up', aborted: true }, 1)
    await journal.recordFailure(LIST, { code: 'CIRCUIT_OPEN', message: 'open', aborted: false })

    expect(await persistence.getActivity('exec-1', 1)).toMatchObject({ status: ACTIVITY_STATUS.FAILED, failure: { code: 'API_ERROR', message: 'socket hang up', outcomeKnown: false } })
    expect(await persistence.listActivities('exec-1')).toHaveLength(1)
    expect(journal.entries()).toEqual([
      { ...CREATE, outcome: 'FAILED', sequence: 1, error: 'socket hang up', aborted: true },
      { ...LIST, outcome: 'FAILED', error: 'open', aborted: false }
    ])
  })

  it('a store failure while recording FAILED is swallowed — the run is already failing — and the outcome is still logged', async () => {
    const journal = new ActivityJournal(new InMemoryExecutionStore(), 'exec-1', 'svc', 1)
    // Nothing journaled at #7, so the durable update cannot find its record.
    await expect(journal.recordFailure(CREATE, { code: 'API_ERROR', message: 'x', aborted: false }, 7)).resolves.toBeUndefined()
    expect(journal.entries()).toHaveLength(1)
  })
})
