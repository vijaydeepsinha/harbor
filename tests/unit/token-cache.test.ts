// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryTokenCache } from '../../adapters/auth/strategies/in-memory-token-cache.strategy.js'
import type { TokenPayload } from '../../core/types/auth.types.js'

const SVC = 'test-service'

const makePayload = (expiresIn: number): TokenPayload => ({
  access_token: 'test-token',
  token_type: 'bearer',
  expires_in: expiresIn,
  refresh_token: 'refresh',
  scope: 'login_mode:self'
})

describe('InMemoryTokenCache', () => {
  let cache: InMemoryTokenCache
  const configTtlMs = 300_000

  beforeEach(() => {
    cache = new InMemoryTokenCache(configTtlMs)
  })

  it('cache hit returns payload without calling validator', async () => {
    const validator = vi.fn().mockResolvedValue(makePayload(3600))

    await cache.getOrValidate(SVC, 'my-token', validator)
    const result = await cache.getOrValidate(SVC, 'my-token', validator)

    expect(validator).toHaveBeenCalledTimes(1)
    expect(result.access_token).toBe('test-token')
  })

  it('cache miss calls validator and stores result', async () => {
    const validator = vi.fn().mockResolvedValue(makePayload(3600))

    const result = await cache.getOrValidate(SVC, 'new-token', validator)

    expect(validator).toHaveBeenCalledTimes(1)
    expect(result.access_token).toBe('test-token')
  })

  it('TTL = min(expires_in * 1000, configTtlMs)', async () => {
    // expires_in=60 → 60_000ms which is less than configTtlMs=300_000
    // So TTL should be 60_000ms
    const shortPayload = makePayload(60)
    const validator = vi.fn().mockResolvedValue(shortPayload)

    await cache.getOrValidate(SVC, 'short-token', validator)

    // Advance time past the 60 second TTL
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)

    const validator2 = vi.fn().mockResolvedValue(makePayload(3600))
    await cache.getOrValidate(SVC, 'short-token', validator2)

    expect(validator2).toHaveBeenCalledTimes(1) // re-validated
    vi.useRealTimers()
  })

  it('expired cache entry triggers fresh validation', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    const validator = vi.fn().mockResolvedValue(makePayload(10))
    await cache.getOrValidate(SVC, 'expiring-token', validator)

    // Advance past expiry
    vi.setSystemTime(now + 11_000)

    const validator2 = vi.fn().mockResolvedValue(makePayload(3600))
    await cache.getOrValidate(SVC, 'expiring-token', validator2)

    expect(validator2).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('invalidate() removes entry immediately', async () => {
    const validator = vi.fn().mockResolvedValue(makePayload(3600))

    await cache.getOrValidate(SVC, 'my-token', validator)

    const tokenHash = cache.hashToken(SVC, 'my-token')
    await cache.invalidate(tokenHash)

    const validator2 = vi.fn().mockResolvedValue(makePayload(3600))
    await cache.getOrValidate(SVC, 'my-token', validator2)

    expect(validator2).toHaveBeenCalledTimes(1)
  })
})
