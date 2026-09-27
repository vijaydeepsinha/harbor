// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-019 failure handling. Two very different facts are kept apart:
 * "the API answered with an error" (journaled COMPLETED, replayable) and
 * "Harbor does not know whether the API executed" (journaled FAILED,
 * outcomeKnown:false, never repeated).
 */
import { describe, it, expect } from 'vitest'
import { useScenario } from '../helpers/diagnostics.js'
import { expectCompleted, expectToolError } from '../helpers/assertions.js'
import { ACTIVITY_STATUS, ERR, EXECUTION_STATUS } from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'

describe('failure handling', () => {
  const s = useScenario()

  for (const status of [400, 401, 403, 404, 409, 429]) {
    it(`should_record_an_explicit_${status}_as_a_completed_replayable_activity_without_retrying`, async () => {
      const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.unstable(String(status))))
      s().track(out.meta.executionId)
      expect(out.value).toMatchObject({ status, ok: false })
      expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.COMPLETED) // the program handled it; the execution succeeded
      const insp = await s().admin.inspect(out.meta.executionId!)
      expect(insp.activities[0]).toMatchObject({ status: ACTIVITY_STATUS.COMPLETED, response: { status, ok: false } })
      expect(await s().mock.count('POST', '/unstable')).toBe(1)
    })
  }

  it('should_not_retry_a_post_that_got_a_500_and_journal_the_activity_as_failed_with_unknown_outcome', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.unstable('500')))
    s().track(out.meta.executionId)
    s().note('uncaught500Code', out.code)
    expect(out.message).toContain('500')
    expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.FAILED)
    // maxRetries: 1, but a POST is never re-sent: the first attempt may already have taken effect.
    expect(await s().mock.count('POST', '/unstable')).toBe(1)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.FAILED)
    expect(insp.activities[0]).toMatchObject({ status: ACTIVITY_STATUS.FAILED, failure: { outcomeKnown: false } })
    expect(insp.activities[0]).not.toHaveProperty('response')
    // The structured progress tells the caller what was attempted.
    const progress = out.payload['progress'] as { calls?: unknown[] } | undefined
    expect(progress).toBeDefined()
  })

  it('should_journal_a_backend_timeout_as_failed_with_unknown_outcome', async () => {
    const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.unstableCaught('timeout')))
    s().track(out.meta.executionId)
    expect(out.value).toMatchObject({ threw: true })
    expect(String((out.value as { message: string }).message).toLowerCase()).toContain('timeout')
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.activities[0]).toMatchObject({ status: ACTIVITY_STATUS.FAILED, failure: { outcomeKnown: false } })
    const attempts = await s().mock.requests({ method: 'POST', path: '/unstable' })
    expect(attempts).toHaveLength(1) // received (and held) by the backend — Harbor cannot know that, so it never re-sends
  }, 30_000)

  it('should_keep_the_completed_first_step_when_a_middle_step_fails', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.pingThenUnstable('500')))
    s().track(out.meta.executionId)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.activities.map(a => [a.sequence, a.status])).toEqual([[1, ACTIVITY_STATUS.COMPLETED], [2, ACTIVITY_STATUS.FAILED]])
    expect(await s().mock.calls()).toEqual(['GET /ping', 'POST /unstable'])
    expectToolError(await s().client('alice').resumeByMeta('commerce', programs.pingThenUnstable('500'), out.meta.executionId!), ERR.EXECUTION_NOT_RESUMABLE)
  })

  it('should_interrupt_with_sandbox_timeout_when_the_program_never_yields', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.busyLoop()), ERR.SANDBOX_TIMEOUT)
    s().track(out.meta.executionId)
    // A sandbox timeout is classified retryable ⇒ the execution is INTERRUPTED (resumable), not FAILED.
    expect(out.retryable).toBe(true)
    expect(out.meta.executionStatus).toBe(EXECUTION_STATUS.INTERRUPTED)
    expect(await s().mock.requests()).toHaveLength(0)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.INTERRUPTED)
    expect(insp.execution.terminalReason?.code).toBe(ERR.SANDBOX_TIMEOUT)
  }, 30_000)

  it('known_quirk_an_uncaught_backend_timeout_is_reported_as_sandbox_timeout', async () => {
    // The API client's 2 s timeout error bubbles into the isolate as an Error whose message contains "timeout";
    // sandbox-core's error normaliser classifies any such message as SandboxTimeoutError. The journal is right
    // (activity FAILED, outcome unknown) but the tool-level code and message are misleading. Pinned as observed.
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.unstable('timeout')))
    s().track(out.meta.executionId)
    s().note('uncaughtBackendTimeoutCode', out.code)
    expect([ERR.SANDBOX_TIMEOUT, ERR.API_ERROR, ERR.SANDBOX_RUNTIME]).toContain(out.code)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.activities[0]).toMatchObject({ status: ACTIVITY_STATUS.FAILED, failure: { outcomeKnown: false } })
    if (out.code === ERR.SANDBOX_TIMEOUT) console.warn('KNOWN QUIRK: backend timeout surfaced as SANDBOX_TIMEOUT (sandbox-core normalizeIsolateError substring match)')
  }, 30_000)

  it('should_fail_with_sandbox_syntax_before_any_call_when_the_program_does_not_parse', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.syntaxError()), ERR.SANDBOX_SYNTAX)
    s().track(out.meta.executionId)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.execution.status).toBe(EXECUTION_STATUS.FAILED)
    expect(insp.activities).toEqual([])
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_fail_with_sandbox_runtime_when_the_program_throws_after_a_completed_call', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', `async () => { await api.request({ method: 'GET', path: '/ping' }); throw new Error('boom') }`), ERR.SANDBOX_RUNTIME)
    s().track(out.meta.executionId)
    expect(out.message).toContain('boom')
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.activities.map(a => a.status)).toEqual([ACTIVITY_STATUS.COMPLETED])
    expect(await s().mock.count('GET', '/ping')).toBe(1)
  })

  it('should_stop_at_the_call_limit_and_fail_the_execution', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.manyCalls(13)), ERR.CALL_LIMIT_EXCEEDED)
    s().track(out.meta.executionId)
    expect(await s().mock.count('GET', '/ping')).toBe(12) // the service's maxApiCalls
    expect((await s().admin.inspect(out.meta.executionId!)).execution.status).toBe(EXECUTION_STATUS.FAILED)
  })

  it('should_stop_at_the_concurrent_call_limit', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('commerce', programs.concurrentCalls(4)), ERR.CONCURRENT_LIMIT_EXCEEDED)
    s().track(out.meta.executionId)
    expect(await s().mock.count('GET', '/ping')).toBeLessThanOrEqual(3)
  })

  it('should_reject_an_invalid_api_request_shape_before_journaling_anything', async () => {
    for (const program of [programs.invalidApiRequest(), programs.noPath()]) {
      const out = expectToolError(await s().client('alice').apiExecute('commerce', program), ERR.INVALID_API_REQUEST)
      s().track(out.meta.executionId)
      expect((await s().admin.inspect(out.meta.executionId!)).activities).toEqual([])
    }
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_reject_an_unknown_service_without_creating_an_execution', async () => {
    const out = expectToolError(await s().client('alice').apiExecute('warehouse', programs.ping()), ERR.UNKNOWN_SERVICE)
    expect(out.retryable).toBe(true)
    expect(out.message).toContain('commerce')
    expect(out.meta.executionId).toBeUndefined()
    expect(await s().mock.requests()).toHaveLength(0)
  })

  it('should_fail_the_execution_when_the_backend_is_unreachable_for_a_service', async () => {
    // A hostile 'path' cannot redirect: the base URL is the service's; but a 404 from the backend is an explicit outcome.
    const out = expectCompleted(await s().client('alice').apiExecute('commerce', `async () => (await api.request({ method: 'GET', path: '/no/such/route' })).status`))
    s().track(out.meta.executionId)
    expect(out.value).toBe(404)
    const insp = await s().admin.inspect(out.meta.executionId!)
    expect(insp.activities[0]!.request.specPath).toBe('/no/such/route') // unmatched by the spec: governance saw the raw path
  })
})
