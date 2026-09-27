// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { CircuitBreakerStrategy, CircuitState } from '../../../core/types/circuit-breaker.types.js'
import { CircuitOpenError } from '../../../core/types/circuit-breaker.types.js'
import { CB_TYPE } from '../../../core/constants.js'
import { normalizeEndpointPath } from '../../../core/utils/url.js'

interface EndpointState {
  state: CircuitState
  failures: number
  openedAt?: number
}

export class CountBasedCircuitBreakerStrategy implements CircuitBreakerStrategy {
  readonly name = CB_TYPE.COUNT_BASED
  private readonly states = new Map<string, EndpointState>()

  constructor(private readonly config: {
    failureThreshold: number
    recoveryTimeMs: number
  }) {}

  private normalizeEndpoint(endpoint: string): string {
    return normalizeEndpointPath(endpoint)
  }

  private getEndpointState(key: string): EndpointState {
    const existing = this.states.get(key)
    if (existing !== undefined) return existing
    const fresh: EndpointState = { state: 'CLOSED', failures: 0 }
    this.states.set(key, fresh)
    return fresh
  }

  check(endpoint: string): void {
    const key = this.normalizeEndpoint(endpoint)
    const s = this.getEndpointState(key)

    if (s.state === 'OPEN') {
      const elapsed = Date.now() - (s.openedAt ?? 0)
      if (elapsed < this.config.recoveryTimeMs) {
        throw new CircuitOpenError(endpoint, this.config.recoveryTimeMs - elapsed)
      }
      s.state = 'HALF_OPEN'
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
