// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GlobalConfig } from '../core/types/config.types.js'
import { createLogger } from './observability/logger.js'
import { MetricsRegistry } from './observability/metrics.js'
import { ServiceRegistry } from './registry/service-registry.js'
import { scanServicesDirectory } from './registry/filesystem-scanner.js'
import { registerDiscoverServicesTool } from '../tools/discover-services.tool.js'
import { registerDiscoverSkillsTool } from '../tools/discover-skills.tool.js'
import { registerGetSkillDetailsTool } from '../tools/get-skill-details.tool.js'
import { registerSearchCodeTool } from '../tools/search-code.tool.js'
import { registerExecuteApiTool } from '../tools/execute-api.tool.js'
import { buildTokenCacheStrategy } from './gateway/strategy-builders.js'
import { buildServiceResources } from './gateway/service-resources-factory.js'
import { startHttpGateway } from './http/http-gateway.js'
import { startStdioGateway } from './transport/stdio-gateway.js'
import { GATEWAY_NAME, STORE_TYPE } from '../core/constants.js'
import { errorMessage } from '../core/utils/errors.js'

/**
 * Boots a single MCP gateway by auto-scanning the services directory.
 * Each subdirectory with a spec file becomes a registered service.
 * Exposes 5 tools: discover_services, discover_skills, get_skill_details, search_code, api_execute.
 */
export async function createMcpGateway(
  servicesDir: string,
  globalConfig: GlobalConfig
): Promise<void> {
  const gatewayLogger = createLogger(GATEWAY_NAME, globalConfig)
  const gatewayMetrics = new MetricsRegistry(GATEWAY_NAME, gatewayLogger)

  // ── 1. Auto-scan services directory ─────────────────────────────────────
  const scannedServices = await scanServicesDirectory(servicesDir, gatewayLogger)
  if (scannedServices.length === 0) {
    gatewayLogger.error({ servicesDir }, 'No services found — exiting')
    process.exit(1)
  }

  // ── 2. Build global token cache (shared by all services) ────────────────
  const tokenCacheTtlMs = globalConfig.auth?.tokenCacheTtlMs ?? 300_000
  const tokenCacheConfig = globalConfig.auth?.tokenCacheBackend ?? { type: STORE_TYPE.IN_MEMORY }
  const tokenCacheStrategy = buildTokenCacheStrategy(tokenCacheConfig, tokenCacheTtlMs, gatewayLogger)
  gatewayLogger.info({ backend: tokenCacheStrategy.name, tokenCacheTtlMs }, 'Token cache initialized')

  // ── 3. Build service registry from scanned results ──────────────────────
  // One failing service must not take down the gateway: log, skip, continue.
  const registry = new ServiceRegistry()
  for (const svc of scannedServices) {
    try {
      const resources = await buildServiceResources(svc, globalConfig, tokenCacheStrategy)
      registry.register(svc.name, resources)
      gatewayLogger.info(
        { service: svc.name, skills: resources.skillStore.getSkills().length },
        'Service registered'
      )
    } catch (err) {
      gatewayLogger.error(
        { service: svc.name, error: errorMessage(err) },
        'Failed to build service resources — skipping service'
      )
    }
  }
  if (registry.serviceNames().length === 0) {
    gatewayLogger.error('No services registered after buildServiceResources — exiting')
    process.exit(1)
  }
  gatewayLogger.info({ services: registry.serviceNames() }, 'All services registered in gateway')

  // ── 4. Factory: fresh McpServer per session with 5 tools ────────────────
  function createSessionServer(clientToken: string): McpServer {
    const sessionServer = new McpServer({ name: GATEWAY_NAME, version: '1.0.0' })
    registerDiscoverServicesTool(sessionServer, registry, gatewayLogger, gatewayMetrics)
    registerDiscoverSkillsTool(sessionServer, registry, gatewayLogger, gatewayMetrics, clientToken)
    registerGetSkillDetailsTool(sessionServer, registry, gatewayLogger, gatewayMetrics, clientToken)
    registerSearchCodeTool(sessionServer, registry, gatewayLogger, gatewayMetrics, clientToken)
    registerExecuteApiTool(sessionServer, registry, globalConfig, gatewayLogger, gatewayMetrics, clientToken)
    return sessionServer
  }

  // ── 5. Transport — Streamable HTTP (default) or stdio ───────────────────
  const transportMode = globalConfig.mcp.transport

  // Shared shutdown tail. Both transports must tear down cache, registry,
  // and metrics in the same order; any transport-specific teardown (e.g.
  // closing the HTTP listener) runs *before* this.
  const shutdownShared = () => {
    tokenCacheStrategy.destroy()
    registry.shutdownAll()
    gatewayMetrics.stop()
    gatewayLogger.info('Shutting down gracefully')
  }

  if (transportMode === 'http') {
    const { host, port } = globalConfig.mcp
    const { idleTtlMs, sweepIntervalMs } = globalConfig.session

    const http = startHttpGateway({
      host, port, idleTtlMs, sweepIntervalMs,
      createSessionServer, registry, logger: gatewayLogger,
      oauthConfig: globalConfig.oauth
    })

    const httpShutdown = (signal: string) => {
      gatewayLogger.info({ signal }, 'Received shutdown signal — closing HTTP listener')
      http.stopIdleSweep()
      http.server.close(() => gatewayLogger.info('HTTP server closed — no longer accepting connections'))
      shutdownShared()
    }
    process.on('SIGTERM', () => httpShutdown('SIGTERM'))
    process.on('SIGINT', () => httpShutdown('SIGINT'))
    return
  }

  // stdio
  const stdioPat = globalConfig.mcp.token ?? ''
  if (!stdioPat) {
    gatewayLogger.error('MCP_TOKEN env var required for stdio transport — exiting')
    process.exit(1)
  }

  await startStdioGateway({
    clientToken: stdioPat, createSessionServer, registry, logger: gatewayLogger
  })

  process.on('SIGTERM', shutdownShared)
  process.on('SIGINT', shutdownShared)
}
