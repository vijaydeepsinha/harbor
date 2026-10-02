// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { SpecLoaderStrategy, OpenAPISpec } from '../../core/types/spec.types.js'
import type { SpecStore } from './spec-store.js'
import type { SkillStore } from '../registry/skill-store.js'
import type { Logger } from '../observability/logger.js'
import { scanSkills, type SkillMetadata } from '../registry/filesystem-scanner.js'
import { errorMessage } from '../../core/utils/errors.js'

export interface ServiceRefreshConfig {
  serviceRefreshIntervalMs: number
  serviceRefreshTimeoutMs: number
}

/**
 * Periodically refreshes both spec and skills for a service.
 * A single timer drives both; spec and skills are fully loaded before
 * either store is swapped so they remain in sync at all times.
 */
export class ServiceRefresher {
  private timer: ReturnType<typeof setInterval> | null = null
  /** A refresh in flight: the next tick is skipped, so a slow load can never land after a newer one. */
  private running = false
  private stopped = false

  constructor(
    private readonly specLoader: SpecLoaderStrategy,
    private readonly specStore: SpecStore,
    private readonly skillStore: SkillStore,
    private readonly serviceDir: string,
    private readonly config: ServiceRefreshConfig,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.config.serviceRefreshIntervalMs === 0) {
      this.logger.info(
        { specLoader: this.specLoader.name },
        'Service refresh disabled (serviceRefreshIntervalMs = 0)'
      )
      return
    }

    this.timer = setInterval(() => {
      void this.refresh()
    }, this.config.serviceRefreshIntervalMs)

    if (this.timer.unref) {
      this.timer.unref()
    }

    this.logger.info(
      { serviceRefreshIntervalMs: this.config.serviceRefreshIntervalMs, specLoader: this.specLoader.name },
      'Service refresh scheduler started (spec + skills)'
    )
  }

  /**
   * One refresh: spec and skills are swapped together or not at all — skills
   * written against a spec that failed to load would describe endpoints the
   * served spec does not have. Overlapping ticks are skipped (a slow load
   * finishing after a newer one used to install the older spec), and nothing
   * is swapped after stop().
   */
  private async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const newSpec = await this.loadSpecWithTimeout()
      if (newSpec === null || this.stopped) return
      const newSkills = this.loadSkills()
      this.specStore.swap(newSpec)
      this.skillStore.swap(newSkills)
      this.logger.info({ loader: this.specLoader.name, skills: newSkills.length }, 'Spec and skills refreshed')
    } finally {
      this.running = false
    }
  }

  private async loadSpecWithTimeout(): Promise<OpenAPISpec | null> {
    const timeoutMs = this.config.serviceRefreshTimeoutMs
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.specLoader.load(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
        })
      ])
    } catch (err) {
      this.logger.warn(
        { err: errorMessage(err), loader: this.specLoader.name },
        'Spec refresh failed — keeping existing spec'
      )
      return null
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private loadSkills(): SkillMetadata[] {
    try {
      return scanSkills(this.serviceDir, this.logger)
    } catch (err) {
      this.logger.warn({ err: errorMessage(err) }, 'Skills refresh failed — keeping existing skills')
      return this.skillStore.getSkills()
    }
  }

  async forceRefresh(): Promise<void> {
    return this.refresh()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
      this.logger.info('Service refresh scheduler stopped')
    }
  }
}
