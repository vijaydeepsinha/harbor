// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenCacheStrategy } from '../core/types/auth.types.js'
import type { IdempotencyStrategy } from '../core/types/idempotency.types.js'
import type { SpecLoaderStrategy } from '../core/types/spec.types.js'
import type { IdempotencyBackendConfig, TokenCacheBackendConfig, ExecutionStoreBackendConfig, CodeModeConfig } from '../core/types/config.types.js'
import type { CodeModeStore } from '../spi/execution/execution-store.js'
import { inMemoryCodeModeStore } from '../adapters/execution/in-memory-execution-store.js'
import { fileCodeModeStore } from '../adapters/execution/file-execution-store.js'
import { memcacheCodeModeStore } from '../adapters/execution/memcache-execution-store.js'
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
import type { GovernanceRuleSource } from '../spi/governance/rule-source.js'
import { DirectoryRuleSourceStrategy } from '../spi/governance/strategies/directory-rule-source.strategy.js'
import { UrlRuleSourceStrategy } from '../spi/governance/strategies/url-rule-source.strategy.js'
import { STORE_TYPE, EXECUTION_STORE_TYPE, GOVERNANCE_RULE_SOURCE_TYPE } from '../core/constants.js'

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

export type ExecutionStoreFactory = (
  config: ExecutionStoreBackendConfig & Record<string, unknown>,
  logger?: Logger
) => CodeModeStore

export type GovernanceRuleSourceFactory = (
  config: CodeModeConfig['governance'],
  logger?: Logger
) => GovernanceRuleSource

const _tokenCacheRegistry = new Map<string, TokenCacheFactory>()
const _executionStoreRegistry = new Map<string, ExecutionStoreFactory>()
const _idempotencyRegistry = new Map<string, IdempotencyFactory>()
const _ruleSourceRegistry = new Map<string, GovernanceRuleSourceFactory>()

export function registerTokenCacheBackend(type: string, factory: TokenCacheFactory): void {
  _tokenCacheRegistry.set(type, factory)
}

export function registerIdempotencyBackend(type: string, factory: IdempotencyFactory): void {
  _idempotencyRegistry.set(type, factory)
}

/** Register a custom Code Mode execution store (e.g. Postgres, Redis) keyed by the EXECUTION_STORE_TYPE value. */
export function registerExecutionStoreBackend(type: string, factory: ExecutionStoreFactory): void {
  _executionStoreRegistry.set(type, factory)
}

/** Register a custom Governance Rule source (e.g. object storage, a config service) keyed by the GOVERNANCE_RULES_SOURCE value. */
export function registerGovernanceRuleSourceBackend(type: string, factory: GovernanceRuleSourceFactory): void {
  _ruleSourceRegistry.set(type, factory)
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

export function buildExecutionStore(
  config: ExecutionStoreBackendConfig | undefined,
  logger?: Logger
): CodeModeStore {
  if (!config) return inMemoryCodeModeStore()

  const custom = _executionStoreRegistry.get(config.type)
  if (custom) return custom(config as ExecutionStoreBackendConfig & Record<string, unknown>, logger)

  switch (config.type) {
    case EXECUTION_STORE_TYPE.IN_MEMORY: return inMemoryCodeModeStore()
    case EXECUTION_STORE_TYPE.FILE:      return fileCodeModeStore(config.dir, logger)
    case EXECUTION_STORE_TYPE.MEMCACHE:  return memcacheCodeModeStore(config)
    default: throw new Error(`Unknown execution store type: "${(config as { type: string }).type}"`)
  }
}

export function buildGovernanceRuleSource(
  config: CodeModeConfig['governance'],
  logger?: Logger
): GovernanceRuleSource {
  const type = config.rulesSource ?? GOVERNANCE_RULE_SOURCE_TYPE.DIR

  const custom = _ruleSourceRegistry.get(type)
  if (custom) return custom(config, logger)

  switch (type) {
    case GOVERNANCE_RULE_SOURCE_TYPE.DIR:
      return new DirectoryRuleSourceStrategy(config.rulesDir, logger)
    case GOVERNANCE_RULE_SOURCE_TYPE.URL:
      if (!config.rulesUrl) throw new Error('GOVERNANCE_RULES_URL is required when GOVERNANCE_RULES_SOURCE is "url"')
      return new UrlRuleSourceStrategy(config.rulesUrl, config.rulesUrlTimeoutMs ?? 5000)
    default:
      throw new Error(`Unknown governance rule source: "${type}"`)
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
