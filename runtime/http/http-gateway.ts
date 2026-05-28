// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { extractBearerFromRequest, bearerFailureToHttpResponse } from '../../spi/auth/bearer-authorization.js'
import { handleProtectedResourceMetadata } from './oauth-metadata-handler.js'
import { SessionManager } from './session-manager.js'
import { sendJson, sendGatewayError } from './send-response.js'
import { HttpError } from './http-error.js'
import { ERR, HTTP_ROUTES, MCP_SESSION_HEADER } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'

export interface HttpGatewayOptions {
  host: string
  port: number
  idleTtlMs: number
  sweepIntervalMs: number
  createSessionServer: (clientToken: string) => McpServer
  registry: ServiceRegistry
  logger: Logger
  oauthConfig?: OAuthResourceConfig
}

export interface HttpGatewayHandle {
  /** The underlying Node `http.Server`, exposed so the caller can close it on shutdown. */
  server: Server
  /** Stops the idle-sweep timer. Callers must still `server.close()` to stop listening. */
  stopIdleSweep: () => void
}

/**
 * Creates and starts the Streamable-HTTP MCP gateway.
 *
 * This module owns the HTTP surface end-to-end: routing, bearer-auth
 * extraction, session lifecycle, and idle eviction. The boot logic in
 * `server-factory.ts` depends only on the returned handle — it does not
 * need to know about `node:http`, session maps, or the SDK transport.
 */
export function startHttpGateway(opts: HttpGatewayOptions): HttpGatewayHandle {
  const { host, port, idleTtlMs, sweepIntervalMs, createSessionServer, registry, logger, oauthConfig } = opts
  const sessions = new SessionManager()

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/'

      if (url === HTTP_ROUTES.HEALTH) {
        sendJson(res, 200, {
          status: 'ok',
          services: registry.serviceNames(),
          activeSessions: sessions.size()
        })
        return
      }

      if (
        url === HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE ||
        url === HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE_MCP
      ) {
        if (oauthConfig) {
          handleProtectedResourceMetadata(res, oauthConfig)
        } else {
          throw new HttpError(404, ERR.NOT_FOUND, 'Not found', undefined, { url })
        }
        return
      }

      if (url === HTTP_ROUTES.MCP) {
        await handleMcpRequest(req, res, sessions, createSessionServer, logger, oauthConfig)
        return
      }

      throw new HttpError(404, ERR.NOT_FOUND, 'Not found', undefined, { url })
    } catch (err) {
      if (res.headersSent) {
        // Transport already owns the response stream — best we can do is end it
        // and log. Typed-error serialization would corrupt a partial body.
        logger.error(
          { url: req.url, method: req.method, error: errorMessage(err) },
          'Unhandled error after response started'
        )
        res.end()
        return
      }

      if (err instanceof HttpError) {
        const logPayload = { url: req.url, method: req.method, code: err.code, ...err.logContext }
        if (err.status >= 500) {
          logger.error({ ...logPayload, error: err.message }, err.message)
        } else {
          logger.warn(logPayload, err.message)
        }
        sendJson(res, err.status, { error: err.message, code: err.code, ...err.body }, err.headers)
        return
      }

      logger.error(
        { url: req.url, method: req.method, error: errorMessage(err) },
        'Unhandled error in HTTP handler'
      )
      sendGatewayError(res, 500, ERR.INTERNAL, 'Internal server error')
    }
  })

  // setInterval ignores rejections, so we keep the body as an async closure
  // invoked with `void` — per-iteration try/catch already keeps close()
  // failures visible in logs.
  const runIdleSweep = async (): Promise<void> => {
    const evicted = sessions.sweepIdle(idleTtlMs)
    for (const { sessionId, entry, idleMs } of evicted) {
      logger.debug({ sessionId, idleMs }, 'Idle session evicted')
      try {
        await entry.transport.close?.()
      } catch (err) {
        logger.warn(
          { sessionId, error: errorMessage(err) },
          'Idle eviction: transport.close() failed'
        )
      }
    }
    if (evicted.length > 0) {
      logger.info({ evicted: evicted.length, remaining: sessions.size() }, 'Idle sessions evicted')
    }
  }

  const sweepTimer = setInterval(() => void runIdleSweep(), sweepIntervalMs)
  sweepTimer.unref()

  logger.info({ idleTtlMs, sweepIntervalMs }, 'Session idle sweep configured')

  server.listen(port, host, () => {
    logger.info(
      {
        endpoint: `http://${host}:${port}${HTTP_ROUTES.MCP}`,
        health: `http://${host}:${port}${HTTP_ROUTES.HEALTH}`,
        services: registry.serviceNames()
      },
      '🚀 Harbor ready (Streamable HTTP) — waiting for Clients to connect'
    )
  })

  return {
    server,
    stopIdleSweep: () => clearInterval(sweepTimer)
  }
}

/**
 * Handles a request on the `/mcp` route. Either resumes an existing session
 * (when `mcp-session-id` is present) or performs bearer auth and creates a
 * new session for first-time connections.
 *
 * Auth/routing failures throw {@link HttpError}; only the transport itself
 * owns the response stream on the happy path.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  createSessionServer: (clientToken: string) => McpServer,
  logger: Logger,
  oauthConfig?: OAuthResourceConfig
): Promise<void> {
  const sessionId = req.headers[MCP_SESSION_HEADER] as string | undefined

  if (sessionId) {
    await resumeSession(sessionId, req, res, sessions, logger, oauthConfig)
    return
  }

  await createAuthenticatedSession(req, res, sessions, createSessionServer, logger, oauthConfig)
}

async function resumeSession(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  logger: Logger,
  oauthConfig?: OAuthResourceConfig
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new HttpError(
      404,
      ERR.UNKNOWN_SESSION,
      `Unknown session: ${sessionId}`,
      undefined,
      { sessionId }
    )
  }

  const extracted = extractBearerFromRequest(req)
  if (!extracted.ok) {
    const resourceMetadataUrl = oauthConfig
      ? `${oauthConfig.resourceUri}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`
      : undefined
    const { status, body, headers } = bearerFailureToHttpResponse(extracted.error, extracted.reason, resourceMetadataUrl)
    throw new HttpError(status, extracted.error.code, body.error, { reason: body.reason }, { sessionId, reason: extracted.reason }, headers)
  }
  if (extracted.token !== session.clientToken) {
    throw new HttpError(
      401,
      ERR.TOKEN_INVALID,
      'Authorization does not match session',
      undefined,
      { sessionId }
    )
  }

  sessions.touch(sessionId)
  await session.transport.handleRequest(req, res)

  if (req.method === 'DELETE') {
    sessions.delete(sessionId)
    logger.info({ sessionId }, 'Session closed via DELETE')
  }
}

async function createAuthenticatedSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  createSessionServer: (clientToken: string) => McpServer,
  logger: Logger,
  oauthConfig?: OAuthResourceConfig
): Promise<void> {
  const extracted = extractBearerFromRequest(req)
  if (!extracted.ok) {
    const resourceMetadataUrl = oauthConfig
      ? `${oauthConfig.resourceUri}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`
      : undefined
    const { status, body, headers } = bearerFailureToHttpResponse(extracted.error, extracted.reason, resourceMetadataUrl)
    throw new HttpError(status, extracted.error.code, body.error, { reason: body.reason }, { reason: extracted.reason }, headers)
  }

  const clientToken = extracted.token
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  })

  transport.onclose = () => {
    const sid = transport.sessionId
    if (sid) {
      sessions.delete(sid)
      logger.info({ sessionId: sid }, 'Session closed')
    }
  }

  const sessionServer = createSessionServer(clientToken)
  await sessionServer.connect(transport)
  await transport.handleRequest(req, res)

  const sid = transport.sessionId
  if (sid) {
    sessions.register(sid, { transport, server: sessionServer, clientToken })
    logger.info({ sessionId: sid }, 'New session (authenticated)')
  }
}
