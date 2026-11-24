// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {GlobalConfig} from '../core/types/config.types.js'
import {createLogger} from './observability/logger.js'
import {MetricsRegistry} from './observability/metrics.js'
import {ServiceRegistry} from './registry/service-registry.js'
import {scanServicesDirectory} from './registry/filesystem-scanner.js'
import {buildAuditSinks, buildTokenCacheStrategy} from '../wiring/strategy-builders.js'
import {buildServiceResources} from './gateway/service-resources-factory.js'
import {startHttpGateway} from './http/http-gateway.js'
import {buildMcpServerFactory} from './http/mcp-server-factory.js'
import {buildGovernanceRuntime} from './execution/governance-runtime.js'
import {AuditPipeline} from './observability/audit-pipeline.js'
import {startStdioGateway} from './transport/stdio-gateway.js'
import {GATEWAY_NAME, STORE_TYPE} from '../core/constants.js'
import {errorMessage} from '../core/utils/errors.js'
import {extractBearerFromHeader} from './auth/bearer-authorization.js'

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
        gatewayLogger.error(
            'No services found — set SERVICES_DIR to a directory containing configured service folders'
        )
        process.exit(1)
    }

    // ── 2. Build global token cache (shared by all services) ────────────────
    const tokenCacheTtlMs = globalConfig.auth?.tokenCacheTtlMs ?? 300_000
    const tokenCacheConfig = globalConfig.auth?.tokenCacheBackend ?? {type: STORE_TYPE.IN_MEMORY}
    const tokenCacheStrategy = buildTokenCacheStrategy(tokenCacheConfig, tokenCacheTtlMs, gatewayLogger)
    gatewayLogger.info({tokenCacheTtlMs}, 'Token cache initialized')

    // ── 3. Build service registry from scanned results ──────────────────────
    // One failing service must not take down the gateway: log, skip, continue.
    const registry = new ServiceRegistry()
    const activeGovernanceServices: Array<{
        name: string;
        governance: (typeof scannedServices)[number]['governance']
    }> = []
    for (const svc of scannedServices) {
        try {
            const resources = await buildServiceResources(svc, globalConfig, tokenCacheStrategy)
            registry.register(svc.name, resources)
            activeGovernanceServices.push({name: svc.name, governance: svc.governance})
            gatewayLogger.info(
                {service: svc.name, skills: resources.skillStore.getSkills().length},
                'Service registered'
            )
        } catch (err) {
            gatewayLogger.error(
                {service: svc.name, error: errorMessage(err)},
                'Failed to build service resources — skipping service'
            )
        }
    }
    if (registry.serviceNames().length === 0) {
        gatewayLogger.error('No services registered after buildServiceResources — exiting')
        process.exit(1)
    }
    gatewayLogger.info({services: registry.serviceNames()}, 'All services registered in gateway')

    // ── 4. Transport mode ───────────────────────────────────────────────────
    const transportMode = globalConfig.mcp.transport
    const stdioPat = globalConfig.mcp.token ?? ''

    // Audit trail: every api_execute record and every execution state change goes
    // to each AUDIT_SINKS sink, written with the owning service's logger.
    const auditPipeline = new AuditPipeline(
        globalConfig.observability.enableAudit
            ? buildAuditSinks(globalConfig.observability.auditSinks ?? ['console'], {
                loggerFor: service => registry.get(service)?.logger ?? gatewayLogger
            })
            : [],
        gatewayLogger
    )
    gatewayLogger.info({sinks: auditPipeline.sinkNames}, 'Audit pipeline ready')

    // Process-wide governance runtime: executions outlive requests and isolates.
    const governanceRuntime = await buildGovernanceRuntime(
        globalConfig.execution, activeGovernanceServices, gatewayLogger, auditPipeline
    )

    const createMcpServer = buildMcpServerFactory({
        registry,
        globalConfig,
        logger: gatewayLogger,
        metrics: gatewayMetrics,
        stdioToken: transportMode === 'stdio' ? stdioPat : undefined,
        governanceRuntime,
        auditPipeline
    })

    // Shared shutdown tail. Both transports must tear down cache, registry,
    // and metrics in the same order; any transport-specific teardown (e.g.
    // closing the HTTP listener) runs *before* this.
    const shutdownShared = () => {
        void governanceRuntime.shutdown().catch(err => gatewayLogger.warn({error: errorMessage(err)}, 'Code Mode store shutdown failed'))
        void auditPipeline.close()
        tokenCacheStrategy.destroy()
        registry.shutdownAll()
        gatewayMetrics.stop()
        gatewayLogger.info('Shutting down gracefully')
    }

    if (transportMode === 'http') {
        const {host, port} = globalConfig.mcp

        const http = startHttpGateway({
            host, port,
            ...(globalConfig.mcp.maxBodyBytes !== undefined ? {maxBodyBytes: globalConfig.mcp.maxBodyBytes} : {}),
            createMcpServer, registry, logger: gatewayLogger,
            oauthConfig: globalConfig.oauth,
            governanceRuntime
        })

        const httpShutdown = (signal: string) => {
            gatewayLogger.info({signal}, 'Received shutdown signal — closing HTTP listener')
            http.server.close(() => gatewayLogger.info('HTTP server closed — no longer accepting connections'))
            shutdownShared()
        }
        process.on('SIGTERM', () => httpShutdown('SIGTERM'))
        process.on('SIGINT', () => httpShutdown('SIGINT'))
        return
    }

    if (!stdioPat) {
        gatewayLogger.error('MCP_TOKEN env var required for stdio transport — exiting')
        process.exit(1)
    }
    // Every stdio call presents MCP_TOKEN as its bearer; one the bearer parser
    // refuses (too short, not a JWT) would fail every tool call with
    // TOKEN_INVALID after a clean-looking boot. Refuse it here instead.
    const stdioBearer = extractBearerFromHeader(`Bearer ${stdioPat}`)
    if (!stdioBearer.ok) {
        gatewayLogger.error({reason: stdioBearer.reason}, 'MCP_TOKEN is not an acceptable bearer (a JWT, or an opaque token of at least 32 base64url characters) — exiting')
        process.exit(1)
    }

    await startStdioGateway({
        createMcpServer, registry, logger: gatewayLogger
    })

    process.on('SIGTERM', shutdownShared)
    process.on('SIGINT', shutdownShared)
}
