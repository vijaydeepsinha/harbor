// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {CircuitState} from '../../../core/types/circuit-breaker.types.js'
import {CircuitOpenError} from '../../../core/types/circuit-breaker.types.js'
import type {CircuitBreakerStrategy} from '../../../spi/resilience/circuit-breaker.js'
import {CB_TYPE} from '../../../core/constants.js'
import {normalizeEndpointPath} from '../../../core/utils/url.js'

interface EndpointState {
    state: CircuitState
    failures: number
    openedAt?: number
    /** When the one HALF_OPEN probe was let through; others are refused until it reports or recoveryTimeMs passes. */
    probeAt?: number
}

export class CountBasedCircuitBreakerStrategy implements CircuitBreakerStrategy {
    readonly name = CB_TYPE.COUNT_BASED
    private readonly states = new Map<string, EndpointState>()

    constructor(private readonly config: {
        failureThreshold: number
        recoveryTimeMs: number
    }) {
    }

    check(endpoint: string): void {
        const key = this.normalizeEndpoint(endpoint)
        const s = this.getEndpointState(key)

        const now = Date.now()
        if (s.state === 'OPEN') {
            const elapsed = now - (s.openedAt ?? 0)
            if (elapsed < this.config.recoveryTimeMs) {
                throw new CircuitOpenError(endpoint, this.config.recoveryTimeMs - elapsed)
            }
            s.state = 'HALF_OPEN'
            s.probeAt = now
            return
        }
        if (s.state === 'HALF_OPEN') {
            // One probe at a time: a recovering backend is not hit by every waiting
            // caller at once. A probe whose outcome never came back (aborted) stops
            // blocking after recoveryTimeMs.
            const sinceProbe = now - (s.probeAt ?? 0)
            if (sinceProbe < this.config.recoveryTimeMs) {
                throw new CircuitOpenError(endpoint, this.config.recoveryTimeMs - sinceProbe)
            }
            s.probeAt = now
        }
    }

    recordSuccess(endpoint: string): void {
        const key = this.normalizeEndpoint(endpoint)
        const s = this.getEndpointState(key)

        if (s.state === 'HALF_OPEN') {
            s.state = 'CLOSED'
            s.failures = 0
        } else if (s.state === 'CLOSED') {
            s.failures = 0
        }
    }

    recordFailure(endpoint: string): void {
        const key = this.normalizeEndpoint(endpoint)
        const s = this.getEndpointState(key)

        if (s.state === 'HALF_OPEN') {
            s.state = 'OPEN'
            s.openedAt = Date.now()
        } else if (s.state === 'CLOSED') {
            s.failures++
            if (s.failures >= this.config.failureThreshold) {
                s.state = 'OPEN'
                s.openedAt = Date.now()
            }
        }
    }

    getState(endpoint: string): CircuitState {
        const key = this.normalizeEndpoint(endpoint)
        return this.getEndpointState(key).state
    }

    private normalizeEndpoint(endpoint: string): string {
        return normalizeEndpointPath(endpoint)
    }

    private getEndpointState(key: string): EndpointState {
        const existing = this.states.get(key)
        if (existing !== undefined) return existing
        const fresh: EndpointState = {state: 'CLOSED', failures: 0}
        this.states.set(key, fresh)
        return fresh
    }
}

export function countBasedCircuitBreaker(config: {
    failureThreshold?: number
    recoveryTimeMs?: number
} = {}): CircuitBreakerStrategy {
    return new CountBasedCircuitBreakerStrategy({
        failureThreshold: config.failureThreshold ?? 5,
        recoveryTimeMs: config.recoveryTimeMs ?? 30_000
    })
}
