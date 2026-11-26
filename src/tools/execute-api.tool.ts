// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {inputRequired, type InputRequiredResult, McpServer} from '@modelcontextprotocol/server'
import {z} from 'zod'
import {v4 as uuidv4} from 'uuid'
import type {ServiceRegistry, ServiceResources} from '../runtime/registry/service-registry.js'
import type {GlobalConfig} from '../core/types/config.types.js'
import type {Logger} from '../runtime/observability/logger.js'
import type {MetricsCollector} from '../core/types/metrics.types.js'
import {AuditCollector, writeAuditRecord} from '../runtime/observability/audit.js'
import type {AuditPipeline} from '../runtime/observability/audit-pipeline.js'
import {ProgressCollector} from '../runtime/observability/progress.js'
import {SandboxExecutionError} from '../core/types/sandbox-error.types.js'
import {ApprovalRequiredError} from '../core/types/execution.types.js'
import type {GovernanceRuntime} from '../runtime/execution/governance-runtime.js'
import type {ResumeState} from '../runtime/execution/request-state.js'
import {CallLog, type CallLogSource} from '../runtime/execution/activity-journal.js'
import {isToolError, mcpError, mcpSuccess, resolveService, type ToolResponse, validateAuth} from './tool-helpers.js'
import {type McpRequestView, readMcpRequest} from './mcp-request-view.js'
import {type ApiExecuteResult, runApiExecute} from './execute-api-run.js'
import {classifyFailure, executionMeta, refusalOutcome} from './execute-api-outcome.js'
import {
    APPROVAL_INPUT_KEY,
    type AuditOutcome,
    ERR,
    EXECUTION_ID_META_KEY,
    EXECUTION_STATUS,
    LOG_PREFIX,
    METRIC,
    OUTCOME,
    TOOL
} from '../core/constants.js'
import {ensureError, errorCode as getErrorCode, errorRetryable} from '../core/utils/errors.js'
import {hashAuthenticatedPrincipal} from '../core/utils/user-id-hash.js'

export function registerExecuteApiTool(
    server: McpServer,
    registry: ServiceRegistry,
    globalConfig: GlobalConfig,
    logger: Logger,
    metrics: MetricsCollector,
    clientToken?: string,
    /** Absent ⇒ legacy behaviour: no durable execution, no governance. */
    governanceRuntime?: GovernanceRuntime,
    /** Where audit records go (AUDIT_SINKS). Absent ⇒ written to the service logger, as before. */
    auditPipeline?: AuditPipeline,
    /** The caller's X-Harbor-Client-ID from the inbound request, forwarded on every backend call. */
    callerClientId?: string
): void {
    const serviceNames = registry.serviceNames()

    const EXECUTE_DESCRIPTION = `Execute API calls against a specific backend service by writing a
JavaScript async arrow function.

Only call this AFTER you have:
  1. Found the right service via discover_services()
  2. (Optional) Checked discover_skills() for the workflow
  3. (Optional) Read each matching Skill via get_skill_details(service, skill_name)
  4. Found the exact endpoints via search_code()

Steps 2-3 are optional unless the service description declares a mandatory
prerequisite. Not every scenario has a matching Skill. If discover_skills() returns no relevant
skill_name and the service description does not declare a mandatory prerequisite,
skip steps 2-3. Do not invent a skill_name; discovery is the source of that value.

IMPORTANT: You MUST provide the "service" parameter to select which backend to call.
Available services: ${serviceNames.join(', ')}

You have access to:
  api.request(config) → makes an authenticated HTTP call

config shape:
{
  method:   'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path:     string,    // exact path from search_code() — never invent
  params?:  object,    // query parameters as flat key-value object
  body?:    object,    // request body for POST/PUT/PATCH
  headers?: object     // additional headers if needed
}

Returns: { data: any, status: number, ok: boolean }

Rules:
  1. Always use paths confirmed by search_code() — never guess
  2. Follow business rules from get_skill_details() when a skill was consulted
  3. Chain multiple api.request() calls in one function when possible
  4. Filter results before returning — only return what user needs
  5. For write operations: confirm change by reading after writing
  6. For paginated endpoints: loop until all records collected

Governance: some operations require human approval. When that happens the
result carries "${EXECUTION_ID_META_KEY}" in _meta. Prefer resuming by that
execution id after deciding through the Harbor execution API. Standard MCP
elicitation/requestState remains supported when the client does not provide
the execution id. Do NOT rewrite or resend a different program — Harbor
resumes the original program and never repeats calls it already made.

Pattern — fetch pending orders and cancel them:
async () => {
  const { data: orders } = await api.request({
    method: 'GET', path: '/orders', params: { status: 'pending' }
  })
  const results = []
  for (const order of orders) {
    const r = await api.request({
      method: 'PATCH',
      path: \`/orders/\${order.id}\`,
      body: { status: 'cancelled' }
    })
    results.push({ id: order.id, cancelled: r.ok })
  }
  return {
    total: results.length,
    cancelled: results.filter(r => r.cancelled).length
  }
}

Pattern — paginated collection:
async () => {
  let page = 1, allItems = []
  while (true) {
    const { data } = await api.request({
      method: 'GET',
      path: '/orders',
      params: { page, limit: 100, status: 'pending' }
    })
    allItems = allItems.concat(data.items)
    if (!data.hasNextPage) break
    page++
  }
  return { total: allItems.length }
}

Pattern — create then verify:
async () => {
  const created = await api.request({
    method: 'POST', path: '/campaigns',
    body: { name: 'Q4 Campaign', budget: 10000 }
  })
  if (!created.ok) return { error: created.data }
  const verify = await api.request({
    method: 'GET', path: \`/campaigns/\${created.data.id}\`
  })
  return verify.data
}`

    server.registerTool(
        TOOL.API_EXECUTE,
        {description: EXECUTE_DESCRIPTION, inputSchema: z.object({service: z.string(), code: z.string()})},
        async ({service, code}, ctx): Promise<ToolResponse | InputRequiredResult> => {
            // The SDK boundary: from here on the tool reads this validated view, never ServerContext.
            const request = readMcpRequest(ctx, governanceRuntime?.requestState)
            const {correlationId} = request
            logger.info(
                {correlationId, tool: TOOL.API_EXECUTE, service, ...request.advisory},
                `${LOG_PREFIX.MCP_IN} ${TOOL.API_EXECUTE} — request received from AI client`
            )

            // An unknown service is answered with the names that do exist; there is
            // no service to audit it under and nothing to run, so it returns here.
            const resources = resolveService(registry, service, serviceNames)
            if (isToolError(resources)) return resources
            const startTime = Date.now()

            logger.info({correlationId, service, step: '1/4 auth'}, `${LOG_PREFIX.MCP} Validating token...`)
            const authResult = await validateAuth(resources, clientToken, correlationId, logger, TOOL.API_EXECUTE)
            if (isToolError(authResult)) return authResult
            const {payload: tokenPayload, invalidate} = authResult
            const userIdHash = hashAuthenticatedPrincipal(tokenPayload, clientToken)

            logger.info({
                correlationId,
                service,
                step: '2/4 code'
            }, `${LOG_PREFIX.MCP} JavaScript code received from AI client`)
            logger.debug({correlationId, service, codeReceived: code}, `${LOG_PREFIX.MCP} code payload`)

            const report = await runApiExecute(
                {service, code, request, resources, tokenPayload, invalidate, userIdHash},
                {governanceRuntime, logger, metrics, ...(callerClientId !== undefined ? {callerClientId} : {})}
            )
            return respond(report, {
                service, code, request, resources, userIdHash, startTime,
                globalConfig, logger, metrics, governanceRuntime, auditPipeline
            })
        }
    )
}

// ── responder: a report becomes metrics, an audit record and the MCP result ──

interface Responder {
    service: string
    /** The program as this caller sent it. */
    code: string
    request: McpRequestView
    resources: ServiceResources
    /** The principal that authenticated for this call — every audit record names it. */
    userIdHash: string
    startTime: number
    globalConfig: GlobalConfig
    logger: Logger
    metrics: MetricsCollector
    governanceRuntime: GovernanceRuntime | undefined
    auditPipeline: AuditPipeline | undefined
}

const NO_CALLS: CallLogSource = new CallLog()

async function respond(apiExecuteResult: ApiExecuteResult, responder: Responder): Promise<ToolResponse | InputRequiredResult> {
    switch (apiExecuteResult.kind) {
        case 'askAgain':
            // Before the call there was nothing new to record: the question is simply put again.
            // Approval resumes require the execution runtime; this guard fails fast instead of
            // letting the request proceed without the data needed to seal the approval state.
            return buildInputRequired(
                requireGovernanceRuntime(responder),
                responder.request,
                apiExecuteResult.approvalId,
                apiExecuteResult.state
            )

        case 'refused': {
            // Refused, or the answer itself ended the execution (decline, cancel): nothing ran, but the
            // decision is part of the audit trail — under the principal that just authenticated, which
            // for a refused resume is the caller who tried, not the execution's owner. codeSubmitted
            // stays what this caller sent — never the persisted program, which may belong to someone else.
            // Destructure only the fields we need from the result object. This is equivalent to
            // `apiExecuteResult.refusal` and `apiExecuteResult.executionId`, but keeps the call-site concise.
            const {refusal, executionId} = apiExecuteResult
            audit(responder, {calls: NO_CALLS, executionId}, {
                outcome: refusalOutcome(refusal.code),
                errorCode: refusal.code
            }, responder.code)
            return mcpError(
                refusal.message, refusal.code, refusal.retryable, refusal.extra,
                refusal.meta ? executionMeta(executionId, refusal.meta.status, refusal.meta.approvalId) : undefined
            )
        }

        case 'completed': {
            const {result, executionId, calls} = apiExecuteResult
            const collector = new AuditCollector(calls)
            responder.logger.info(
                {
                    correlationId: responder.request.correlationId,
                    service: responder.service,
                    executionId,
                    step: '4/4 done',
                    durationMs: Date.now() - responder.startTime,
                    apiCallCount: collector.getCallCount(),
                    endpointsAccessed: collector.getEndpoints()
                },
                `${LOG_PREFIX.MCP_OUT} ${TOOL.API_EXECUTE} — result returned to AI client`
            )
            responder.logger.debug({
                correlationId: responder.request.correlationId,
                service: responder.service,
                response: JSON.stringify(result, null, 2)
            }, `${LOG_PREFIX.MCP_OUT} response payload`)
            responder.metrics.increment(METRIC.TOOL_CALLS, {
                tool: TOOL.API_EXECUTE,
                service: responder.service,
                outcome: OUTCOME.SUCCESS
            })
            audit(responder, apiExecuteResult, {outcome: OUTCOME.SUCCESS}, apiExecuteResult.program)
            return mcpSuccess(result, executionMeta(executionId, EXECUTION_STATUS.COMPLETED))
        }

        case 'failed':
            return respondToFailure(apiExecuteResult, responder)
    }
}

async function respondToFailure(apiExecuteResult: Extract<ApiExecuteResult, {
    kind: 'failed'
}>, responder: Responder): Promise<ToolResponse | InputRequiredResult> {
    const {error, executionId} = apiExecuteResult
    const errObj = ensureError(error)
    const errorCode = getErrorCode(error)
    const failure = classifyFailure(error)
    // `request` is the normalized MCP view; its first-class `correlationId` field is the
    // request-scoped trace id used for logs and metrics. It is distinct from a durable
    // execution id and is intentionally not read from the response `_meta`.
    const {correlationId} = responder.request

    if (failure.openedCircuit !== undefined) responder.metrics.increment(METRIC.CB_OPENS, {endpoint: failure.openedCircuit})
    if (failure.sandboxError) responder.metrics.increment(METRIC.SANDBOX_ERRORS, {
        tool: TOOL.API_EXECUTE,
        errorType: errorCode
    })
    responder.metrics.increment(METRIC.TOOL_CALLS, {
        tool: TOOL.API_EXECUTE,
        service: responder.service,
        outcome: failure.outcome
    })

    // Log raw cause server-side for internal errors; client response stays sanitized.
    if (error instanceof SandboxExecutionError && error.cause) {
        const cause = ensureError(error.cause)
        responder.logger.error(
            {
                correlationId,
                service: responder.service,
                executionId,
                errorCode,
                causeMessage: cause.message,
                causeStack: cause.stack
            },
            `${TOOL.API_EXECUTE} failed — internal sandbox error`
        )
    } else {
        responder.logger.warn({
            correlationId,
            service: responder.service,
            executionId,
            errorCode,
            message: errObj.message
        }, `${TOOL.API_EXECUTE} failed`)
    }

    audit(responder, apiExecuteResult, {
        outcome: failure.outcome,
        errorType: errObj.name,
        errorCode
    }, apiExecuteResult.program)

    // A pause: hand the question to the client.
    if (error instanceof ApprovalRequiredError && responder.governanceRuntime && executionId !== undefined) {
        return approvalResult(responder.governanceRuntime, responder.request, error, responder.userIdHash, responder.logger)
    }

    // Attach structured progress (per-call status + ids extracted from
    // successful POST responses) so the caller can resume a failed
    // multi-step workflow without recreating already-created entities.
    // Omit the field entirely when nothing was recorded to keep the
    // payload minimal.
    const progress = new ProgressCollector(apiExecuteResult.calls, responder.resources.sandboxLimits.maxApiCalls)
    const extra = {
        ...(progress.hasAny() ? {progress: progress.summary()} : {}),
        ...(executionId !== undefined ? {executionId} : {})
    }
    return mcpError(
        errObj.message,
        errorCode,
        errorRetryable(error),
        Object.keys(extra).length ? extra : undefined,
        executionMeta(executionId, apiExecuteResult.status)
    )
}

/** One audit record for this tool call; `codeSubmitted` is the program that ran, or what the caller sent when nothing did. */
function audit(
    responder: Responder,
    run: { calls: CallLogSource; executionId?: string },
    fields: { outcome: AuditOutcome; errorType?: string; errorCode?: string },
    codeSubmitted: string
): void {
    const collector = new AuditCollector(run.calls)
    writeAuditRecord(
        {
            auditId: uuidv4(),
            timestamp: new Date().toISOString(),
            service: responder.resources.name,
            environment: responder.globalConfig.observability.environment,
            userIdHash: responder.userIdHash,
            correlationId: responder.request.correlationId,
            tool: TOOL.API_EXECUTE,
            authStrategy: responder.resources.authStrategyName,
            idempotencyStrategy: responder.resources.idempotencyStrategyName,
            circuitBreakerStrategy: responder.resources.circuitBreakerStrategyName,
            codeSubmitted,
            endpointsAccessed: collector.getEndpoints(),
            apiCallCount: collector.getCallCount(),
            durationMs: Date.now() - responder.startTime,
            ...(run.executionId !== undefined ? {executionId: run.executionId} : {}),
            ...fields
        },
        responder.resources.logger,
        responder.globalConfig,
        responder.auditPipeline
    )
}

function requireGovernanceRuntime(r: Responder): GovernanceRuntime {
    if (!r.governanceRuntime) throw new Error('An approval answer needs the execution runtime')
    return r.governanceRuntime
}

/** Either an MRTR `input_required` (client supports elicitation) or an APPROVAL_REQUIRED error with the ids in `_meta`. */
async function approvalResult(
    governanceRuntime: GovernanceRuntime,
    request: McpRequestView,
    approvalRequiredError: ApprovalRequiredError,
    userIdHash: string,
    logger: Logger
): Promise<ToolResponse | InputRequiredResult> {
    const {correlationId} = request
    if (request.supportsElicitation) {
        logger.info({
            correlationId,
            executionId: approvalRequiredError.executionId,
            approvalId: approvalRequiredError.approvalId
        }, 'Execution paused — approval requested via MCP elicitation fallback')
        return buildInputRequired(governanceRuntime, request, approvalRequiredError.approvalId, {
            executionId: approvalRequiredError.executionId,
            approvalId: approvalRequiredError.approvalId,
            activitySequence: approvalRequiredError.activitySequence,
            userIdHash
        })
    }
    logger.info({
        correlationId,
        executionId: approvalRequiredError.executionId,
        approvalId: approvalRequiredError.approvalId
    }, 'Execution paused — approval decision expected over HTTP')
    return mcpError(
        `${approvalRequiredError.message} Decide via POST /executions/${approvalRequiredError.executionId}/approvals/${approvalRequiredError.approvalId}, ` +
        `then call ${TOOL.API_EXECUTE} again with _meta["${EXECUTION_ID_META_KEY}"] = "${approvalRequiredError.executionId}" to resume.`,
        ERR.APPROVAL_REQUIRED,
        false,
        {
            executionId: approvalRequiredError.executionId,
            approvalId: approvalRequiredError.approvalId,
            activitySequence: approvalRequiredError.activitySequence,
            approval: approvalRequiredError.summary
        },
        executionMeta(approvalRequiredError.executionId, EXECUTION_STATUS.WAITING_APPROVAL, approvalRequiredError.approvalId)
    )
}

async function buildInputRequired(
    governanceRuntime: GovernanceRuntime,
    request: McpRequestView,
    approvalId: string,
    state: ResumeState
): Promise<InputRequiredResult> {
    const approval = await governanceRuntime.approvals.get(approvalId)
    const elicitation = governanceRuntime.approvals.buildElicitation(approval)
    const requestState = await request.sealRequestState(state)
    const result = inputRequired({
        inputRequests: {[APPROVAL_INPUT_KEY]: inputRequired.elicit({mode: 'form', ...elicitation})},
        requestState
    })
    return {...result, _meta: executionMeta(state.executionId, EXECUTION_STATUS.WAITING_APPROVAL, approvalId)}
}
