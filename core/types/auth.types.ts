// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { ERR, type ErrCode } from '../constants.js'

export interface TokenPayload {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  /**
   * Optional — auth servers that don't rotate refresh tokens or that are
   * configured without `refreshPath` never populate this field. Callers MUST
   * guard with `if (!payload.refresh_token) return` before attempting a refresh.
   */
  refresh_token?: string
  scope: string
  metadata?: Record<string, unknown>
}

/**
 * Result of a successful auth validation. `invalidate` is a sealed handle
 * that evicts the cached entry keyed by the user's original bearer. Only
 * used by code paths that observe a token rejection downstream (e.g. the
 * api-client on a backend 401 with WWW-Authenticate: error="invalid_token").
 */
export interface AuthResult {
  payload: TokenPayload
  invalidate: () => Promise<void>
}

export interface AuthStrategy {
  readonly name: string
  validate(token: string): Promise<TokenPayload>
  refresh?(refreshToken: string, currentAccessToken?: string): Promise<TokenPayload>
  readonly tokenRefreshBufferSec?: number
}

export interface TokenCacheStrategy {
  readonly name: string
  hashToken(service: string, rawToken: string): string
  getOrValidate(
    service: string,
    rawToken: string,
    validatorFn: (token: string) => Promise<TokenPayload>
  ): Promise<TokenPayload>
  get(service: string, rawToken: string): Promise<{ payload: TokenPayload; expiresAt: number } | undefined>
  update(service: string, rawToken: string, payload: TokenPayload): Promise<void>
  invalidate(tokenHash: string): Promise<void>
  destroy(): void
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: ErrCode,
    readonly retryable: boolean,
    readonly context?: string
  ) {
    super(context ? `${message} [${context}]` : message)
    this.name = 'AuthError'
  }
}

export class TokenExpiredError extends AuthError {
  constructor(context?: string) {
    super('Token has expired. Re-authenticate and retry.', ERR.TOKEN_EXPIRED, false, context)
    this.name = 'TokenExpiredError'
  }
}

export class TokenInvalidError extends AuthError {
  constructor(context?: string) {
    super('Token is invalid or revoked.', ERR.TOKEN_INVALID, false, context)
    this.name = 'TokenInvalidError'
  }
}

export class TokenIntrospectionError extends AuthError {
  constructor(context?: string) {
    super('Auth server unreachable. Retry shortly.', ERR.INTROSPECTION_FAILED, true, context)
    this.name = 'TokenIntrospectionError'
  }
}

export class MissingTokenError extends AuthError {
  constructor(context?: string) {
    super(
      'No Authorization header. Provide: Authorization: Bearer <token>',
      ERR.MISSING_TOKEN,
      false,
      context
    )
    this.name = 'MissingTokenError'
  }
}

export class SessionExpiredError extends AuthError {
  constructor(context?: string) {
    super(
      'Your session has expired (max 12h). Please update your Bearer token in Client settings and retry.',
      ERR.SESSION_EXPIRED,
      false,
      context
    )
    this.name = 'SessionExpiredError'
  }
}
