// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import {
  ApprovalRequiredError,
  GovernanceDeniedError,
  ReplayDivergedError,
  ExecutionLockedError,
  ExecutionNotFoundError,
  ExecutionNotResumableError,
  ExecutionCancelledError,
  ExecutionError
} from '../../core/types/execution.types.js'
import {
  ERR, EXECUTION_STATUS, ACTIVITY_STATUS, GOVERNANCE_DECISION, GOVERNANCE_PRECEDENCE,
  EXECUTION_ID_META_KEY, META_PREFIX
} from '../../core/constants.js'
import { errorCode, errorRetryable } from '../../core/utils/errors.js'

const summary = {
  service: 'trafficking', method: 'POST' as const, specPath: '/campaigns/{id}',
  reason: 'budget above threshold', matchedRules: ['high-budget-campaign']
}

describe('execution typed errors', () => {
  it('carry ERR codes and retryable flags readable via the shared helpers', () => {
    const cases: Array<[ExecutionError, string, boolean]> = [
      [new ApprovalRequiredError('e1', 3, 'a1', summary), ERR.APPROVAL_REQUIRED, false],
      [new GovernanceDeniedError('e1', 3, 'nope', ['r1']), ERR.GOVERNANCE_DENIED, false],
      [new ReplayDivergedError('e1', 2, 'GET /a', 'POST /b'), ERR.REPLAY_DIVERGED, false],
      [new ExecutionLockedError('e1'), ERR.EXECUTION_LOCKED, true],
      [new ExecutionNotFoundError('e1'), ERR.EXECUTION_NOT_FOUND, false],
      [new ExecutionNotResumableError('e1', EXECUTION_STATUS.COMPLETED), ERR.EXECUTION_NOT_RESUMABLE, false],
      [new ExecutionCancelledError('e1', 4), ERR.EXECUTION_CANCELLED, false]
    ]
    for (const [err, code, retryable] of cases) {
      expect(err).toBeInstanceOf(ExecutionError)
      expect(err).toBeInstanceOf(Error)
      expect(errorCode(err)).toBe(code)
      expect(errorRetryable(err)).toBe(retryable)
      expect(err.name).not.toBe('Error')
    }
  })

  it('messages name the activity and never leak beyond the summary', () => {
    const err = new ApprovalRequiredError('e1', 3, 'a1', summary)
    expect(err.message).toContain('#3')
    expect(err.message).toContain('POST /campaigns/{id}')
    expect(err.approvalId).toBe('a1')
    const div = new ReplayDivergedError('e1', 2, 'GET /a', 'POST /b')
    expect(div.message).toContain('recorded "GET /a"')
    expect(div.message).toContain('issued "POST /b"')
  })
})

describe('governance vocabulary', () => {
  it('precedence is DENY > REQUIRE_APPROVAL > ALLOW', () => {
    expect(GOVERNANCE_PRECEDENCE[GOVERNANCE_DECISION.DENY])
      .toBeGreaterThan(GOVERNANCE_PRECEDENCE[GOVERNANCE_DECISION.REQUIRE_APPROVAL])
    expect(GOVERNANCE_PRECEDENCE[GOVERNANCE_DECISION.REQUIRE_APPROVAL])
      .toBeGreaterThan(GOVERNANCE_PRECEDENCE[GOVERNANCE_DECISION.ALLOW])
  })

  it('lifecycle vocab covers every state the requirements name', () => {
    expect(Object.values(EXECUTION_STATUS)).toEqual(
      expect.arrayContaining(['CREATED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'DENIED', 'CANCELLED'])
    )
    expect(Object.values(ACTIVITY_STATUS)).toContain('COMPLETED')
    expect(Object.values(ACTIVITY_STATUS)).toContain('WAITING_APPROVAL')
  })

  it('harbor _meta keys are namespaced under a vendor prefix that is not MCP-reserved', () => {
    expect(EXECUTION_ID_META_KEY.startsWith(META_PREFIX)).toBe(true)
    const labels = META_PREFIX.replace(/\/$/, '').split('.')
    expect(labels[1] ?? '').not.toMatch(/^(mcp|modelcontextprotocol)$/)
  })
})
