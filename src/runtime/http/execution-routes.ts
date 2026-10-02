// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { v4 as uuidv4 } from 'uuid'
import type { Logger } from '../observability/logger.js'
import type { DurableExecutionRuntime } from '../execution/durable-execution-runtime.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { extractBearerFromRequest, bearerFailureToHttpResponse } from '../../spi/auth/bearer-authorization.js'
import { AuthError, type AuthResult } from '../../core/types/auth.types.js'
import { HttpError } from './http-error.js'
import { readBoundedBody } from './read-body.js'
import { sendJson } from './send-response.js'
import { ERR, HTTP_ROUTES } from '../../core/constants.js'
import { ExecutionError, ApprovalAlreadyDecidedError, type ExecutionRecord } from '../../core/types/execution.types.js'
import { errorCode } from '../../core/utils/errors.js'
import { hashAuthenticatedPrincipal } from '../../core/utils/user-id-hash.js'

const MAX_BODY_BYTES = 64 * 1024

/**
 * Execution inspection (§33–§34) and the fallback approval channel for MCP
 * clients that do not support elicitation (§24):
 *
 *   GET  /executions/{id}                          → execution, activities, approvals, decisions, history
 *   POST /executions/{id}/approvals/{approvalId}   → { action: accept|decline|cancel, approve?, comment? }
 *
 * Validates the bearer against the execution's service and binds it to the
 * execution owner. Returns `true` when this router handled the URL.
 */
export async function handleExecutionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  durableExecutionRuntime: DurableExecutionRuntime,
  registry: ServiceRegistry,
  logger: Logger,
  oauthConfig?: OAuthResourceConfig
): Promise<boolean> {
  const match = /^\/executions\/([A-Za-z0-9-]+)(?:\/approvals\/([A-Za-z0-9-]+))?\/?$/.exec(url.split('?')[0] ?? url)
  if (!match || !url.startsWith(HTTP_ROUTES.EXECUTIONS)) return false
  const executionId = match[1] as string
  const approvalId = match[2]

  const extracted = extractBearerFromRequest(req)
  if (!extracted.ok) {
    const resourceMetadataUrl = oauthConfig ? `${oauthConfig.resourceUri}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}` : undefined
    const { status, body, headers } = bearerFailureToHttpResponse(extracted.error, extracted.reason, resourceMetadataUrl)
    throw new HttpError(status, extracted.error.code, body.error, { reason: body.reason }, { reason: extracted.reason }, headers)
  }

  try {
    if (approvalId === undefined) {
      if (req.method !== 'GET') throw new HttpError(405, ERR.NOT_FOUND, 'Method not allowed', undefined, { url })
      const execution = await durableExecutionRuntime.manager.load(executionId)
      await authorizeExecution(execution, extracted.token, registry, url)
      const inspection = await durableExecutionRuntime.manager.inspect(executionId)
      sendJson(res, 200, inspection)
      return true
    }

    if (req.method !== 'POST') throw new HttpError(405, ERR.NOT_FOUND, 'Method not allowed', undefined, { url })
    const body = await readJsonBody(req, res)
    const action = body['action']
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new HttpError(400, ERR.INVALID_API_REQUEST, 'body.action must be one of accept, decline, cancel', undefined, { url })
    }
    // Authorize on the execution first; only then look at the approval, and
    // report one that belongs elsewhere exactly like an unknown one — the
    // reply must not confirm that some other execution's approval exists.
    const execution = await durableExecutionRuntime.manager.load(executionId)
    await authorizeExecution(execution, extracted.token, registry, url)
    const approval = await durableExecutionRuntime.approvals.get(approvalId)
    if (approval.executionId !== executionId) {
      throw new HttpError(404, ERR.APPROVAL_NOT_FOUND, `Unknown approval ${approvalId}`, undefined, { url, approvalExecutionId: approval.executionId })
    }
    const result = await durableExecutionRuntime.approvals.decide(approvalId, {
      action,
      executionId,
      ...(typeof body['approve'] === 'boolean' ? { approve: body['approve'] } : {}),
      ...(typeof body['comment'] === 'string' && body['comment'] ? { comment: body['comment'] } : {}),
      via: 'http'
    })
    logger.info({ executionId, approvalId, outcome: result.outcome }, 'Approval decided via HTTP')
    sendJson(res, 200, { approval: result.approval, outcome: result.outcome, executionStatus: (await durableExecutionRuntime.manager.load(executionId)).status })
    return true
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (err instanceof ApprovalAlreadyDecidedError) throw new HttpError(409, err.code, err.message, undefined, { url })
    if (err instanceof ExecutionError) {
      const status = err.code === ERR.EXECUTION_NOT_FOUND || err.code === ERR.APPROVAL_NOT_FOUND ? 404
        : err.code === ERR.EXECUTION_LOCKED ? 409
        : 400
      throw new HttpError(status, err.code, err.message, undefined, { url })
    }
    throw new HttpError(500, errorCode(err, ERR.INTERNAL), 'Internal server error', undefined, { url })
  }
}

async function authorizeExecution(
  execution: ExecutionRecord,
  token: string,
  registry: ServiceRegistry,
  url: string
): Promise<void> {
  const resources = registry.get(execution.service)
  if (!resources) throw new HttpError(404, ERR.EXECUTION_NOT_FOUND, 'Execution not found', undefined, { url })

  let authResult: AuthResult
  try {
    authResult = await resources.authMiddleware.validateRequest(`Bearer ${token}`, uuidv4())
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.retryable ? 503 : 401
      const message = err.retryable ? 'Authentication service temporarily unavailable' : 'Bearer token validation failed'
      throw new HttpError(status, err.code, message, undefined, { url, service: execution.service })
    }
    throw new HttpError(500, errorCode(err, ERR.INTERNAL), 'Internal server error', undefined, { url })
  }

  if (hashAuthenticatedPrincipal(authResult.payload, token) !== execution.userIdHash) {
    throw new HttpError(403, ERR.AUTH_FAILED, 'Execution belongs to a different authenticated principal', undefined, {
      url,
      service: execution.service
    })
  }
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
  const text = await readBoundedBody(req, res, MAX_BODY_BYTES)
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, ERR.INVALID_API_REQUEST, 'Request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, ERR.INVALID_API_REQUEST, 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
