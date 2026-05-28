// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

export interface IdempotencyStrategy {
  readonly name: string
  checkAndExecute<T>(key: string, fn: () => Promise<T>, idempotencyKeyTtlMs: number): Promise<T>
  generateKey(userIdHash: string): string
}
