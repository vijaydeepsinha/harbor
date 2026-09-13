// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** Minimal ServerContext stub for unit-testing tool handlers. */
export function makeServerCtx(correlationId?: string, sessionId?: string): Record<string, unknown> {
  if (correlationId === undefined && sessionId === undefined) return {}
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(correlationId !== undefined ? { mcpReq: { id: correlationId } } : {})
  }
}
