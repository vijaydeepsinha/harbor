// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {SpecStore} from '../spec/spec-store.js'
import type {SkillStore} from './skill-store.js'
import type {ServiceRefresher} from '../spec/service-refresher.js'
import type {ConnectorAPI} from '../../spi/connector/connector-api.js'
import type {AuthMiddleware} from '../auth/auth-middleware.js'
import type {CircuitBreakerStrategy} from '../../spi/resilience/circuit-breaker.js'
import type {PermissionGuard} from '../../spi/permissions/permission-guard.js'
import type {Logger} from '../observability/logger.js'
import type {MetricsRegistry} from '../observability/metrics.js'
import type {SandboxLimits} from '../../core/types/config.types.js'

export interface ServiceResources {
    name: string
    description: string
    specStore: SpecStore
    skillStore: SkillStore
    refresher: ServiceRefresher
    apiClient: ConnectorAPI
    authMiddleware: AuthMiddleware
    circuitBreaker: CircuitBreakerStrategy
    permissionGuard: PermissionGuard
    idempotencyKeyTtlMs: number
    idempotencyStrategyName: string
    circuitBreakerStrategyName: string
    authStrategyName: string
    sandboxLimits: SandboxLimits
    logger: Logger
    metrics: MetricsRegistry
}

export class ServiceRegistry {
    private readonly services = new Map<string, ServiceResources>()

    register(key: string, resources: ServiceResources): void {
        if (this.services.has(key)) {
            throw new Error(`Service "${key}" is already registered`)
        }
        this.services.set(key, resources)
    }

    get(key: string): ServiceResources | undefined {
        return this.services.get(key)
    }

    listServices(): Array<{ service: string; description: string }> {
        return Array.from(this.services.entries()).map(([key, r]) => ({
            service: key,
            description: r.description
        }))
    }

    serviceNames(): string[] {
        return Array.from(this.services.keys())
    }

    shutdownAll(): void {
        for (const r of Array.from(this.services.values())) {
            r.refresher.stop()
            r.metrics.stop()
        }
    }
}
