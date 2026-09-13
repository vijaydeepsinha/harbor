// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import { readMcpRequestIdentity } from '../../runtime/http/mcp-request-identity.js'

describe('readMcpRequestIdentity (spec §13/§14)', () => {
  it('reads protocol version, method and name from headers', () => {
    const headers: IncomingHttpHeaders = {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'api_execute'
    }
    expect(readMcpRequestIdentity(headers)).toEqual({
      protocolVersion: '2026-07-28',
      method: 'tools/call',
      name: 'api_execute'
    })
  })

  it('returns an empty identity when the headers are absent', () => {
    expect(readMcpRequestIdentity({})).toEqual({})
  })

  it('takes the first value when a header arrives as an array', () => {
    const headers: IncomingHttpHeaders = { 'mcp-method': ['tools/list', 'ping'] }
    expect(readMcpRequestIdentity(headers).method).toBe('tools/list')
  })

  it('omits keys for empty header values', () => {
    const headers: IncomingHttpHeaders = { 'mcp-method': '' }
    expect(readMcpRequestIdentity(headers)).toEqual({})
  })
})
