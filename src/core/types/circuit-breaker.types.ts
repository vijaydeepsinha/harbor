// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { ERR } from '../constants.js'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerStrategy {
  readonly name: string
  check(endpoint: string): void
  recordSuccess(endpoint: string): void
  recordFailure(endpoint: string): void
  getState(endpoint: string): CircuitState
}

export class CircuitOpenError extends Error {
  readonly code = ERR.CIRCUIT_OPEN
  readonly retryable = true
  constructor(
    readonly endpoint: string,
    readonly retryAfterMs: number
  ) {
    super(
      `The ${endpoint} endpoint is temporarily unavailable. ` +
      `Retry after ${retryAfterMs}ms. Consider whether an ` +
      `alternative endpoint exists for your task.`
    )
    this.name = 'CircuitOpenError'
  }
}
