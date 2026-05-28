// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {
  type TokenPayload,
  type AuthResult,
  type AuthStrategy,
  type TokenCacheStrategy,
  TokenExpiredError,
  SessionExpiredError
} from '../../core/types/auth.types.js'
import { extractBearerFromHeader } from './bearer-authorization.js'
import type { Logger } from '../../core/types/logger.types.js'
import type { MetricsCollector } from '../../core/types/metrics.types.js'
import { METRIC } from '../../core/constants.js'
import { ensureError, errorMessage, errorCode } from '../../core/utils/errors.js'

type StartDecision = { ok: true } | { ok: false; reason: 'inflight' | 'cooldown' }

/**
 * In-pod single-flight for proactive token refresh. Prevents concurrent
 * refreshes for the same token (a thundering herd at the IdP) and suppresses
 * retries for `cooldownMs` after a failure so a flapping auth server isn't
 * hammered on every incoming request.
 *
 * State is per-pod; sticky sessions in the LB ensure all requests for one
 * client land on the same pod, so no cross-pod coordination is needed.
 */
class InflightRefreshTracker {
  private readonly inflight = new Set<string>()
  private readonly recentFailures = new Map<string, number>()

  shouldStart(tokenHash: string, cooldownMs: number): StartDecision {
    // Opportunistic eviction: drop expired cooldown entries every time we
    // look at the map, so the map can't grow without bound in a long-lived
    // pod that sees many unique tokens.
    const now = Date.now()
    for (const [hash, failedAt] of this.recentFailures) {
      if (now - failedAt >= cooldownMs) this.recentFailures.delete(hash)
    }

    if (this.inflight.has(tokenHash)) return { ok: false, reason: 'inflight' }
    const lastFail = this.recentFailures.get(tokenHash)
    if (lastFail !== undefined && now - lastFail < cooldownMs) {
      return { ok: false, reason: 'cooldown' }
    }
    return { ok: true }
  }

  markStarted(tokenHash: string): void {
    this.inflight.add(tokenHash)
  }

  markSucceeded(tokenHash: string): void {
    this.inflight.delete(tokenHash)
    this.recentFailures.delete(tokenHash)
  }

  markFailed(tokenHash: string): void {
    this.inflight.delete(tokenHash)
    this.recentFailures.set(tokenHash, Date.now())
  }
}
// Cooldown period after a failed refresh attempt to prevent thundering herd.
const REFRESH_FAILURE_COOLDOWN_MS = 30_000

export class AuthMiddleware {
  private readonly tracker = new InflightRefreshTracker()

  constructor(
    private readonly authStrategy: AuthStrategy,
    private readonly tokenCacheStrategy: TokenCacheStrategy,
    private readonly logger: Logger,
    private readonly serviceName: string,
    private readonly metrics?: MetricsCollector
  ) {}

  extractBearerToken(authHeader: string | undefined): string {
    const result = extractBearerFromHeader(authHeader)
    if (result.ok) return result.token
    throw result.error
  }

  async validateRequest(
    authHeader: string | undefined,
    correlationId: string
  ): Promise<AuthResult> {
    const rawToken = this.extractBearerToken(authHeader)
    const tokenHash = this.tokenCacheStrategy.hashToken(this.serviceName, rawToken)
    const invalidate = () => this.tokenCacheStrategy.invalidate(tokenHash)

    try {
      const cached = await this.tokenCacheStrategy.get(this.serviceName, rawToken)

      if (cached) {
        this.metrics?.increment(METRIC.AUTH_CACHE, { outcome: 'hit' })
        // Cache entries from `.get()` are guaranteed not yet expired, so the
        // cached payload is always safe to serve. If it's inside the refresh
        // window, kick off a background refresh — the next request will see
        // the refreshed token. Current request returns immediately.
        this.maybeStartBackgroundRefresh(rawToken, tokenHash, cached.payload, cached.expiresAt, correlationId)
        return { payload: cached.payload, invalidate }
      }

      this.metrics?.increment(METRIC.AUTH_CACHE, { outcome: 'miss' })
      // Cache miss: introspect synchronously. If the freshly-validated token
      // is already near expiry (or past it), a synchronous refresh is the
      // correct move — we have no earlier cached fallback to serve.
      const payload = await this.tokenCacheStrategy.getOrValidate(
        this.serviceName,
        rawToken,
        (t) => this.authStrategy.validate(t)
      )
      const expiresAt = Date.now() + payload.expires_in * 1000
      const refreshed = await this.refreshIfNeededSync(rawToken, payload, expiresAt, correlationId)
      return { payload: refreshed ?? payload, invalidate }
    } catch (err) {
      const errObj = ensureError(err)
      this.logger.warn(
        {
          tokenHash,
          correlationId,
          errorCode: errorCode(err),
          message: errObj.message
        },
        'Auth validation failed'
      )
      throw err
    }
  }

  /**
   * Writes a refreshed token to the cache, swallowing any backend failure.
   * If the cache is down, the next request simply re-introspects — the
   * refresh itself already succeeded, so this write is strictly best-effort.
   */
  private async updateCacheBestEffort(rawToken: string, payload: TokenPayload): Promise<void> {
    try {
      await this.tokenCacheStrategy.update(this.serviceName, rawToken, payload)
    } catch (err) {
      this.logger.warn(
        {
          service: this.serviceName,
          errorCode: errorCode(err),
          error: errorMessage(err)
        },
        'Token cache update failed — next request will re-introspect'
      )
      this.metrics?.increment(METRIC.AUTH_CACHE_UPDATE_FAILED, { mode: 'background' })
    }
  }

  /**
   * Single source of truth for the "near expiry" predicate. `now` is exposed
   * so callers that need the same timestamp for follow-up checks (e.g. the
   * sync path's `tokenIsAlsoExpired`) can pass a captured value.
   */
  private isWithinRefreshWindow(expiresAt: number, now: number = Date.now()): boolean {
    const bufferMs = (this.authStrategy.tokenRefreshBufferSec ?? 300) * 1000
    return (expiresAt - now) <= bufferMs
  }

  private maybeStartBackgroundRefresh(
    rawToken: string,
    tokenHash: string,
    payload: TokenPayload,
    expiresAt: number,
    correlationId: string
  ): void {
    if (!this.authStrategy.refresh) return
    if (!payload.refresh_token) return
    if (!this.isWithinRefreshWindow(expiresAt)) return

    const decision = this.tracker.shouldStart(tokenHash, REFRESH_FAILURE_COOLDOWN_MS)
    if (!decision.ok) {
      this.metrics?.increment(METRIC.AUTH_REFRESH_SKIPPED, { mode: 'background', reason: decision.reason })
      return
    }

    this.tracker.markStarted(tokenHash)
    this.metrics?.increment(METRIC.AUTH_REFRESH_STARTED, { mode: 'background' })
    void this.runBackgroundRefresh(rawToken, tokenHash, payload, correlationId)
  }

  private async runBackgroundRefresh(
    rawToken: string,
    tokenHash: string,
    payload: TokenPayload,
    correlationId: string
  ): Promise<void> {
    const refresh = this.authStrategy.refresh
    if (!refresh || !payload.refresh_token) {
      this.tracker.markFailed(tokenHash)
      return
    }

    try {
      this.logger.info({ correlationId }, 'Token near expiry — refreshing in background')
      const refreshedToken = await refresh(payload.refresh_token, payload.access_token)
      this.metrics?.increment(METRIC.AUTH_REFRESH_SUCCEEDED, { mode: 'background' })
      await this.updateCacheBestEffort(rawToken, refreshedToken)
      this.tracker.markSucceeded(tokenHash)
    } catch (err) {
      this.tracker.markFailed(tokenHash)
      this.metrics?.increment(METRIC.AUTH_REFRESH_FAILED, { mode: 'background', errorType: errorCode(err) })
      this.logger.warn(
        { correlationId, error: errorMessage(err) },
        'Background token refresh failed — entering cooldown'
      )
    }
  }

  private async refreshIfNeededSync(
    rawToken: string,
    payload: TokenPayload,
    expiresAt: number,
    correlationId: string
  ): Promise<TokenPayload | null> {
    if (!this.authStrategy.refresh) return null
    if (!payload.refresh_token) return null

    const now = Date.now()
    if (!this.isWithinRefreshWindow(expiresAt, now)) return null

    this.metrics?.increment(METRIC.AUTH_REFRESH_STARTED, { mode: 'sync' })
    try {
      this.logger.info({ correlationId }, 'Token near expiry — refreshing synchronously (cache miss path)')
      const refreshedToken = await this.authStrategy.refresh(payload.refresh_token, payload.access_token)
      this.metrics?.increment(METRIC.AUTH_REFRESH_SUCCEEDED, { mode: 'sync' })
      await this.updateCacheBestEffort(rawToken, refreshedToken)
      return refreshedToken
    } catch (err) {
      this.metrics?.increment(METRIC.AUTH_REFRESH_FAILED, { mode: 'sync', errorType: errorCode(err) })
      // If the refresh token itself is expired AND the access token is also
      // past its expiry, the session is unrecoverable. Otherwise fall back to
      // the existing (still-valid) token for this request.
      if (err instanceof TokenExpiredError) {
        const tokenIsAlsoExpired = (expiresAt - now) <= 0
        if (tokenIsAlsoExpired) {
          this.logger.warn({ correlationId }, 'Session expired — refresh token and access token both exhausted')
          throw new SessionExpiredError('both access and refresh tokens expired')
        }
      }
      this.logger.warn(
        { correlationId, error: errorMessage(err) },
        'Proactive token refresh failed — using existing token'
      )
      return null
    }
  }
}
