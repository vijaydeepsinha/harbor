// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AuthStrategy, TokenPayload } from '../../../core/types/auth.types.js'
import { TokenIntrospectionError } from '../../../core/types/auth.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { AUTH_TYPE } from '../../../core/constants.js'
import { JwtValidationStrategy } from './jwt-validation.strategy.js'

export interface OAuthDiscoveryConfig {
  authorizationServer: string
  audience?: string
  clockToleranceSec?: number
  scopeClaim?: string
  metadataMapping?: Record<string, string>
  discoveryTimeoutMs?: number
  logger?: Logger
}

export class OAuthDiscoveryStrategy implements AuthStrategy {
  readonly name = AUTH_TYPE.OAUTH_2_1
  readonly tokenRefreshBufferSec = undefined

  private inner?: JwtValidationStrategy
  private initPromise?: Promise<void>
  private readonly config: OAuthDiscoveryConfig
  private readonly logger?: Logger

  constructor(config: OAuthDiscoveryConfig) {
    this.config = config
    this.logger = config.logger
  }

  async validate(rawToken: string): Promise<TokenPayload> {
    await this.ensureInitialized()
    return this.inner!.validate(rawToken)
  }

  private async ensureInitialized(): Promise<void> {
    if (this.inner) return
    if (!this.initPromise) {
      this.initPromise = this.discover()
    }
    return this.initPromise
  }

  private async discover(): Promise<void> {
    try {
      const jwksUri = await discoverJwksUri(
        this.config.authorizationServer,
        this.config.discoveryTimeoutMs ?? 10_000,
        this.logger
      )
      this.inner = new JwtValidationStrategy({
        jwksUri,
        issuer: this.config.authorizationServer,
        ...(this.config.audience !== undefined ? { audience: this.config.audience } : {}),
        ...(this.config.clockToleranceSec !== undefined ? { clockToleranceSec: this.config.clockToleranceSec } : {}),
        ...(this.config.scopeClaim !== undefined ? { scopeClaim: this.config.scopeClaim } : {}),
        ...(this.config.metadataMapping !== undefined ? { metadataMapping: this.config.metadataMapping } : {}),
        ...(this.logger !== undefined ? { logger: this.logger } : {}),
      })
    } catch (err) {
      this.initPromise = undefined
      if (err instanceof TokenIntrospectionError) throw err
      this.logger?.error({ err }, 'OAuth discovery failed')
      throw new TokenIntrospectionError()
    }
  }
}

async function discoverJwksUri(authorizationServer: string, timeoutMs: number, logger?: Logger): Promise<string> {
  const candidates = [
    `${authorizationServer}/.well-known/openid-configuration`,
    `${authorizationServer}/.well-known/oauth-authorization-server`,
  ]

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) continue
      const metadata = await res.json() as Record<string, unknown>
      if (typeof metadata.jwks_uri === 'string' && metadata.jwks_uri) {
        const asUrl = new URL(authorizationServer)
        const jwksUrl = new URL(metadata.jwks_uri)
        if (jwksUrl.protocol !== asUrl.protocol || jwksUrl.hostname !== asUrl.hostname) {
          // Log mismatch server-side only; do not surface URLs to callers.
          logger?.warn(
            { jwksHost: jwksUrl.hostname, asHost: asUrl.hostname },
            'SSRF guard: jwks_uri origin mismatch — rejecting'
          )
          throw new TokenIntrospectionError('jwks_uri origin mismatch')
        }
        return metadata.jwks_uri
      }
    } catch (err) {
      if (err instanceof TokenIntrospectionError) throw err
      // try next candidate
    }
  }

  logger?.warn(
    { authorizationServer },
    'Could not discover jwks_uri — both well-known endpoints failed or returned no jwks_uri'
  )
  throw new TokenIntrospectionError('authorization server metadata discovery failed')
}

export function oauthDiscovery(config: OAuthDiscoveryConfig): AuthStrategy {
  return new OAuthDiscoveryStrategy(config)
}
