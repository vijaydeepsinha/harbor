// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { canonicalizeRequestPath } from '../../src/runtime/sandbox/request-path.js'

describe('canonicalizeRequestPath — one spelling for governance, journal and wire', () => {
  it.each([
    ['/orders/1', '/orders/1'],
    ['orders/1', '/orders/1'],                         // missing leading slash was always accepted
    ['/orders/', '/orders/'],                          // trailing slash kept
    ['/', '/'],
    ['/%6frders/%31', '/orders/1'],                    // unreserved escapes decoded
    ['/Orders/1', '/Orders/1'],                        // case is the resolver's business, not ours
    ['/stations/New Delhi', '/stations/New%20Delhi'],
    ['/stations/New%20Delhi', '/stations/New%20Delhi'],
    ['/v1/job-7:cancel', '/v1/job-7:cancel'],          // pchar stays literal
    ['/a/b@c/$x;y=1', '/a/b@c/$x;y=1'],
    ['/files/100%25', '/files/100%25'],                // a literal % stays encoded
    ['/q/a%2Bb', '/q/a+b']
  ])('%s → %s', (raw, expected) => {
    expect(canonicalizeRequestPath(raw, undefined)).toEqual({ ok: true, path: expected })
  })

  it.each([
    ['http://attacker.example/steal', 'not a URL'],
    ['HTTPS://attacker.example/x', 'not a URL'],
    ['//attacker.example/x', 'not a URL'],
    ['/orders\\1', 'backslash'],
    ['/orders/1#frag', 'fragment'],
    ['/orders/\t1', 'control characters'],
    ['/orders//1', 'empty segments'],
    ['/orders/./1', '"." or ".."'],
    ['/orders/x/../1', '"." or ".."'],
    ['/orders/%2e/1', '"." or ".."'],
    ['/orders/%2E%2E/admin', '"." or ".."'],
    ['/orders/.', '"." or ".."'],
    ['../other-api/orders', '"." or ".."'],
    ['/orders%2F1', 'encode "/"'],
    ['/orders%5C1', 'encode "/"'],
    ['/orders/%0a1', 'control characters'],
    ['/orders/%E0%A4%A', 'malformed percent-encoding']
  ])('refuses %s (%s)', (raw, why) => {
    const r = canonicalizeRequestPath(raw, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain(why)
  })

  it('moves a query string in the path into params, so query rules see it', () => {
    expect(canonicalizeRequestPath('/campaigns/C1?all=true&x=a+b', { page: 2 })).toEqual({
      ok: true, path: '/campaigns/C1', params: { page: 2, all: 'true', x: 'a b' }
    })
    expect(canonicalizeRequestPath('/tasks?', undefined)).toEqual({ ok: true, path: '/tasks' })
  })

  it('refuses a query key that repeats or is also in params — its wire form would be ambiguous', () => {
    expect(canonicalizeRequestPath('/tasks?tag=a&tag=b', undefined).ok).toBe(false)
    expect(canonicalizeRequestPath('/tasks?status=todo', { status: 'done' }).ok).toBe(false)
  })

  it('passes params through untouched when the path has no query', () => {
    const params = { status: 'todo' }
    expect(canonicalizeRequestPath('/tasks', params)).toEqual({ ok: true, path: '/tasks', params })
  })
})
