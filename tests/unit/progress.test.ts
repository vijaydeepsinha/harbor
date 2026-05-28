// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { ProgressCollector, extractTopLevelIds } from '../../runtime/observability/progress.js'

describe('ProgressCollector', () => {
  it('starts empty', () => {
    const p = new ProgressCollector(100)
    expect(p.hasAny()).toBe(false)
    expect(p.summary()).toEqual({ completedCalls: 0, calls: [] })
  })

  it('records successful calls in completion order with monotonic indices', () => {
    const p = new ProgressCollector(100)
    p.recordSuccess('POST', '/campaigns', 201, true)
    p.recordSuccess('GET', '/campaigns/{id}', 200, true)

    const s = p.summary()
    expect(s.completedCalls).toBe(2)
    expect(s.calls).toEqual([
      { i: 1, method: 'POST', endpoint: '/campaigns', status: 201, ok: true },
      { i: 2, method: 'GET', endpoint: '/campaigns/{id}', status: 200, ok: true }
    ])
  })

  it('attaches ids when provided and omits the field when empty', () => {
    const p = new ProgressCollector(100)
    p.recordSuccess('POST', '/campaigns', 201, true, { campaignId: 'C1' })
    p.recordSuccess('POST', '/placements', 201, true, {})

    const s = p.summary()
    expect(s.calls[0]!.ids).toEqual({ campaignId: 'C1' })
    expect(s.calls[1]!.ids).toBeUndefined()
  })

  it('records failures with truncated message and aborted flag, and they do not count as completed', () => {
    const p = new ProgressCollector(100)
    const longMsg = 'x'.repeat(1000)
    p.recordFailure('POST', '/ads', longMsg, true)

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

  it('completedCalls counts entries with a status (any 2xx-5xx) and excludes failures', () => {
    const p = new ProgressCollector(100)
    p.recordSuccess('POST', '/campaigns', 201, true)
    p.recordSuccess('POST', '/ads', 400, false) // 4xx still counts as completed
    p.recordFailure('POST', '/ads', 'network error', false) // does not count

    expect(p.summary().completedCalls).toBe(2)
  })

  it('caps recorded entries at maxEntries (aligned with sandbox maxApiCalls)', () => {
    const p = new ProgressCollector(100)
    for (let i = 0; i < 200; i++) p.recordSuccess('GET', '/x', 200, true)
    expect(p.summary().calls.length).toBe(100)
  })

  it('respects a smaller maxEntries from service config', () => {
    const p = new ProgressCollector(25)
    for (let i = 0; i < 50; i++) p.recordSuccess('GET', '/x', 200, true)
    expect(p.summary().calls.length).toBe(25)
  })

  it('summary returns a defensive copy of the calls array', () => {
    const p = new ProgressCollector(100)
    p.recordSuccess('GET', '/x', 200, true)
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
