// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {inputResponse, type ServerContext} from '@modelcontextprotocol/server'
import {z} from 'zod'
import {APPROVAL_INPUT_KEY, EXECUTION_ID_META_KEY} from '../core/constants.js'
import {readApprovalAnswer} from '../runtime/execution/approval-service.js'
import type {ResumeState, ResumeStateCodec} from '../runtime/execution/request-state.js'
import {type AdvisoryRequestMeta, extractCorrelationId, readRequestMeta} from './tool-helpers.js'

/** The human's answer an MRTR retry carries. `approve` has been read with `readApprovalAnswer`. */
export interface ApprovalAnswer {
    action: 'accept' | 'decline' | 'cancel'
    /** Absent: no answer, or one that is not recognised — `decide` refuses an accept without it. */
    approve?: boolean
    comment?: string
}

/** How a request asks to continue an execution. Empty for a new program. */
export interface ResumeRequest {
    /** A verified MRTR retry's sealed state: the SDK checked the seal, this boundary checks the shape. */
    state?: ResumeState
    /** The answer that retry carries. A retry without one is asked again. */
    answer?: ApprovalAnswer
    /** `_meta["harbor/execution-id"]`: how a client without elicitation resumes after deciding over HTTP. */
    executionId?: string
}

/**
 * The SDK boundary of `api_execute`: everything the tool reads from an MCP
 * request, read once and validated here. The rest of the tool — the run
 * orchestrator and the responder — works on this view and never touches
 * `ServerContext`, so a change in the SDK's context shape is a change to
 * this file alone, and nothing a client sent reaches the execution logic
 * unchecked. Every field is client-controlled input; none of it is auth.
 */
export interface McpRequestView {
    /** The JSON-RPC request id (a fresh UUID when absent) — logs, and the legacy path's correlation id. */
    correlationId: string
    /** Advisory client metadata: protocol version, client info, capabilities. Logging only. */
    advisory: AdvisoryRequestMeta
    /** The client declared `elicitation`, so an approval can be asked inside MCP (`input_required`). */
    supportsElicitation: boolean
    resume: ResumeRequest

    /** Seals `requestState` for an `input_required` answer to this request (bound to its JSON-RPC method). */
    sealRequestState(state: ResumeState): Promise<string>
}

const resumeStateSchema = z.object({
    executionId: z.string().min(1),
    approvalId: z.string().min(1),
    activitySequence: z.number().int().positive(),
    userIdHash: z.string().min(1)
})

/**
 * Builds the validated view of one incoming MCP request.
 * The function reads only the fields the tool is allowed to consume from
 * `ServerContext`, normalizes them into a stable shape, and treats missing or
 * malformed values as "no such input" instead of failing the whole request.
 * `codec` is the execution runtime's requestState codec; it is absent on the
 * legacy path, where nothing is sealed or resumed.
 */
export function readMcpRequest(ctx: ServerContext | undefined, codec?: Pick<ResumeStateCodec, 'mint'>): McpRequestView {
    const advisory = readRequestMeta(ctx)
    const elicitation = advisory.clientCapabilities?.['elicitation']
    const state = readResumeState(ctx)
    const answer = state ? readAnswer(ctx) : undefined
    const metaId = ctx?.mcpReq?._meta?.[EXECUTION_ID_META_KEY]
    return {
        correlationId: extractCorrelationId(ctx),
        advisory,
        supportsElicitation: elicitation !== undefined && elicitation !== null,
        resume: {
            ...(state !== undefined ? {state} : {}),
            ...(answer !== undefined ? {answer} : {}),
            ...(typeof metaId === 'string' && metaId !== '' ? {executionId: metaId} : {})
        },
        sealRequestState: async (resumeState: ResumeState): Promise<string> => {
            if (!codec || !ctx) throw new Error('requestState cannot be sealed without an execution runtime and a request context')
            return codec.mint(resumeState, ctx)
        }
    }
}

/** The SDK has already verified the seal before the handler runs; the payload still gets a shape check. */
function readResumeState(ctx: ServerContext | undefined): ResumeState | undefined {
    const accessor: unknown = ctx?.mcpReq?.requestState
    if (typeof accessor !== 'function') return undefined
    let value: unknown
    try {
        value = (accessor as () => unknown)()
    } catch {
        return undefined
    }
    const parsed = resumeStateSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

const ANSWER_ACTIONS: ReadonlySet<string> = new Set(['accept', 'decline', 'cancel'])

/** Only an elicitation answer under the approval key counts; anything else reads as "no answer". */
function readAnswer(ctx: ServerContext | undefined): ApprovalAnswer | undefined {
    const view = inputResponse(ctx?.mcpReq?.inputResponses, APPROVAL_INPUT_KEY)
    if (view.kind !== 'elicit' || !ANSWER_ACTIONS.has(view.action)) return undefined
    const approve = readApprovalAnswer(view.content?.['approve'])
    const comment = view.content?.['comment']
    return {
        action: view.action,
        ...(approve !== undefined ? {approve} : {}),
        ...(typeof comment === 'string' && comment !== '' ? {comment} : {})
    }
}
