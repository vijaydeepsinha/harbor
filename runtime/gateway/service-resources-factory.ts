// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { GlobalConfig, SandboxLimits } from '../../core/types/config.types.js'
import type { TokenCacheStrategy } from '../../core/types/auth.types.js'
import type { ServiceResources } from '../registry/service-registry.js'
import type { ServiceDefinition } from '../registry/filesystem-scanner.js'
type ApiConfig = ServiceDefinition['apiConfig']
import { createLogger } from '../observability/logger.js'
import { MetricsRegistry } from '../observability/metrics.js'
import { SpecStore } from '../spec/spec-store.js'
import { SkillStore } from '../registry/skill-store.js'
import { ServiceRefresher } from '../spec/service-refresher.js'
import { AuthMiddleware } from '../../spi/auth/auth-middleware.js'
import { ApiClient } from '../api-client/api-client.js'
import { buildIdempotencyStrategy, buildSpecLoader } from './strategy-builders.js'
import { joinUrl } from '../../core/utils/url.js'

/**
 * Wires a scanned {@link ServiceDefinition} into the fully-constructed
 * {@link ServiceResources} bag consumed by the tool layer at runtime.
 */
export async function buildServiceResources(
  svc: ServiceDefinition,
  globalConfig: GlobalConfig,
  tokenCacheStrategy: TokenCacheStrategy
): Promise<ServiceResources> {
  const svcLogger = createLogger(svc.name, globalConfig)
  const svcMetrics = new MetricsRegistry(svc.name, svcLogger)

  // Spec + skill stores are seeded from the initial scan and swapped
  // atomically on later reloads (see ServiceRefresher).
  const specStore = new SpecStore()
  specStore.swap(svc.spec)
  const skillStore = new SkillStore()
  skillStore.swap(svc.skills)

  const specLoader = buildSpecLoader(svc.specSource, svc.specPath, svcLogger)
  const refresher = new ServiceRefresher(
    specLoader, specStore, skillStore, svc.serviceDir,
    { serviceRefreshIntervalMs: svc.serviceRefreshIntervalMs, serviceRefreshTimeoutMs: svc.serviceRefreshTimeoutMs },
    svcLogger
  )
  refresher.start()

  const authMiddleware = new AuthMiddleware(svc.auth, tokenCacheStrategy, svcLogger, svc.name, svcMetrics)
  const idempotency = buildIdempotencyStrategy(svc.idempotencyBackend, svcLogger)

  // Service overrides take precedence over global defaults. Timeouts are
  // wall-clock (CPU + awaits), enforced inside the isolated-vm sandbox.
  const sandboxLimits: SandboxLimits = {
    memoryLimitMb: svc.sandboxOverride.memoryLimitMb ?? globalConfig.sandbox.memoryLimitMb,
    executeTimeoutMs: svc.sandboxOverride.executeTimeoutMs ?? globalConfig.sandbox.executeTimeoutMs,
    searchTimeoutMs: svc.sandboxOverride.searchTimeoutMs ?? globalConfig.sandbox.searchTimeoutMs,
    maxApiCalls: svc.sandboxOverride.maxApiCalls ?? globalConfig.sandbox.maxApiCalls,
    maxConcurrentCalls: svc.sandboxOverride.maxConcurrentCalls ?? globalConfig.sandbox.maxConcurrentCalls
  }

  const apiBaseUrl = buildApiBaseUrl(svc.apiConfig)
  const apiClient = new ApiClient(
    apiBaseUrl, svc.apiConfig, svc.circuitBreaker, idempotency, svcLogger,
    { serviceName: svc.name, agentName: globalConfig.observability.agentName }
  )

  return {
    name: svc.name,
    description: svc.description,
    specStore,
    skillStore,
    refresher,
    apiClient,
    authMiddleware,
    circuitBreaker: svc.circuitBreaker,
    permissionGuard: svc.permissionGuard,
    idempotencyKeyTtlMs: svc.idempotencyKeyTtlMs,
    idempotencyStrategyName: idempotency.name,
    circuitBreakerStrategyName: svc.circuitBreaker.name,
    authStrategyName: svc.auth.name,
    sandboxLimits,
    logger: svcLogger,
    metrics: svcMetrics
  }
}

/**
 * Collapses `{ protocol, host, port, basePath }` into a single base URL,
 * omitting the port when it is the scheme default. Extracted so the
 * base-url rule has exactly one implementation.
 */
function buildApiBaseUrl(apiConfig: ApiConfig): string {
  const { protocol, host, port, basePath } = apiConfig
  const isDefaultPort = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80)
  const origin = `${protocol}://${host}${isDefaultPort ? '' : `:${port}`}`
  return joinUrl(origin, basePath)
}
