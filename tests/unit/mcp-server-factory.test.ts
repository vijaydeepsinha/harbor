// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { buildMcpServerOptions } from '../../runtime/http/mcp-server-factory.js'

describe('buildMcpServerOptions (spec §15/§16)', () => {
  const opts = buildMcpServerOptions()

  it('advertises only the tools capability Harbor implements', () => {
    expect(opts.capabilities).toEqual({ tools: {} })
    // Must NOT fabricate prompts/resources/logging capabilities.
    expect(opts.capabilities).not.toHaveProperty('prompts')
    expect(opts.capabilities).not.toHaveProperty('resources')
    expect(opts.capabilities).not.toHaveProperty('logging')
  })

  it('provides real instructions describing the 5-tool workflow', () => {
    const text = opts.instructions ?? ''
    for (const tool of ['discover_services', 'discover_skills', 'get_skill_details', 'search_code', 'api_execute']) {
      expect(text).toContain(tool)
    }
  })

  it('sets conservative, non-aggressive cache hints only for cacheable ops', () => {
    expect(opts.cacheHints).toEqual({
      'tools/list': { ttlMs: 0, cacheScope: 'private' },
      'server/discover': { ttlMs: 0, cacheScope: 'private' }
    })
    for (const hint of Object.values(opts.cacheHints ?? {})) {
      expect(hint.cacheScope).toBe('private') // never shared/public
      expect(hint.ttlMs).toBe(0) // no invented TTL
    }
  })
})
