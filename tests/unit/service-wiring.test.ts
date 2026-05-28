// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { resolveAuth, resolveCircuitBreaker } from '../../wiring/service-wiring.js'
import { AUTH_TYPE, CB_TYPE } from '../../core/constants.js'
import { StaticTokenAuthStrategy } from '../../adapters/auth/strategies/static-token.strategy.js'
import { NoopCircuitBreakerStrategy } from '../../spi/resilience/strategies/noop-circuit-breaker.strategy.js'
import { CountBasedCircuitBreakerStrategy } from '../../adapters/resilience/strategies/count-based-circuit-breaker.strategy.js'

describe('resolveAuth', () => {
  it('throws when auth config is undefined', () => {
    expect(() => resolveAuth(undefined)).toThrow('config.auth is required')
  })

  it('returns StaticTokenAuthStrategy for static-token type', () => {
    const strategy = resolveAuth({ type: AUTH_TYPE.STATIC_TOKEN, token: 'secret' })
    expect(strategy).toBeInstanceOf(StaticTokenAuthStrategy)
  })

  it('throws when static-token type has no token', () => {
    expect(() =>
      resolveAuth({ type: AUTH_TYPE.STATIC_TOKEN } as never)
    ).toThrow('config.auth.token is required for static-token auth')
  })
})

describe('resolveCircuitBreaker', () => {
  it('returns NoopCircuitBreakerStrategy when config is undefined', () => {
    const cb = resolveCircuitBreaker(undefined)
    expect(cb).toBeInstanceOf(NoopCircuitBreakerStrategy)
    expect(cb.name).toBe(CB_TYPE.NOOP)
  })

  it('returns NoopCircuitBreakerStrategy for noop type', () => {
    const cb = resolveCircuitBreaker({ type: CB_TYPE.NOOP })
    expect(cb).toBeInstanceOf(NoopCircuitBreakerStrategy)
  })

  it('returns CountBasedCircuitBreakerStrategy for count-based type', () => {
    const cb = resolveCircuitBreaker({
      type: CB_TYPE.COUNT_BASED,
      failureThreshold: 5,
      recoveryTimeMs: 30_000
    })
    expect(cb).toBeInstanceOf(CountBasedCircuitBreakerStrategy)
    expect(cb.name).toBe(CB_TYPE.COUNT_BASED)
  })
})
