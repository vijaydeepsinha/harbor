// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'node:crypto'
import type { ServiceRegistry } from '../runtime/registry/service-registry.js'
import { PermissionDeniedError } from '../core/types/permission.types.js'
import { CircuitOpenError } from '../core/types/circuit-breaker.types.js'
import type { GlobalConfig } from '../core/types/config.types.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { AuditCollector, writeAuditRecord } from '../runtime/observability/audit.js'
import { ProgressCollector } from '../runtime/observability/progress.js'
import { runApiInSandbox, type SandboxExecutionContext } from '../runtime/sandbox/execute-api-in-sandbox.js'
import { SandboxCallLimitError, SandboxConcurrentLimitError, SandboxExecutionError } from '../core/types/sandbox-error.types.js'
import {
  mcpError, mcpSuccess,
  extractCorrelationId, extractSessionId,
  resolveService, isToolError,
  validateAuth
} from './tool-helpers.js'
import { TOOL, LOG_PREFIX, METRIC, OUTCOME } from '../core/constants.js'
import type { AuditOutcome } from '../core/constants.js'
import { ensureError, errorCode as getErrorCode, errorRetryable } from '../core/utils/errors.js'

export function registerExecuteApiTool(
  server: McpServer,
  registry: ServiceRegistry,
  globalConfig: GlobalConfig,
  logger: Logger,
  metrics: MetricsCollector,
  clientToken?: string
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
    { description: EXECUTE_DESCRIPTION, inputSchema: { service: z.string(), code: z.string() } },
    async ({ service, code }, extra) => {
      const correlationId = extractCorrelationId(extra)
      const sessionId = extractSessionId(extra)

      logger.info(
        { correlationId, tool: TOOL.API_EXECUTE, service },
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
      const auditCollector = new AuditCollector()
      const progressCollector = new ProgressCollector(sandboxLimits.maxApiCalls)

      try {
        logger.info({ correlationId, service, step: '1/4 auth' }, `${LOG_PREFIX.MCP} Validating token...`)
        const authResult = await validateAuth(
          svcResources, clientToken, correlationId, logger, TOOL.API_EXECUTE
        )
        if (isToolError(authResult)) return authResult
        const { payload: tokenPayload, invalidate } = authResult
        const rawUserId = tokenPayload.metadata?.userId
        const userIdHash = rawUserId
          ? createHash('sha256').update(String(rawUserId)).digest('hex')
          : createHash('sha256').update(tokenPayload.access_token).digest('hex')

        logger.info({ correlationId, service, step: '2/4 code' }, `${LOG_PREFIX.MCP} JavaScript code received from AI client`)
        logger.debug({ correlationId, service, codeReceived: code }, `${LOG_PREFIX.MCP} code payload`)

        logger.info({ correlationId, service, step: '3/4 sandbox-run' }, `${LOG_PREFIX.MCP} Executing code in V8 sandbox...`)
        const codeHash = createHash('sha256').update(code).digest('hex').slice(0, 16)
        const idempotencyKey = `mcp-${service}-${userIdHash.slice(0, 12)}-${codeHash}`

        const sandboxCtx: SandboxExecutionContext = {
          tokenPayload, invalidate, apiClient, circuitBreaker, permissionGuard,
          idempotencyKey, idempotencyKeyTtlMs, correlationId,
          sessionId, auditCollector, progressCollector,
          limits: sandboxLimits
        }
        const result = await runApiInSandbox(code, sandboxCtx)

        const durationMs = Date.now() - startTime
        const responseText = JSON.stringify(result, null, 2)
        logger.info(
          {
            correlationId, service, step: '4/4 done',
            durationMs,
            apiCallCount: auditCollector.getCallCount(),
            endpointsAccessed: auditCollector.getEndpoints()
          },
          `${LOG_PREFIX.MCP_OUT} ${TOOL.API_EXECUTE} — result returned to AI client`
        )
        logger.debug({ correlationId, service, response: responseText }, `${LOG_PREFIX.MCP_OUT} response payload`)

        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service, outcome: OUTCOME.SUCCESS })

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
            codeSubmitted: code,
            endpointsAccessed: auditCollector.getEndpoints(),
            apiCallCount: auditCollector.getCallCount(),
            durationMs: Date.now() - startTime,
            outcome: OUTCOME.SUCCESS
          },
          svcResources.logger,
          globalConfig
        )

        return mcpSuccess(result)
      } catch (err) {
        const errObj = ensureError(err)
        errorCode = getErrorCode(err)
        errorType = errObj.name

        if (err instanceof CircuitOpenError) {
          outcome = OUTCOME.CIRCUIT_OPEN
          metrics.increment(METRIC.CB_OPENS, { endpoint: err.endpoint })
        } else if (err instanceof PermissionDeniedError) {
          outcome = OUTCOME.PERMISSION_DENIED
        } else if (err instanceof SandboxCallLimitError) {
          outcome = OUTCOME.CALL_LIMIT_EXCEEDED
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        } else if (err instanceof SandboxConcurrentLimitError) {
          outcome = OUTCOME.CONCURRENT_LIMIT_EXCEEDED
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        } else {
          outcome = OUTCOME.ERROR
          metrics.increment(METRIC.SANDBOX_ERRORS, { tool: TOOL.API_EXECUTE, errorType: errorCode })
        }

        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.API_EXECUTE, service, outcome })

        // Log raw cause server-side for internal errors; client response stays sanitized.
        if (err instanceof SandboxExecutionError && err.cause) {
          const cause = ensureError(err.cause)
          logger.error(
            { correlationId, service, errorCode, causeMessage: cause.message, causeStack: cause.stack },
            `${TOOL.API_EXECUTE} failed — internal sandbox error`
          )
        } else {
          logger.warn({ correlationId, service, errorCode, message: errObj.message }, `${TOOL.API_EXECUTE} failed`)
        }

        writeAuditRecord(
          {
            auditId: uuidv4(),
            timestamp: new Date().toISOString(),
            service: svcResources.name,
            environment: globalConfig.observability.environment,
            userIdHash: 'unknown', sessionId, correlationId,
            tool: TOOL.API_EXECUTE,
            authStrategy: authStrategyName,
            idempotencyStrategy: idempotencyStrategyName,
            circuitBreakerStrategy: circuitBreakerStrategyName,
            codeSubmitted: code,
            endpointsAccessed: auditCollector.getEndpoints(), apiCallCount: auditCollector.getCallCount(),
            durationMs: Date.now() - startTime,
            outcome, errorType, errorCode
          },
          svcResources.logger,
          globalConfig
        )

        // Attach structured progress (per-call status + ids extracted from
        // successful POST responses) so the caller can resume a failed
        // multi-step workflow without recreating already-created entities.
        // Omit the field entirely when nothing was recorded to keep the
        // payload minimal.
        const extra = progressCollector.hasAny()
          ? { progress: progressCollector.summary() }
          : undefined
        return mcpError(
          errObj.message,
          errorCode,
          errorRetryable(err),
          extra
        )
      }
    }
  )
}
