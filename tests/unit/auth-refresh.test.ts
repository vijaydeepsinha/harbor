// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import { AuthMiddleware } from '../../spi/auth/auth-middleware.js'
import { OAuthIntrospectionStrategy } from '../../adapters/auth/strategies/oauth-introspection.strategy.js'
import { InMemoryTokenCache } from '../../adapters/auth/strategies/in-memory-token-cache.strategy.js'
import { CouchbaseTokenCache } from '../../adapters/auth/strategies/couchbase-token-cache.strategy.js'
import type { TokenPayload, AuthStrategy } from '../../core/types/auth.types.js'
import {
  TokenExpiredError,
  SessionExpiredError,
  TokenIntrospectionError
} from '../../core/types/auth.types.js'

vi.mock('axios')

const TOK = 'TestBearerTokenForE2ETestingOnly'

const makePayload = (overrides?: Partial<TokenPayload>): TokenPayload => ({
  access_token: 'valid-access',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'valid-refresh',
  scope: 'openid profile',
  ...overrides
})

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis()
})

// ── Response Mapping ─────────────────────────────────────────────────────────

describe('OAuthIntrospectionStrategy — response mapping', () => {
  it('resolves flat field names without responseMapping config', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000
    })

    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'flat-tok', expires_in: 1800, refresh_token: 'flat-ref', scope: 'all' }
    })

    const result = await strategy.validate('raw')
    expect(result.access_token).toBe('flat-tok')
    expect(result.expires_in).toBe(1800)
    expect(result.refresh_token).toBe('flat-ref')
  })

  it('resolves nested dot-path via responseMapping', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000,
      responseMapping: {
        access_token: 'tokenResponse.token',
        expires_in: 'tokenResponse.expiresIn',
        refresh_token: 'tokenResponse.refreshToken',
        scope: 'tokenResponse.scope'
      }
    })

    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        tokenResponse: {
          token: 'nested-tok',
          expiresIn: 3600,
          refreshToken: 'nested-ref',
          scope: 'openid profile'
        }
      }
    })

    const result = await strategy.validate('raw')
    expect(result.access_token).toBe('nested-tok')
    expect(result.expires_in).toBe(3600)
    expect(result.refresh_token).toBe('nested-ref')
    expect(result.scope).toBe('openid profile')
  })

  it('populates metadata from metadataMapping', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000,
      metadataMapping: { userId: 'userId', accountId: 'accountId' }
    })

    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        access_token: 'tok',
        expires_in: 3600,
        refresh_token: 'ref',
        scope: '',
        userId: 42,
        accountId: 99
      }
    })

    const result = await strategy.validate('raw')
    expect(result.metadata).toEqual({ userId: 42, accountId: 99 })
  })

  it('omits metadata key when metadataMapping is empty', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000
    })

    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok', expires_in: 3600, refresh_token: 'ref', scope: '' }
    })

    const result = await strategy.validate('raw')
    expect(result.metadata).toBeUndefined()
  })
})

// ── POST validate — tokenPassMode variants ───────────────────────────────────

describe('OAuthIntrospectionStrategy — POST validate tokenPassMode variants', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset()
    vi.mocked(axios.post).mockReset()
  })

  const validResponse = {
    status: 200,
    data: { access_token: 'tok', expires_in: 1800, scope: 'openid profile' }
  }

  it('method=POST + tokenPassMode=body sends token in JSON body', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000,
      method: 'POST',
      tokenPassMode: 'body',
      tokenParamName: 'access_token'
    })

    vi.mocked(axios.post).mockResolvedValueOnce(validResponse)

    await strategy.validate('raw-token')

    expect(axios.post).toHaveBeenCalledOnce()
    const [url, body, opts] = vi.mocked(axios.post).mock.calls[0]!
    expect(url).toContain('/oauth/auth')
    expect(body).toEqual({ access_token: 'raw-token' })
    expect((opts as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/json')
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('method=POST + tokenPassMode=header puts token on Authorization with empty body', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000,
      method: 'POST',
      tokenPassMode: 'header'
    })

    vi.mocked(axios.post).mockResolvedValueOnce(validResponse)

    await strategy.validate('raw-token')

    expect(axios.post).toHaveBeenCalledOnce()
    const [, body, opts] = vi.mocked(axios.post).mock.calls[0]!
    expect(body).toBeUndefined()
    const headers = (opts as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer raw-token')
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('method=POST + tokenPassMode=query (default) puts token in URL params', async () => {
    const strategy = new OAuthIntrospectionStrategy({
      host: 'auth.local',
      port: 8080,
      introspectionPath: '/oauth/auth',
      authTimeoutMs: 5000,
      method: 'POST'
    })

    vi.mocked(axios.post).mockResolvedValueOnce(validResponse)

    await strategy.validate('raw-token')

    const [, body, opts] = vi.mocked(axios.post).mock.calls[0]!
    expect(body).toBeUndefined()
    expect((opts as { params: Record<string, string> }).params).toEqual({ token: 'raw-token' })
  })
})

// ── Refresh Auth Header ──────────────────────────────────────────────────────

describe('OAuthIntrospectionStrategy — refresh with Authorization header', () => {
  const strategy = new OAuthIntrospectionStrategy({
    host: 'auth.local',
    port: 8080,
    introspectionPath: '/oauth/auth',
    authTimeoutMs: 5000,
    refreshPath: '/oauth/access_token'
  })

  beforeEach(() => vi.clearAllMocks())

  it('sends Authorization: Bearer header when currentAccessToken is provided', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'new-tok', expires_in: 3600, refresh_token: 'new-ref', scope: '' }
    })

    await strategy.refresh('my-refresh', 'current-access')

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/oauth/access_token'),
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer current-access'
        })
      })
    )
  })

  it('omits Authorization header when currentAccessToken is undefined', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'new-tok', expires_in: 3600, refresh_token: 'new-ref', scope: '' }
    })

    await strategy.refresh('my-refresh')

    const callArgs = vi.mocked(axios.post).mock.calls[0]!
    const headers = (callArgs[2] as { headers: Record<string, string> }).headers
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('throws TokenExpiredError on 401 from refresh endpoint', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 401, data: {} })
    await expect(strategy.refresh('my-refresh', 'current-access')).rejects.toThrow(TokenExpiredError)
  })
})

// ── AuthMiddleware — proactive refresh in cache-miss path ────────────────────

describe('AuthMiddleware — proactive refresh', () => {
  let cache: InMemoryTokenCache
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    cache = new InMemoryTokenCache(600_000)
    logger = makeLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cache.destroy()
    vi.useRealTimers()
  })

  it('refreshes proactively on cache hit when token is near expiry', async () => {
    const refreshedPayload = makePayload({ access_token: 'refreshed-tok' })
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 200 })),
      refresh: vi.fn().mockResolvedValue(refreshedPayload)
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')

    // First call — populate cache with a token expiring in 200s (within 300s buffer)
    const first = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-1')
    expect(first.payload.access_token).toBe('refreshed-tok')
    expect(authStrategy.refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes proactively on cache miss when freshly-validated token is near expiry', async () => {
    const nearExpiryPayload = makePayload({ expires_in: 120 })
    const refreshedPayload = makePayload({ access_token: 'miss-refresh-tok' })

    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(nearExpiryPayload),
      refresh: vi.fn().mockResolvedValue(refreshedPayload)
    }

    // Use a fresh cache — so this is a cache-miss path
    const freshCache = new InMemoryTokenCache(600_000)
    const middleware = new AuthMiddleware(authStrategy, freshCache, logger as never, 'test-service')

    const result = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-2')
    expect(result.payload.access_token).toBe('miss-refresh-tok')
    expect(authStrategy.refresh).toHaveBeenCalledTimes(1)
    freshCache.destroy()
  })

  it('does NOT refresh when token has plenty of time left', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 3600 })),
      refresh: vi.fn()
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')
    const result = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-3')

    expect(result.payload.access_token).toBe('valid-access')
    expect(authStrategy.refresh).not.toHaveBeenCalled()
  })

  it('passes currentAccessToken to refresh()', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 120, access_token: 'curr-tok' })),
      refresh: vi.fn().mockResolvedValue(makePayload({ access_token: 'new-tok' }))
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')
    await middleware.validateRequest(`Bearer ${TOK}`, 'cid-4')

    expect(authStrategy.refresh).toHaveBeenCalledWith('valid-refresh', 'curr-tok')
  })
})

// ── AuthMiddleware — SessionExpiredError ──────────────────────────────────────

describe('AuthMiddleware — session expiry', () => {
  let cache: InMemoryTokenCache
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    cache = new InMemoryTokenCache(600_000)
    logger = makeLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cache.destroy()
    vi.useRealTimers()
  })

  it('throws SessionExpiredError on cache miss when access token AND refresh token are both exhausted', async () => {
    // Auth server hands back a fully-expired token and the refresh call also fails
    // with TokenExpiredError. The cache-miss path must throw SessionExpiredError
    // rather than silently serving a dead token.
    const fullyExpiredPayload = makePayload({ expires_in: -1 })

    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(fullyExpiredPayload),
      refresh: vi.fn().mockRejectedValue(new TokenExpiredError())
    }

    const freshCache = new InMemoryTokenCache(600_000)
    const middleware = new AuthMiddleware(authStrategy, freshCache, logger as never, 'test-service')

    await expect(middleware.validateRequest(`Bearer ${TOK}`, 'cid-2')).rejects.toThrow(SessionExpiredError)
    freshCache.destroy()
  })

  it('falls back to existing token when refresh fails but access token is still valid', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 200 })),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')
    const result = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-3')

    // Refresh failed but token is still valid — returns the existing payload
    expect(result.payload.access_token).toBe('valid-access')
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── AuthMiddleware — background refresh on cache hit ─────────────────────────

describe('AuthMiddleware — background refresh on cache hit', () => {
  let cache: InMemoryTokenCache
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    cache = new InMemoryTokenCache(600_000)
    logger = makeLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cache.destroy()
    vi.useRealTimers()
  })

  it('cache hit in refresh window: returns cached payload immediately, refreshes in background', async () => {
    const cachedPayload = makePayload({ expires_in: 200, access_token: 'cached-tok' })
    await cache.update('test-service', TOK, cachedPayload)

    const refreshedPayload = makePayload({ access_token: 'refreshed-tok', expires_in: 3600 })
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockResolvedValue(refreshedPayload)
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')

    // First call: cache hit, still-valid token, returns cached payload immediately
    const first = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-1')
    expect(first.payload.access_token).toBe('cached-tok')
    expect(authStrategy.validate).not.toHaveBeenCalled()

    // Background refresh should have been kicked off; wait for it to settle
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))

    // Cache now carries the refreshed token; next call sees the new access_token
    const second = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-2')
    expect(second.payload.access_token).toBe('refreshed-tok')
  })

  it('cache hit outside refresh window: does NOT refresh', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 3600, access_token: 'cached-tok' }))

    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn()
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')
    const result = await middleware.validateRequest(`Bearer ${TOK}`, 'cid-1')

    expect(result.payload.access_token).toBe('cached-tok')
    expect(authStrategy.refresh).not.toHaveBeenCalled()
  })

  it('concurrent validateRequest calls in refresh window trigger only one background refresh', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))

    // Deferred refresh that stays pending so the single-flight window is visible
    let resolveRefresh: ((v: TokenPayload) => void) | null = null
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockImplementation(
        () =>
          new Promise<TokenPayload>((resolve) => {
            resolveRefresh = resolve
          })
      )
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')

    await Promise.all([
      middleware.validateRequest(`Bearer ${TOK}`, 'cid-1'),
      middleware.validateRequest(`Bearer ${TOK}`, 'cid-2'),
      middleware.validateRequest(`Bearer ${TOK}`, 'cid-3'),
      middleware.validateRequest(`Bearer ${TOK}`, 'cid-4'),
      middleware.validateRequest(`Bearer ${TOK}`, 'cid-5')
    ])

    // Despite 5 concurrent cache-hits in the window, the tracker coalesced them
    expect(authStrategy.refresh).toHaveBeenCalledTimes(1)

    // Resolve the pending refresh so the background task completes cleanly
    resolveRefresh?.(makePayload({ access_token: 'refreshed' }))
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))
  })

  it('after refresh failure, suppresses further refresh attempts for the cooldown window', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))

    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')

    // First call kicks off a refresh that fails in the background
    await middleware.validateRequest(`Bearer ${TOK}`, 'cid-1')
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))

    // 5s later — still inside the 30s cooldown, second call should NOT refresh
    vi.advanceTimersByTime(5_000)
    await middleware.validateRequest(`Bearer ${TOK}`, 'cid-2')
    await vi.advanceTimersByTimeAsync(0)
    expect(authStrategy.refresh).toHaveBeenCalledTimes(1)
  })

  it('refresh retries after the cooldown window elapses', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))

    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    const middleware = new AuthMiddleware(authStrategy, cache, logger as never, 'test-service')

    await middleware.validateRequest(`Bearer ${TOK}`, 'cid-1')
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))

    // Advance past the 30s cooldown; the cached token is still valid
    // (expires_in=200s, only 31s elapsed → 169s left, still inside 300s buffer)
    vi.advanceTimersByTime(31_000)

    await middleware.validateRequest(`Bearer ${TOK}`, 'cid-2')
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(2))
  })
})

// ── AuthMiddleware — metrics ─────────────────────────────────────────────────

describe('AuthMiddleware — metrics', () => {
  let cache: InMemoryTokenCache
  let logger: ReturnType<typeof makeLogger>
  let metrics: { increment: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    cache = new InMemoryTokenCache(600_000)
    logger = makeLogger()
    metrics = { increment: vi.fn() }
    vi.clearAllMocks()
  })

  afterEach(() => {
    cache.destroy()
    vi.useRealTimers()
  })

  const makeMiddleware = (authStrategy: AuthStrategy, c = cache) =>
    new AuthMiddleware(authStrategy, c, logger as never, 'test-service', metrics as never)

  it('emits auth_cache_total { outcome: hit } on cache hit', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 3600 }))
    const authStrategy: AuthStrategy = { name: 'test', validate: vi.fn(), refresh: vi.fn() }

    await makeMiddleware(authStrategy).validateRequest(`Bearer ${TOK}`, 'cid')

    expect(metrics.increment).toHaveBeenCalledWith('auth_cache_total', { outcome: 'hit' })
  })

  it('emits auth_cache_total { outcome: miss } on cache miss', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 3600 })),
      refresh: vi.fn()
    }

    await makeMiddleware(authStrategy).validateRequest(`Bearer ${TOK}`, 'cid')

    expect(metrics.increment).toHaveBeenCalledWith('auth_cache_total', { outcome: 'miss' })
  })

  it('emits auth_refresh_started + succeeded for background refresh', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockResolvedValue(makePayload())
    }

    await makeMiddleware(authStrategy).validateRequest(`Bearer ${TOK}`, 'cid')

    expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_started_total', { mode: 'background' })
    await vi.waitFor(() =>
      expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_succeeded_total', { mode: 'background' })
    )
  })

  it('emits auth_refresh_failed for background refresh error', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    await makeMiddleware(authStrategy).validateRequest(`Bearer ${TOK}`, 'cid')

    await vi.waitFor(() =>
      expect(metrics.increment).toHaveBeenCalledWith(
        'auth_refresh_failed_total',
        expect.objectContaining({ mode: 'background' })
      )
    )
  })

  it('emits auth_refresh_skipped { reason: inflight } on concurrent cache hits', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))

    let resolveRefresh: ((v: TokenPayload) => void) | null = null
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockImplementation(
        () =>
          new Promise<TokenPayload>((resolve) => {
            resolveRefresh = resolve
          })
      )
    }

    const mw = makeMiddleware(authStrategy)
    await Promise.all([
      mw.validateRequest(`Bearer ${TOK}`, 'cid-1'),
      mw.validateRequest(`Bearer ${TOK}`, 'cid-2'),
      mw.validateRequest(`Bearer ${TOK}`, 'cid-3')
    ])

    expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_skipped_total', {
      mode: 'background',
      reason: 'inflight'
    })

    resolveRefresh?.(makePayload())
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))
  })

  it('emits auth_refresh_skipped { reason: cooldown } after a recent failure', async () => {
    await cache.update('test-service', TOK, makePayload({ expires_in: 200 }))
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn(),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    const mw = makeMiddleware(authStrategy)
    await mw.validateRequest(`Bearer ${TOK}`, 'cid-1')
    await vi.waitFor(() => expect(authStrategy.refresh).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(0)

    vi.advanceTimersByTime(5_000)
    metrics.increment.mockClear()

    await mw.validateRequest(`Bearer ${TOK}`, 'cid-2')

    expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_skipped_total', {
      mode: 'background',
      reason: 'cooldown'
    })
  })

  it('emits auth_refresh_started + succeeded for sync refresh', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 120 })),
      refresh: vi.fn().mockResolvedValue(makePayload({ access_token: 'refreshed' }))
    }

    const freshCache = new InMemoryTokenCache(600_000)
    await makeMiddleware(authStrategy, freshCache).validateRequest(`Bearer ${TOK}`, 'cid')

    expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_started_total', { mode: 'sync' })
    expect(metrics.increment).toHaveBeenCalledWith('auth_refresh_succeeded_total', { mode: 'sync' })
    freshCache.destroy()
  })

  it('emits auth_refresh_failed for sync refresh error', async () => {
    const authStrategy: AuthStrategy = {
      name: 'test',
      tokenRefreshBufferSec: 300,
      validate: vi.fn().mockResolvedValue(makePayload({ expires_in: 120 })),
      refresh: vi.fn().mockRejectedValue(new TokenIntrospectionError())
    }

    const freshCache = new InMemoryTokenCache(600_000)
    await makeMiddleware(authStrategy, freshCache).validateRequest(`Bearer ${TOK}`, 'cid')

    expect(metrics.increment).toHaveBeenCalledWith(
      'auth_refresh_failed_total',
      expect.objectContaining({ mode: 'sync' })
    )
    freshCache.destroy()
  })
})

// ── CouchbaseTokenCache — cache resilience ───────────────────────────────────

const cbMocks = {
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  deleteDoc: vi.fn()
}

vi.mock('../../adapters/infra/couchbase-client.js', () => ({
  CouchbaseRestClient: vi.fn().mockImplementation(() => cbMocks)
}))

describe('CouchbaseTokenCache — error resilience', () => {
  let cacheInstance: CouchbaseTokenCache

  beforeEach(() => {
    cbMocks.getDoc.mockReset()
    cbMocks.setDoc.mockReset()
    cbMocks.deleteDoc.mockReset()

    cacheInstance = new CouchbaseTokenCache(300_000, {
      host: 'localhost',
      port: 8093,
      bucket: 'test',
      username: '',
      password: '',
      kvTimeoutMs: 3000
    })
  })

  it('readEntry returns undefined on Couchbase error instead of throwing', async () => {
    cbMocks.getDoc.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await cacheInstance.get('test-service', 'some-token')
    expect(result).toBeUndefined()
  })

  it('writeEntry swallows Couchbase error silently', async () => {
    cbMocks.setDoc.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(cacheInstance.update('test-service', 'some-token', makePayload())).resolves.toBeUndefined()
  })

  it('falls through to validator on cache read error', async () => {
    cbMocks.getDoc.mockRejectedValueOnce(new Error('timeout'))
    cbMocks.getDoc.mockRejectedValueOnce(new Error('timeout'))

    const validator = vi.fn().mockResolvedValue(makePayload())

    const result = await cacheInstance.getOrValidate('test-service', 'token', validator)
    expect(validator).toHaveBeenCalledTimes(1)
    expect(result.access_token).toBe('valid-access')
  })
})
