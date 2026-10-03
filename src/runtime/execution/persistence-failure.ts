// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from '../../core/types/logger.types.js'
import type { MetricsCollector } from '../../core/types/metrics.types.js'
import { METRIC, type PersistenceOperation } from '../../core/constants.js'

/**
 * A store write that failed after the outcome it records was already decided
 * — a secondary failure. The primary outcome stands: the client sees it
 * unchanged. What is reported is what the store holds instead, and how a
 * later run gets from there to a correct outcome — the recovery policy for
 * that write (docs/code-mode-governance.md §14).
 */
export interface PersistenceFailure {
  operation: PersistenceOperation
  executionId: string
  /** The activity, for a journal write. */
  sequence?: number
  /** What the write would have recorded. */
  intended: string
  /** Observed store state, or `unknown` when it could not be read. */
  left: string
  /** How a later run recovers from `left`. */
  recovery: string
  error: Error
}

export type PersistenceFailureReporter = (failure: PersistenceFailure) => void

/**
 * Reports a secondary persistence failure as one structured error log line
 * (`event: persistence_failure`, stable fields for alerting) and one count of
 * `execution_persistence_failures_total{operation}`. Never throws: it runs on
 * paths that are already reporting another outcome.
 */
export function persistenceFailureReporter(logger: Logger, metrics?: MetricsCollector, correlationId?: string): PersistenceFailureReporter {
  return failure => {
    try {
      logger.error(
        {
          event: 'persistence_failure',
          operation: failure.operation,
          executionId: failure.executionId,
          ...(failure.sequence !== undefined ? { sequence: failure.sequence } : {}),
          intended: failure.intended,
          left: failure.left,
          recovery: failure.recovery,
          error: failure.error.message,
          ...(correlationId !== undefined ? { correlationId } : {})
        },
        `Store write failed after the outcome was decided (${failure.operation}); the outcome stands — ${failure.recovery}`
      )
      metrics?.increment(METRIC.PERSISTENCE_FAILURES, { operation: failure.operation })
    } catch {
      // Reporting must not turn a reported outcome into a different one.
    }
  }
}
