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

  private async refresh(): Promise<void> {
    const newSpec = await this.loadSpecWithTimeout()
    const newSkills = this.loadSkills()
    if (newSpec !== null) {
      this.specStore.swap(newSpec)
      this.logger.info({ loader: this.specLoader.name }, 'Spec refreshed successfully')
    }
    this.skillStore.swap(newSkills)
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
      const skills = scanSkills(this.serviceDir)
      this.logger.info({ count: skills.length }, 'Skills refreshed successfully')
      return skills
    } catch (err) {
      this.logger.warn({ err: errorMessage(err) }, 'Skills refresh failed — keeping existing skills')
      return this.skillStore.getSkills()
    }
  }

  async forceRefresh(): Promise<void> {
    return this.refresh()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
      this.logger.info('Service refresh scheduler stopped')
    }
  }
}
