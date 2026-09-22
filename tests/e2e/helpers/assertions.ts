// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** Small typed narrowing helpers so tests read as claims, not as casts. */
import { expect } from 'vitest'
import type { ExecuteOutcome } from '../client/mcp-client.js'

export function expectCompleted(o: ExecuteOutcome): Extract<ExecuteOutcome, { kind: 'completed' }> {
  expect(o.kind, `expected a completed result, got ${describe(o)}`).toBe('completed')
  return o as Extract<ExecuteOutcome, { kind: 'completed' }>
}

export function expectPaused(o: ExecuteOutcome): Extract<ExecuteOutcome, { kind: 'input_required' }> {
  expect(o.kind, `expected input_required, got ${describe(o)}`).toBe('input_required')
  const p = o as Extract<ExecuteOutcome, { kind: 'input_required' }>
  expect(p.requestState.length, 'requestState must be a non-empty sealed string').toBeGreaterThan(20)
  expect(p.executionId, 'input_required must carry harbor/execution-id').toMatch(/^[0-9a-f-]{36}$/)
  expect(p.approvalId, 'input_required must carry harbor/approval-id').toMatch(/^[0-9a-f-]{36}$/)
  return p
}

export function expectToolError(o: ExecuteOutcome, code?: string): Extract<ExecuteOutcome, { kind: 'tool_error' }> {
  expect(o.kind, `expected a tool error${code ? ` ${code}` : ''}, got ${describe(o)}`).toBe('tool_error')
  const e = o as Extract<ExecuteOutcome, { kind: 'tool_error' }>
  if (code) expect(e.code, `tool error code (message: ${e.message})`).toBe(code)
  return e
}

export function expectRpcError(o: ExecuteOutcome, code?: number): Extract<ExecuteOutcome, { kind: 'rpc_error' }> {
  expect(o.kind, `expected a JSON-RPC error${code ? ` ${code}` : ''}, got ${describe(o)}`).toBe('rpc_error')
  const e = o as Extract<ExecuteOutcome, { kind: 'rpc_error' }>
  if (code !== undefined) expect(e.code, `rpc error code (message: ${e.message})`).toBe(code)
  return e
}

export function describe(o: ExecuteOutcome): string {
  switch (o.kind) {
    case 'completed': return `completed ${JSON.stringify(o.value).slice(0, 200)}`
    case 'input_required': return `input_required (execution ${o.executionId}, approval ${o.approvalId})`
    case 'tool_error': return `tool_error ${o.code}: ${o.message}`
    case 'rpc_error': return `rpc_error ${o.code}: ${o.message}`
    case 'transport_error': return `transport_error HTTP ${o.httpStatus}: ${JSON.stringify(o.body).slice(0, 200)}`
  }
}
