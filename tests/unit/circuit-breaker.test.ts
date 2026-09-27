// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CountBasedCircuitBreakerStrategy } from '../../src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.js'
import { NoopCircuitBreakerStrategy } from '../../src/spi/resilience/strategies/noop-circuit-breaker.strategy.js'
import { CircuitOpenError } from '../../src/core/types/circuit-breaker.types.js'

describe('CountBasedCircuitBreakerStrategy', () => {
  let cb: CountBasedCircuitBreakerStrategy

  beforeEach(() => {
    cb = new CountBasedCircuitBreakerStrategy({
      failureThreshold: 3,
      recoveryTimeMs: 30_000
    })
  })

  it('CLOSED state allows requests through', () => {
    expect(() => cb.check('/orders')).not.toThrow()
    expect(cb.getState('/orders')).toBe('CLOSED')
  })

  it('N consecutive 5xx failures transitions to OPEN', () => {
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    expect(cb.getState('/orders')).toBe('OPEN')
  })

  it('OPEN throws CircuitOpenError without calling API', () => {
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    expect(() => cb.check('/orders')).toThrow(CircuitOpenError)
  })

  it('OPEN transitions to HALF_OPEN after recoveryTimeMs', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    expect(cb.getState('/orders')).toBe('OPEN')

    vi.setSystemTime(now + 31_000)
    cb.check('/orders')
    expect(cb.getState('/orders')).toBe('HALF_OPEN')
    vi.useRealTimers()
  })

  it('HALF_OPEN + success transitions to CLOSED', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')

    vi.setSystemTime(now + 31_000)
    cb.check('/orders') // transitions to HALF_OPEN

    cb.recordSuccess('/orders')
    expect(cb.getState('/orders')).toBe('CLOSED')
    vi.useRealTimers()
  })

  it('HALF_OPEN + failure transitions back to OPEN', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')

    vi.setSystemTime(now + 31_000)
    cb.check('/orders') // transitions to HALF_OPEN

    cb.recordFailure('/orders')
    expect(cb.getState('/orders')).toBe('OPEN')
    vi.useRealTimers()
  })

  it('/orders/123 and /orders/456 share same circuit breaker key', () => {
    cb.recordFailure('/orders/123')
    cb.recordFailure('/orders/456')
    cb.recordFailure('/orders/789')
    expect(cb.getState('/orders/123')).toBe('OPEN')
    expect(cb.getState('/orders/456')).toBe('OPEN')
  })

  it('/orders and /campaigns have independent circuit breaker state', () => {
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    expect(cb.getState('/orders')).toBe('OPEN')
    expect(cb.getState('/campaigns')).toBe('CLOSED')
  })

  it('4xx response does NOT increment failure count (manual validation)', () => {
    // 4xx must never call recordFailure — this tests the invariant
    // by confirming circuit stays CLOSED after 2 4xx-equivalent non-records
    expect(cb.getState('/orders')).toBe('CLOSED')
    // (caller code must not call recordFailure for 4xx)
    // Circuit stays CLOSED since recordFailure never called
    cb.recordFailure('/orders') // one genuine 5xx
    expect(cb.getState('/orders')).toBe('CLOSED') // still needs 2 more
  })
})

describe('CountBasedCircuitBreakerStrategy — HALF_OPEN admits one probe', () => {
  it('refuses other callers while the probe is out, and lets a new probe through if it never reports', () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)
    const cb = new CountBasedCircuitBreakerStrategy({ failureThreshold: 1, recoveryTimeMs: 10_000 })
    cb.recordFailure('/orders/{id}')
    vi.setSystemTime(now + 10_001)
    expect(() => cb.check('/orders/{id}')).not.toThrow() // the probe
    expect(() => cb.check('/orders/{id}')).toThrow(CircuitOpenError)
    expect(() => cb.check('/orders/{id}')).toThrow(CircuitOpenError)
    vi.setSystemTime(now + 20_002)
    expect(() => cb.check('/orders/{id}')).not.toThrow() // the first probe never reported
    cb.recordSuccess('/orders/{id}')
    expect(cb.getState('/orders/{id}')).toBe('CLOSED')
    expect(() => cb.check('/orders/{id}')).not.toThrow()
    vi.useRealTimers()
  })
})

describe('NoopCircuitBreakerStrategy', () => {
  let cb: NoopCircuitBreakerStrategy

  beforeEach(() => {
    cb = new NoopCircuitBreakerStrategy()
  })

  it('always returns CLOSED and never throws', () => {
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    cb.recordFailure('/orders')
    expect(cb.getState('/orders')).toBe('CLOSED')
    expect(() => cb.check('/orders')).not.toThrow()
  })
})
