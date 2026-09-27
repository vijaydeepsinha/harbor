// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { resolveOperation } from '../../src/runtime/governance/operation-resolver.js'
import type { OpenAPISpec } from '../../src/core/types/spec.types.js'

const spec: OpenAPISpec = {
  openapi: '3.0.3',
  info: { title: 'Trafficking', version: '1' },
  paths: {
    '/api/v1/tasks': { get: { operationId: 'listTasks' } },
    '/campaigns': { get: { operationId: 'listCampaigns' }, post: { operationId: 'createCampaign' } },
    '/campaigns/{id}': { get: { operationId: 'getCampaign' }, post: { operationId: 'updateCampaign' } },
    '/campaigns/{id}/activate': { post: { operationId: 'activateCampaign' } },
    '/campaigns/{campaignId}/creatives': { get: { operationId: 'listCreatives' } },
    '/users/{id}': { get: { operationId: 'getUser' } },
    '/users/me': { get: { operationId: 'getMe' } },
    '/bookings/{pnr}/cancel': { post: {} }
  }
}

describe('resolveOperation', () => {
  it('keeps version prefixes literal instead of collapsing them to {id}', () => {
    expect(resolveOperation(spec, 'GET', '/api/v1/tasks')).toEqual({
      specPath: '/api/v1/tasks', operationId: 'listTasks', pathParams: {}, matched: true
    })
  })

  it('captures template parameters by their declared names', () => {
    const r = resolveOperation(spec, 'POST', '/bookings/4213056789/cancel')
    expect(r.specPath).toBe('/bookings/{pnr}/cancel')
    expect(r.pathParams).toEqual({ pnr: '4213056789' })
    expect(r.operationId).toBeUndefined()
    expect(resolveOperation(spec, 'GET', '/campaigns/C123/creatives')).toMatchObject({
      specPath: '/campaigns/{campaignId}/creatives', operationId: 'listCreatives', pathParams: { campaignId: 'C123' }
    })
  })

  it('prefers the template with the most literal segments', () => {
    expect(resolveOperation(spec, 'GET', '/users/me').operationId).toBe('getMe')
    expect(resolveOperation(spec, 'GET', '/users/u-7')).toMatchObject({ operationId: 'getUser', pathParams: { id: 'u-7' } })
  })

  it('requires the method to exist on the matched path item', () => {
    expect(resolveOperation(spec, 'DELETE', '/campaigns/C1').matched).toBe(false)
    expect(resolveOperation(spec, 'POST', '/campaigns/C1')).toMatchObject({ operationId: 'updateCampaign', matched: true })
  })

  it('treats equivalent spellings identically (leading/trailing slash, query string)', () => {
    for (const p of ['/campaigns', 'campaigns', '/campaigns/', '/campaigns?status=active']) {
      expect(resolveOperation(spec, 'POST', p)).toMatchObject({ specPath: '/campaigns', operationId: 'createCampaign' })
    }
  })

  it('falls back to the normalized path, flagged unmatched, when the spec has no template', () => {
    expect(resolveOperation(spec, 'GET', '/unknown/123/thing')).toEqual({
      specPath: '/unknown/{id}/thing', pathParams: {}, matched: false
    })
    expect(resolveOperation({ openapi: '3.0.0', info: { title: 't', version: '1' } }, 'GET', '/x').matched).toBe(false)
  })

  it('decodes percent-encoded parameter values', () => {
    expect(resolveOperation(spec, 'GET', '/campaigns/a%20b').pathParams).toEqual({ id: 'a b' })
  })
})
