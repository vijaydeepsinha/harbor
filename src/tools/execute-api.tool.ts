// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer, inputRequired, inputResponse, type ServerContext, type InputRequiredResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'node:crypto'
import type { ServiceRegistry, ServiceResources } from '../runtime/registry/service-registry.js'
import { PermissionDeniedError } from '../core/types/permission.types.js'
import { CircuitOpenError } from '../core/types/circuit-breaker.types.js'
import type { GlobalConfig } from '../core/types/config.types.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { AuditCollector, writeAuditRecord } from '../runtime/observability/audit.js'
import type { AuditPipeline } from '../runtime/observability/audit-pipeline.js'
import { ProgressCollector } from '../runtime/observability/progress.js'
import {
  runApiInSandbox,
  type SandboxExecutionContext,
  type ExecutionBridge,
  type GovernanceVerdict
} from '../runtime/sandbox/execute-api-in-sandbox.js'
import { SandboxCallLimitError, SandboxConcurrentLimitError, SandboxExecutionError } from '../core/types/sandbox-error.types.js'
import {
  type ActivityRequestRecord,
  type ExecutionRecord,
  ApprovalRequiredError,
  GovernanceDeniedError,
  ReplayDivergedError,
  ExecutionCancelledError,
  ActivityOutcomeUnknownError,
  ApprovalAlreadyDecidedError
} from '../core/types/execution.types.js'
import type { DurableExecutionRuntime } from '../runtime/execution/durable-execution-runtime.js'
import type { ResumeState } from '../runtime/execution/request-state.js'
import { ActivityJournal, CallLog, type CallLogSource } from '../runtime/execution/activity-journal.js'
import { resolveOperation } from '../runtime/governance/operation-resolver.js'
import { evaluateGovernance } from '../runtime/governance/rule-evaluator.js'
import {
  mcpError, mcpSuccess,
  extractCorrelationId, extractSessionId, readRequestMeta,
  resolveService, isToolError,
  validateAuth,
  type ToolResponse
} from './tool-helpers.js'
import {
  TOOL, LOG_PREFIX, METRIC, OUTCOME, ERR,
  EXECUTION_STATUS, GOVERNANCE_DECISION, APPROVAL_STATUS,
  EXECUTION_ID_META_KEY, EXECUTION_STATUS_META_KEY, APPROVAL_ID_META_KEY, APPROVAL_INPUT_KEY
} from '../core/constants.js'
import type { AuditOutcome, ExecutionStatus } from '../core/constants.js'
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
  durableExecutionRuntime?: DurableExecutionRuntime,
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
      const correlationId = extractCorrelationId(ctx)
      const sessionId = extractSessionId(ctx)
      // Advisory-only (never auth) request metadata, logged here as its first
      // real production consumer — see AdvisoryRequestMeta's invariant note.
      const requestMeta = readRequestMeta(ctx)

      logger.info(
        { correlationId, tool: TOOL.API_EXECUTE, service, ...requestMeta },
        `${LOG_PREFIX.MCP_IN} ${TOOL.API_EXECUTE} — request received from AI client`
      )

      const svcResources = resolveService(registry, service, serviceNames)
      if (isToolError(svcResources)) return svcResources

      const { apiClient, circuitBreaker, permissionGuard,
              idempotencyKeyTtlMs, idempotencyStrategyName,
              circuitBreakerStrategyName, authStrategyName,
              sandboxLimits } = svcResources

      const startTime = Date.now()
      let outcome: AuditOutcome = OUTCOME.SUCCESS
      let errorType: string | undefined
      let errorCode: string | undefined
      // Every call's outcome is recorded once, in the run's CallLog — the
      // execution's durable activity journal once a governed run starts.
      // Audit and progress are read-only projections of it.
      let callLog: CallLog = new CallLog()
      const runCalls: CallLogSource = { entries: () => callLog.entries() }
      const auditCollector = new AuditCollector(runCalls)
      const progressCollector = new ProgressCollector(runCalls, sandboxLimits.maxApiCalls)
      // Set once the execution is known so every audit line and error carries it.
      let executionId: string | undefined
      // True once beginRun took the run lock — only then is there a run to end.
      let runStarted = false
      // What actually runs: the persisted original on a resume (the incoming code is ignored then).
      let program = code
      let userIdHash = 'unknown'

      const audit = (extra: Partial<Parameters<typeof writeAuditRecord>[0]>, codeSubmitted: string): void => {
        writeAuditRecord(
          {
            auditId: uuidv4(),
            timestamp: new Date().toISOString(),
            service: svcResources.name,
            environment: globalConfig.observability.environment,
            userIdHash, sessionId, correlationId,
            tool: TOOL.API_EXECUTE,
            authStrategy: authStrategyName,
            idempotencyStrategy: idempotencyStrategyName,
            circuitBreakerStrategy: circuitBreakerStrategyName,
            codeSubmitted,
            endpointsAccessed: auditCollector.getEndpoints(),
            apiCallCount: auditCollector.getCallCount(),
            durationMs: Date.now() - startTime,
            outcome,
            ...(executionId !== undefined ? { executionId } : {}),
            ...extra
          },
          svcResources.logger,
          globalConfig,
          auditPipeline
        )
      }

      try {
        logger.info({ correlationId, service, step: '1/4 auth' }, `${LOG_PREFIX.MCP} Validating token...`)
        const authResult = await validateAuth(
          svcResources, clientToken, correlationId, logger, TOOL.API_EXECUTE
        )
        if (isToolError(authResult)) return authResult
        const { payload: tokenPayload, invalidate } = authResult
        userIdHash = hashAuthenticatedPrincipal(tokenPayload, clientToken)

        logger.info({ correlationId, service, step: '2/4 code' }, `${LOG_PREFIX.MCP} JavaScript code received from AI client`)
        logger.debug({ correlationId, service, codeReceived: code }, `${LOG_PREFIX.MCP} code payload`)

        // ── Durable execution: create or resume ─────────────────────────────
        let execution: ExecutionRecord | undefined
        let bridge: ExecutionBridge | undefined
        let pendingRetry: InputRequiredResult | undefined
        if (durableExecutionRuntime) {
          const resumed = await resolveExecution(durableExecutionRuntime, ctx, { service, code, userIdHash }, logger, correlationId)
          if ('error' in resumed) {
            // Refused, or the answer itself ended the execution (decline, cancel): nothing ran, but the
            // decision is part of the audit trail. codeSubmitted stays what this caller sent — never
            // the persisted program, which may belong to someone else.
            executionId = resumed.executionId
            const refusedCode = toolErrorCode(resumed.error)
            outcome = refusedCode === ERR.GOVERNANCE_DENIED ? OUTCOME.GOVERNANCE_DENIED
              : refusedCode === ERR.EXECUTION_CANCELLED ? OUTCOME.EXECUTION_CANCELLED
              : OUTCOME.ERROR
            audit({ outcome, errorCode: refusedCode, userIdHash: 'unknown' }, code)
            return resumed.error
          }
          if ('reprompt' in resumed) pendingRetry = resumed.reprompt
          execution = resumed.execution
          executionId = execution.executionId
          if (pendingRetry) return pendingRetry
          execution = await durableExecutionRuntime.executionManager.beginRun(execution.executionId)
          runStarted = true
          bridge = makeBridge(durableExecutionRuntime, execution, svcResources, userIdHash)
          callLog = bridge.journal
        }
        program = execution?.originalCode ?? code

        logger.info({ correlationId, service, executionId, step: '3/4 sandbox-run' }, `${LOG_PREFIX.MCP} Executing code in V8 sandbox...`)
        // A governed run's calls are keyed by the execution (the bridge adds
        // the activity sequence): two executions of the same program are two
        // intents and must never share a key, while a resume of one keeps it.
        // Without an execution (legacy) the key is per user + program, so an
        // agent retrying the identical tool call is deduplicated.
        const codeHash = createHash('sha256').update(program).digest('hex').slice(0, 16)
        const idempotencyKey = executionId !== undefined
          ? `mcp-${service}-${executionId}`
          : `mcp-${service}-${userIdHash.slice(0, 12)}-${codeHash}`

        const sandboxCtx: SandboxExecutionContext = {
          tokenPayload, invalidate, apiClient, circuitBreaker, permissionGuard,
          idempotencyKey, idempotencyKeyTtlMs,
          // Backends correlate every call of one script by its execution id — it
          // survives the new isolate (and new MCP request) of each approval resume.
          correlationId: executionId ?? correlationId,
          sessionId,
          ...(callerClientId !== undefined ? { clientId: callerClientId } : {}),
          limits: sandboxLimits,
          ...(bridge ? { executionBridge: bridge } : { callLog })
        }
        const result = await runApiInSandbox(program, sandboxCtx)

        if (durableExecutionRuntime && execution) {
          await durableExecutionRuntime.executionManager.endRun(execution.executionId, { kind: 'completed', result })
        }

        const durationMs = Date.now() - startTime
        const responseText = JSON.stringify(result, null, 2)
        logger.info(
          {
            correlationId, service, executionId, step: '4/4 done',
            durationMs,
            apiCallCount: auditCollector.getCallCount(),
            endpointsAccessed: auditCollector.getEndpoints()
          },
          `${LOG_PREFIX.MCP_OUT} ${TOOL.API_EXECUTE} — result returned to AI client`
        )
        logger.debug({ correlationId, service, response: responseText }, `${LOG_PREFIX.MCP_OUT} response payload`)

        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service, outcome: OUTCOME.SUCCESS })
        audit({ outcome: OUTCOME.SUCCESS }, program)

        return mcpSuccess(result, executionMeta(executionId, EXECUTION_STATUS.COMPLETED))
      } catch (err) {
        const errObj = ensureError(err)
        errorCode = getErrorCode(err)
        errorType = errObj.name
        let status: ExecutionStatus | undefined

        if (err instanceof ApprovalRequiredError) {
          outcome = OUTCOME.APPROVAL_REQUIRED
          status = EXECUTION_STATUS.WAITING_APPROVAL
        } else if (err instanceof GovernanceDeniedError) {
          outcome = OUTCOME.GOVERNANCE_DENIED
          status = EXECUTION_STATUS.DENIED
        } else if (err instanceof ExecutionCancelledError) {
          outcome = OUTCOME.EXECUTION_CANCELLED
          status = EXECUTION_STATUS.CANCELLED
        } else if (err instanceof ReplayDivergedError) {
          outcome = OUTCOME.REPLAY_DIVERGED
          status = EXECUTION_STATUS.FAILED
        } else if (err instanceof ActivityOutcomeUnknownError) {
          outcome = OUTCOME.ERROR
          status = EXECUTION_STATUS.FAILED
        } else if (err instanceof CircuitOpenError) {
          outcome = OUTCOME.CIRCUIT_OPEN
          status = EXECUTION_STATUS.INTERRUPTED
          metrics.increment(METRIC.CB_OPENS, { endpoint: err.endpoint })
        } else if (err instanceof PermissionDeniedError) {
          outcome = OUTCOME.PERMISSION_DENIED
          status = EXECUTION_STATUS.FAILED
        } else if (err instanceof SandboxCallLimitError) {
          outcome = OUTCOME.CALL_LIMIT_EXCEEDED
          status = EXECUTION_STATUS.FAILED
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        } else if (err instanceof SandboxConcurrentLimitError) {
          outcome = OUTCOME.CONCURRENT_LIMIT_EXCEEDED
          status = EXECUTION_STATUS.FAILED
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        } else {
          outcome = OUTCOME.ERROR
          status = errorRetryable(err) ? EXECUTION_STATUS.INTERRUPTED : EXECUTION_STATUS.FAILED
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        }

        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service, outcome })

        // Log raw cause server-side for internal errors; client response stays sanitized.
        if (err instanceof SandboxExecutionError && err.cause) {
          const cause = ensureError(err.cause)
          logger.error(
            { correlationId, service, executionId, errorCode, causeMessage: cause.message, causeStack: cause.stack },
            `${TOOL.API_EXECUTE} failed — internal sandbox error`
          )
        } else {
          logger.warn({ correlationId, service, executionId, errorCode, message: errObj.message }, `${TOOL.API_EXECUTE} failed`)
        }

        // ── Persist the run outcome and, for approvals, hand the question to the client ──
        let approvalId: string | undefined
        if (durableExecutionRuntime && executionId && status) {
          const outcomeForStore =
            err instanceof ApprovalRequiredError ? { kind: 'waitingApproval' as const, approvalId: err.approvalId }
            : status === EXECUTION_STATUS.DENIED ? { kind: 'denied' as const, code: errorCode, message: errObj.message }
            : status === EXECUTION_STATUS.CANCELLED ? { kind: 'cancelled' as const, code: errorCode, message: errObj.message }
            : status === EXECUTION_STATUS.INTERRUPTED ? { kind: 'interrupted' as const, code: errorCode, message: errObj.message }
            : { kind: 'failed' as const, code: errorCode, message: errObj.message }
          // beginRun may itself have thrown (locked, not resumable, approval still
          // pending) — then no run started, there is no lock to release and the
          // stored execution must stay exactly as it was.
          if (runStarted) {
            await durableExecutionRuntime.executionManager.endRun(executionId, outcomeForStore).catch(e =>
              logger.error({ correlationId, executionId, error: ensureError(e).message }, 'Failed to persist run outcome'))
          }
          if (err instanceof ApprovalRequiredError) {
            approvalId = err.approvalId
            audit({ outcome, errorType, errorCode, userIdHash: 'unknown' }, program)
            return await approvalResult(durableExecutionRuntime, ctx, err, userIdHash, logger, correlationId)
          }
        }

        // Error-path audit keeps the pre-existing shape (userIdHash 'unknown'); see docs/code-mode-governance.md → limitations.
        audit({ outcome, errorType, errorCode, userIdHash: 'unknown' }, program)

        // Attach structured progress (per-call status + ids extracted from
        // successful POST responses) so the caller can resume a failed
        // multi-step workflow without recreating already-created entities.
        // Omit the field entirely when nothing was recorded to keep the
        // payload minimal.
        const extra = {
          ...(progressCollector.hasAny() ? { progress: progressCollector.summary() } : {}),
          ...(executionId !== undefined ? { executionId } : {})
        }
        // When no run started (beginRun refused: locked, finished, approval
        // still pending) nothing changed, so `_meta` reports the execution as
        // it is stored — not the status this error would have given a run.
        const reportedStatus = runStarted || !durableExecutionRuntime || executionId === undefined
          ? status
          : await durableExecutionRuntime.executionManager.load(executionId).then(r => r.status, () => undefined)
        return mcpError(
          errObj.message,
          errorCode,
          errorRetryable(err),
          Object.keys(extra).length ? extra : undefined,
          executionMeta(executionId, reportedStatus, approvalId)
        )
      }
    }
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The `code` an mcpError carries in its JSON text. */
function toolErrorCode(response: ToolResponse): string {
  try {
    const body = JSON.parse(response.content[0]?.text ?? '{}') as { code?: unknown }
    return typeof body.code === 'string' ? body.code : ERR.UNKNOWN
  } catch {
    return ERR.UNKNOWN
  }
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
])

/** Loose view of the handler context fields the governance layer reads (all untrusted, all optional). */
interface ResumeContextView {
  mcpReq?: {
    _meta?: Record<string, unknown>
    inputResponses?: Record<string, unknown>
    requestState?: <T>() => T | undefined
  }
}

function executionMeta(executionId?: string, status?: ExecutionStatus, approvalId?: string): Record<string, unknown> | undefined {
  if (!executionId) return undefined
  return {
    [EXECUTION_ID_META_KEY]: executionId,
    ...(status ? { [EXECUTION_STATUS_META_KEY]: status } : {}),
    ...(approvalId ? { [APPROVAL_ID_META_KEY]: approvalId } : {})
  }
}

type ResolvedExecution =
  | { execution: ExecutionRecord }
  | { execution: ExecutionRecord; reprompt: InputRequiredResult }
  /** The resume was refused or the human's answer ended it; nothing ran. */
  | { error: ToolResponse; executionId: string }

/**
 * Decides which execution this call belongs to (§6, §7, §26):
 *  - an MRTR retry carries a sealed `requestState` (verified by the SDK) and the human's answer;
 *  - a client without elicitation resumes via `_meta["harbor/execution-id"]` after deciding over HTTP;
 *  - otherwise this is a new program and its code is persisted as the authoritative original.
 * Incoming `code` is ignored on resume.
 */
async function resolveExecution(
  rt: DurableExecutionRuntime,
  ctx: ServerContext,
  input: { service: string; code: string; userIdHash: string },
  logger: Logger,
  correlationId: string
): Promise<ResolvedExecution> {
  const view = ctx as unknown as ResumeContextView
  const state = safeRequestState(view)
  const metaId = view.mcpReq?._meta?.[EXECUTION_ID_META_KEY]
  const resumeId = state?.executionId ?? (typeof metaId === 'string' ? metaId : undefined)

  if (resumeId === undefined) {
    const execution = await rt.executionManager.create({ service: input.service, code: input.code, userIdHash: input.userIdHash })
    logger.info({ correlationId, executionId: execution.executionId }, 'Code Mode execution created')
    return { execution }
  }

  let execution: ExecutionRecord
  try {
    execution = await rt.executionManager.load(resumeId)
  } catch (err) {
    return { executionId: resumeId, error: mcpError(ensureError(err).message, getErrorCode(err), errorRetryable(err)) }
  }
  // Principal binding: the sealed state and the stored execution both name the caller.
  if ((state && state.userIdHash !== input.userIdHash) || execution.userIdHash !== input.userIdHash) {
    return { executionId: resumeId, error: mcpError('This execution belongs to a different principal', ERR.EXECUTION_NOT_RESUMABLE, false) }
  }
  if (execution.service !== input.service) {
    return { executionId: resumeId, error: mcpError(`Execution ${resumeId} runs against service "${execution.service}", not "${input.service}"`, ERR.EXECUTION_NOT_RESUMABLE, false) }
  }
  if (execution.originalCode !== undefined && input.code !== execution.originalCode) {
    logger.warn({ correlationId, executionId: resumeId }, 'Resume carried different code — ignored; the persisted original program is authoritative')
  }

  // Apply the human's answer carried by an MRTR retry, if any.
  if (state) {
    const answer = inputResponse(view.mcpReq?.inputResponses, APPROVAL_INPUT_KEY)
    if (answer.kind === 'elicit') {
      try {
        const content = answer.content ?? {}
        const decided = await rt.approvals.decide(state.approvalId, {
          action: answer.action,
          executionId: state.executionId,
          ...(typeof content['approve'] === 'boolean' ? { approve: content['approve'] } : {}),
          ...(typeof content['comment'] === 'string' && content['comment'] ? { comment: content['comment'] } : {}),
          via: 'mcp-elicitation'
        })
        logger.info({ correlationId, executionId: resumeId, approvalId: state.approvalId, outcome: decided.outcome }, 'Approval decided via MCP elicitation')
        // The human's answer may end the execution here and now — report that consequence, not a failed resume.
        if (decided.outcome === 'REJECTED') {
          return { executionId: resumeId, error: mcpError(
            `Approval rejected for activity #${state.activitySequence}; the execution is denied and the operation was not executed.`,
            ERR.GOVERNANCE_DENIED, false, { executionId: resumeId, approvalId: state.approvalId },
            executionMeta(resumeId, EXECUTION_STATUS.DENIED, state.approvalId)
          ) }
        }
        if (decided.outcome === 'CANCELLED') {
          return { executionId: resumeId, error: mcpError(
            `Approval cancelled for activity #${state.activitySequence}; the execution is cancelled and the operation was not executed.`,
            ERR.EXECUTION_CANCELLED, false, { executionId: resumeId, approvalId: state.approvalId },
            executionMeta(resumeId, EXECUTION_STATUS.CANCELLED, state.approvalId)
          ) }
        }
      } catch (err) {
        if (!(err instanceof ApprovalAlreadyDecidedError)) {
          return { executionId: resumeId, error: mcpError(ensureError(err).message, getErrorCode(err), errorRetryable(err), undefined, executionMeta(resumeId, execution.status)) }
        }
        // Already decided. A retry carrying the *same* answer (the client
        // retried after a lost response) resumes; a different answer — a
        // decline arriving after an HTTP approve — must not quietly run the
        // approved call on the decliner's behalf.
        const recorded = err.status
        const asked = answer.action === 'cancel' ? APPROVAL_STATUS.CANCELLED
          : answer.action === 'decline' || answer.content?.['approve'] === false ? APPROVAL_STATUS.REJECTED
          : APPROVAL_STATUS.APPROVED
        // Only while the execution could still run: a finished one is refused below as not resumable.
        if (recorded !== asked && !TERMINAL_STATUSES.has(execution.status)) {
          return { executionId: resumeId, error: mcpError(
            `${err.message}; this answer (${asked}) was not applied and nothing was executed.`,
            ERR.APPROVAL_ALREADY_DECIDED, false, { executionId: resumeId, approvalId: state.approvalId },
            executionMeta(resumeId, execution.status, state.approvalId)
          ) }
        }
      }
      execution = await rt.executionManager.load(resumeId)
    } else if (execution.status === EXECUTION_STATUS.WAITING_APPROVAL) {
      // The client retried without answering: ask again (spec allows repeated input_required).
      const approval = await rt.approvals.get(state.approvalId)
      if (approval.status === 'PENDING') {
        const reprompt = await buildInputRequired(rt, ctx, approval.approvalId, state)
        return { execution, reprompt }
      }
    }
  }
  return { execution }
}

function safeRequestState(view: ResumeContextView): ResumeState | undefined {
  const accessor = view.mcpReq?.requestState
  if (typeof accessor !== 'function') return undefined
  const value = accessor<unknown>()
  if (value === null || typeof value !== 'object') return undefined
  const s = value as Partial<ResumeState>
  if (typeof s.executionId !== 'string' || typeof s.approvalId !== 'string' || typeof s.activitySequence !== 'number' || typeof s.userIdHash !== 'string') {
    return undefined
  }
  return { executionId: s.executionId, approvalId: s.approvalId, activitySequence: s.activitySequence, userIdHash: s.userIdHash }
}

/** The hooks the bridge calls: OpenAPI resolution and governance for new activities. */
function makeBridge(rt: DurableExecutionRuntime, execution: ExecutionRecord, svc: ServiceResources, _userIdHash: string): ExecutionBridge {
  const journal = new ActivityJournal(rt.persistence, execution.executionId, svc.name, execution.runCount)
  return {
    journal,
    resolve: (method, rawPath) => resolveOperation(svc.specStore.getSpec(), method, rawPath),
    decide: async (sequence: number, request: ActivityRequestRecord): Promise<GovernanceVerdict> => {
      const outcome = evaluateGovernance(rt.rules.getRules(), {
        executionId: execution.executionId, activitySequence: sequence, service: svc.name,
        method: request.method, specPath: request.specPath,
        ...(request.operationId !== undefined ? { operationId: request.operationId } : {}),
        ...(request.pathParams !== undefined ? { pathParams: request.pathParams } : {}),
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      }, rt.executionConfig.governance.defaultDecision)
      await rt.persistence.putDecision({
        executionId: execution.executionId, activitySequence: sequence,
        decision: outcome.decision, reason: outcome.reason,
        matchedRules: outcome.matchedRules, ruleVersions: outcome.ruleVersions,
        ...(outcome.decidingRule !== undefined ? { decidingRule: outcome.decidingRule } : {}),
        evaluatedAt: new Date().toISOString()
      })
      await rt.executionManager.recordProgress(execution.executionId, sequence)
      switch (outcome.decision) {
        case GOVERNANCE_DECISION.ALLOW:
          return { decision: 'ALLOW' }
        case GOVERNANCE_DECISION.DENY:
          return { decision: 'DENY', reason: outcome.reason, matchedRules: outcome.matchedRules }
        case GOVERNANCE_DECISION.REQUIRE_APPROVAL: {
          const summary = {
            service: svc.name, method: request.method, specPath: request.specPath,
            ...(request.operationId !== undefined ? { operationId: request.operationId } : {}),
            ...(request.pathParams !== undefined ? { pathParams: request.pathParams } : {}),
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.body !== undefined ? { body: request.body } : {}),
            reason: outcome.reason, matchedRules: outcome.matchedRules
          }
          const approval = await rt.approvals.request(execution.executionId, sequence, summary)
          return { decision: 'REQUIRE_APPROVAL', approvalId: approval.approvalId, summary }
        }
      }
    }
  }
}

/** Either an MRTR `input_required` (client supports elicitation) or an APPROVAL_REQUIRED error with the ids in `_meta`. */
async function approvalResult(
  rt: DurableExecutionRuntime,
  ctx: ServerContext,
  err: ApprovalRequiredError,
  userIdHash: string,
  logger: Logger,
  correlationId: string
): Promise<ToolResponse | InputRequiredResult> {
  const caps = readRequestMeta(ctx).clientCapabilities
  const supportsElicitation = caps !== undefined && caps['elicitation'] !== undefined && caps['elicitation'] !== null
  if (supportsElicitation) {
    logger.info({ correlationId, executionId: err.executionId, approvalId: err.approvalId }, 'Execution paused — approval requested via MCP elicitation')
    return buildInputRequired(rt, ctx, err.approvalId, {
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

async function buildInputRequired(rt: DurableExecutionRuntime, ctx: ServerContext, approvalId: string, state: ResumeState): Promise<InputRequiredResult> {
  const approval = await rt.approvals.get(approvalId)
  const elicitation = rt.approvals.buildElicitation(approval)
  const requestState = await rt.requestState.mint(state, ctx)
  const result = inputRequired({
    inputRequests: { [APPROVAL_INPUT_KEY]: inputRequired.elicit({ mode: 'form', ...elicitation }) },
    requestState
  })
  return { ...result, _meta: executionMeta(state.executionId, EXECUTION_STATUS.WAITING_APPROVAL, approvalId) }
}
