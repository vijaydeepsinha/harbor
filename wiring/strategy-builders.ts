// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenCacheStrategy } from '../core/types/auth.types.js'
import type { IdempotencyStrategy } from '../core/types/idempotency.types.js'
import type { SpecLoaderStrategy } from '../core/types/spec.types.js'
import type { IdempotencyBackendConfig, TokenCacheBackendConfig } from '../core/types/config.types.js'
import type { Logger } from '../core/types/logger.types.js'
import { inMemoryTokenCache } from '../adapters/auth/strategies/in-memory-token-cache.strategy.js'
import { memcacheTokenCache } from '../adapters/auth/strategies/memcache-token-cache.strategy.js'
import { couchbaseTokenCache } from '../adapters/auth/strategies/couchbase-token-cache.strategy.js'
import { noopIdempotency } from '../spi/idempotency/strategies/noop-idempotency.strategy.js'
import { inMemoryIdempotency } from '../adapters/idempotency/strategies/in-memory-idempotency.strategy.js'
import { memcacheIdempotency } from '../adapters/idempotency/strategies/memcache-idempotency.strategy.js'
import { couchbaseIdempotency } from '../adapters/idempotency/strategies/couchbase-idempotency.strategy.js'
import { fileSpec } from '../spi/spec/strategies/file-spec-loader.strategy.js'
import { urlSpec } from '../spi/spec/strategies/url-spec-loader.strategy.js'
import { urlWithFallback } from '../spi/spec/strategies/url-with-fallback-spec-loader.strategy.js'
import { STORE_TYPE } from '../core/constants.js'

// ── External backend registration ────────────────────────────────────────────
//
// OSS consumers can register custom token-cache or idempotency backends without
// forking this file. Call registerTokenCacheBackend / registerIdempotencyBackend
// once at startup (before createMcpGateway) with the type string that matches
// TOKEN_CACHE_TYPE / IDEMPOTENCY_TYPE env var values.
//
// Example (Redis token cache):
//   registerTokenCacheBackend('redis', (config, ttlMs, logger) => new RedisTokenCache(config, ttlMs))

export type TokenCacheFactory = (
  config: TokenCacheBackendConfig & Record<string, unknown>,
  tokenCacheTtlMs: number,
  logger?: Logger
) => TokenCacheStrategy

export type IdempotencyFactory = (
  config: IdempotencyBackendConfig & Record<string, unknown>,
  logger?: Logger
) => IdempotencyStrategy

const _tokenCacheRegistry = new Map<string, TokenCacheFactory>()
const _idempotencyRegistry = new Map<string, IdempotencyFactory>()

export function registerTokenCacheBackend(type: string, factory: TokenCacheFactory): void {
  _tokenCacheRegistry.set(type, factory)
}

export function registerIdempotencyBackend(type: string, factory: IdempotencyFactory): void {
  _idempotencyRegistry.set(type, factory)
}

// ── Builders ─────────────────────────────────────────────────────────────────

export function buildTokenCacheStrategy(
  config: TokenCacheBackendConfig | undefined,
  tokenCacheTtlMs: number,
  logger?: Logger
): TokenCacheStrategy {
  if (!config) return inMemoryTokenCache(tokenCacheTtlMs)

  const custom = _tokenCacheRegistry.get(config.type)
  if (custom) return custom(config as TokenCacheBackendConfig & Record<string, unknown>, tokenCacheTtlMs, logger)

  switch (config.type) {
    case STORE_TYPE.IN_MEMORY: return inMemoryTokenCache(tokenCacheTtlMs)
    case STORE_TYPE.MEMCACHE:  return memcacheTokenCache(tokenCacheTtlMs, config, logger)
    case STORE_TYPE.COUCHBASE: return couchbaseTokenCache(tokenCacheTtlMs, config, logger)
    default: throw new Error(`Unknown token cache type: "${(config as { type: string }).type}"`)
  }
}

export function buildIdempotencyStrategy(
  config: IdempotencyBackendConfig | undefined,
  logger?: Logger
): IdempotencyStrategy {
  if (!config) return noopIdempotency()

  const custom = _idempotencyRegistry.get(config.type)
  if (custom) return custom(config as IdempotencyBackendConfig & Record<string, unknown>, logger)

  switch (config.type) {
    case STORE_TYPE.NOOP:      return noopIdempotency()
    case STORE_TYPE.IN_MEMORY: return inMemoryIdempotency(logger)
    case STORE_TYPE.MEMCACHE:  return memcacheIdempotency(config, logger)
    case STORE_TYPE.COUCHBASE: return couchbaseIdempotency(config, logger)
    default: throw new Error(`Unknown idempotency type: "${(config as { type: string }).type}"`)
  }
}

export function buildSpecLoader(
  specSource: { type: 'file' | 'url' | 'url-with-fallback'; url?: string },
  specPath: string,
  logger?: Logger
): SpecLoaderStrategy {
  switch (specSource.type) {
    case 'file':
      return fileSpec(specPath)
    case 'url':
      if (!specSource.url) throw new Error('spec.url is required when spec.source is "url"')
      return urlSpec(specSource.url, undefined, logger)
    case 'url-with-fallback':
      if (!specSource.url) throw new Error('spec.url is required when spec.source is "url-with-fallback"')
      return urlWithFallback(specSource.url, specPath, undefined, logger)
  }
}
