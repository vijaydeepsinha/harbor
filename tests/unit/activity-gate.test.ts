// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it} from 'vitest'
import {ActivityGate, type GovernanceVerdict} from '../../src/runtime/execution/activity-gate.js'
import {ActivityJournal} from '../../src/runtime/execution/activity-journal.js'
import {InMemoryExecutionStore} from '../../src/adapters/execution/in-memory-execution-store.js'
import {resolveOperation} from '../../src/runtime/governance/operation-resolver.js'
import {ACTIVITY_STATUS, type ActivityStatus, ERR} from '../../src/core/constants.js'
import {type ApprovalSummary, ReplayDivergedError} from '../../src/core/types/execution.types.js'
import type {ApiRequest} from '../../src/spi/connector/connector-api.js'
import {campaignSpec} from './code-mode-harness.js'

const FINALIZE: ApiRequest = {method: 'POST', path: '/campaigns/C1/finalize', body: {note: 'go'}}
const LIST: ApiRequest = {method: 'GET', path: '/campaigns'}
const SUMMARY: ApprovalSummary = {
    service: 'trafficking',
    method: 'POST',
    specPath: '/campaigns/{id}/finalize',
    reason: 'r',
    matchedRules: ['x']
}

describe('ActivityGate — the single owner of replay and governance for a governed call', () => {
    let persistence: InMemoryExecutionStore
    let journal: ActivityJournal
    beforeEach(() => {
        persistence = new InMemoryExecutionStore()
        journal = new ActivityJournal(persistence, 'exec-1', 'trafficking', 2)
    })

    const gate = (decide?: (seq: number) => Promise<GovernanceVerdict>) => new ActivityGate({
        journal,
        resolve: (m, p) => resolveOperation(campaignSpec, m, p),
        ...(decide ? {decide: (seq: number) => decide(seq)} : {})
    })
    const admit = (g: ActivityGate, req: ApiRequest) => g.admit(req, g.resolve(req.method, req.path))

    /** Journals activity #1 as a previous run left it. */
    async function seed(req: ApiRequest, status: ActivityStatus, extra: Record<string, unknown> = {}) {
        const resolved = resolveOperation(campaignSpec, req.method, req.path)
        await persistence.putActivity({
            executionId: 'exec-1', sequence: 1, service: 'trafficking', status,
            // As the journal records it: the request the program sent, query and body included.
            request: {
                method: req.method, rawPath: req.path, specPath: resolved.specPath,
                ...(req.params !== undefined ? {query: req.params} : {}), ...(req.body !== undefined ? {body: req.body} : {})
            },
            runIndex: 1, createdAt: 't0', updatedAt: 't1', ...extra
        })
    }

    it.each([
        [ACTIVITY_STATUS.WAITING_APPROVAL, {approvalId: 'ap-1'}, 'approvalRequired', ERR.APPROVAL_REQUIRED, 'Activity #1 is waiting for approval'],
        [ACTIVITY_STATUS.DENIED, {}, 'governanceDenied', ERR.GOVERNANCE_DENIED, 'Activity #1 was denied'],
        [ACTIVITY_STATUS.CANCELLED, {}, 'cancelled', ERR.EXECUTION_CANCELLED, 'Activity #1 was cancelled'],
        [ACTIVITY_STATUS.FAILED, {}, 'outcomeUnknown', ERR.ACTIVITY_OUTCOME_UNKNOWN, 'Activity #1 failed in a previous run'],
        [ACTIVITY_STATUS.EXECUTING, {}, 'outcomeUnknown', ERR.ACTIVITY_OUTCOME_UNKNOWN, 'Activity #1 was in flight when a previous run ended']
    ] as const)('journaled %s ⇒ stop (%s) without asking governance', async (status, extra, stopKind, code, message) => {
        await seed(FINALIZE, status, extra)
        let asked = 0
        const r = await admit(gate(async () => {
            asked++;
            return {decision: 'ALLOW'}
        }), FINALIZE)
        expect(r).toMatchObject({kind: 'stop', stop: {kind: stopKind, sequence: 1}, code, message})
        expect(asked).toBe(0)
    })

    it('a journaled WAITING_APPROVAL re-pauses on the same approval with a "pending from a previous run" summary', async () => {
        await seed(FINALIZE, ACTIVITY_STATUS.WAITING_APPROVAL, {approvalId: 'ap-1'})
        const r = await admit(gate(), FINALIZE)
        expect(r).toMatchObject({
            kind: 'stop',
            stop: {
                approvalId: 'ap-1',
                summary: {
                    operationId: 'finalizeCampaign',
                    reason: 'Approval pending from a previous run',
                    body: {note: 'go'}
                }
            }
        })
    })

    it('COMPLETED ⇒ replay the recorded response; APPROVED ⇒ execute with the approval id; EXECUTING GET ⇒ re-execute', async () => {
        await seed(LIST, ACTIVITY_STATUS.COMPLETED, {response: {status: 200, ok: true, data: [{id: 'C1'}]}})
        expect(await admit(gate(), LIST)).toEqual({
            kind: 'replay',
            sequence: 1,
            response: {status: 200, ok: true, data: [{id: 'C1'}]}
        })

        journal = new ActivityJournal(persistence, 'exec-1', 'trafficking', 2)
        await seed(FINALIZE, ACTIVITY_STATUS.APPROVED, {approvalId: 'ap-1'})
        expect(await admit(gate(), FINALIZE)).toMatchObject({kind: 'execute', sequence: 1, approvalId: 'ap-1'})

        journal = new ActivityJournal(persistence, 'exec-1', 'trafficking', 2)
        await seed(LIST, ACTIVITY_STATUS.EXECUTING)
        const again = await admit(gate(), LIST)
        expect(again.kind).toBe('execute')
        expect(again).not.toHaveProperty('approvalId')
    })

    it('a new activity asks governance: ALLOW executes, DENY and REQUIRE_APPROVAL stop and are journaled', async () => {
        expect(await admit(gate(async () => ({decision: 'ALLOW'})), FINALIZE)).toMatchObject({
            kind: 'execute',
            sequence: 1,
            request: {specPath: '/campaigns/{id}/finalize', pathParams: {id: 'C1'}}
        })

        journal = new ActivityJournal(new InMemoryExecutionStore(), 'exec-2', 'trafficking', 1)
        const denied = await admit(gate(async () => ({
            decision: 'DENY',
            reason: 'frozen',
            matchedRules: ['no-finalize']
        })), FINALIZE)
        expect(denied).toMatchObject({
            kind: 'stop',
            stop: {kind: 'governanceDenied', reason: 'frozen', matchedRules: ['no-finalize']},
            code: ERR.GOVERNANCE_DENIED,
            message: 'Governance denied POST /campaigns/{id}/finalize: frozen'
        })

        persistence = new InMemoryExecutionStore()
        journal = new ActivityJournal(persistence, 'exec-3', 'trafficking', 1)
        const paused = await admit(gate(async () => ({
            decision: 'REQUIRE_APPROVAL',
            approvalId: 'ap-9',
            summary: SUMMARY
        })), FINALIZE)
        expect(paused).toMatchObject({
            kind: 'stop',
            stop: {kind: 'approvalRequired', approvalId: 'ap-9', summary: SUMMARY},
            code: ERR.APPROVAL_REQUIRED
        })
        expect(await persistence.getActivity('exec-3', 1)).toMatchObject({
            status: ACTIVITY_STATUS.WAITING_APPROVAL,
            approvalId: 'ap-9'
        })
    })

    it('without a governance hook a new activity executes (journal + replay only)', async () => {
        expect(await admit(gate(), FINALIZE)).toMatchObject({kind: 'execute', sequence: 1})
    })

    it('a different call at a journaled sequence propagates ReplayDivergedError', async () => {
        await seed(LIST, ACTIVITY_STATUS.COMPLETED, {response: {status: 200, ok: true, data: []}})
        await expect(admit(gate(), FINALIZE)).rejects.toBeInstanceOf(ReplayDivergedError)
    })

    it.each([
        [ACTIVITY_STATUS.APPROVED, {approvalId: 'ap-1'}],
        [ACTIVITY_STATUS.WAITING_APPROVAL, {approvalId: 'ap-1'}],
        [ACTIVITY_STATUS.EXECUTING, {}]
    ] as const)('journaled %s binds the whole request: another body, query or resource diverges', async (status, extra) => {
        const request = status === ACTIVITY_STATUS.EXECUTING ? {...LIST, params: {page: 1}} : FINALIZE
        await seed(request, status, extra)
        const variants: ApiRequest[] = status === ACTIVITY_STATUS.EXECUTING
            ? [{...LIST, params: {page: 2}}, LIST]
            : [{...FINALIZE, body: {note: 'other'}}, {...FINALIZE, params: {force: true}}, {
                ...FINALIZE,
                path: '/campaigns/C2/finalize'
            }]
        for (const v of variants) {
            journal = new ActivityJournal(persistence, 'exec-1', 'trafficking', 2) // each attempt is a fresh run reaching #1
            await expect(admit(gate(), v)).rejects.toBeInstanceOf(ReplayDivergedError)
        }
    })

    it('journaled COMPLETED binds the resource but not the body: a replay is a read of history, not an execution', async () => {
        await seed(FINALIZE, ACTIVITY_STATUS.COMPLETED, {response: {status: 201, ok: true, data: {}}})
        expect(await admit(gate(), {...FINALIZE, body: {note: 'drifted'}})).toMatchObject({kind: 'replay'})
        journal = new ActivityJournal(persistence, 'exec-1', 'trafficking', 2)
        await expect(admit(gate(), {
            ...FINALIZE,
            path: '/campaigns/C2/finalize'
        })).rejects.toBeInstanceOf(ReplayDivergedError)
    })

    it('begin journals an admitted call as EXECUTING; the journal then records how it ended', async () => {
        const g = gate()
        const first = await admit(g, FINALIZE)
        if (first.kind !== 'execute') throw new Error('expected execute')
        await g.begin(first)
        expect((await persistence.getActivity('exec-1', 1))?.status).toBe(ACTIVITY_STATUS.EXECUTING)
        await journal.recordResponse({method: 'POST', endpoint: '/campaigns/{id}/finalize'}, {
            status: 201,
            ok: true,
            data: {id: 'x'}
        }, 1)
        expect(await persistence.getActivity('exec-1', 1)).toMatchObject({
            status: ACTIVITY_STATUS.COMPLETED,
            response: {status: 201}
        })

        const second = await admit(g, LIST)
        if (second.kind !== 'execute') throw new Error('expected execute')
        await g.begin(second)
        await journal.recordFailure({method: 'GET', endpoint: '/campaigns'}, {
            code: ERR.API_ERROR,
            message: 'socket hang up',
            aborted: false
        }, 2)
        expect(await persistence.getActivity('exec-1', 2)).toMatchObject({
            status: ACTIVITY_STATUS.FAILED,
            failure: {code: ERR.API_ERROR, outcomeKnown: false}
        })
    })
})
