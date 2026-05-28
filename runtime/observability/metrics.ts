// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from './logger.js'

type Labels = Record<string, string>

interface Counter {
  labels: Labels
  value: number
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter[]>()
  private flushTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly serviceName: string,
    private readonly logger: Logger,
    flushIntervalMs = 60_000
  ) {
    this.flushTimer = setInterval(() => {
      this.flush()
    }, flushIntervalMs)

    if (this.flushTimer.unref) {
      this.flushTimer.unref()
    }
  }

  increment(metricName: string, labels: Labels = {}): void {
    const allLabels = { service: this.serviceName, ...labels }
    const existing = this.counters.get(metricName)

    if (existing === undefined) {
      this.counters.set(metricName, [{ labels: allLabels, value: 1 }])
      return
    }

    const match = existing.find(c => labelsMatch(c.labels, allLabels))
    if (match !== undefined) {
      match.value++
    } else {
      existing.push({ labels: allLabels, value: 1 })
    }
  }

  private flush(): void {
    if (this.counters.size === 0) return

    const snapshot: Record<string, Counter[]> = {}
    for (const [name, counters] of this.counters.entries()) {
      snapshot[name] = counters.map(c => ({ ...c }))
    }

    this.logger.info({ metrics: snapshot }, 'metrics_flush')
  }

  stop(): void {
    clearInterval(this.flushTimer)
    this.flush()
  }
}

function labelsMatch(a: Labels, b: Labels): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(k => a[k] === b[k])
}
