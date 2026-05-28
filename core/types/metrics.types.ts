// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

export interface MetricsCollector {
  increment(metricName: string, labels?: Record<string, string>): void
}
