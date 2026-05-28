// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { ERR } from '../constants.js'

/** Extracts a human-readable message from any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Coerces any thrown value into a real `Error` instance. */
export function ensureError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Reads the optional machine-readable `code` property that our domain errors
 * attach, falling back to a caller-supplied code (defaulting to `ERR.UNKNOWN`).
 */
export function errorCode(err: unknown, fallback: string = ERR.UNKNOWN): string {
  return (err as { code?: string }).code ?? fallback
}

/** Reads the optional `retryable` flag attached to our domain errors. */
export function errorRetryable(err: unknown): boolean {
  return (err as { retryable?: boolean }).retryable ?? false
}
