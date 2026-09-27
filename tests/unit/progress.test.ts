// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { ProgressCollector, extractTopLevelIds } from '../../src/runtime/observability/progress.js'
import { CallLog } from '../../src/runtime/execution/activity-journal.js'

describe('ProgressCollector — a projection of the run\'s call log', () => {
  const ok = (status: number, data: unknown = {}) => ({ status, ok: status < 400, data })
  const setup = (maxEntries = 100) => {
    const log = new CallLog()
    return { log, p: new ProgressCollector(log, maxEntries) }
  }

  it('starts empty', () => {
    const { p } = setup()
    expect(p.hasAny()).toBe(false)
    expect(p.summary()).toEqual({ completedCalls: 0, calls: [] })
  })

  it('records successful calls in completion order with monotonic indices', async () => {
    const { log, p } = setup()
    await log.recordResponse({ method: 'POST', endpoint: '/campaigns' }, ok(201))
    await log.recordResponse({ method: 'GET', endpoint: '/campaigns/{id}' }, ok(200))

    const s = p.summary()
    expect(s.completedCalls).toBe(2)
    expect(s.calls).toEqual([
      { i: 1, method: 'POST', endpoint: '/campaigns', status: 201, ok: true },
      { i: 2, method: 'GET', endpoint: '/campaigns/{id}', status: 200, ok: true }
    ])
  })

  it('attaches ids extracted from create responses (POST + ok only) and omits the field when there are none', async () => {
    const { log, p } = setup()
    await log.recordResponse({ method: 'POST', endpoint: '/campaigns' }, ok(201, { campaignId: 'C1', name: 'x' }))
    await log.recordResponse({ method: 'POST', endpoint: '/placements' }, ok(201, { name: 'no ids here' }))
    await log.recordResponse({ method: 'GET', endpoint: '/campaigns/{id}' }, ok(200, { id: 'C1' }))
    await log.recordResponse({ method: 'POST', endpoint: '/ads' }, ok(409, { id: 'dup' }))

    const s = p.summary()
    expect(s.calls[0]!.ids).toEqual({ campaignId: 'C1' })
    expect(s.calls[1]!.ids).toBeUndefined()
    expect(s.calls[2]!.ids).toBeUndefined()
    expect(s.calls[3]!.ids).toBeUndefined()
  })

  it('includes calls replayed from an earlier run, with their recorded status and ids', () => {
    const { log, p } = setup()
    log.recordReplayed({ method: 'POST', endpoint: '/campaigns' }, 1, ok(201, { id: 'C1' }))
    expect(p.summary()).toEqual({
      completedCalls: 1,
      calls: [{ i: 1, method: 'POST', endpoint: '/campaigns', status: 201, ok: true, ids: { id: 'C1' } }]
    })
  })

  it('records failures with truncated message and aborted flag, and they do not count as completed', async () => {
    const { log, p } = setup()
    const longMsg = 'x'.repeat(1000)
    await log.recordFailure({ method: 'POST', endpoint: '/ads' }, { code: 'API_ERROR', message: longMsg, aborted: true })

    const s = p.summary()
    expect(s.completedCalls).toBe(0)
    expect(s.calls).toHaveLength(1)
    const entry = s.calls[0]!
    expect(entry.method).toBe('POST')
    expect(entry.endpoint).toBe('/ads')
    expect(entry.aborted).toBe(true)
    expect(entry.status).toBeUndefined()
    expect(entry.ok).toBeUndefined()
    expect(entry.error).toBeDefined()
    expect(entry.error!.length).toBeLessThanOrEqual(200)
  })

  it('completedCalls counts entries with a status (any 2xx-5xx) and excludes failures', async () => {
    const { log, p } = setup()
    await log.recordResponse({ method: 'POST', endpoint: '/campaigns' }, ok(201))
    await log.recordResponse({ method: 'POST', endpoint: '/ads' }, ok(400)) // 4xx still counts as completed
    await log.recordFailure({ method: 'POST', endpoint: '/ads' }, { code: 'API_ERROR', message: 'network error', aborted: false }) // does not count

    expect(p.summary().completedCalls).toBe(2)
  })

  it('caps recorded entries at maxEntries (aligned with sandbox maxApiCalls)', async () => {
    const { log, p } = setup(100)
    for (let i = 0; i < 200; i++) await log.recordResponse({ method: 'GET', endpoint: '/x' }, ok(200))
    expect(p.summary().calls.length).toBe(100)
  })

  it('respects a smaller maxEntries from service config', async () => {
    const { log, p } = setup(25)
    for (let i = 0; i < 50; i++) await log.recordResponse({ method: 'GET', endpoint: '/x' }, ok(200))
    expect(p.summary().calls.length).toBe(25)
  })

  it('summary returns a defensive copy of the calls array', async () => {
    const { log, p } = setup()
    await log.recordResponse({ method: 'GET', endpoint: '/x' }, ok(200))
    const s = p.summary()
    s.calls.push({ i: 999, method: 'X', endpoint: '/x' })
    expect(p.summary().calls).toHaveLength(1)
  })
})

describe('extractTopLevelIds', () => {
  it('returns undefined for non-objects', () => {
    expect(extractTopLevelIds(null)).toBeUndefined()
    expect(extractTopLevelIds(undefined)).toBeUndefined()
    expect(extractTopLevelIds('foo')).toBeUndefined()
    expect(extractTopLevelIds(123)).toBeUndefined()
    expect(extractTopLevelIds([1, 2, 3])).toBeUndefined()
  })

  it('extracts the top-level "id" field', () => {
    expect(extractTopLevelIds({ id: 'C1', name: 'x' })).toEqual({ id: 'C1' })
  })

  it('extracts every top-level *Id field (camelCase suffix)', () => {
    const out = extractTopLevelIds({
      campaignId: 'C1',
      placementId: 'P9',
      advertiserId: 7,
      name: 'ignored',
      nested: { id: 'should-be-ignored' }
    })
    expect(out).toEqual({ campaignId: 'C1', placementId: 'P9', advertiserId: '7' })
  })

  it('matches id-like keys case-insensitively (whole id, *Id, *ID)', () => {
    expect(extractTopLevelIds({ ID: 'upper', CampaignID: 'mix' })).toEqual({
      ID: 'upper',
      CampaignID: 'mix'
    })
  })

  it('extracts uid and *Uid / snake_case *_uid', () => {
    expect(
      extractTopLevelIds({
        uid: 'u1',
        resourceUid: 'r1',
        external_uid: 's1',
        uuid: 'full-uuid'
      })
    ).toEqual({
      uid: 'u1',
      resourceUid: 'r1',
      external_uid: 's1',
      uuid: 'full-uuid'
    })
  })

  it('extracts snake_case *_id', () => {
    expect(extractTopLevelIds({ campaign_id: 'C1' })).toEqual({ campaign_id: 'C1' })
  })

  it('extracts camel *Uuid when the suffix uses capital U', () => {
    expect(extractTopLevelIds({ placementUuid: 'pu1' })).toEqual({ placementUuid: 'pu1' })
  })

  it('does not treat common English words ending in "id" as id keys', () => {
    expect(
      extractTopLevelIds({
        paid: 1,
        fluid: 'x',
        squid: 2,
        valid: true
      })
    ).toBeUndefined()
  })

  it('ignores non-string/number id values', () => {
    expect(extractTopLevelIds({ id: { value: 'C1' } })).toBeUndefined()
    expect(extractTopLevelIds({ id: ['C1'] })).toBeUndefined()
    expect(extractTopLevelIds({ id: true })).toBeUndefined()
  })

  it('truncates very long id values', () => {
    const longId = 'x'.repeat(500)
    const out = extractTopLevelIds({ id: longId })
    expect(out!.id.length).toBeLessThanOrEqual(128)
  })

  it('returns undefined when no id-like fields are present', () => {
    expect(extractTopLevelIds({ name: 'x', count: 3 })).toBeUndefined()
  })
})
