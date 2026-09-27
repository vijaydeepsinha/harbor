// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { AuthMiddleware } from '../../src/spi/auth/auth-middleware.js'
import { InMemoryTokenCache } from '../../src/adapters/auth/strategies/in-memory-token-cache.strategy.js'
import { hashAuthenticatedPrincipal } from '../../src/core/utils/user-id-hash.js'
import type { TokenPayload, AuthStrategy } from '../../src/core/types/auth.types.js'

const TOK = 'StableInboundBearerPresentedByTheCaller'

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis()
})

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('hashAuthenticatedPrincipal', () => {
  let cache: InMemoryTokenCache
  const t0 = Date.now()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    cache = new InMemoryTokenCache(600_000)
    vi.clearAllMocks()
  })
  afterEach(() => { cache.destroy(); vi.useRealTimers() })

  it('survives the silent token refresh that keeps a caller session seamless', async () => {
    // The caller presents one bearer for the whole flow; the middleware rotates
    // the backend token underneath so the human never re-authenticates. Identity
    // must not follow that rotation, or the owner of a paused execution is locked
    // out of it — permanently, since only finished executions are ever retained.
    const strategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue({
        access_token: 'backend-token-v1', token_type: 'bearer', expires_in: 600,
        refresh_token: 'r', scope: ''
      } satisfies TokenPayload),
      refresh: vi.fn().mockResolvedValue({
        access_token: 'backend-token-v2', token_type: 'bearer', expires_in: 3600,
        refresh_token: 'r', scope: ''
      } satisfies TokenPayload)
    }
    const mw = new AuthMiddleware(strategy, cache, makeLogger() as never, 'svc')

    const atCreate = await mw.validateRequest(`Bearer ${TOK}`, 'c1')
    expect(strategy.refresh).not.toHaveBeenCalled()

    // Time passes until the cached token enters the refresh window.
    vi.setSystemTime(t0 + 400_000)
    await mw.validateRequest(`Bearer ${TOK}`, 'c2')
    await flush()
    const atResume = await mw.validateRequest(`Bearer ${TOK}`, 'c3')

    // The premise: one bearer in, two different backend tokens out.
    expect(strategy.refresh).toHaveBeenCalled()
    expect(atResume.payload.access_token).not.toBe(atCreate.payload.access_token)

    // The guarantee: the principal is unchanged, so the owner keeps access.
    expect(hashAuthenticatedPrincipal(atResume.payload, TOK))
      .toBe(hashAuthenticatedPrincipal(atCreate.payload, TOK))
  })

  it('prefers metadata.userId, so one user converges across different bearers', () => {
    const a = hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: 'user-42' } }, 'bearer-terminal-1')
    const b = hashAuthenticatedPrincipal({ access_token: 'y', metadata: { userId: 'user-42' } }, 'bearer-terminal-2')
    expect(a).toBe(b)
    expect(a).toBe(createHash('sha256').update('user-42').digest('hex'))
  })

  it('separates distinct bearers and falls back to access_token when none is supplied', () => {
    expect(hashAuthenticatedPrincipal({ access_token: 'shared' }, 'bearer-alice'))
      .not.toBe(hashAuthenticatedPrincipal({ access_token: 'shared' }, 'bearer-mallory'))
    expect(hashAuthenticatedPrincipal({ access_token: 'only-this' }))
      .toBe(createHash('sha256').update('only-this').digest('hex'))
  })
})

describe('hashAuthenticatedPrincipal — only a scalar userId names a principal', () => {
  it('an object or array userId never collapses callers into one identity; it falls back to the caller\'s bearer', () => {
    const a = hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: { id: 1 } } }, 'bearer-a')
    const b = hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: { id: 2 } } }, 'bearer-b')
    expect(a).not.toBe(b)
    expect(a).toBe(hashAuthenticatedPrincipal({ access_token: 'x' }, 'bearer-a'))
    expect(hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: ['u'] } }, 'bearer-a')).toBe(a)
    expect(hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: '' } }, 'bearer-a')).toBe(a)
  })

  it('string and number ids still name the principal, whatever the bearer', () => {
    expect(hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: 'alice' } }, 'b1'))
      .toBe(hashAuthenticatedPrincipal({ access_token: 'y', metadata: { userId: 'alice' } }, 'b2'))
    expect(hashAuthenticatedPrincipal({ access_token: 'x', metadata: { userId: 42 } }, 'b1'))
      .toBe(hashAuthenticatedPrincipal({ access_token: 'y', metadata: { userId: 42 } }, 'b2'))
  })
})
