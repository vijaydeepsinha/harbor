// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {CircuitState} from '../../core/types/circuit-breaker.types.js'

export interface CircuitBreakerStrategy {
    readonly name: string

    check(endpoint: string): void

    recordSuccess(endpoint: string): void

    recordFailure(endpoint: string): void

    getState(endpoint: string): CircuitState
}
