// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthStrategy, TokenPayload } from '../../../core/types/auth.types.js'
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../../core/types/auth.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { AUTH_TYPE } from '../../../core/constants.js'
import { requireResourceBindingAudience } from './resource-binding.js'

export interface JwtValidationConfig {
  jwksUri: string
  issuer: string
  /**
   * Canonical resource identifier this gateway accepts tokens for (RFC 8707
   * resource indicator / JWT `aud`). REQUIRED under MCP 2026-07-28 (spec §17):
   * the resource server MUST reject tokens not bound to it, otherwise a token
   * minted for another resource behind the same authorization server would be
   * accepted here (confused-deputy / token pass-through). Set this to the value
   * Harbor advertises as `resource` in its Protected Resource Metadata.
   */
  audience: string
  clockToleranceSec?: number
  scopeClaim?: string
  metadataMapping?: Record<string, string>
  logger?: Logger
}

export class JwtValidationStrategy implements AuthStrategy {
  readonly name = AUTH_TYPE.JWT_VALIDATION
  readonly tokenRefreshBufferSec = undefined

  private readonly JWKS: ReturnType<typeof createRemoteJWKSet>
  private readonly config: JwtValidationConfig
  private readonly logger?: Logger

  constructor(config: JwtValidationConfig) {
    // Fail closed on missing resource binding (spec §17, RFC 8707). Without an
    // audience, JWT verification would accept any `aud`, defeating
    // resource-binding — so this is a misconfiguration, not a soft default.
    requireResourceBindingAudience(
      config.audience,
      'jwt-validation auth requires `audience` (resource binding) under MCP 2026-07-28'
    )
    this.config = config
    this.logger = config.logger
    this.JWKS = createRemoteJWKSet(new URL(config.jwksUri), {
      cooldownDuration: 30_000,
      cacheMaxAge: 3_600_000
    })
  }

  async validate(rawToken: string): Promise<TokenPayload> {
    try {
      const { payload } = await jwtVerify(rawToken, this.JWKS, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSec ?? 30,
      })
      return this.mapClaims(payload as Record<string, unknown>, rawToken)
    } catch (err) {
      const name = (err as Error).name
      if (name === 'JWTExpired')                     throw new TokenExpiredError('JWT exp claim exceeded')
      if (name === 'JWTClaimValidationFailed') {
        // Log the specific failing claim server-side only (e.g. "unexpected
        // \"aud\" claim value" would tell an attacker iterating on a
        // confused-deputy attempt exactly which claim to fix next); the
        // client only ever sees a generic, non-specific rejection reason —
        // consistent with the other branches below.
        this.logger?.warn({ err: (err as Error).message }, 'JWT claim validation failed')
        throw new TokenInvalidError('claim validation failed')
      }
      if (name === 'JWSSignatureVerificationFailed') throw new TokenInvalidError('signature invalid')
      if (name === 'JWSInvalid')                     throw new TokenInvalidError('malformed JWT structure')
      this.logger?.error({ err }, 'Unexpected JWT validation error')
      throw new TokenIntrospectionError()
    }
  }

  private mapClaims(payload: Record<string, unknown>, rawToken: string): TokenPayload {
    const exp = payload['exp'] as number | undefined
    const now = Math.floor(Date.now() / 1000)
    const expiresIn = exp !== undefined ? exp - now : 3600

    if (expiresIn <= 0) throw new TokenExpiredError('JWT already expired at validation time')

    const scopeClaim = this.config.scopeClaim ?? 'scope'
    const rawScope = payload[scopeClaim]
    const scope = typeof rawScope === 'string'
      ? rawScope
      : Array.isArray(rawScope) ? (rawScope as string[]).join(' ') : ''

    const metadata: Record<string, unknown> = {}
    for (const [key, claimName] of Object.entries(this.config.metadataMapping ?? {})) {
      if (payload[claimName] !== undefined) metadata[key] = payload[claimName]
    }

    return {
      access_token: rawToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    }
  }
}

export function jwtValidation(config: JwtValidationConfig): AuthStrategy {
  return new JwtValidationStrategy(config)
}
