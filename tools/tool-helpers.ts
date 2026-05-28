// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenPayload, AuthResult } from '../core/types/auth.types.js'
import { SessionExpiredError } from '../core/types/auth.types.js'
import type { ServiceRegistry, ServiceResources } from '../runtime/registry/service-registry.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import {
  ERR,
  AUTH_SCHEME,
  METRIC,
  OUTCOME,
  LOG_PREFIX
} from '../core/constants.js'
import { ensureError, errorCode, errorRetryable } from '../core/utils/errors.js'

/** MCP tool handlers expect `Record<string, unknown>`-compatible objects. */
export type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} & Record<string, unknown>

/**
 * Shape of the `extra` bag the MCP SDK passes to tool handlers. Only the
 * fields the gateway actually reads are declared — the SDK may attach more
 * but we don't depend on them.
 */
export interface McpToolExtra {
  correlationId?: string
  sessionId?: string
}

/**
 * Builds the standard `isError` MCP tool response. The on-wire payload always
 * carries `error`, `code`, and `retryable`; optional `extra` is shallow-merged
 * into the payload so callers can attach structured diagnostics (e.g. partial
 * `progress` from `api_execute`) without breaking existing consumers that
 * only read the three core fields.
 *
 * Reserved keys (`error`, `code`, `retryable`) cannot be overridden by `extra`.
 */
export function mcpError(
  message: string,
  code: string,
  retryable = false,
  extra?: Record<string, unknown>
): ToolResponse {
  const payload: Record<string, unknown> = { ...(extra ?? {}), error: message, code, retryable }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload)
    }],
    isError: true
  }
}

export function mcpSuccess(data: unknown): ToolResponse {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }]
  }
}

/** Reads `correlationId` off the MCP `extra` bag, falling back to a fresh UUID. */
export function extractCorrelationId(extra: unknown): string {
  return (extra as McpToolExtra | undefined)?.correlationId ?? crypto.randomUUID()
}

/** Reads `sessionId` off the MCP `extra` bag, falling back to a fresh UUID. */
export function extractSessionId(extra: unknown): string {
  return (extra as McpToolExtra | undefined)?.sessionId ?? crypto.randomUUID()
}

export function resolveService(
  registry: ServiceRegistry,
  service: string,
  serviceNames: string[]
): ServiceResources | ToolResponse {
  const resources = registry.get(service)
  if (!resources) {
    return mcpError(
      `Unknown service "${service}". Available: ${serviceNames.join(', ')}`,
      ERR.UNKNOWN_SERVICE,
      true
    )
  }
  return resources
}

export function isToolError(result: unknown): result is ToolResponse {
  return typeof result === 'object' && result !== null && 'isError' in result
}

/**
 * Standard auth path for all tools: missing token is a hard error surfaced
 * back to the client.
 */
export async function validateAuth(
  resources: ServiceResources,
  clientToken: string | undefined,
  correlationId: string,
  logger: Logger,
  toolName: string
): Promise<AuthResult | ToolResponse> {
  const authHeader = clientToken ? `${AUTH_SCHEME} ${clientToken}` : undefined
  return runValidation(resources, authHeader, correlationId, logger, toolName)
}

async function runValidation(
  resources: ServiceResources,
  authHeader: string | undefined,
  correlationId: string,
  logger: Logger,
  toolName: string
): Promise<AuthResult | ToolResponse> {
  try {
    return await resources.authMiddleware.validateRequest(authHeader, correlationId)
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      logger.warn({ correlationId, service: resources.name }, `${toolName} session expired`)
      return mcpError(err.message, err.code, false)
    }
    const errObj = ensureError(err)
    logger.warn({ correlationId, service: resources.name, error: errObj.message }, `${toolName} auth failed`)
    return mcpError(
      errObj.message,
      errorCode(err, ERR.AUTH_FAILED),
      errorRetryable(err)
    )
  }
}

/**
 * Higher-order pipeline for sandbox-backed tools (currently `search_code`
 * and `discover_skills`). Consolidates the steps every such tool repeats:
 *
 *   validateAuth → run the body → wrap in `mcpSuccess`
 *                 ↘ on failure: log + TOOL_CALLS (outcome=error)
 *                              + SANDBOX_ERRORS + `mcpError`
 *
 * Service resolution stays in the caller because the "unknown service"
 * error message includes the set of known names — forcing it through the
 * HOF would muddy the early-return path. `api_execute` has enough bespoke
 * logic (audit records, circuit-breaker outcomes, permission enforcement
 * inside the sandbox bridge) that it is intentionally *not* migrated to
 * this HOF; it calls {@link validateAuth} directly.
 */
export async function runSandboxTool<T>(
  opts: {
    tool: string
    service: string
    resources: ServiceResources
    clientToken: string | undefined
    correlationId: string
    logger: Logger
    metrics: MetricsCollector
  },
  body: (tokenPayload: TokenPayload) => Promise<T>
): Promise<ToolResponse> {
  const { tool, service, resources, clientToken, correlationId, logger, metrics } = opts

  const authResult = await validateAuth(resources, clientToken, correlationId, logger, tool)
  if (isToolError(authResult)) return authResult

  try {
    const result = await body(authResult.payload)
    metrics.increment(METRIC.TOOL_CALLS, { tool, service, outcome: OUTCOME.SUCCESS })
    logger.info(
      { correlationId, tool, service, response: JSON.stringify(result, null, 2) },
      `${LOG_PREFIX.MCP_OUT} ${tool} — response sent to AI client`
    )
    return mcpSuccess(result)
  } catch (err) {
    const errObj = ensureError(err)
    const code = errorCode(err)
    logger.warn({ correlationId, service, error: errObj.message, code }, `${tool} failed`)
    metrics.increment(METRIC.TOOL_CALLS, { tool, service, outcome: OUTCOME.ERROR })
    metrics.increment(METRIC.SANDBOX_ERRORS, { tool, errorType: code })
    return mcpError(errObj.message, code, errorRetryable(err))
  }
}
