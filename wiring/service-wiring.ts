// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AuthStrategy } from '../core/types/auth.types.js'
import type { CircuitBreakerStrategy } from '../core/types/circuit-breaker.types.js'
import type { ServiceAuthConfig, ServiceCircuitBreakerConfig } from '../core/types/config.types.js'
import type { Logger } from '../core/types/logger.types.js'
import { AUTH_TYPE, CB_TYPE } from '../core/constants.js'
import { staticToken } from '../adapters/auth/strategies/static-token.strategy.js'
import { oauthIntrospection } from '../adapters/auth/strategies/oauth-introspection.strategy.js'
import { jwtValidation } from '../adapters/auth/strategies/jwt-validation.strategy.js'
import { oauthDiscovery } from '../adapters/auth/strategies/oauth-discovery.strategy.js'
import { noopCircuitBreaker } from '../spi/resilience/strategies/noop-circuit-breaker.strategy.js'
import { countBasedCircuitBreaker } from '../adapters/resilience/strategies/count-based-circuit-breaker.strategy.js'

export function resolveAuth(auth: ServiceAuthConfig | undefined, logger?: Logger): AuthStrategy {
  if (!auth) {
    throw new Error('config.auth is required — no placeholder fallback available')
  }

  switch (auth.type) {
    case AUTH_TYPE.STATIC_TOKEN:
      if (!auth.token) {
        throw new Error('config.auth.token is required for static-token auth')
      }
      return staticToken(auth.token)
    case AUTH_TYPE.OAUTH_INTROSPECTION:
      return oauthIntrospection({
        protocol: auth.protocol ?? 'http',
        host: auth.host,
        port: auth.port,
        introspectionPath: auth.introspectionPath,
        authTimeoutMs: auth.authTimeoutMs ?? 5000,
        method: auth.method,
        tokenPassMode: auth.tokenPassMode,
        tokenParamName: auth.tokenParamName,
        refreshPath: auth.refreshPath,
        tokenRefreshBufferSec: auth.tokenRefreshBufferSec,
        responseMapping: auth.responseMapping,
        metadataMapping: auth.metadataMapping,
      })
    case AUTH_TYPE.JWT_VALIDATION:
      return jwtValidation({
        jwksUri: auth.jwksUri,
        issuer: auth.issuer,
        ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
        ...(auth.clockToleranceSec !== undefined ? { clockToleranceSec: auth.clockToleranceSec } : {}),
        ...(auth.scopeClaim !== undefined ? { scopeClaim: auth.scopeClaim } : {}),
        ...(auth.metadataMapping !== undefined ? { metadataMapping: auth.metadataMapping } : {}),
        ...(logger !== undefined ? { logger } : {}),
      })
    case AUTH_TYPE.OAUTH_2_1:
      return oauthDiscovery({
        authorizationServer: auth.authorizationServer,
        ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
        ...(auth.clockToleranceSec !== undefined ? { clockToleranceSec: auth.clockToleranceSec } : {}),
        ...(auth.scopeClaim !== undefined ? { scopeClaim: auth.scopeClaim } : {}),
        ...(auth.metadataMapping !== undefined ? { metadataMapping: auth.metadataMapping } : {}),
        ...(auth.discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs: auth.discoveryTimeoutMs } : {}),
        ...(logger !== undefined ? { logger } : {}),
      })
  }
}

export function resolveCircuitBreaker(cb: ServiceCircuitBreakerConfig | undefined): CircuitBreakerStrategy {
  if (!cb || cb.type === CB_TYPE.NOOP) return noopCircuitBreaker()
  return countBasedCircuitBreaker({
    failureThreshold: cb.failureThreshold,
    recoveryTimeMs: cb.recoveryTimeMs
  })
}
