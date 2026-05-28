// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import {
  buildTokenCacheStrategy,
  buildIdempotencyStrategy,
  buildSpecLoader,
  registerTokenCacheBackend,
  registerIdempotencyBackend
} from '../../wiring/strategy-builders.js'
import { STORE_TYPE } from '../../core/constants.js'
import { InMemoryTokenCache } from '../../adapters/auth/strategies/in-memory-token-cache.strategy.js'
import { InMemoryIdempotencyStrategy } from '../../adapters/idempotency/strategies/in-memory-idempotency.strategy.js'
import { NoopIdempotencyStrategy } from '../../spi/idempotency/strategies/noop-idempotency.strategy.js'

vi.mock('memjs', () => ({
  default: { Client: { create: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })) } }
}))

describe('buildTokenCacheStrategy', () => {
  it('defaults to InMemoryTokenCache when config is undefined', () => {
    const strategy = buildTokenCacheStrategy(undefined, 300_000)
    expect(strategy).toBeInstanceOf(InMemoryTokenCache)
  })

  it('returns InMemoryTokenCache for in-memory type', () => {
    const strategy = buildTokenCacheStrategy({ type: STORE_TYPE.IN_MEMORY }, 300_000)
    expect(strategy).toBeInstanceOf(InMemoryTokenCache)
    expect(strategy.name).toBe(STORE_TYPE.IN_MEMORY)
  })

  it('throws on unknown type', () => {
    expect(() =>
      buildTokenCacheStrategy({ type: 'unknown-type' } as never, 300_000)
    ).toThrow('Unknown token cache type: "unknown-type"')
  })

  it('custom registration takes precedence over built-in', () => {
    const mockStrategy = { name: 'custom-tc', getOrValidate: vi.fn(), get: vi.fn(), update: vi.fn(), invalidate: vi.fn(), destroy: vi.fn() }
    registerTokenCacheBackend('custom-tc', () => mockStrategy)
    const result = buildTokenCacheStrategy({ type: 'custom-tc' } as never, 300_000)
    expect(result).toBe(mockStrategy)
  })
})

describe('buildIdempotencyStrategy', () => {
  it('defaults to NoopIdempotencyStrategy when config is undefined', () => {
    const strategy = buildIdempotencyStrategy(undefined)
    expect(strategy).toBeInstanceOf(NoopIdempotencyStrategy)
  })

  it('returns NoopIdempotencyStrategy for noop type', () => {
    const strategy = buildIdempotencyStrategy({ type: STORE_TYPE.NOOP })
    expect(strategy).toBeInstanceOf(NoopIdempotencyStrategy)
    expect(strategy.name).toBe(STORE_TYPE.NOOP)
  })

  it('returns InMemoryIdempotencyStrategy for in-memory type', () => {
    const strategy = buildIdempotencyStrategy({ type: STORE_TYPE.IN_MEMORY })
    expect(strategy).toBeInstanceOf(InMemoryIdempotencyStrategy)
  })

  it('throws on unknown type', () => {
    expect(() =>
      buildIdempotencyStrategy({ type: 'unknown-idp' } as never)
    ).toThrow('Unknown idempotency type: "unknown-idp"')
  })

  it('custom registration takes precedence over built-in', () => {
    const mockStrategy = { name: 'custom-idp', checkAndExecute: vi.fn(), generateKey: vi.fn() }
    registerIdempotencyBackend('custom-idp', () => mockStrategy)
    const result = buildIdempotencyStrategy({ type: 'custom-idp' } as never)
    expect(result).toBe(mockStrategy)
  })
})

describe('buildSpecLoader', () => {
  it('returns a SpecLoaderStrategy for file type', () => {
    const loader = buildSpecLoader({ type: 'file' }, '/some/spec.yaml')
    expect(loader).toBeDefined()
    expect(typeof loader.load).toBe('function')
  })

  it('throws when url type is used without url field', () => {
    expect(() =>
      buildSpecLoader({ type: 'url' }, '/some/spec.yaml')
    ).toThrow('spec.url is required')
  })

  it('throws when url-with-fallback type is used without url field', () => {
    expect(() =>
      buildSpecLoader({ type: 'url-with-fallback' }, '/some/spec.yaml')
    ).toThrow('spec.url is required')
  })
})
