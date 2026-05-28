// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import {
  StaticTokenAuthStrategy,
  staticToken
} from '../../adapters/auth/strategies/static-token.strategy.js'
import { AUTH_TYPE } from '../../core/constants.js'

describe('StaticTokenAuthStrategy', () => {
  it('advertises the static-token strategy name', () => {
    const s = new StaticTokenAuthStrategy('fallback-tok')
    expect(s.name).toBe(AUTH_TYPE.STATIC_TOKEN)
  })

  it('validate() returns the client-supplied token verbatim when present', async () => {
    const s = new StaticTokenAuthStrategy('fallback-tok')
    const payload = await s.validate('client-tok')

    expect(payload.access_token).toBe('client-tok')
    expect(payload.token_type).toBe('bearer')
    expect(payload.expires_in).toBeGreaterThan(0)
    expect(payload.scope).toBe('login_mode:self')
  })

  it('validate() substitutes the fallback token when the raw token is empty', async () => {
    const s = new StaticTokenAuthStrategy('fallback-tok')
    const payload = await s.validate('')
    expect(payload.access_token).toBe('fallback-tok')
  })

  it('does not expose a refresh() hook — this strategy cannot refresh', () => {
    const s = new StaticTokenAuthStrategy('fallback-tok')
    expect((s as Partial<{ refresh: unknown }>).refresh).toBeUndefined()
  })

  it('staticToken() factory returns a configured strategy instance', async () => {
    const s = staticToken('factory-tok')
    expect(s.name).toBe(AUTH_TYPE.STATIC_TOKEN)
    const payload = await s.validate('')
    expect(payload.access_token).toBe('factory-tok')
  })
})
