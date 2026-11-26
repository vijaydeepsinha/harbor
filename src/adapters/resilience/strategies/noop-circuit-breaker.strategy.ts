// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {CircuitState} from '../../../core/types/circuit-breaker.types.js'
import type {CircuitBreakerStrategy} from '../../../spi/resilience/circuit-breaker.js'
import {CB_TYPE} from '../../../core/constants.js'

export class NoopCircuitBreakerStrategy implements CircuitBreakerStrategy {
    readonly name = CB_TYPE.NOOP

    check(_endpoint: string): void {
        // Always allows through — no-op
    }

    recordSuccess(_endpoint: string): void {
        // No-op
    }

    recordFailure(_endpoint: string): void {
        // No-op
    }

    getState(_endpoint: string): CircuitState {
        return 'CLOSED'
    }
}

export function noopCircuitBreaker(): CircuitBreakerStrategy {
    return new NoopCircuitBreakerStrategy()
}
