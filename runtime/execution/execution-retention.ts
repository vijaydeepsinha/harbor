// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from '../../core/types/logger.types.js'
import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import { errorMessage } from '../../core/utils/errors.js'

/** Deletions per store query, so one sweep never loads an unbounded list. */
const SWEEP_BATCH = 100
/** Sweep at least hourly, and as often as the retention period for short ones. */
const MAX_SWEEP_INTERVAL_SEC = 3600

/**
 * Deletes terminal executions — and everything recorded for them: activities,
 * approvals, decisions — once their `expiresAt` has passed
 * (EXECUTION_RETENTION_SEC after they finished). Paused and interrupted
 * executions have no `expiresAt` and are never touched. A failed sweep is
 * logged and retried on the next tick; it never affects running executions.
 */
export class ExecutionRetentionSweeper {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly store: CodeModeStore,
    private readonly retentionSec: number,
    private readonly logger: Logger,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  start(): void {
    if (this.retentionSec <= 0) {
      this.logger.info('Execution retention disabled (EXECUTION_RETENTION_SEC = 0) — finished executions are kept')
      return
    }
    const intervalSec = Math.min(this.retentionSec, MAX_SWEEP_INTERVAL_SEC)
    this.timer = setInterval(() => { void this.sweep() }, intervalSec * 1000)
    if (this.timer.unref) this.timer.unref()
    this.logger.info({ retentionSec: this.retentionSec, intervalSec }, 'Execution retention sweep started')
  }

  /** One sweep; returns how many executions were deleted. Never throws. */
  async sweep(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let deleted = 0
    try {
      const now = this.now()
      for (;;) {
        const expired = await this.store.listExpiredExecutions(now, SWEEP_BATCH)
        for (const executionId of expired) {
          await this.store.deleteExecution(executionId)
          deleted++
        }
        if (expired.length < SWEEP_BATCH) break
      }
      if (deleted > 0) this.logger.info({ deleted }, 'Expired executions deleted')
    } catch (err) {
      this.logger.error({ deleted, error: errorMessage(err) }, 'Execution retention sweep failed — will retry')
    } finally {
      this.running = false
    }
    return deleted
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
