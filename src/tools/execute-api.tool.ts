// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer, inputRequired, type InputRequiredResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import type { ServiceRegistry, ServiceResources } from '../runtime/registry/service-registry.js'
import type { GlobalConfig } from '../core/types/config.types.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { AuditCollector, writeAuditRecord } from '../runtime/observability/audit.js'
import type { AuditPipeline } from '../runtime/observability/audit-pipeline.js'
import { ProgressCollector } from '../runtime/observability/progress.js'
import { SandboxExecutionError } from '../core/types/sandbox-error.types.js'
import { ApprovalRequiredError } from '../core/types/execution.types.js'
import type { GovernanceRuntime } from '../runtime/execution/governance-runtime.js'
import type { ResumeState } from '../runtime/execution/request-state.js'
import { CallLog, type CallLogSource } from '../runtime/execution/activity-journal.js'
import {
  mcpError, mcpSuccess,
  resolveService, isToolError,
  validateAuth,
  type ToolResponse
} from './tool-helpers.js'
import { readMcpRequest, type McpRequestView } from './mcp-request-view.js'
import { runApiExecute, type ApiExecuteReport } from './execute-api-run.js'
import { classifyFailure, refusalOutcome, executionMeta } from './execute-api-outcome.js'
import {
  TOOL, LOG_PREFIX, METRIC, OUTCOME, ERR,
  EXECUTION_STATUS, EXECUTION_ID_META_KEY, APPROVAL_INPUT_KEY,
  type AuditOutcome
} from '../core/constants.js'
import { ensureError, errorCode as getErrorCode, errorRetryable } from '../core/utils/errors.js'
import { hashAuthenticatedPrincipal } from '../core/utils/user-id-hash.js'

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
  2. (Recommended) Read business SOPs via discover_skills() + get_skill_details() — if available
  3. Found the exact endpoints via search_code()

Not every scenario has a matching skill. If no relevant skills are available,
steps 1 → 3 (skipping 2) is perfectly valid.

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
call returns an input_required result with an approval form (or an
APPROVAL_REQUIRED error carrying "${EXECUTION_ID_META_KEY}" in _meta). Do NOT
rewrite or resend a different program: retry the same call after the human
decides — Harbor resumes the original program and never repeats calls it
already made.

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
    { description: EXECUTE_DESCRIPTION, inputSchema: z.object({ service: z.string(), code: z.string() }) },
    async ({ service, code }, ctx): Promise<ToolResponse | InputRequiredResult> => {
      // The SDK boundary: from here on the tool reads this validated view, never ServerContext.
      const request = readMcpRequest(ctx, governanceRuntime?.requestState)
      const { correlationId } = request
      logger.info(
        { correlationId, tool: TOOL.API_EXECUTE, service, ...request.advisory },
        `${LOG_PREFIX.MCP_IN} ${TOOL.API_EXECUTE} — request received from AI client`
      )

      // An unknown service is answered with the names that do exist; there is
      // no service to audit it under and nothing to run, so it returns here.
      const resources = resolveService(registry, service, serviceNames)
      if (isToolError(resources)) return resources
      const startTime = Date.now()

      logger.info({ correlationId, service, step: '1/4 auth' }, `${LOG_PREFIX.MCP} Validating token...`)
      const authResult = await validateAuth(resources, clientToken, correlationId, logger, TOOL.API_EXECUTE)
      if (isToolError(authResult)) return authResult
      const { payload: tokenPayload, invalidate } = authResult
      const userIdHash = hashAuthenticatedPrincipal(tokenPayload, clientToken)

      logger.info({ correlationId, service, step: '2/4 code' }, `${LOG_PREFIX.MCP} JavaScript code received from AI client`)
      logger.debug({ correlationId, service, codeReceived: code }, `${LOG_PREFIX.MCP} code payload`)

      const report = await runApiExecute(
        { service, code, request, resources, tokenPayload, invalidate, userIdHash },
        { governanceRuntime, logger, ...(callerClientId !== undefined ? { callerClientId } : {}) }
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

async function respond(report: ApiExecuteReport, r: Responder): Promise<ToolResponse | InputRequiredResult> {
  switch (report.kind) {
    case 'askAgain':
      // Before the call there was nothing new to record: the question is simply put again.
      return buildInputRequired(requireRuntime(r), r.request, report.approvalId, report.state)

    case 'refused': {
      // Refused, or the answer itself ended the execution (decline, cancel): nothing ran, but the
      // decision is part of the audit trail — under the principal that just authenticated, which
      // for a refused resume is the caller who tried, not the execution's owner. codeSubmitted
      // stays what this caller sent — never the persisted program, which may belong to someone else.
      const { refusal, executionId } = report
      audit(r, { calls: NO_CALLS, executionId }, { outcome: refusalOutcome(refusal.code), errorCode: refusal.code }, r.code)
      return mcpError(
        refusal.message, refusal.code, refusal.retryable, refusal.extra,
        refusal.meta ? executionMeta(executionId, refusal.meta.status, refusal.meta.approvalId) : undefined
      )
    }

    case 'completed': {
      const { result, executionId, calls } = report
      const collector = new AuditCollector(calls)
      r.logger.info(
        {
          correlationId: r.request.correlationId, service: r.service, executionId, step: '4/4 done',
          durationMs: Date.now() - r.startTime,
          apiCallCount: collector.getCallCount(),
          endpointsAccessed: collector.getEndpoints()
        },
        `${LOG_PREFIX.MCP_OUT} ${TOOL.API_EXECUTE} — result returned to AI client`
      )
      r.logger.debug({ correlationId: r.request.correlationId, service: r.service, response: JSON.stringify(result, null, 2) }, `${LOG_PREFIX.MCP_OUT} response payload`)
      r.metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service: r.service, outcome: OUTCOME.SUCCESS })
      audit(r, report, { outcome: OUTCOME.SUCCESS }, report.program)
      return mcpSuccess(result, executionMeta(executionId, EXECUTION_STATUS.COMPLETED))
    }

    case 'failed':
      return respondToFailure(report, r)
  }
}

async function respondToFailure(report: Extract<ApiExecuteReport, { kind: 'failed' }>, r: Responder): Promise<ToolResponse | InputRequiredResult> {
  const { error, executionId } = report
  const errObj = ensureError(error)
  const errorCode = getErrorCode(error)
  const failure = classifyFailure(error)
  const { correlationId } = r.request

  if (failure.openedCircuit !== undefined) r.metrics.increment(METRIC.CB_OPENS, { endpoint: failure.openedCircuit })
  if (failure.sandboxError) r.metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
  r.metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service: r.service, outcome: failure.outcome })

  // Log raw cause server-side for internal errors; client response stays sanitized.
  if (error instanceof SandboxExecutionError && error.cause) {
    const cause = ensureError(error.cause)
    r.logger.error(
      { correlationId, service: r.service, executionId, errorCode, causeMessage: cause.message, causeStack: cause.stack },
      `${TOOL.API_EXECUTE} failed — internal sandbox error`
    )
  } else {
    r.logger.warn({ correlationId, service: r.service, executionId, errorCode, message: errObj.message }, `${TOOL.API_EXECUTE} failed`)
  }

  audit(r, report, { outcome: failure.outcome, errorType: errObj.name, errorCode }, report.program)

  // A pause: hand the question to the client.
  if (error instanceof ApprovalRequiredError && r.governanceRuntime && executionId !== undefined) {
    return approvalResult(r.governanceRuntime, r.request, error, r.userIdHash, r.logger)
  }

  // Attach structured progress (per-call status + ids extracted from
  // successful POST responses) so the caller can resume a failed
  // multi-step workflow without recreating already-created entities.
  // Omit the field entirely when nothing was recorded to keep the
  // payload minimal.
  const progress = new ProgressCollector(report.calls, r.resources.sandboxLimits.maxApiCalls)
  const extra = {
    ...(progress.hasAny() ? { progress: progress.summary() } : {}),
    ...(executionId !== undefined ? { executionId } : {})
  }
  return mcpError(
    errObj.message,
    errorCode,
    errorRetryable(error),
    Object.keys(extra).length ? extra : undefined,
    executionMeta(executionId, report.status)
  )
}

/** One audit record for this tool call; `codeSubmitted` is the program that ran, or what the caller sent when nothing did. */
function audit(
  r: Responder,
  run: { calls: CallLogSource; executionId?: string },
  fields: { outcome: AuditOutcome; errorType?: string; errorCode?: string },
  codeSubmitted: string
): void {
  const collector = new AuditCollector(run.calls)
  writeAuditRecord(
    {
      auditId: uuidv4(),
      timestamp: new Date().toISOString(),
      service: r.resources.name,
      environment: r.globalConfig.observability.environment,
      userIdHash: r.userIdHash,
      correlationId: r.request.correlationId,
      tool: TOOL.API_EXECUTE,
      authStrategy: r.resources.authStrategyName,
      idempotencyStrategy: r.resources.idempotencyStrategyName,
      circuitBreakerStrategy: r.resources.circuitBreakerStrategyName,
      codeSubmitted,
      endpointsAccessed: collector.getEndpoints(),
      apiCallCount: collector.getCallCount(),
      durationMs: Date.now() - r.startTime,
      ...(run.executionId !== undefined ? { executionId: run.executionId } : {}),
      ...fields
    },
    r.resources.logger,
    r.globalConfig,
    r.auditPipeline
  )
}

function requireRuntime(r: Responder): GovernanceRuntime {
  if (!r.governanceRuntime) throw new Error('An approval answer needs the execution runtime')
  return r.governanceRuntime
}

/** Either an MRTR `input_required` (client supports elicitation) or an APPROVAL_REQUIRED error with the ids in `_meta`. */
async function approvalResult(
  governanceRuntime: GovernanceRuntime,
  request: McpRequestView,
  err: ApprovalRequiredError,
  userIdHash: string,
  logger: Logger
): Promise<ToolResponse | InputRequiredResult> {
  const { correlationId } = request
  if (request.supportsElicitation) {
    logger.info({ correlationId, executionId: err.executionId, approvalId: err.approvalId }, 'Execution paused — approval requested via MCP elicitation')
    return buildInputRequired(governanceRuntime, request, err.approvalId, {
      executionId: err.executionId, approvalId: err.approvalId, activitySequence: err.activitySequence, userIdHash
    })
  }
  logger.info({ correlationId, executionId: err.executionId, approvalId: err.approvalId }, 'Execution paused — client lacks elicitation; approval expected over HTTP')
  return mcpError(
    `${err.message} This client does not support elicitation: decide via POST /executions/${err.executionId}/approvals/${err.approvalId}, ` +
    `then call ${TOOL.API_EXECUTE} again with _meta["${EXECUTION_ID_META_KEY}"] = "${err.executionId}" to resume.`,
    ERR.APPROVAL_REQUIRED,
    false,
    { executionId: err.executionId, approvalId: err.approvalId, activitySequence: err.activitySequence, approval: err.summary },
    executionMeta(err.executionId, EXECUTION_STATUS.WAITING_APPROVAL, err.approvalId)
  )
}

async function buildInputRequired(governanceRuntime: GovernanceRuntime, request: McpRequestView, approvalId: string, state: ResumeState): Promise<InputRequiredResult> {
  const approval = await governanceRuntime.approvals.get(approvalId)
  const elicitation = governanceRuntime.approvals.buildElicitation(approval)
  const requestState = await request.sealRequestState(state)
  const result = inputRequired({
    inputRequests: { [APPROVAL_INPUT_KEY]: inputRequired.elicit({ mode: 'form', ...elicitation }) },
    requestState
  })
  return { ...result, _meta: executionMeta(state.executionId, EXECUTION_STATUS.WAITING_APPROVAL, approvalId) }
}
