// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * The three seams api_execute is built from (the owner's PR #7 review):
 * the SDK boundary (readMcpRequest) — the only code that reads
 * ServerContext; the outcome mapping (classifyFailure and friends) — one
 * table read by persistence, metrics and audit; and the run orchestrator
 * (runApiExecute) — the execution lifecycle, testable without MCP.
 */
import {describe, expect, it} from 'vitest'
import type {ServerContext} from '@modelcontextprotocol/server'
import {readMcpRequest} from '../../src/tools/mcp-request-view.js'
import {classifyFailure, executionMeta, refusalOutcome, runOutcomeFor} from '../../src/tools/execute-api-outcome.js'
import {type ApiExecuteRunInput, runApiExecute} from '../../src/tools/execute-api-run.js'
import {CircuitOpenError} from '../../src/core/types/circuit-breaker.types.js'
import {PermissionDeniedError} from '../../src/core/types/permission.types.js'
import {
    SandboxCallLimitError,
    SandboxConcurrentLimitError,
    SandboxRuntimeError
} from '../../src/core/types/sandbox-error.types.js'
import {
    ActivityOutcomeUnknownError,
    ApprovalPendingError,
    ApprovalRequiredError,
    ExecutionCancelledError,
    ExecutionLockedError,
    GovernanceDeniedError,
    ReplayDivergedError,
    RunOutcomeNotRecordedError
} from '../../src/core/types/execution.types.js'
import {
    APPROVAL_ID_META_KEY,
    APPROVAL_INPUT_KEY,
    APPROVAL_STATUS,
    ERR,
    EXECUTION_ID_META_KEY,
    EXECUTION_STATUS,
    EXECUTION_STATUS_META_KEY,
    OUTCOME,
    RUN_OUTCOME
} from '../../src/core/constants.js'
import {makeConnector, makeCtx, makeResources, makeRuntime, silentLogger} from './code-mode-harness.js'

const summary = {service: 's', method: 'POST' as const, specPath: '/x', reason: 'r', matchedRules: []}

describe('readMcpRequest — the SDK boundary', () => {
    const state = {executionId: 'e1', approvalId: 'a1', activitySequence: 2, userIdHash: 'h'}

    it('reads a new program\'s request: correlation id, advisory metadata, elicitation support, nothing to resume', () => {
        const view = readMcpRequest(makeCtx({requestId: '7'}))
        expect(view.correlationId).toBe('7')
        expect(view.advisory.protocolVersion).toBe('2026-07-28')
        expect(view.supportsElicitation).toBe(true)
        expect(view.resume).toEqual({})
        expect(readMcpRequest(makeCtx({elicitation: false})).supportsElicitation).toBe(false)
    })

    it('reads an MRTR retry: the verified state, and the answer with approve read once (words included)', () => {
        const view = readMcpRequest(makeCtx({
            state,
            inputResponses: {[APPROVAL_INPUT_KEY]: {action: 'accept', content: {approve: 'Yes', comment: 'go'}}}
        }))
        expect(view.resume).toEqual({state, answer: {action: 'accept', approve: true, comment: 'go'}})
        const declined = readMcpRequest(makeCtx({state, inputResponses: {[APPROVAL_INPUT_KEY]: {action: 'decline'}}}))
        expect(declined.resume.answer).toEqual({action: 'decline'})
    })

    it('reads the _meta resume of a client without elicitation', () => {
        expect(readMcpRequest(makeCtx({executionIdMeta: 'e9'})).resume).toEqual({executionId: 'e9'})
    })

    it('treats anything malformed as "no such input", never as an error', () => {
        const ctxWith = (mcpReq: Record<string, unknown>) => ({
            mcpReq: {
                id: '1',
                method: 'tools/call', ...mcpReq
            }
        }) as unknown as ServerContext
        const malformedStates: unknown[] = [
            undefined, null, 'e1', 42, {},
            {...state, activitySequence: '2'}, {...state, activitySequence: 0}, {...state, activitySequence: 1.5},
            {...state, executionId: ''}, {executionId: 'e1', approvalId: 'a1', activitySequence: 2}
        ]
        for (const value of malformedStates) {
            expect(readMcpRequest(ctxWith({requestState: () => value})).resume.state, JSON.stringify(value)).toBeUndefined()
        }
        // An accessor that throws, or is not a function at all.
        expect(readMcpRequest(ctxWith({
            requestState: () => {
                throw new Error('bad seal')
            }
        })).resume).toEqual({})
        expect(readMcpRequest(ctxWith({requestState: 'not a function'})).resume).toEqual({})
        // A well-formed state keeps only its four fields.
        expect(readMcpRequest(ctxWith({
            requestState: () => ({
                ...state,
                extra: 'dropped'
            })
        })).resume.state).toEqual(state)
        // Answers that are not an elicitation answer under the approval key, or name an unknown action.
        for (const inputResponses of [undefined, {}, {other: {action: 'accept'}}, {[APPROVAL_INPUT_KEY]: {action: 'maybe'}}, {[APPROVAL_INPUT_KEY]: 'yes'}]) {
            expect(readMcpRequest(ctxWith({
                requestState: () => state,
                inputResponses
            })).resume.answer, JSON.stringify(inputResponses)).toBeUndefined()
        }
        // An unrecognised approve value or an empty comment is left out — decide() refuses an accept without approve.
        const odd = readMcpRequest(ctxWith({
            requestState: () => state,
            inputResponses: {[APPROVAL_INPUT_KEY]: {action: 'accept', content: {approve: 'sure thing', comment: ''}}}
        }))
        expect(odd.resume.answer).toEqual({action: 'accept'})
        // An answer without the sealed state is ignored: only an MRTR retry may carry one.
        expect(readMcpRequest(ctxWith({
            inputResponses: {
                [APPROVAL_INPUT_KEY]: {
                    action: 'accept',
                    content: {approve: true}
                }
            }
        })).resume).toEqual({})
        // _meta ids that are not non-empty strings.
        for (const id of [42, '', null, {id: 'e1'}]) {
            expect(readMcpRequest(ctxWith({_meta: {[EXECUTION_ID_META_KEY]: id}})).resume.executionId).toBeUndefined()
        }
        // No context at all (a test double, a transport that supplies none).
        const bare = readMcpRequest(undefined)
        expect(bare.resume).toEqual({})
        expect(bare.supportsElicitation).toBe(false)
        expect(bare.correlationId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('cannot seal requestState without the execution runtime\'s codec', async () => {
        await expect(readMcpRequest(makeCtx()).sealRequestState(state)).rejects.toThrow(/execution runtime/)
    })
})

describe('outcome mapping — one table for persistence, metrics and audit', () => {
    it('classifies every known failure', () => {
        const cases: Array<[Error, ReturnType<typeof classifyFailure>]> = [
            [new ApprovalRequiredError('e', 1, 'a', summary), {
                outcome: OUTCOME.APPROVAL_REQUIRED,
                status: EXECUTION_STATUS.WAITING_APPROVAL,
                sandboxError: false
            }],
            [new ApprovalPendingError('e', 1, 'a', summary), {
                outcome: OUTCOME.APPROVAL_REQUIRED,
                status: EXECUTION_STATUS.WAITING_APPROVAL,
                sandboxError: false
            }],
            [new GovernanceDeniedError('e', 1, 'no', []), {
                outcome: OUTCOME.GOVERNANCE_DENIED,
                status: EXECUTION_STATUS.DENIED,
                sandboxError: false
            }],
            [new ExecutionCancelledError('e', 1), {
                outcome: OUTCOME.EXECUTION_CANCELLED,
                status: EXECUTION_STATUS.CANCELLED,
                sandboxError: false
            }],
            [new ReplayDivergedError('e', 1, 'a', 'b'), {
                outcome: OUTCOME.REPLAY_DIVERGED,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: false
            }],
            [new ActivityOutcomeUnknownError('e', 1, 'POST /x'), {
                outcome: OUTCOME.ERROR,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: false
            }],
            [new RunOutcomeNotRecordedError('e'), {
                outcome: OUTCOME.ERROR,
                status: EXECUTION_STATUS.RUNNING,
                sandboxError: false
            }],
            [new CircuitOpenError('/x', 1000), {
                outcome: OUTCOME.CIRCUIT_OPEN,
                status: EXECUTION_STATUS.INTERRUPTED,
                sandboxError: false,
                openedCircuit: '/x'
            }],
            [new PermissionDeniedError('/x', 'POST'), {
                outcome: OUTCOME.PERMISSION_DENIED,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: false
            }],
            [new SandboxCallLimitError(5), {
                outcome: OUTCOME.CALL_LIMIT_EXCEEDED,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: true
            }],
            [new SandboxConcurrentLimitError(5), {
                outcome: OUTCOME.CONCURRENT_LIMIT_EXCEEDED,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: true
            }],
            [new SandboxRuntimeError('TypeError'), {
                outcome: OUTCOME.ERROR,
                status: EXECUTION_STATUS.FAILED,
                sandboxError: true
            }],
            [new ExecutionLockedError('e'), {
                outcome: OUTCOME.ERROR,
                status: EXECUTION_STATUS.INTERRUPTED,
                sandboxError: true
            }] // retryable ⇒ resumable
        ]
        for (const [err, expected] of cases) expect(classifyFailure(err), err.name).toEqual(expected)
        expect(classifyFailure('a thrown string')).toEqual({
            outcome: OUTCOME.ERROR,
            status: EXECUTION_STATUS.FAILED,
            sandboxError: true
        })
    })

    it('maps a failure to the run outcome the store records', () => {
        expect(runOutcomeFor(new ApprovalRequiredError('e', 1, 'ap-1', summary), EXECUTION_STATUS.WAITING_APPROVAL, ERR.APPROVAL_REQUIRED, 'm'))
            .toEqual({kind: RUN_OUTCOME.WAITING_APPROVAL, approvalId: 'ap-1'})
        for (const [status, kind] of [
            [EXECUTION_STATUS.DENIED, RUN_OUTCOME.DENIED], [EXECUTION_STATUS.CANCELLED, RUN_OUTCOME.CANCELLED],
            [EXECUTION_STATUS.INTERRUPTED, RUN_OUTCOME.INTERRUPTED], [EXECUTION_STATUS.FAILED, RUN_OUTCOME.FAILED]
        ] as const) {
            expect(runOutcomeFor(new Error('x'), status, 'C', 'm')).toEqual({kind, code: 'C', message: 'm'})
        }
    })

    it('maps a refusal\'s code to its audit outcome, and builds the harbor/* _meta keys', () => {
        expect(refusalOutcome(ERR.GOVERNANCE_DENIED)).toBe(OUTCOME.GOVERNANCE_DENIED)
        expect(refusalOutcome(ERR.EXECUTION_CANCELLED)).toBe(OUTCOME.EXECUTION_CANCELLED)
        expect(refusalOutcome(ERR.EXECUTION_NOT_RESUMABLE)).toBe(OUTCOME.ERROR)
        expect(executionMeta()).toBeUndefined()
        expect(executionMeta('e', EXECUTION_STATUS.WAITING_APPROVAL, 'a')).toEqual({
            [EXECUTION_ID_META_KEY]: 'e',
            [EXECUTION_STATUS_META_KEY]: EXECUTION_STATUS.WAITING_APPROVAL,
            [APPROVAL_ID_META_KEY]: 'a'
        })
    })
})

describe('runApiExecute — the run orchestrator, without MCP', () => {
    const FINALIZE_NEEDS_APPROVAL = {
        name: 'finalize-needs-approval',
        match: {operation: 'finalizeCampaign'},
        action: {type: 'REQUIRE_APPROVAL', reason: 'r'}
    }
    const PROGRAM = `async () => {
    const c = await api.request({ method: 'GET', path: '/campaigns' })
    await api.request({ method: 'POST', path: '/campaigns/' + c.data[0].id + '/finalize' })
    return 'done'
  }`

    function input(ctx: ServerContext, resources = makeResources('trafficking', makeConnector().connector)): ApiExecuteRunInput {
        return {
            service: 'trafficking', code: PROGRAM, request: readMcpRequest(ctx), resources,
            tokenPayload: {access_token: 'tok', token_type: 'bearer', expires_in: 60, refresh_token: '', scope: ''},
            invalidate: async () => {
            }, userIdHash: 'owner'
        }
    }

    it('legacy (no runtime): runs the program and reports it completed, with no execution', async () => {
        const report = await runApiExecute(input(makeCtx()), {logger: silentLogger})
        expect(report).toMatchObject({kind: 'completed', result: 'done', program: PROGRAM})
        expect(report).not.toHaveProperty('executionId')
    })

    it('governed: a pause is a failed report carrying the approval error and WAITING_APPROVAL — already persisted', async () => {
        const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL])
        const report = await runApiExecute(input(makeCtx()), {governanceRuntime, logger: silentLogger})
        expect(report.kind).toBe('failed')
        if (report.kind !== 'failed') return
        expect(report.error).toBeInstanceOf(ApprovalRequiredError)
        expect(report.status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect((await governanceRuntime.executionManager.load(report.executionId!)).status).toBe(EXECUTION_STATUS.WAITING_APPROVAL)
        expect(report.calls.entries().map(e => e.outcome)).toEqual(['EXECUTED'])
    })

    it('governed: a resume by another principal is refused before anything runs; one without an answer is asked again', async () => {
        const governanceRuntime = makeRuntime([FINALIZE_NEEDS_APPROVAL])
        const paused = await runApiExecute(input(makeCtx()), {governanceRuntime, logger: silentLogger})
        const executionId = paused.kind === 'failed' ? paused.executionId! : ''
        const approval = (await governanceRuntime.executionManager.inspect(executionId)).approvals[0]!

        const foreign = await runApiExecute({
            ...input(makeCtx({executionIdMeta: executionId})),
            userIdHash: 'mallory'
        }, {governanceRuntime, logger: silentLogger})
        expect(foreign).toMatchObject({
            kind: 'refused',
            executionId,
            refusal: {code: ERR.EXECUTION_NOT_RESUMABLE, retryable: false}
        })

        const state = {executionId, approvalId: approval.approvalId, activitySequence: 2, userIdHash: 'owner'}
        const again = await runApiExecute(input(makeCtx({state})), {governanceRuntime, logger: silentLogger})
        expect(again).toEqual({kind: 'askAgain', executionId, approvalId: approval.approvalId, state})
        expect((await governanceRuntime.approvals.get(approval.approvalId)).status).toBe(APPROVAL_STATUS.PENDING)
    })
})
